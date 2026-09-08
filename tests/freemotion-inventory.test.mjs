// tests/freemotion-inventory.test.mjs — the read side of form filling.
//
// The injected script is exercised for real, not stubbed: the suite builds the
// DOM shapes that actually broke live runs and runs FORM_INVENTORY_SCRIPT over
// them through a minimal document implementation. The shapes are described by
// what they are — a radio group whose question sits on an ancestor, a 1x1 file
// input behind a dropzone, a validation message with no ARIA role — never by
// which vendor shipped them, because the whole point of Requirement 1 is that
// the module must not know.
//
// Run: node test-all.mjs --only freemotion-inventory

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-inventory — describing a form well enough to fill it');

const { FORM_INVENTORY_SCRIPT, pendingWork, readiness, MAX_TEXT } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-inventory.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

// ---------------------------------------------------------------- the script

check('the injected script is a parseable function expression', (() => {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return ${FORM_INVENTORY_SCRIPT}`);
    return 'ok';
  } catch (err) {
    return `parse error: ${err.message}`;
  }
})(), 'ok');

check('the script names no ATS vendor (Requirement 1)',
  /workday|greenhouse|lever|ashby|radancy|icims|taleo|smartrecruiters|successfactors|teamtailor|recruitee|personio|welcometothejungle/i
    .test(FORM_INVENTORY_SCRIPT), false);

check('the script is self-contained — no imports or module-scope references',
  /\bimport\b|\brequire\(/.test(FORM_INVENTORY_SCRIPT), false);

// The script is serialized into a page, so a stray backtick or `${}` that the
// template literal ate would produce silently wrong JS rather than an error.
check('the script kept its template placeholders substituted',
  FORM_INVENTORY_SCRIPT.includes('${'), false);
check('the caps were interpolated as literals', FORM_INVENTORY_SCRIPT.includes(`const MAX_TEXT = ${MAX_TEXT};`), true);

// ------------------------------------------------- running it against a DOM

// A deliberately small DOM. Building this by hand rather than pulling in jsdom
// keeps the suite dependency-free and, more usefully, makes each shape under
// test explicit and readable.
function makeDom(spec) {
  let idSeq = 0;
  const all = [];

  function el(tag, attrs = {}, children = []) {
    const node = {
      // A real browser upper-cases tagName for HTML elements only; SVG-namespace
      // elements keep the author's case. The fixture must reproduce that or the
      // case-normalization the script needs is never exercised.
      tagName: tag === 'svg' ? 'svg' : tag.toUpperCase(),
      nodeType: 1,
      attrs: { ...attrs },
      children: [],
      parentElement: null,
      _text: attrs._text ?? '',
      labels: [],
      files: null,
      options: [],
      multiple: false,
      disabled: Boolean(attrs.disabled),
      checked: Boolean(attrs.checked),
      value: attrs.value ?? '',
      maxLength: attrs.maxLength ?? -1,
      id: attrs.id ?? '',
      _seq: idSeq++,
    };
    delete node.attrs._text;
    node.getAttribute = (k) => (k in node.attrs ? String(node.attrs[k]) : null);
    node.hasAttribute = (k) => k in node.attrs;
    node.getBoundingClientRect = () => ({ width: attrs._w ?? 100, height: attrs._h ?? 20 });
    node.getClientRects = () => (attrs._hidden ? [] : [{}]);
    Object.defineProperty(node, 'offsetParent', { get: () => (attrs._hidden ? null : { }) });
    Object.defineProperty(node, 'innerText', { get: () => nodeText(node) });
    Object.defineProperty(node, 'textContent', { get: () => nodeText(node) });
    node.querySelectorAll = (sel) => matchAll(node, sel);
    node.querySelector = (sel) => matchAll(node, sel)[0] ?? null;
    // getRootNode() is how the script asks "which root do I live in" — the
    // basis of every shadow-aware decision it makes. Walk to the topmost
    // ancestor: a shadow root (marked by `.host`) or the document.
    node.getRootNode = () => {
      let n = node;
      while (n.parentElement) n = n.parentElement;
      return n.host ? n : doc;
    };
    for (const c of children) { c.parentElement = node; node.children.push(c); }
    // `childNodes` (elements AND text nodes) is what the script's readableText
    // walker uses to strip icon/SVG decoration out of a label. A fixture with
    // only `children` would exercise a path real browsers never take.
    Object.defineProperty(node, 'previousElementSibling', {
      get: () => {
        const sibs = node.parentElement?.children ?? [];
        return sibs[sibs.indexOf(node) - 1] ?? null;
      },
    });
    Object.defineProperty(node, 'firstElementChild', { get: () => node.children[0] ?? null });
    Object.defineProperty(node, 'childNodes', {
      get: () => [
        ...(node._text ? [{ nodeType: 3, nodeValue: node._text }] : []),
        ...node.children,
      ],
    });
    all.push(node);
    return node;
  }

  function nodeText(node) {
    const own = node._text ?? '';
    const kids = node.children.map(nodeText).join(' ');
    return `${own} ${kids}`.replace(/\s+/g, ' ').trim();
  }

  function descendants(node) {
    const out = [];
    for (const c of node.children) { out.push(c, ...descendants(c)); }
    return out;
  }

  // Only the selector forms the script actually uses.
  function matches(node, sel) {
    const s = sel.trim();
    // The script sweeps '*' to discover shadow hosts; without it the whole
    // shadow-piercing path is unreachable from the fixture.
    if (s === '*') return true;
    // Any bare tag selector ('a', 'label', 'button', 'select', 'textarea').
    if (/^[a-z][\w-]*$/.test(s)) return node.tagName === s.toUpperCase();
    if (s === 'input[type=file]') return node.tagName === 'INPUT' && node.getAttribute('type') === 'file';
    if (s.startsWith('input:not([type=hidden])')) {
      return node.tagName === 'INPUT' && node.getAttribute('type') !== 'hidden';
    }
    if (s === 'select') return node.tagName === 'SELECT';
    if (s === 'textarea') return node.tagName === 'TEXTAREA';
    if (s === 'button') return node.tagName === 'BUTTON';
    if (s === '[role="button"]') return node.getAttribute('role') === 'button';
    if (s === '[role="alert"]') return node.getAttribute('role') === 'alert';
    if (s === '.help-block') return (node.getAttribute('class') || '').includes('help-block');
    if (s === '[aria-invalid="true"]') return node.getAttribute('aria-invalid') === 'true';
    if (s === 'input[type=submit]') return node.tagName === 'INPUT' && node.getAttribute('type') === 'submit';
    if (s.startsWith('a[class*="btn"')) return node.tagName === 'A' && /btn/i.test(node.getAttribute('class') || '');
    const cls = s.match(/^\[class\*="([^"]+)"(?:\s+i)?\]$/);
    if (cls) return new RegExp(cls[1], 'i').test(node.getAttribute('class') || '');
    const attr = s.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (attr) return node.getAttribute(attr[1]) === attr[2] || (attr[1] === 'id' && node.id === attr[2]);
    // Tag-qualified attribute form, e.g. input[id="x"] — how the script breaks
    // a tie between a web component and the native control it wraps.
    const tagAttr = s.match(/^([\w-]+)\[([\w-]+)="([^"]*)"\]$/);
    if (tagAttr) {
      if (node.tagName !== tagAttr[1].toUpperCase()) return false;
      return node.getAttribute(tagAttr[2]) === tagAttr[3] || (tagAttr[2] === 'id' && node.id === tagAttr[3]);
    }
    const typed = s.match(/^input\[type=(\w+)\]\[name="([^"]*)"\]$/);
    if (typed) return node.tagName === 'INPUT' && node.getAttribute('type') === typed[1] && node.getAttribute('name') === typed[2];
    return false;
  }

  function matchAll(root, sel) {
    const parts = sel.split(',').map((p) => p.trim()).filter(Boolean);
    return descendants(root).filter((n) => parts.some((p) => matches(n, p)));
  }

  const body = el('body', {}, spec(el));
  body.parentElement = null;

  // A browser populates `el.labels` from every <label for="thisId">. The
  // script relies on it first, so the fixture has to provide it or the tests
  // measure a fallback path that real pages never reach.
  for (const node of all) {
    if (node.tagName !== 'LABEL') continue;
    const target = all.find((n) => n.id && n.id === node.getAttribute('for'));
    if (target) target.labels.push(node);
  }

  const doc = {
    body,
    querySelectorAll: (sel) => matchAll(body, sel),
    querySelector: (sel) => matchAll(body, sel)[0] ?? null,
    getElementById: (id) => all.find((n) => n.id === id) ?? null,
    title: 'Application form',
  };
  return { doc, el };
}

function runScript(dom) {
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'location', 'window', `return (${FORM_INVENTORY_SCRIPT})();`);
  return factory(dom.doc, { href: 'https://example.test/apply' }, { CSS: { escape: (v) => String(v) } });
}

// A radio group whose options are each labelled only "Yes"/"No" and whose real
// question sits two levels up. Three such groups on one page are otherwise
// indistinguishable — this is the shape that makes a form unanswerable.
const radioDom = makeDom((el) => [
  el('div', {}, [
    el('div', { _text: 'Are you legally authorised to work in this country?' }, []),
    el('div', {}, [
      el('input', { type: 'radio', name: 'authz', value: 'yes', id: 'authz-0' }, []),
      el('label', { _text: 'Yes', for: 'authz-0' }, []),
      el('input', { type: 'radio', name: 'authz', value: 'no', id: 'authz-1' }, []),
      el('label', { _text: 'No', for: 'authz-1' }, []),
    ]),
  ]),
]);
const radioOut = runScript(radioDom);

check('a radio group is reported as one group, not two fields', radioOut.groups.length, 1);
check('the group is not counted among the plain fields', radioOut.fields.length, 0);
check('the ancestor question is recovered, not the option label',
  radioOut.groups[0].question.startsWith('Are you legally authorised to work'), true);
check('every option is listed with its own label', radioOut.groups[0].options.map((o) => o.label), ['Yes', 'No']);
check('and with its own selector', radioOut.groups[0].options.map((o) => o.selector), ['[id="authz-0"]', '[id="authz-1"]']);
check('an untouched group reads as unanswered', radioOut.groups[0].answered, false);

// The same group, answered.
radioDom.doc.getElementById('authz-0').checked = true;
check('answering one option marks the whole group answered', runScript(radioDom).groups[0].answered, true);

// --------------------------------------------------------------- file inputs

const uploadDom = makeDom((el) => [
  // A CV-autofill dropzone ABOVE the real resume field. Both accept a PDF, so
  // attaching to the wrong one is silent — the reason the trigger search must
  // stop before an ancestor that holds a second file input.
  el('div', { class: 'autofill-zone' }, [
    el('input', { type: 'file', _w: 1, _h: 1 }, []),
    el('button', { _text: 'Autofill from CV' }, []),
  ]),
  el('div', { class: 'resume-zone' }, [
    el('input', { type: 'file', id: 'resume', required: '', _w: 1, _h: 1, accept: '.pdf' }, []),
    el('button', { _text: 'Upload File' }, []),
  ]),
]);
const uploadOut = runScript(uploadDom);

check('both file inputs are found', uploadOut.uploads.length, 2);
check('a 1x1 input is flagged as hidden', uploadOut.uploads[1].hiddenInput, true);
check('the resume trigger is the button in its OWN container',
  uploadOut.uploads[1].triggerText, 'Upload File');
check('the autofill trigger is not confused with the resume one',
  uploadOut.uploads[0].triggerText, 'Autofill from CV');
check('a required upload is marked required', uploadOut.uploads[1].required, true);
check('the accept list is passed through', uploadOut.uploads[1].accept, '.pdf');
check('an empty upload is not marked filled', uploadOut.uploads[1].filled, false);

// ------------------------------------------------------------------- errors

// A validation message with NO role="alert" — only a class. Reading role=alert
// alone reports a blocked form as clean, which is the worst possible failure
// for a Tier-3 gate.
const errorDom = makeDom((el) => [
  el('div', {}, [
    el('label', { _text: 'Postal code' }, []),
    el('input', { type: 'text', id: 'zip', required: '' }, []),
    el('div', { class: 'error-detail', _text: 'is a required property' }, []),
  ]),
]);
const errorOut = runScript(errorDom);

check('a class-only validation message is still found', errorOut.errors.length >= 1, true);
check('the message is resolved to the field it belongs to', errorOut.errors[0].field, 'zip');
check('the message text is preserved', errorOut.errors[0].text, 'is a required property');

// ------------------------------------------------------------------ selects

const selectDom = makeDom((el) => [
  el('div', {}, [
    el('label', { _text: 'Country' }, []),
    Object.assign(el('select', { id: 'country', required: '' }, []), {
      options: [{ text: 'Please select' }, { text: 'France' }, { text: 'Germany' }],
    }),
  ]),
]);
const selectOut = runScript(selectDom);
check('a select reports its options so an answer can be matched to one',
  selectOut.fields[0].options, ['Please select', 'France', 'Germany']);
check('a select is reported as a combobox', selectOut.fields[0].role, 'combobox');
check('the label is read from the sibling label element', selectOut.fields[0].label, 'Country');

// ------------------------------------------------------------ shadow DOM

// A form built out of web components. `document.querySelectorAll` stops at
// every shadow boundary, so a non-piercing inventory reports a fully rendered
// form as "no fields" — indistinguishable from a page that failed to load.
// Seen live on a component-built ATS: 1 input at document level, 1814 open
// shadow roots holding the real ones.
function attachShadow(host, children, mk) {
  const root = mk('shadow-root', {}, children);
  root.parentElement = null;
  // A DocumentFragment-ish stand-in: what the script needs from a shadow root
  // is querySelectorAll, getElementById and a back-reference to its host.
  root.host = host;
  root.getElementById = (id) => root.querySelectorAll('[id="' + id + '"]')[0] ?? null;
  host.shadowRoot = root;
  for (const c of children) c.parentElement = root;
  return root;
}

const shadowDom = makeDom((el) => {
  const hostA = el('spl-form-field', { _text: 'First name *' }, []);
  attachShadow(hostA, [el('input', { type: 'text', id: 'first-name-input', required: '' }, [])], el);
  const hostB = el('spl-form-field', { _text: 'City *' }, []);
  attachShadow(hostB, [el('input', { type: 'text', id: 'city-input', required: '' }, [])], el);
  // Two instances of the SAME component: the id repeats across roots, which is
  // legal (ids are unique per root) but makes a piercing [id=] selector match
  // both and the action ambiguous.
  const dupA = el('spl-dropzone', { _text: 'CV' }, []);
  attachShadow(dupA, [el('input', { type: 'file', id: 'file-input' }, [])], el);
  const dupB = el('spl-dropzone', { _text: 'Cover letter' }, []);
  attachShadow(dupB, [el('input', { type: 'file', id: 'file-input' }, [])], el);
  return [hostA, hostB, dupA, dupB];
});
const shadowOut = runScript(shadowDom);

check('controls inside shadow roots are found at all', shadowOut.fields.length, 2);
check('a shadow-hosted field gets its label from the host',
  shadowOut.fields.map((f) => f.label), ['First name *', 'City *']);
check('a uniquely-id\'d shadow control still gets an id selector',
  shadowOut.fields[0].selector, '[id="first-name-input"]');
check('file inputs inside shadow roots are found too', shadowOut.uploads.length, 2);
check('an id repeated across shadow roots is NOT handed back as a bare id selector',
  shadowOut.uploads.every((u) => u.selector !== '[id="file-input"]'), true);

// The commonest collision is a web component and the native control it wraps
// sharing one id. Tag-qualifying picks out the one you can actually type into.
const wrapperDom = makeDom((el) => {
  const host = el('spl-input', { id: 'first-name-input', _text: 'First name *' }, []);
  attachShadow(host, [el('input', { type: 'text', id: 'first-name-input', required: '' }, [])], el);
  return [host];
});
check('a component/control id collision is disambiguated by tag',
  runScript(wrapperDom).fields[0].selector, 'input[id="first-name-input"]');

// --------------------------------------------- same-origin iframe forms

// One ATS family renders the whole application inside an iframe pointing at
// its OWN host, and strips the marker parameter if you open that URL
// top-level, so "navigate to the frame src" bounces back to the wrapper with
// no form. The frame is same-origin though, so its document is readable from
// the injected script: 2 fields became 7 on the live page.
const sameOriginFrameDom = makeDom((el) => {
  const inner = el('div', {}, [
    el('label', { _text: 'Email', for: 'email' }, []),
    el('input', { type: 'email', id: 'email', required: '' }, []),
  ]);
  const innerDoc = el('framedoc', {}, [inner]);
  innerDoc.parentElement = null;
  const frame = el('iframe', { src: 'https://ats.example.com/apply?in_iframe=1', _w: 1385 }, []);
  frame.contentDocument = innerDoc;
  return [frame];
});
const frameOut = runScript(sameOriginFrameDom);
check('fields inside a same-origin iframe are found', frameOut.fields.length, 1);
check('and they keep their label', frameOut.fields[0].label, 'Email');

// A cross-origin frame throws on contentDocument access and must be skipped,
// not crash the sweep — it stays in `frames` for the caller to navigate to.
const crossOriginDom = makeDom((el) => {
  const frame = el('iframe', { src: 'https://other.example.net/apply', _w: 900 }, []);
  Object.defineProperty(frame, 'contentDocument', {
    get() { throw new Error('cross-origin'); },
  });
  return [frame, el('div', {}, [el('label', { _text: 'Name', for: 'n' }, []), el('input', { type: 'text', id: 'n' }, [])])];
});
const crossOut = runScript(crossOriginDom);
check('a cross-origin frame does not break the sweep', crossOut.fields.length, 1);
check('and it is still reported for the caller to navigate to',
  crossOut.frames.map((f) => f.src), ['https://other.example.net/apply']);

// -------------------------------------------------- icon noise in labels

// An upload control decorated with an inline <svg> carrying fallback text.
// Read naively, the control's "label" becomes the SVG's fallback string and
// that is what reaches the answer resolver as the question — seen live as
// *SVGs not supported by this browser*.
const iconDom = makeDom((el) => [
  el('div', {}, [
    el('div', {}, [
      // Lower-case on purpose: an inline <svg> is in the SVG namespace, where
      // tagName is NOT upper-cased. Matching it is the whole point.
      el('svg', { _text: 'SVGs not supported by this browser.' }, []),
      el('span', { _text: 'Upload your CV' }, []),
    ]),
    el('input', { type: 'text', id: 'cvnote' }, []),
  ]),
]);
const iconLabel = runScript(iconDom).fields.find((f) => f.id === 'cvnote').label;
check('an inline SVG fallback string is not mistaken for the label',
  /SVGs not supported/.test(iconLabel), false);
check('and the real adjacent text is used instead', iconLabel, 'Upload your CV');

// A wrapper's text must not absorb the labels of controls nested inside it.
const nestedDom = makeDom((el) => [
  el('div', {}, [
    el('label', { _text: 'Notice period', for: 'notice' }, []),
    el('input', { type: 'text', id: 'notice' }, []),
  ]),
]);
check('a label does not swallow neighbouring input values',
  runScript(nestedDom).fields[0].label, 'Notice period');

// The skip list must apply to NESTED elements only. Applied to the root too,
// it silently returns '' for every button and label read directly — which is
// how entry-point and consent detection went blind.
const buttonTextDom = makeDom((el) => [
  el('button', { _text: 'Submit application' }, []),
  el('div', {}, [
    el('label', { _text: 'Salary', for: 'sal' }, []),
    el('input', { type: 'text', id: 'sal' }, []),
    // A button inside the wrapper must NOT leak into the field's label.
    el('button', { _text: 'Clear' }, []),
  ]),
]);
const btnOut = runScript(buttonTextDom);
check('a button read directly still reports its own text',
  btnOut.submits[0].text, 'Submit application');
check('but a button nested beside a field does not leak into that label',
  btnOut.fields[0].label, 'Salary');

// The real shape from a live form: a <label> wrapping BOTH the caption and the
// field, with the widget's live dropdown state inside the field wrapper. Read
// whole, the caption became "Current location No location found. Try entering
// a different location" — the question welded to transient widget state.
const statusDom = makeDom((el) => {
  const input = el('input', { type: 'text', id: 'loc' }, []);
  const label = el('label', { for: 'loc' }, [
    el('div', { class: 'application-label', _text: 'Current location' }, []),
    el('div', { class: 'application-field' }, [
      input,
      el('div', { _text: 'No location found. Try entering a different location' }, []),
    ]),
  ]);
  return [label];
});
check('widget state inside the field wrapper is not absorbed into the label',
  runScript(statusDom).fields[0].label, 'Current location');

// ------------------------------------------------------- ARIA comboboxes

// An <input role="combobox"> whose choices live in a separate listbox. The
// page ALSO carries an unrelated widget with its own listbox — the shape that
// makes naive "find a listbox" association hand back one field's options for
// another. Both list countries, so getting it wrong is invisible.
const comboDom = makeDom((el) => [
  el('div', { class: 'phone-widget' }, [
    el('input', { type: 'tel', id: 'phone', role: 'combobox' }, []),
    el('ul', { role: 'listbox', id: 'phone-country-listbox' }, [
      el('li', { role: 'option', _text: 'France (+33)' }, []),
      el('li', { role: 'option', _text: 'Germany (+49)' }, []),
    ]),
  ]),
  el('div', { class: 'location-widget' }, [
    el('input', { type: 'text', id: 'location', role: 'combobox', 'aria-expanded': 'false' }, []),
  ]),
]);
const comboOut = runScript(comboDom);
const locationField = comboOut.fields.find((f) => f.id === 'location');
const phoneField = comboOut.fields.find((f) => f.id === 'phone');

check('a collapsed combobox with no reachable listbox reports options as unknown',
  locationField.optionsUnknown, true);
check('and does NOT borrow the neighbouring widget\'s options',
  locationField.options, undefined);
check('and tells the caller how to get them', /click to expand/.test(locationField.hint), true);
check('and reports that it is currently collapsed', locationField.expanded, false);
check('a combobox whose own container holds the listbox does read its options',
  phoneField.options, ['France (+33)', 'Germany (+49)']);

// A widget's own plumbing is not a question. A combobox is often accompanied
// by an anonymous proxy input whose only job is to make the browser's native
// "required" validation fire — no id, no name, no label. Reported as fields,
// two of these turned 7 unanswered required questions into 9 and invited a
// caller to type an answer into a control nothing reads.
const plumbingDom = makeDom((el) => [
  el('div', { class: 'select-shell' }, [
    el('input', { type: 'text', id: 'gender', role: 'combobox', 'aria-label': 'What is your gender?', required: '' }, []),
    el('input', { type: 'text', class: 'requiredInput', required: '' }, []),
  ]),
]);
const plumbingOut = runScript(plumbingDom);
check('a combobox validation proxy is not reported as a question',
  plumbingOut.fields.length, 1);
check('and the real combobox survives', plumbingOut.fields[0].label, 'What is your gender?');

// The anonymity test is what keeps that rule safe: a genuine neighbouring
// question always has an id, a name or a label, and must NOT be dropped.
const neighbourDom = makeDom((el) => [
  el('div', { class: 'select-shell' }, [
    el('input', { type: 'text', id: 'country', role: 'combobox', 'aria-label': 'Country', required: '' }, []),
    el('input', { type: 'text', id: 'postcode', 'aria-label': 'Postal code', required: '' }, []),
  ]),
]);
check('a real labelled field beside a combobox is kept',
  runScript(neighbourDom).fields.map((f) => f.label), ['Country', 'Postal code']);

// An explicit ARIA reference wins over containment.
const ownsDom = makeDom((el) => [
  el('div', {}, [
    el('input', { type: 'text', id: 'country', role: 'combobox', 'aria-controls': 'country-list' }, []),
  ]),
  el('ul', { role: 'listbox', id: 'country-list' }, [
    el('li', { role: 'option', _text: 'France' }, []),
    el('li', { role: 'option', _text: 'Spain' }, []),
  ]),
]);
check('aria-controls resolves a listbox that is not a DOM ancestor sibling',
  runScript(ownsDom).fields.find((f) => f.id === 'country').options, ['France', 'Spain']);

// -------------------------------------------------------------- submit hunt

const submitDom = makeDom((el) => [
  el('button', { _text: 'Back' }, []),
  el('button', { _text: 'Suivant' }, []),
  el('button', { _text: 'Submit Application' }, []),
  el('button', { _text: 'Save draft' }, []),
]);
const submitOut = runScript(submitDom);
check('advance and submit buttons are found in several languages',
  submitOut.submits.map((b) => b.text), ['Suivant', 'Submit Application']);
check('unrelated buttons are not offered as submits',
  submitOut.submits.some((b) => /Back|Save draft/.test(b.text)), false);

// ------------------------------------------------------------- pendingWork

const inventory = {
  fields: [
    { selector: '#a', label: 'First name', role: 'textbox', required: true, visible: true, disabled: false, value: '' },
    { selector: '#b', label: 'Last name', role: 'textbox', required: true, visible: true, disabled: false, value: 'Machaka' },
    { selector: '#c', label: 'LinkedIn', role: 'textbox', required: false, visible: true, disabled: false, value: '' },
    { selector: '#d', label: 'Hidden thing', role: 'textbox', required: true, visible: false, disabled: false, value: '' },
    // The partner of an answered mutually-exclusive consent pair: still marked
    // required by the page, but disabled. It is not a question being asked.
    { selector: '#e', label: 'I refuse', role: 'checkbox', required: true, visible: true, disabled: true, checked: false },
    { selector: '#f', label: 'I accept', role: 'checkbox', required: true, visible: true, disabled: false, checked: true },
  ],
  groups: [
    { group: 'g1', question: 'Work authorised?', required: true, visible: true, answered: false, role: 'radio', options: [{ selector: '#g1y', label: 'Yes', disabled: false }, { selector: '#g1n', label: 'No', disabled: false }] },
    { group: 'g2', question: 'Heard from?', required: false, visible: true, answered: true, role: 'radio', options: [] },
  ],
  uploads: [
    { selector: '#cv', label: 'Resume', required: true, filled: false, hiddenInput: true, triggerSelector: '#cvbtn', accept: '.pdf' },
    { selector: '#cover', label: 'Cover letter', required: false, filled: false, hiddenInput: false, triggerSelector: '', accept: '' },
  ],
  errors: [],
};
const work = pendingWork(inventory);

check('an unanswered required field is pending', work.required.map((w) => w.question), ['First name', 'Work authorised?']);
check('an unanswered OPTIONAL field is reported too, separately', work.optional.map((w) => w.question), ['LinkedIn']);
check('an answered field is not pending', work.required.concat(work.optional).some((w) => w.question === 'Last name'), false);
check('an invisible field is not a question being asked', work.required.some((w) => w.question === 'Hidden thing'), false);
check('a DISABLED required control is not reported as unanswered',
  work.required.concat(work.optional).some((w) => w.question === 'I refuse'), false);
check('an answered group is not pending', work.required.concat(work.optional).some((w) => w.question === 'Heard from?'), false);
check('a hidden upload hands back its TRIGGER as the click target',
  work.uploads.find((u) => u.question === 'Resume').clickSelector, '#cvbtn');
check('a visible upload is clicked directly',
  work.uploads.find((u) => u.question === 'Cover letter').clickSelector, '#cover');
check('an optional upload is still listed — a form is not done at its asterisks',
  work.uploads.length, 2);

// ------------------------------------------- consent walls and entry points

// A working page whose form is hidden behind a consent overlay: zero controls,
// only cookie buttons. Reporting "no form" here is indistinguishable from a
// page that failed to load, so the wall has to be named.
const consentDom = makeDom((el) => [
  el('button', { _text: 'Accept All Cookies' }, []),
  el('button', { _text: 'Reject All' }, []),
  el('button', { _text: 'Cookies Settings' }, []),
]);
const consentOut = runScript(consentDom);
check('a page with no fields and only cookie buttons is flagged as a consent wall',
  consentOut.consentWall, true);
check('and the dismiss controls are handed back', consentOut.consentButtons.length >= 2, true);

// The same footer link on a page that DOES have a form is not a wall.
const footerCookieDom = makeDom((el) => [
  el('div', {}, [el('label', { _text: 'Email', for: 'e' }, []), el('input', { type: 'text', id: 'e' }, [])]),
  el('button', { _text: 'Cookie Settings' }, []),
]);
check('a cookie link beside a real form is NOT a consent wall',
  runScript(footerCookieDom).consentWall, false);

// The way in is a wider vocabulary than the way on.
const entryDom = makeDom((el) => [
  el('a', { _text: "I'm interested", href: '/oneclick/123' }, []),
  el('a', { _text: 'Je postule', href: '/apply/fr' }, []),
  el('a', { _text: 'Privacy Notice', href: '/privacy' }, []),
]);
const entryOut = runScript(entryDom);
check('an apply entry link is found even when it never says "apply"',
  entryOut.entryPoints.map((e) => e.text), ["I'm interested", 'Je postule']);
check('and entry points are kept separate from submits', entryOut.submits.length, 0);

// A page whose form lives in an iframe: browser_evaluate runs in the top frame
// only, so no amount of shadow piercing will find the fields. The frame URL is
// readable though, and navigating to it directly gives a page that IS readable.
const iframeDom = makeDom((el) => [
  el('iframe', { src: 'https://job-boards.example.com/embed/job_app?for=acme', title: 'Application', _w: 900 }, []),
  // Most iframes on a page are captcha widgets and beacons: tiny or zero-width.
  // Listing those sends the caller off to "navigate to the form" at a captcha.
  el('iframe', { src: 'https://challenge.example.net/captcha/v1/abc', _w: 0 }, []),
  el('iframe', { src: 'https://beacon.example.net/px.gif', _w: 1 }, []),
]);
const iframeOut = runScript(iframeDom);
check('an embedded application frame is reported so the caller can navigate to it',
  iframeOut.frames.map((f) => f.src), ['https://job-boards.example.com/embed/job_app?for=acme']);
check('and tiny captcha/beacon frames are not offered as the form',
  iframeOut.frames.length, 1);
check('an empty page with a frame is not mistaken for a consent wall',
  iframeOut.consentWall, false);

// ---------------------------------------------------------------- readiness

const verdict = readiness(inventory);
check('a form with unanswered required work is not ready', verdict.ready, false);
check('every blocker is named', verdict.blockers.length, 3);
check('the required upload is named as a blocker',
  verdict.blockers.some((b) => b.includes('missing required upload: Resume')), true);

const clean = readiness({
  fields: [{ selector: '#a', label: 'First name', role: 'textbox', required: true, visible: true, disabled: false, value: 'Mohammad' }],
  groups: [], uploads: [{ selector: '#cv', label: 'Resume', required: true, filled: true }], errors: [],
});
check('a fully answered form is ready', clean.ready, true);
check('and reports no blockers', clean.blockers, []);

// An error on the page blocks even when every field looks answered — this is
// the case the Tier-3 gate exists for.
const withError = readiness({
  fields: [], groups: [], uploads: [],
  errors: [{ text: 'is a required property', field: 'fitScoreNo' }],
});
check('a visible error blocks an otherwise complete form', withError.ready, false);
check('and the blocker names the field', withError.blockers[0], 'error on fitScoreNo: is a required property');

check('an empty inventory is ready, not a crash', readiness({}).ready, true);
check('pendingWork tolerates an empty inventory', pendingWork({}), { required: [], optional: [], uploads: [] });

// ------------------------------------- a dial prefix is not a phone number

// A phone widget with a country picker pre-fills the input with the dial code
// on render. A plain non-empty test called the field answered, no fill was
// planned, and the form then rejected "+33" as invalid — naming a field that
// looked populated both on screen and in the inventory.
const dialOnly = pendingWork({
  fields: [
    { selector: '#p1', label: 'Phone', role: 'textbox', tag: 'input', required: true, visible: true, value: '+33' },
    { selector: '#p2', label: 'Phone', role: 'textbox', tag: 'input', required: true, visible: true, value: ' +33 ' },
    { selector: '#p3', label: 'Phone', role: 'textbox', tag: 'input', required: true, visible: true, value: '0033' },
  ],
  groups: [], uploads: [],
});
check('a lone dial prefix is not an answer', dialOnly.required.length, 3);

const realValues = pendingWork({
  fields: [
    { selector: '#a', label: 'Phone', role: 'textbox', tag: 'input', required: true, visible: true, value: '+33 7 53 37 78 23' },
    { selector: '#b', label: 'Postcode', role: 'textbox', tag: 'input', required: true, visible: true, value: '31300' },
    { selector: '#c', label: 'Years', role: 'textbox', tag: 'input', required: true, visible: true, value: '6' },
    { selector: '#d', label: 'Salary', role: 'textbox', tag: 'input', required: true, visible: true, value: '42000' },
  ],
  groups: [], uploads: [],
});
// The rule has to stay narrow: a bare number with no plus sign is a real
// answer, and so is a full number that merely starts with a prefix.
check('a real value is still an answer, prefix-shaped or not', realValues.required.length, 0);

check('the tag comes through, so a native select is distinguishable from a combobox',
  pendingWork({ fields: [{ selector: '#s', label: 'Country', role: 'combobox', tag: 'select', required: true, visible: true, value: '', options: ['A'] }], groups: [], uploads: [] })
    .required[0].tag, 'select');

// --------------------------------------- posting page, or the form itself?

const { looksLikeApplicationForm } = await import(pathToFileURL(join(ROOT, 'lib/freemotion-inventory.mjs')).href);

// "Are there any fields?" is the wrong question. A posting page carries one or
// two — an "email me this job" box, a search, a newsletter signup — so a
// caller keyed on zero fields never clicks Apply on those pages, and one keyed
// on any field stops at the posting and fills a mailing list.
check('one stray email box is not an application form',
  looksLikeApplicationForm({ counts: { fields: 1, groups: 0, uploads: 0, requiredEmpty: 1 } }), false);

check('a CV upload settles it, however few the fields',
  looksLikeApplicationForm({ counts: { fields: 1, groups: 0, uploads: 1, requiredEmpty: 2 } }), true);

check('enough questions is the other way to tell',
  looksLikeApplicationForm({ counts: { fields: 4, groups: 0, uploads: 0, requiredEmpty: 4 } }), true);

check('and a group counts as a question',
  looksLikeApplicationForm({ counts: { fields: 2, groups: 2, uploads: 0, requiredEmpty: 3 } }), true);

check('an empty page is not a form', looksLikeApplicationForm({ counts: { fields: 0, groups: 0, uploads: 0, requiredEmpty: 0 } }), false);
check('a missing inventory is not a form', looksLikeApplicationForm({}), false);
check('a null inventory does not throw', looksLikeApplicationForm(null), false);

// ------------------------------------------------------------- honeypots

// Found live: an <input> labelled "Please leave this field blank" in an
// ordinary application form, optional and rendered. This project fills
// optional fields on purpose, so it would have been filled — and filling it
// is the single thing that marks the application as automated.
const honeypots = pendingWork({
  fields: [
    { selector: '#hp', label: 'Please leave this field blank', role: 'textbox', tag: 'input', required: false, visible: true, value: '', honeypot: true },
    { selector: '#real', label: 'First Name', role: 'textbox', tag: 'input', required: true, visible: true, value: '', honeypot: false },
  ],
  groups: [], uploads: [],
});
check('a honeypot is not work, required or not',
  [...honeypots.required, ...honeypots.optional].map((i) => i.selector), ['#real']);

const onlyHoneypot = pendingWork({
  fields: [{ selector: '#hp', label: 'Please leave this field blank', role: 'textbox', tag: 'input', required: true, visible: true, value: '', honeypot: true }],
  groups: [], uploads: [],
});
check('even a REQUIRED honeypot is left alone', onlyHoneypot.required.length, 0);

// The detection itself lives in the injected script, so exercise the phrasing
// it keys on rather than the mechanism.
const LEAVE_BLANK = /leave (this|it) (field )?(blank|empty)|leave blank|do ?n[o']?t (fill|complete)|ne (pas )?remplir|laissez? (ce champ )?vide|nicht ausf.llen|dejar? en blanco|non compilare/i;
for (const phrase of [
  'Please leave this field blank',
  'Leave this field empty',
  'leave blank',
  'Do not fill this in',
  'Don\'t fill this field',
  'Ne pas remplir',
  'Laissez ce champ vide',
  'Bitte nicht ausfüllen',
  'Dejar en blanco',
  'Non compilare',
]) {
  check(`"${phrase}" reads as a honeypot`, LEAVE_BLANK.test(phrase), true);
}
// And the phrases a real question uses must not trip it.
for (const phrase of ['First Name', 'Cover letter (optional)', 'Leave of absence history', 'Blank canvas experience']) {
  check(`"${phrase}" is a real question`, LEAVE_BLANK.test(phrase), false);
}

// ------------------------------- a select can lie about being answered too

// A form defaulting Country to its own company's country reads as perfectly
// answered while being wrong for most candidates. A REQUIRED picklist still
// sitting on the option the markup shipped has not been answered by anyone.
const shippedDefault = pendingWork({
  fields: [
    { selector: '#req', label: 'Country *', role: 'combobox', tag: 'select', type: 'select-one',
      required: true, visible: true, value: 'United States', defaultValue: 'United States', options: ['United States', 'France'] },
    { selector: '#opt', label: 'Country', role: 'combobox', tag: 'select', type: 'select-one',
      required: false, visible: true, value: 'United States', defaultValue: 'United States', options: ['United States', 'France'] },
    { selector: '#chosen', label: 'Country *', role: 'combobox', tag: 'select', type: 'select-one',
      required: true, visible: true, value: 'France', defaultValue: 'United States', options: ['United States', 'France'] },
  ],
  groups: [], uploads: [],
});
check('a required select on its shipped default is unanswered',
  [...shippedDefault.required, ...shippedDefault.optional].map((f) => f.selector), ['#req']);

// An optional select left at a sensible default is a legitimate end state,
// and re-answering every one of those would fight the form for no reason.
check('an optional select on its default is left alone',
  shippedDefault.optional.some((f) => f.selector === '#opt'), false);
check('a select deliberately changed is not re-answered',
  shippedDefault.required.some((f) => f.selector === '#chosen'), false);

// A native <select> holding only a blank placeholder has options injected on
// interaction. Reporting [""] as the list sends a caller off to match its
// answer against an empty string and conclude the form offers no valid value.
check('a select with no options yet reports them as unknown, not as empty',
  pendingWork({ fields: [{ selector: '#lazy', label: 'Country *', role: 'combobox', tag: 'select', type: 'select-one',
    required: true, visible: true, value: '', optionsUnknown: true }], groups: [], uploads: [] })
    .required[0].options, undefined);

// ------------------------------------------ the required marker, in practice

// The asterisk is the commonest required marker of all, and a word-only check
// misses it entirely: one live form marked every required field with nothing
// but "*" and so reported requiredEmpty 0 on a page where nine were mandatory.
const REQUIRED_MARKER = /(^|[^a-z])(required|mandatory|obligatoire|requis|erforderlich|obligatorio|obbligatorio)([^a-z]|$)|[*✱]/i;
for (const label of ['First Name *', 'Email* Required', 'Nom complet *', 'Champ obligatoire',
  'Pflichtfeld erforderlich', 'Campo obligatorio', 'CV ✱']) {
  check(`"${label}" reads as required`, REQUIRED_MARKER.test(label), true);
}
// Labels are short and do not use an asterisk for footnotes the way body text
// does, but the word must not be matched inside an unrelated one.
for (const label of ['Cover letter (Optional)', 'LinkedIn URL', 'Desired Pay',
  'References (Name, Company, and Contact Information)', 'Requirements you have read']) {
  check(`"${label}" is not marked required`, REQUIRED_MARKER.test(label), false);
}
