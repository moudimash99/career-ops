#!/usr/bin/env node

/**
 * freemotion-inventory.mjs — one browser_evaluate that describes ANY form well
 * enough to fill it, without knowing which ATS built it.
 *
 * WHY THIS EXISTS, GIVEN `freemotion-snapshot.mjs` AND `freemotion-validate.mjs`.
 * The three are different jobs and the gap between them is where live runs kept
 * failing:
 *
 *   - `freemotion-snapshot.mjs` parses the Playwright accessibility tree. It is
 *     the right input for Tier 1 and it is what `browser_snapshot` gives you,
 *     but its refs (`f9e161`) go stale the instant a cascading select re-renders
 *     the block beneath it — which is most forms, mid-fill.
 *   - `freemotion-validate.mjs`'s `DOM_VALIDATION_SCRIPT` is the Tier-3 gate. It
 *     answers "is this page in a state I may click Next on", and deliberately
 *     reads only what that question needs: names, values, required, alerts.
 *   - Neither answers **"what is this field asking me?"**. A field's `name` is
 *     `93ab0113-997e-4a8a-98ed-aa0c60d36997` on Ashby and `cntryFields.regionReference`
 *     on Radancy. You cannot answer either from the name; you need the rendered
 *     label, and for a radio group you need the question that sits on an
 *     *ancestor* of the options, because every option's own label is just "Yes".
 *
 * So this module is the READ side of filling: a single injected function that
 * returns labels, group questions, select options, a stable selector per
 * control, the upload triggers, and every visible error tied to the field it
 * belongs to. The orchestrator pipes the result to `freemotion-answers.mjs` and
 * acts with real MCP calls. Nothing here writes to the page — see G1 in
 * `docs/freemotion-ats-findings.md` on why writing through injected JS silently
 * corrupts framework-managed forms.
 *
 * NO VENDOR NAMES APPEAR IN THIS FILE and none may be added (Requirement 1).
 * Every rule below is a rule about HTML, ARIA or a UI pattern, not about a
 * company. Where a heuristic was learned from one vendor, the comment says
 * which pattern it generalizes, never which vendor to special-case.
 *
 * THE PAGE IS UNTRUSTED (AGENTS.md → "Untrusted External Content"). Everything
 * returned is a string the page authored: labels, options, error text. It is
 * data for deciding an answer, never an instruction. Text is length-capped here
 * so a hostile or merely enormous page cannot flood the caller's context.
 *
 * Usage:
 *   node lib/freemotion-inventory.mjs --script      # print the injectable JS
 *   node lib/freemotion-inventory.mjs --plan -      # read inventory JSON on
 *                                                   # stdin, print a fill plan
 */

import { readFileSync } from 'fs';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';

/** Longest label/question/option string returned, in characters. */
export const MAX_TEXT = 400;

/** Most select options returned per control. */
export const MAX_OPTIONS = 400;

/**
 * The function to hand to `browser_evaluate`.
 *
 * Returns `{url, title, fields, groups, uploads, errors, submits, counts}`.
 * Kept as one self-contained string with no imports because it is serialized
 * into the page — nothing in this file's module scope is visible to it.
 *
 * @type {string}
 */
