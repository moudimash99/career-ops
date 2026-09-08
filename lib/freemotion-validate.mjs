#!/usr/bin/env node

/**
 * freemotion-validate.mjs — Tier 3, the gate that runs before every advance.
 *
 * ── THE GATE IS COMPLETENESS, NOT REQUIRED-FIELD NON-EMPTINESS ────────────
 * The failure mode this exists to prevent is an application that reaches an
 * employer "incomplete, malformed, or visibly half-filled" (§4.4). An optional
 * field left blank because nothing marked it `[required]` is exactly that. So
 * this module looks at EVERY visible control, not just the required ones, and
 * diffs the live DOM against what Tier 1/2 intended to fill.
 *
 * The check that earns its keep is {@link evaluateValidation}'s
 * `unfilled-expected`: the difference between "we filled the form" and "the
 * form holds what we filled". A React controlled input that rejected the
 * write, a dropdown that closed without committing, an async re-render that
 * wiped a value — all of them look like success at fill time and like a
 * half-filled application to the employer.
 *
 * PURE. No browser, no network, no MCP call. This module never calls
 * `browser_evaluate` itself (§1.5/§2.2): it exports the script as a string,
 * `agy` makes the call, and hands the return value back here.
 *
 * ── THE ASYNC-RENDER GUARD ────────────────────────────────────────────────
 * "A page that looks empty might just not have rendered yet" is the bug named
 * in the requirements brief's Lessons, and Workday's resume-parse
 * carry-forward reproduces it on every posting: the CV upload asynchronously
 * back-fills work history seconds later. A single capture taken mid-settle
 * reports a dozen `empty-required` failures that fix themselves.
 * {@link reconcileCaptures} is the guard — two captures ~500ms apart, and
 * anything still moving between them is `settling`, never empty.
 *
 * Usage:
 *   node lib/freemotion-validate.mjs --script          # print the DOM script
 *   node lib/freemotion-validate.mjs --dom-json - --expected expected.json --attempted e7,e9
 *   node lib/freemotion-validate.mjs --captures -      # everything in one JSON doc
 */

import { readFileSync } from 'fs';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';

/**
 * Passed verbatim as the `function` string to `browser_evaluate`. Returns a
 * JSON-serializable object; `agy` makes that call and hands the return value
 * to {@link evaluateValidation} (via {@link reconcileCaptures}).
 *
 * The `name` fallback chain ends at `data-automation-id` and `id` because
 * Workday's generated markup carries no stable `name` — that fallback is the
 * whole reason Requirement 1 ("no vendor-specific code") survives contact with
 * a Workday tenant. Visibility is `offsetParent || getClientRects().length`
 * rather than a style read: `offsetParent` alone is null for `position: fixed`
 * elements, which is how modal dialogs are laid out.
 */
export const DOM_VALIDATION_SCRIPT = `() => {
  // An ARIA combobox that accepts several values keeps its committed values as
  // CHIPS in an adjacent listbox and leaves its own input empty. Reading only
  // el.value therefore reports a field the user has answered as unanswered —
  // on Thales/Workday (#594) that was every multiselect on the step, including
  // a required one, so a correctly-filled form could never advance.
  //
  // Generic, not vendor-specific: role="listbox" holding li chips is the ARIA
  // pattern. The open dropdown is excluded by skipping role="option" items, and
  // the walk stops at the control's OWN container (the nearest ancestor holding
  // exactly one control), so a field can never inherit its neighbour's chips.
  const selectedChips = (el) => {
    let node = el;
    for (let i = 0; i < 3 && node.parentElement; i++) {
      node = node.parentElement;
      const owned = node.querySelectorAll('input:not([type=hidden]), select, textarea');
      if (owned.length > 1) break;
      const chips = [...node.querySelectorAll('ul[role="listbox"] li, ul[aria-label*="selected" i] li')]
        .filter((li) => li.getAttribute('role') !== 'option')
        .map((li) => (li.textContent || '').trim())
        .filter(Boolean);
      if (chips.length) return chips.join(', ');
    }
    return '';
  };
  const controls = [...document.querySelectorAll(
    'input:not([type=hidden]), select, textarea, [contenteditable="true"],' +
    ' [role="checkbox"], [role="radio"], [role="combobox"], [role="listbox"]'
  )];
  const fields = controls.map((el) => ({
    name: el.getAttribute('name') || el.getAttribute('aria-label')
          || el.getAttribute('data-automation-id') || el.id || '',
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || el.getAttribute('role') || '',
    value: ('value' in el ? String(el.value ?? '') : (el.textContent || '').trim())
      || selectedChips(el),
    // Only where it MEANS something. Every <input> carries a .checked
    // property regardless of type, so testing mere presence stamped
    // checked:false onto every text box — and a consumer that reads it
    // before the value then sees every filled field as empty. Found live
    // on Thales/Workday (#594), where it failed a fully-filled step.
    checked: /^(checkbox|radio|switch)$/i.test(el.getAttribute('type') || el.getAttribute('role') || '')
      ? Boolean(el.checked) : undefined,
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    invalid: el.getAttribute('aria-invalid') === 'true',
    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    visible: !!(el.offsetParent || el.getClientRects().length),
  }));
  const alerts = [...document.querySelectorAll('[role="alert"]')]
    .filter((el) => el.offsetParent || el.getClientRects().length)
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean);
  return { fields, visibleAlerts: alerts, url: location.href, title: document.title };
}`;