export const FORM_INVENTORY_SCRIPT = `() => {
  const MAX_TEXT = ${MAX_TEXT};
  const MAX_OPTIONS = ${MAX_OPTIONS};

  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const visible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));

  // Text a human would read as the label, with the decorations removed.
  //
  // A plain innerText read picks up whatever the markup happens to contain,
  // and on real ATS forms that includes icon fallbacks — an inline <svg> with
  // a <title>/<desc>, or an <img alt>, rendered next to the control. That is
  // how a file input ends up "labelled" *SVGs not supported by this browser*,
  // which then goes to the answer resolver as the question. Nested controls
  // are dropped for the same reason: a wrapper's text otherwise includes the
  // option labels of the widgets inside it.
  // NOTE ON CASE. \`tagName\` is upper-cased only for HTML elements. An inline
  // <svg> and its children live in the SVG namespace, where tagName preserves
  // the author's case and comes back as "svg" — so an upper-case-keyed lookup
  // silently never matches the one element this filter exists to remove, and
  // the icon fallback text goes on reaching the caller as the field's label.
  // Normalize before every comparison.
  const SKIP_TAGS = { SVG: 1, IMG: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, INPUT: 1, BUTTON: 1 };
  const readableText = (root) => {
    if (!root) return '';
    let out = '';
    // The skip list applies to NESTED elements only, never to the root being
    // read. Asking for a button's own text must return it — the list exists to
    // stop a *container* absorbing the text of controls inside it, and applying
    // it to the root as well silently returns '' for every button and label
    // this is called on directly.
    const walk = (node, isRoot) => {
      if (!node) return;
      if (node.nodeType === 3) { out += ' ' + (node.nodeValue || ''); return; }
      if (node.nodeType !== 1) return;
      if (!isRoot && SKIP_TAGS[String(node.tagName || '').toUpperCase()]) return;
      for (const child of node.childNodes || []) walk(child, false);
    };
    walk(root, true);
    return clean(out);
  };

  // Label text specifically: like readableText, but it also drops any subtree
  // that CONTAINS a form control.
  //
  // A <label> very often wraps both the caption and the field itself:
  //
  //   <label>
  //     <div class="application-label">Current location</div>
  //     <div class="application-field"><input ...><div>No location found...</div></div>
  //   </label>
  //
  // Reading all of it gave "Current location No location found. Try entering a
  // different location" — the widget's live dropdown state welded onto the
  // question. The caption is the text OUTSIDE the control's own wrapper, so
  // skipping control-bearing subtrees is the precise rule, not a guess about
  // which block comes first. Same fix cleaned up an upload label that had
  // absorbed "Couldn't auto-read resume. Analyzing resume".
  const holdsControl = (node) => {
    try { return !!node.querySelector('input, select, textarea'); } catch (e) { return false; }
  };
  const labelText = (root) => {
    if (!root) return '';
    let out = '';
    const walk = (node, isRoot) => {
      if (!node) return;
      if (node.nodeType === 3) { out += ' ' + (node.nodeValue || ''); return; }
      if (node.nodeType !== 1) return;
      if (!isRoot) {
        if (SKIP_TAGS[String(node.tagName || '').toUpperCase()]) return;
        if (holdsControl(node)) return;
      }
      for (const child of node.childNodes || []) walk(child, false);
    };
    walk(root, true);
    return clean(out);
  };

  // SHADOW DOM. \`document.querySelectorAll\` does not cross a shadow boundary,
  // and an ATS built out of web components puts the ENTIRE form inside one —
  // one real page here exposed a single input at document level while 1814
  // open shadow roots held the actual fields. A non-piercing inventory reports
  // that page as "no form", which is indistinguishable from a page that failed
  // to load, so the caller retries forever or gives up on a working form.
  //
  // Playwright's own CSS engine pierces open shadow roots, so the id/name
  // selectors returned below stay usable by the caller even for controls found
  // in here. Closed roots are invisible to script by design and stay invisible.
  const deepQueryAll = (selector, root) => {
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      let matches = [];
      try { matches = [...node.querySelectorAll(selector)]; } catch (e) { matches = []; }
      for (const el of matches) out.push(el);
      let all = [];
      try { all = [...node.querySelectorAll('*')]; } catch (e) { all = []; }
      for (const el of all) if (el.shadowRoot) visit(el.shadowRoot);

      // SAME-ORIGIN IFRAMES. One ATS family renders its whole application
      // inside an iframe pointing at its OWN host, and strips the marker
      // parameter if you try to open that URL top-level, so "navigate to the
      // frame src" bounces straight back to the wrapper with no form. But the
      // frame is same-origin, so its document is readable from here — the
      // fields were sitting one contentDocument away the whole time.
      //
      // A cross-origin frame throws on access and is skipped: nothing can read
      // it from script, which is why the frames list is reported separately
      // for the caller to navigate to.
      let iframes = [];
      try { iframes = [...node.querySelectorAll('iframe')]; } catch (e) { iframes = []; }
      for (const frame of iframes) {
        let doc = null;
        try { doc = frame.contentDocument; } catch (e) { doc = null; }
        if (doc && doc.querySelectorAll) visit(doc);
      }
    };
    visit(root || document);
    return out;
  };

  // The root a node actually lives in, so uniqueness is checked in the right
  // scope: an id that repeats across two shadow roots is still unique within
  // each, which is exactly what a piercing selector needs to be told.
  const rootOf = (el) => {
    const root = el.getRootNode ? el.getRootNode() : document;
    return root && root.querySelectorAll ? root : document;
  };
  const inShadow = (el) => rootOf(el) !== document;

  // A selector that survives a re-render. Refs from the accessibility snapshot
  // do not: choosing a value in a cascading select re-renders everything below
  // it and every later ref in the same fill batch dies. An id or a name is
  // re-resolved from scratch on every call, so it cannot go stale.
  // Guard and call must reference the SAME binding: testing window.CSS and
  // then calling the bare global CSS throws wherever those are not the same
  // object, and the fallback that exists for exactly that case never runs.
  const cssEscape = (v) => (typeof window !== 'undefined' && window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(String(v))
    : String(v).replace(/["\\\\]/g, '\\\\$&'));
  const selectorFor = (el) => {
    // Uniqueness is judged inside the element's OWN root. A shadow root is a
    // separate id scope, so an id that looks duplicated document-wide is still
    // the only one where it lives.
    const scope = rootOf(el);
    // Attribute form for ids too: ATS ids routinely contain dots
    // ("cntryFields.firstName"), which a bare #id selector reads as a class.
    //
    // An id is unique per ROOT, not per document, and a component library
    // reuses the same id inside every instance of a component — one live page
    // carried two separate "file-input" controls in two shadow roots. Playwright's
    // CSS pierces shadow roots, so that selector matches both and the action is
    // refused as ambiguous. Check across roots before handing it back.
    if (el.id) {
      const idSel = '[id="' + cssEscape(el.id) + '"]';
      if (deepQueryAll(idSel).length <= 1) return idSel;
      // Most collisions are a web component and the native control it wraps
      // sharing one id (<spl-input id="x"> around <input id="x">). Only one of
      // the two is the thing to type into, and the tag says which.
      const tagSel = el.tagName.toLowerCase() + idSel;
      if (deepQueryAll(tagSel).length === 1) return tagSel;
      // Still ambiguous: the SAME component used twice, each instance holding
      // an identically-id'd control in its own shadow root — a CV-autofill
      // dropzone and the real resume field were literally this. What separates
      // them is a stable attribute on the HOST.
      //
      // A plain descendant combinator is the right output here, but it cannot
      // be VALIDATED the usual way. Playwright's CSS engine pierces open shadow
      // roots, so "[data-test=x] input#y" resolves for the caller even with the
      // host and the control in different roots (confirmed against a live
      // component-built form). \`document.querySelectorAll\` does not pierce, so
      // the same string scores 0 hits from inside the page and a naive
      // uniqueness check would reject a selector that works perfectly.
      //
      // Validate in two parts instead: the host attribute must be unique across
      // all roots, AND the control must be unique inside that host's own root.
      // Together those imply the combined selector resolves to exactly one node.
      // (Playwright's old ">>>" deep combinator is gone — plain descendant is
      // both correct and current.)
      const ownRoot = rootOf(el);
      let hostNode = ownRoot.host;
      for (let up = 0; up < 3 && hostNode; up++) {
        for (const attr of ['data-test', 'data-testid', 'data-automation-id', 'id']) {
          const v = hostNode.getAttribute && hostNode.getAttribute(attr);
          if (!v) continue;
          const hostSel = '[' + attr + '="' + cssEscape(v) + '"]';
          if (deepQueryAll(hostSel).length !== 1) continue;
          let within = [];
          try { within = [...ownRoot.querySelectorAll(tagSel)]; } catch (e) { within = []; }
          if (within.length === 1 && within[0] === el) return hostSel + ' ' + tagSel;
        }
        const nextRoot = hostNode.getRootNode ? hostNode.getRootNode() : null;
        hostNode = nextRoot && nextRoot.host ? nextRoot.host : null;
      }
    }
    const name = el.getAttribute('name');
    if (name) {
      let same = [];
      try { same = [...scope.querySelectorAll('[name="' + cssEscape(name) + '"]')]; } catch (e) { same = []; }
      if (same.length === 1) return '[name="' + cssEscape(name) + '"]';
      return '[name="' + cssEscape(name) + '"]:nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    for (const attr of ['data-automation-id', 'data-testid', 'data-test', 'aria-label']) {
      const v = el.getAttribute(attr);
      let hits = [];
      try { hits = [...scope.querySelectorAll('[' + attr + '="' + cssEscape(v || '\u0000') + '"]')]; } catch (e) { hits = []; }
      if (v && hits.length === 1) {
        return '[' + attr + '="' + cssEscape(v) + '"]';
      }
    }
    // Inside a shadow root a structural "body > ..." path is meaningless: the
    // chain does not start at <body> and cannot express the boundary. Say so
    // rather than returning a path that silently resolves to the wrong node.
    if (inShadow(el)) return '';
    // Last resort: a structural path. Fragile by nature, and it must be
    // ANCHORED: a chain that stops partway up the tree ("div:nth-of-type(2) >
    // ... > button") is a descendant pattern that matches anywhere in the
    // document, so it can silently resolve to a different control than the one
    // measured. Walk all the way to <body>, prefix it, and verify the result
    // selects exactly this element before returning it.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && node.parentElement) {
      const parent = node.parentElement;
      const idx = [...parent.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
      node = parent;
    }
    const path = parts.length ? 'body > ' + parts.join(' > ') : '';
    if (path) {
      try {
        const hit = document.querySelectorAll(path);
        if (hit.length === 1 && hit[0] === el) return path;
      } catch (e) { /* unusable path falls through */ }
    }
    return path;

  };

  // The rendered label, in the order a sighted user would find it. Native
  // <label> first because it is the only one the page guarantees is about THIS
  // control; the container and sibling fallbacks are for the many ATS forms
  // that style a <div> as a label and never associate it.
  const labelFor = (el) => {
    if (el.labels && el.labels.length) {
      const t = labelText(el.labels[0]);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      // IDREFs resolve inside the element's own root. A shadow root has its own
      // getElementById, and the document's cannot see an id that lives in one.
      const byScope = rootOf(el);
      const t = by.split(/\\s+/).map((id) => {
        const n = (byScope.getElementById ? byScope.getElementById(id) : null) || document.getElementById(id);
        return n ? labelText(n) : '';
      }).filter(Boolean).join(' ');
      if (t) return clean(t);
    }
    // The control's own wrapper: the nearest ancestor that holds exactly this
    // one control. Stopping there is what keeps a field from stealing its
    // neighbour's label.
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) {
      node = node.parentElement;
      if (node.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) break;
      const lab = node.querySelector('label');
      if (lab) {
        const t = labelText(lab);
        if (t) return t;
      }
      // A styled div acting as a label sits immediately before the control.
      const prev = el.previousElementSibling || node.firstElementChild;
      if (prev && prev !== el && !prev.querySelector('input,select,textarea')) {
        // First block only: a label and its live status messages share a
        // wrapper, and the status text is not part of the question.
        const t = labelText(prev);
        if (t && t.length <= 200) return t;
      }
    }
    // Still nothing: the wrapper walk stops at the shadow boundary, but the
    // label of a web-component field is routinely projected from OUTSIDE, on
    // the host element or its light-DOM slot. Climbing one host up recovers it,
    // and is what turned a page of unlabelled inputs into "First name *",
    // "Confirm your email *" and "City *" on a real component-built form.
    const host = rootOf(el).host;
    if (host) {
      const t = labelText(host);
      if (t && t.length <= 200) return t;
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  };

  // For a radio/checkbox GROUP the question is on an ancestor: each option's
  // own label is only "Yes" / "No" / an option name, so three different groups
  // are indistinguishable without this walk. Climb until an ancestor's text is
  // meaningfully longer than the options it contains — that extra text IS the
  // question.
  const questionFor = (members) => {
    const optionText = members.map((m) => labelFor(m)).join(' ');
    let node = members[0];
    for (let i = 0; i < 8 && node.parentElement; i++) {
      node = node.parentElement;
      const t = readableText(node);
      if (!t) continue;
      // Enough beyond the option labels to be a sentence, and not so much that
      // we have climbed up to the whole form.
      if (t.length > optionText.length + 12 && t.length < MAX_TEXT) return t;
      if (node.querySelectorAll('input:not([type=hidden]), select, textarea').length > members.length + 2) break;
    }
    return '';
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'file') return type;
    if (type === 'number' || type === 'range') return 'spinbutton';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  };

  // A custom-styled radio or checkbox hides its real input and paints a
  // <label> (or a span inside one) to look like the control. Clicking the
  // INPUT then does nothing at all: it has no size, so the click lands on
  // whatever is on top, and the option stays unchecked while the click itself
  // reports success. Seen live on a French form 2026-09-09, where four
  // force-clicks on four hidden radios all "succeeded" and left every group
  // unanswered.
  //
  // Same shape as the file-input problem (G6) and the same remedy: report the
  // visible thing a human would click. The label is the correct target because
  // a <label> bound to a control toggles it by definition, so this needs no
  // guess about which wrapper is clickable.
  const clickTargetFor = (el) => {
    const rect = el.getBoundingClientRect();
    const hidden = rect.width <= 2 || rect.height <= 2 || !visible(el);
    if (!hidden) return { hidden: false, clickSelector: '' };
    let label = el.labels && el.labels.length ? el.labels[0] : null;
    if (!label && el.id) {
      const scope = rootOf(el);
      try { label = scope.querySelector('label[for="' + cssEscape(el.id) + '"]'); } catch (e) { label = null; }
    }
    if (!label) label = el.closest ? el.closest('label') : null;
    return { hidden: true, clickSelector: label && visible(label) ? selectorFor(label) : '' };
  };

  // Whether the form considers this control mandatory.
  //
  // The \`required\` attribute is the reliable signal when it is there, and on
  // plenty of real forms it is simply absent while the rendered label says
  // "Required" in words. A form like that reports zero required fields, a
  // readiness check passes, and the submit is then refused for a field nobody
  // planned. So the LABEL counts too — in the languages a label says it in.
  //
  // Only as a fallback, never to override an explicit \`required="false"\`-style
  // absence on a control whose label happens to contain the word for another
  // reason: the label text has to be the control's own accessible name, which
  // is what labelFor returns.
  const REQUIRED_WORD = /(^|[^a-z])(required|mandatory|obligatoire|requis|erforderlich|obligatorio|obbligatorio)([^a-z]|$)/i;
  const isRequired = (el, label) => {
    if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') return true;
    return REQUIRED_WORD.test(String(label || ''));
  };

  // Which <form> a control belongs to, as an index into the page's forms.
  //
  // A careers page routinely carries OTHER forms — a newsletter signup in the
  // footer, a site search, a cookie preferences panel. One live page offered a
  // footer field labelled "Email address without domain", which is a mailing
  // list, not part of the application; a planner that fills every field on the
  // page types the candidate's address into it. Reporting the owning form lets
  // the caller keep to the one that holds the application, without this module
  // having to guess which that is.
  const formIndexOf = (el) => {
    const owner = el.form || (el.closest ? el.closest('form') : null);
    if (!owner) return -1;
    let forms = [];
    try { forms = [...rootOf(el).querySelectorAll('form')]; } catch (e) { forms = []; }
    const idx = forms.indexOf(owner);
    return idx >= 0 ? idx : -1;
  };

  // A button-shaped <input> is not a question. type=submit/button/reset/image
  // are all <input> elements, and one live form reported its submit control as
  // an unlabelled textbox whose "value" was the words Submit application —
  // which a planner would then try to type an answer into. Excluded at the
  // source; the buttons are already reported separately as submits.
  const controls = deepQueryAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, [contenteditable="true"]');

  const fields = [];
  const groupMembers = {};
  const uploads = [];

  // An ARIA combobox is built from a wrapper plus one or more inner <input>s
  // (a search box, a hidden value carrier). Those are PARTS of the widget, not
  // separate questions: reported individually they arrive unlabelled, often
  // flagged required, and inflate the count of unanswered required fields —
  // seen live as two extra nameless required "textbox" entries for two
  // picklists. The widget itself is already reported; its internals are not.
  // Two shapes, both plumbing:
  //  - an input nested INSIDE the [role=combobox] element (its search box);
  //  - an anonymous input sitting BESIDE one in the same wrapper — the proxy a
  //    widget adds purely so the browser's native "required" validation fires
  //    for a control that isn't a real <select>. One live form carried two of
  //    these (class "…-requiredInput", no id, no name, no label) and they were
  //    reported as two unlabelled REQUIRED questions, pushing the unanswered
  //    count from 7 to 9 and inviting a caller to type an answer into them.
  //
  // The anonymity test is what keeps this safe: a genuine question always has
  // at least an id, a name, or an accessible label. Something with none of the
  // three, next to a combobox, is never a question being asked.
  const isWidgetPlumbing = (el) => {
    let node = el.parentElement;
    for (let i = 0; i < 4 && node; i++) {
      if (node.getAttribute && node.getAttribute('role') === 'combobox') return true;
      node = node.parentElement;
    }
    const anonymous = !el.id
      && !el.getAttribute('name')
      && !el.getAttribute('aria-label')
      && !el.getAttribute('aria-labelledby')
      && !(el.labels && el.labels.length);
    if (!anonymous) return false;
    node = el.parentElement;
    for (let i = 0; i < 3 && node; i++) {
      let siblings = [];
      try { siblings = [...node.querySelectorAll('[role="combobox"], select')]; } catch (e) { siblings = []; }
      if (siblings.some((s) => s !== el)) return true;
      node = node.parentElement;
    }
    return false;
  };

  for (const el of controls) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = roleOf(el);
    const name = el.getAttribute('name') || '';

    if (type !== 'file' && role !== 'combobox' && isWidgetPlumbing(el)) continue;

    if (type === 'radio' || (type === 'checkbox' && name && deepQueryAll('input[type=checkbox][name="' + cssEscape(name) + '"]').length > 1)) {
      (groupMembers[name || el.id] = groupMembers[name || el.id] || []).push(el);
      continue;
    }

    if (type === 'file') {
      const rect = el.getBoundingClientRect();
      // A file input styled to 1x1 (or hidden outright) cannot be clicked: a
      // dropzone overlay swallows the pointer event. The real trigger is a
      // button or label inside the same container, and clicking THAT is what
      // opens the chooser.
      const hidden = rect.width <= 2 || rect.height <= 2 || !visible(el);
      // Climb for the visible control that actually opens the chooser, but
      // stop the moment the ancestor holds a SECOND file input: above that
      // point the buttons belong to a sibling uploader, and clicking one
      // attaches the CV to the wrong field. (A form with a CV-autofill
      // dropzone at the top and a resume field further down is the common
      // shape, and picking the top one there is silent — both accept a PDF.)
      let trigger = '';
      let triggerText = '';
      let node = el;
      for (let i = 0; i < 4 && node.parentElement && !trigger; i++) {
        node = node.parentElement;
        if (node.querySelectorAll('input[type=file]').length > 1) break;
        const cand = [...node.querySelectorAll('button, label, [role="button"]')].find((b) => visible(b));
        if (cand) { trigger = selectorFor(cand); triggerText = clean(cand.innerText || cand.textContent); }
      }
      uploads.push({
        selector: selectorFor(el),
        label: labelFor(el),
        required: isRequired(el, labelFor(el)),
        formIndex: formIndexOf(el),
        accept: clean(el.getAttribute('accept') || ''),
        multiple: Boolean(el.multiple),
        hiddenInput: hidden,
        triggerSelector: trigger,
        triggerText: triggerText,
        filled: Boolean(el.files && el.files.length),
      });
      continue;
    }

    const field = {
      selector: selectorFor(el),
      id: el.id || '',
      name: name,
      role: role,
      tag: el.tagName.toLowerCase(),
      // The input type, because role alone cannot separate a number box from a
      // slider: both report as spinbutton, and one takes a typed value while
      // the other refuses every write that is not a real interaction.
      type: type,
      label: labelFor(el),
      required: isRequired(el, labelFor(el)),
      formIndex: formIndexOf(el),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      invalid: el.getAttribute('aria-invalid') === 'true',
      visible: visible(el),
      maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : undefined,
    };
    if (type === 'range') {
      // A slider ALWAYS has a value: it renders at its starting position, so
      // "value is non-empty" can never mean "the candidate answered this".
      // The bounds and the untouched default are what let a caller tell the
      // two apart, and are what it needs to step the thing anyway.
      field.min = el.min === '' ? undefined : Number(el.min);
      field.max = el.max === '' ? undefined : Number(el.max);
      field.step = el.step === '' ? undefined : Number(el.step);
      field.defaultValue = String(el.defaultValue == null ? '' : el.defaultValue);
    }
    if (type === 'checkbox' || type === 'radio') Object.assign(field, clickTargetFor(el));
    if (type === 'checkbox') field.checked = Boolean(el.checked);
    else field.value = String(el.value == null ? (el.textContent || '') : el.value).slice(0, MAX_TEXT);
    if (el.tagName === 'SELECT') {
      field.options = [...el.options].slice(0, MAX_OPTIONS).map((o) => clean(o.text));
      field.optionCount = el.options.length;
    } else if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
      // An ARIA combobox is an <input> whose options live in a SEPARATE
      // [role=listbox] — the pattern most modern ATS use for country, city and
      // any long picklist. Two things make it dangerous to read naively:
      //
      //  1. While collapsed (aria-expanded="false") the listbox is often not
      //     rendered at all, so "no options" means "not open yet", NOT "no
      //     choices". Reporting the first as the second makes a caller invent
      //     free text for a field that only accepts a listed value.
      //  2. Pages routinely contain OTHER listboxes belonging to other widgets
      //     (a phone-prefix picker is the classic). Grabbing "the page's
      //     listbox" can hand back one widget's options for another widget's
      //     field — wrong, and silent, because both look like country lists.
      //
      // So associate only by an explicit ARIA reference or by containment in
      // the combobox's own wrapper. When neither resolves, say so and let the
      // caller expand it with a real click and re-read.
      let listbox = null;
      const owns = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (owns) {
        for (const id of owns.split(/\\s+/)) {
          const node = document.getElementById(id);
          if (node && (node.getAttribute('role') === 'listbox' || node.querySelector('[role="option"]'))) { listbox = node; break; }
        }
      }
      if (!listbox) {
        let node = el;
        for (let i = 0; i < 3 && node.parentElement && !listbox; i++) {
          node = node.parentElement;
          // Stop before a container that owns a second combobox: past that
          // point a listbox inside it may belong to the neighbour.
          if (node.querySelectorAll('[role="combobox"], select').length > 1) break;
          listbox = node.querySelector('[role="listbox"]');
        }
      }
      if (listbox) {
        const opts = [...listbox.querySelectorAll('[role="option"], li')].slice(0, MAX_OPTIONS)
          .map((o) => clean(o.innerText || o.textContent)).filter(Boolean);
        if (opts.length) { field.options = opts; field.optionCount = opts.length; }
      }
      if (!field.options) {
        field.optionsUnknown = true;
        field.expanded = el.getAttribute('aria-expanded') === 'true';
        // How the caller gets them: a real click on the control, then re-run
        // this inventory. Never type a free value into a picklist first.
        field.hint = 'aria-combobox: click to expand, then re-read the inventory';
      }
    }
    fields.push(field);
  }

  const groups = Object.entries(groupMembers).map(([key, members]) => ({
    group: key,
    role: (members[0].getAttribute('type') || 'radio').toLowerCase(),
    question: questionFor(members),
    required: members.some((m) => isRequired(m, labelFor(m))) || REQUIRED_WORD.test(questionFor(members)),
    formIndex: formIndexOf(members[0]),
    visible: members.some(visible),
    answered: members.some((m) => m.checked),
    options: members.map((m) => ({
      selector: selectorFor(m),
      label: labelFor(m),
      value: clean(m.value),
      checked: Boolean(m.checked),
      disabled: Boolean(m.disabled),
      ...clickTargetFor(m),
    })),
  }));

  // Errors. role="alert" alone is not enough: plenty of ATS forms render a
  // validation message as a styled div with no ARIA role at all, and reading
  // only body text gives you "is a required property" with no way to tell
  // WHICH property. So: collect by role AND by class, then resolve each
  // message to the nearest control so the caller learns the field name.
  const errorNodes = deepQueryAll(
    '[role="alert"], [class*="error" i], [class*="invalid" i], [class*="Error"], .help-block, [aria-invalid="true"]'
  ).filter((el) => visible(el) && readableText(el));

  const seenError = new Set();
  const errors = [];
  for (const el of errorNodes) {
    const text = clean(el.innerText || el.textContent);
    if (!text || seenError.has(text)) continue;
    // A container that wraps other error nodes repeats their text; keep the
    // innermost, most specific message.
    if (el.querySelector('[role="alert"], [class*="error" i]')) continue;
    seenError.add(text);
    let field = '';
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      const ctl = node && node.querySelector('input:not([type=hidden]), select, textarea');
      if (ctl) { field = ctl.id || ctl.getAttribute('name') || selectorFor(ctl); break; }
    }
    errors.push({ text, field });
  }

  // What could advance or finish the form. The caller decides which — this
  // never clicks anything.
  const SUBMIT_RE = /^(submit|soumettre|envoyer|apply|postuler|next|suivant|continue|continuer|weiter|siguiente|enviar|avanti|senden|save and continue|review)/i;
  const submits = deepQueryAll('button, input[type=submit], [role="button"], a[class*="btn" i]')
    .filter(visible)
    .map((b) => ({ selector: selectorFor(b), text: clean(b.innerText || b.value || b.textContent), disabled: Boolean(b.disabled) }))
    .filter((b) => b.text && SUBMIT_RE.test(b.text))
    .slice(0, 12);

  // The way IN, which is a different vocabulary from the way ON. A link that
  // opens an application says "I'm interested" or "Je postule" as often as it
  // says "Apply", and none of those are advance/submit words. Kept separate
  // from \`submits\` so an entry link is never clicked as if it finished a form.
  const ENTRY_RE = /^(apply|apply now|postuler|je postule|i'?m interested|start (your )?application|bewerben|jetzt bewerben|solicitar|candidatarsi|candidater|inscreva)/i;
  const entryPoints = deepQueryAll('a, button, [role="button"]')
    .filter(visible)
    .map((b) => ({ selector: selectorFor(b), text: readableText(b) || clean(b.value), href: clean(b.getAttribute && b.getAttribute('href')) }))
    .filter((b) => b.text && ENTRY_RE.test(b.text))
    .slice(0, 8);

  // A consent overlay makes a rendered form look absent: zero controls, and the
  // only things clickable are cookie buttons. Reporting that as "no form" is
  // indistinguishable from a page that failed to load, so name it instead.
  const CONSENT_RE = /cookie|consent|consentement|préférences|preferences|accept all|reject all|zustimmen|akzeptieren|aceptar|tout accepter|tout refuser/i;
  const consentButtons = deepQueryAll('button, [role="button"], a')
    .filter(visible)
    .map((b) => ({ selector: selectorFor(b), text: readableText(b) }))
    .filter((b) => b.text && CONSENT_RE.test(b.text))
    .slice(0, 8);

  // The third reason a rendered page reports no fields: the form is in an
  // IFRAME. \`browser_evaluate\` runs in the top frame only, and a cross-origin
  // frame is unreadable from here by design — so an embedded application form
  // is invisible to this script no matter how well it pierces shadow roots.
  // The frame's own URL is readable, though, and navigating straight to it
  // gives a top-level page this inventory can read normally.
  const frames = [...document.querySelectorAll('iframe')]
    .map((f) => ({ src: clean(f.getAttribute('src')), title: clean(f.getAttribute('title')), width: Math.round(f.getBoundingClientRect().width) }))
    // Only frames big enough to hold a form. A page's iframes are mostly
    // captcha widgets, analytics beacons and social embeds, all of them tiny
    // or zero-width; listing those as "the form might be in here" sends the
    // caller off to navigate to a captcha. Width is the vendor-neutral test.
    .filter((f) => f.src && /^https?:/i.test(f.src) && f.width >= 200)
    .slice(0, 8);

  const counts = {
    fields: fields.length,
    groups: groups.length,
    uploads: uploads.length,
    requiredEmpty: fields.filter((f) => f.required && f.visible && !f.disabled && !(f.value || f.checked)).length
      + groups.filter((g) => g.required && g.visible && !g.answered).length
      + uploads.filter((u) => u.required && !u.filled).length,
  };

  // A consent wall is only worth reporting when it is actually IN THE WAY:
  // plenty of filled-in forms carry a "Cookie Settings" link in the footer.
  const consentWall = counts.fields === 0 && counts.groups === 0 && counts.uploads === 0 && consentButtons.length > 0;

  return {
    url: location.href,
    title: document.title,
    fields,
    groups,
    uploads,
    errors,
    submits,
    entryPoints,
    frames,
    consentWall,
    consentButtons: consentWall ? consentButtons : [],
    counts,
  };
}`;

/**
 * A country dial prefix sitting alone in a field. Not an answer.
 *
 * A phone widget with a country picker pre-fills the input with the dial code
 * ("+33") the moment the page renders, so a plain "is the value non-empty?"
 * test reports the field as answered and the plan never emits a fill for it.
 * The form then rejects "+33" as an invalid number, naming a field that looks
 * populated on screen and in the inventory. Seen live on a French form,
 * 2026-09-09.
 *
 * Deliberately narrow: a leading "+" (or "00") followed by at most four digits
 * and nothing else. A real number is longer, and a field that legitimately
 * holds a short number has no plus sign in front of it.
 */
const DIAL_PREFIX_ONLY = /^\s*(\+|00)\s*\d{1,4}\s*$/;

/**
 * Whether a non-checkbox field already carries a real answer.
 *
 * @param {object} field
 * @returns {boolean}
 */
function isAnswered(field) {
  const value = String(field?.value ?? '').trim();
  if (value === '') return false;
  // A slider renders at a starting position, so it is never empty and would
  // otherwise count as answered before anyone touched it. Untouched means the
  // value still equals the default the markup shipped.
  if (field.type === 'range') {
    const shipped = field.defaultValue;
    return shipped !== undefined && String(shipped).trim() !== value;
  }
  return !DIAL_PREFIX_ONLY.test(value);
}