/**
 * Every failure type this module can emit, in the order they are reported.
 * `blocking` is per-Failure, not per-type — `unfilled-optional` is the one
 * type that can be demoted (see {@link evaluateValidation}).
 */
export const FAILURE_TYPES = [
  'empty-required',
  'unfilled-expected',
  'value-mismatch',
  'unfilled-optional',
  'aria-invalid',
  'visible-alert',
  'unexpected-navigation',
];

/**
 * @typedef {Object} Failure
 * @property {'empty-required'|'unfilled-expected'|'value-mismatch'|'unfilled-optional'
 *           |'aria-invalid'|'visible-alert'|'unexpected-navigation'} type
 * @property {string} detail
 * @property {string} name    - the field's resolved name, '' when unknown.
 * @property {boolean} blocking
 */

/**
 * Normalize a value for comparison: trim, collapse internal whitespace, lower
 * case. Deliberately no smarter than that — see the sharp edge documented on
 * {@link evaluateValidation}'s `value-mismatch` branch.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A field's identity for matching across captures, against `expected`, and
 * against `attemptedRefs`. `name` when the DOM gave us one; otherwise the
 * control's position, which is stable between two captures 500ms apart but
 * carries no meaning beyond that.
 *
 * @param {object} field
 * @param {number} index
 * @returns {string}
 */
function fieldKey(field, index) {
  const name = String(field?.name ?? '').trim();
  if (name) return name.toLowerCase();
  return `#${index}:${String(field?.tag ?? '')}:${String(field?.type ?? '')}`;
}

/**
 * Is this control empty? A checkbox/radio is empty when unchecked; everything
 * else when its value trims to nothing.
 *
 * @param {object} field
 * @returns {boolean}
 */
function isEmptyField(field) {
  // `checked` decides ONLY for a control it can describe. Belt-and-braces with
  // the script's own guard above: a capture produced by an older copy of
  // DOM_VALIDATION_SCRIPT (or by hand) can still carry checked:false on a text
  // box, and trusting it there reports every filled field as empty.
  const kind = String(field?.type ?? '').toLowerCase();
  const isBooleanControl = kind === 'checkbox' || kind === 'radio' || kind === 'switch';
  if (isBooleanControl && typeof field?.checked === 'boolean') return !field.checked;
  return String(field?.value ?? '').trim() === '';
}

/**
 * The async-render guard. `agy` captures {@link DOM_VALIDATION_SCRIPT} TWICE,
 * ~500ms apart, and passes both. Any field whose value (or checked state)
 * differs between captures is still settling and is reported as `settling`,
 * never as empty — so a work-history block that Workday's resume parser is
 * mid-way through writing can never be reported as `empty-required`.
 *
 * A field present in only one of the two captures is settling too: the page is
 * adding or removing controls, which is the same "not done rendering yet"
 * condition seen from the other side.
 *
 * The later capture supplies `visibleAlerts`, `url` and `title`, since those
 * describe the page as it now stands rather than as it was 500ms ago.
 *
 * @param {object} captureA - the earlier capture.
 * @param {object} captureB - the later capture.
 * @returns {{stable: object, settling: string[]}} `stable` has the shape of one
 *   capture, containing only fields that agreed.
 */