/**
 * Everything still unanswered, in the order a caller should work through it.
 *
 * Split into `required` and `optional` rather than filtered down to the
 * required ones: this build's instruction is to fill every field a human would
 * fill, and a form is not finished when its asterisks are satisfied. Callers
 * that only care about the gate read `required`.
 *
 * A disabled or invisible control is in neither list — it is not a question
 * being asked. That matters for the mutually-exclusive consent pairs described
 * in `docs/freemotion-ats-findings.md` (G2), where answering one control
 * DISABLES its partner: without this filter the partner reads as an unanswered
 * required field forever and a correct form looks incomplete.
 *
 * @param {{fields?: object[], groups?: object[], uploads?: object[]}} inventory
 *   The parsed return value of {@link FORM_INVENTORY_SCRIPT}.
 * @returns {{required: object[], optional: object[], uploads: object[]}}
 *   Each entry is `{kind, selector, question, ...}` where `kind` is
 *   `'field' | 'group' | 'upload'`.
 */
export function pendingWork(inventory) {
  const required = [];
  const optional = [];

  for (const f of inventory?.fields ?? []) {
    if (!f.visible || f.disabled) continue;
    const answered = f.role === 'checkbox' ? f.checked === true : isAnswered(f);
    if (answered) continue;
    const entry = {
      kind: 'field',
      selector: f.selector,
      question: f.label || f.name || f.id,
      role: f.role,
      // The tag distinguishes a native <select> (role combobox, tag select)
      // from an ARIA combobox (role combobox, tag input). They share a role
      // and need opposite handling: one takes a value, the other only commits
      // on a click in its separate listbox.
      tag: f.tag,
      type: f.type,
      // A slider is answerable only as a number, so its bounds and its
      // untouched starting position travel with it.
      min: f.min,
      max: f.max,
      step: f.step,
      defaultValue: f.defaultValue,
      options: f.options,
      maxLength: f.maxLength,
      // The visible thing to click when the control itself is hidden behind a
      // styled label. Empty for an ordinary, clickable control.
      clickSelector: f.clickSelector,
      formIndex: f.formIndex,
    };
    (f.required ? required : optional).push(entry);
  }

  for (const g of inventory?.groups ?? []) {
    if (!g.visible || g.answered) continue;
    const entry = {
      kind: 'group',
      selector: g.options?.find((o) => !o.disabled)?.selector ?? '',
      question: g.question || g.group,
      role: g.role,
      options: (g.options ?? []).map((o) => o.label),
      choices: g.options,
      formIndex: g.formIndex,
    };
    (g.required ? required : optional).push(entry);
  }

  const uploads = (inventory?.uploads ?? []).filter((u) => !u.filled).map((u) => ({
    kind: 'upload',
    selector: u.selector,
    // The click target, which is NOT the input when the input is hidden (G6).
    clickSelector: u.hiddenInput && u.triggerSelector ? u.triggerSelector : u.selector,
    question: u.label || u.triggerText || 'file upload',
    accept: u.accept,
    required: u.required,
    formIndex: u.formIndex,
  }));

  return { required, optional, uploads };
}