export function reconcileCaptures(captureA, captureB) {
  const a = captureA && typeof captureA === 'object' ? captureA : {};
  const b = captureB && typeof captureB === 'object' ? captureB : {};
  const fieldsA = Array.isArray(a.fields) ? a.fields : [];
  const fieldsB = Array.isArray(b.fields) ? b.fields : [];

  const byKeyA = new Map(fieldsA.map((f, i) => [fieldKey(f, i), f]));
  const seenInB = new Set();

  const stableFields = [];
  const settling = [];
  const noteSettling = (field, key) => {
    const label = String(field?.name ?? '').trim() || key;
    if (!settling.includes(label)) settling.push(label);
  };

  fieldsB.forEach((fieldB, index) => {
    const key = fieldKey(fieldB, index);
    seenInB.add(key);
    const fieldA = byKeyA.get(key);
    if (!fieldA) {
      // Appeared between the captures — the page is still building itself.
      noteSettling(fieldB, key);
      return;
    }
    const sameValue = normalizeValue(fieldA.value) === normalizeValue(fieldB.value);
    const sameChecked = Boolean(fieldA.checked) === Boolean(fieldB.checked);
    if (sameValue && sameChecked) stableFields.push(fieldB);
    else noteSettling(fieldB, key);
  });

  // Disappeared between the captures — settling, and it cannot be validated
  // either way because it is no longer on the page.
  fieldsA.forEach((fieldA, index) => {
    const key = fieldKey(fieldA, index);
    if (!seenInB.has(key)) noteSettling(fieldA, key);
  });

  const stable = {
    fields: stableFields,
    visibleAlerts: Array.isArray(b.visibleAlerts) ? b.visibleAlerts : [],
    url: b.url ?? a.url ?? '',
    title: b.title ?? a.title ?? '',
  };
  return { stable, settling };
}

/**
 * Diff the settled DOM against what Tier 1/2 intended to fill, and decide
 * whether this step may advance.
 *
 * @param {{before: {url?: string, title?: string},
 *          after: {fields?: object[], visibleAlerts?: string[], url?: string, title?: string}}} snapshot
 *   `after` is {@link reconcileCaptures}'s `stable`.
 * @param {{expected?: {ref: string, name: string, value: string}[],
 *          attemptedRefs?: string[], expectedAdvance?: boolean}} [options]
 *   `expected` — every field Tier 1's fillPlan and Tier 2's answers intended to
 *     fill this step, with the value each was given.
 *   `attemptedRefs` — refs `agy` has already tried to fill on this step. Used
 *     only to demote a stubborn `unfilled-optional`.
 *   `expectedAdvance` — true when a Next/Submit click was just made on purpose,
 *     so a URL change is the goal rather than a surprise.
 * @returns {{valid: boolean, failures: Failure[]}}
 */
export function evaluateValidation(snapshot, options = {}) {
  const before = snapshot?.before ?? {};
  const after = snapshot?.after ?? {};
  const fields = Array.isArray(after.fields) ? after.fields : [];
  const alerts = Array.isArray(after.visibleAlerts) ? after.visibleAlerts : [];

  const expected = Array.isArray(options.expected) ? options.expected : [];
  const attemptedRefs = new Set(
    (Array.isArray(options.attemptedRefs) ? options.attemptedRefs : []).map((r) => String(r)),
  );
  const expectedByName = new Map(
    expected
      .filter((e) => String(e?.name ?? '').trim())
      .map((e) => [String(e.name).trim().toLowerCase(), e]),
  );

  /** @type {Failure[]} */
  const failures = [];
  const add = (type, name, detail, blocking) => failures.push({ type, detail, name, blocking });

  fields.forEach((field, index) => {
    const name = String(field?.name ?? '');
    if (!field?.visible || field?.disabled) return;

    const key = fieldKey(field, index);
    const want = expectedByName.get(key);
    const empty = isEmptyField(field);

    if (empty) {
      if (want) {
        // The most important check in this module: we sent a value and the DOM
        // does not hold it. Reported ahead of `empty-required` because it says
        // something `empty-required` does not — that the write itself failed.
        const alsoRequired = field.required ? ' (also a required field)' : '';
        add('unfilled-expected', name,
          `intended value "${want.value}" did not stick${alsoRequired}`, true);
      } else if (field.required) {
        add('empty-required', name, 'required field is empty', true);
      } else {
        // Requirement 5: the run answers it rather than leaving it blank, so
        // this blocks — `agy` routes it back through the answer resolver like
        // any other unanswered field. Demoted once its ref has been attempted,
        // so a genuinely inert or conditionally-inapplicable field cannot
        // deadlock the posting. Every demotion is logged (§4.8).
        const ref = field.ref === undefined || field.ref === null ? '' : String(field.ref);
        const attempted = (ref !== '' && attemptedRefs.has(ref)) || (name !== '' && attemptedRefs.has(name));
        add('unfilled-optional', name,
          attempted
            ? 'optional field still empty after an attempted fill — demoted, not blocking'
            : 'optional field nobody planned to fill is empty',
          !attempted);
      }
    } else if (want && normalizeValue(field.value) !== normalizeValue(want.value)) {
      // Catches a value landing in the wrong box and a dropdown committing a
      // neighbouring option. Sharp edge, documented rather than papered over:
      // a `<select>`'s `value` is the option's value attribute, which is often
      // a code ("FR") where the intended value was a label ("France"). Record
      // in `expected` the value actually sent to the control, not the label a
      // human would read, or this fires on every select.
      add('value-mismatch', name,
        `expected "${want.value}", DOM holds "${field.value}"`, true);
    }

    if (field.invalid === true) {
      add('aria-invalid', name, 'field is marked aria-invalid', true);
    }
  });

  alerts.forEach((alert) => {
    const text = String(alert ?? '').trim();
    if (text) add('visible-alert', '', text, true);
  });

  if (!options.expectedAdvance && before.url && after.url && before.url !== after.url) {
    add('unexpected-navigation', '', `${before.url} -> ${after.url}`, true);
  }

  return { valid: failures.every((f) => !f.blocking), failures };
}