/**
 * Whether the page may be advanced, and what is stopping it.
 *
 * Deliberately narrower than `freemotion-validate.mjs`'s `evaluateValidation`:
 * that one is the Tier-3 gate with two-capture reconciliation and navigation
 * checks. This is the cheap read from a single inventory, for deciding whether
 * there is any point taking the second capture at all.
 *
 * @param {object} inventory
 * @returns {{ready: boolean, blockers: string[]}}
 */
export function readiness(inventory) {
  const { required, uploads } = pendingWork(inventory);
  const blockers = [];
  for (const item of required) blockers.push(`unanswered required: ${item.question}`);
  for (const u of uploads) if (u.required) blockers.push(`missing required upload: ${u.question}`);
  for (const e of inventory?.errors ?? []) blockers.push(`error${e.field ? ` on ${e.field}` : ''}: ${e.text}`);
  return { ready: blockers.length === 0, blockers };
}

const USAGE = `Usage:
  node lib/freemotion-inventory.mjs --script
  node lib/freemotion-inventory.mjs --plan <file|->

--script prints the JavaScript to hand to browser_evaluate. It reads the page
and returns every field with its rendered label, every radio/checkbox group
with the question that sits on an ancestor, select options, upload triggers,
visible errors tied to their field, and the advance/submit buttons. It never
writes to the page.

--plan takes that JSON back (a file, or - for stdin) and prints what is still
unanswered, split into required / optional / uploads, plus a readiness verdict.`;

function main(argv) {
  validateFlags(argv, ['--script', '--plan', '--help', '-h'], USAGE, { valueFlags: ['--plan'] });

  if (hasFlag(argv, '--script')) {
    console.log(FORM_INVENTORY_SCRIPT);
    return 0;
  }

  const planSource = flagValue(argv, '--plan');
  if (planSource) {
    const raw = planSource === '-' ? readFileSync(0, 'utf-8') : readFileSync(planSource, 'utf-8');
    let inventory;
    try {
      inventory = JSON.parse(raw);
    } catch (err) {
      console.error(`could not parse inventory JSON: ${err.message}`);
      return 1;
    }
    const work = pendingWork(inventory);
    const verdict = readiness(inventory);
    console.log(JSON.stringify({ ...work, ...verdict, url: inventory.url ?? null }, null, 2));
    return verdict.ready ? 0 : 2;
  }

  console.error(USAGE);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