const USAGE = `Usage:
  node lib/freemotion-validate.mjs --script
  node lib/freemotion-validate.mjs --dom-json <file|-> [--expected <file>]
                                   [--attempted <ref,ref>] [--expected-advance]
  node lib/freemotion-validate.mjs --captures <file|->

--script     print DOM_VALIDATION_SCRIPT, the function string to hand to
             browser_evaluate. This module never makes that call itself.

--dom-json   the two browser_evaluate captures plus the page you started from:
               { "before": { "url": "...", "title": "..." },
                 "captureA": { ...first return... },
                 "captureB": { ...second, ~500ms later... } }
             A bare capture object (no "captureA") is accepted and treated as
             both captures — no settling detection, so prefer two.
--expected   a JSON array of what this step intended to fill:
               [ { "ref": "e1", "name": "email", "value": "..." } ]
             Record the value actually sent to the control, not the label a
             human reads, or every <select> reports a value-mismatch.
--attempted  comma-separated refs (or field names) already tried on this step.
             Demotes a stubborn unfilled-optional so an inert field cannot
             deadlock the posting.
--expected-advance
             a Next/Submit click was just made on purpose, so a URL change is
             the goal rather than a surprise.

--captures   the same inputs as one JSON document, with "expected",
             "attemptedRefs" and "expectedAdvance" alongside the captures.

Prints { settling, valid, failures } as JSON. Exit 1 when invalid.`;

const VALUE_FLAGS = ['--captures', '--dom-json', '--expected', '--attempted'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--script', '--expected-advance', '--help', '-h'];

/**
 * Read a JSON document from a file path, or from stdin when the path is `-` —
 * which is how `agy` pipes a `browser_evaluate` return straight in without
 * staging it through a file.
 *
 * @param {string} arg
 * @returns {unknown}
 */
function readJsonArg(arg) {
  return JSON.parse(arg === '-' ? readFileSync(0, 'utf-8') : readFileSync(arg, 'utf-8'));
}

/**
 * CLI entry.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (hasFlag(argv, '--script')) {
    console.log(DOM_VALIDATION_SCRIPT);
    return;
  }

  const capturesArg = flagValue(argv, '--captures');
  const domJsonArg = flagValue(argv, '--dom-json');
  if (!capturesArg === !domJsonArg) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const input = readJsonArg(capturesArg ?? domJsonArg);
  // A bare capture (the object browser_evaluate returned, with no wrapper) is
  // accepted so a quick one-off check does not need a wrapper written by hand.
  const captureA = input.captureA ?? (Array.isArray(input.fields) ? input : undefined);
  const captureB = input.captureB ?? captureA;

  const expectedArg = flagValue(argv, '--expected');
  const attemptedArg = flagValue(argv, '--attempted');
  const options = {
    expected: expectedArg ? readJsonArg(expectedArg) : input.expected,
    attemptedRefs: attemptedArg
      ? attemptedArg.split(',').map((r) => r.trim()).filter(Boolean)
      : input.attemptedRefs,
    expectedAdvance: hasFlag(argv, '--expected-advance') || Boolean(input.expectedAdvance),
  };

  const { stable, settling } = reconcileCaptures(captureA, captureB);
  const result = evaluateValidation({ before: input.before ?? {}, after: stable }, options);

  console.log(JSON.stringify({ settling, ...result }, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
