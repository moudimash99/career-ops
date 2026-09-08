// tests/freemotion-validate.test.mjs — Tier 3, the gate before every advance.
//
// The assertion that matters most is `unfilled-expected`: a value we wrote that
// the DOM does not hold. Every other check here answers "is the form complete";
// that one answers "did our own writes survive", which is the difference
// between a submitted application and a half-filled one that looked fine at
// fill time.
//
// The second is `reconcileCaptures`: Workday's resume parser back-fills work
// history asynchronously, so a single capture taken mid-settle reports a dozen
// empty required fields that fix themselves a moment later. Anything still
// moving between two captures is `settling`, never empty.
//
// Run: node test-all.mjs --only freemotion-validate

import { pass, fail, run, rmSync, NODE, ROOT } from './helpers.mjs';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-validate — Tier 3 completeness gate');

const { evaluateValidation, reconcileCaptures, DOM_VALIDATION_SCRIPT, FAILURE_TYPES } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-validate.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const base = { before: { url: 'https://x.com/apply', title: 'Apply' } };
const after = (fields, extra = {}) => ({
  ...base,
  after: { fields, visibleAlerts: [], url: 'https://x.com/apply', title: 'Apply', ...extra },
});
const typesOf = (r) => r.failures.map((f) => f.type);

// ── 1. empty required field ───────────────────────────────────────────────
let r = evaluateValidation(after([
  { name: 'email', tag: 'input', value: '', required: true, visible: true, disabled: false },
]));
check('an empty required field is invalid', r.valid, false);
check('  ...reported as empty-required on that field',
  r.failures.some((f) => f.type === 'empty-required' && f.name === 'email'), true);

// ── 2. a value we filled did not stick ────────────────────────────────────
r = evaluateValidation(
  after([{ name: 'phone', tag: 'input', value: '', required: false, visible: true, disabled: false }]),
  { expected: [{ ref: 'e9', name: 'phone', value: '+33600000000' }] },
);
check('a filled value that did not stick is unfilled-expected',
  r.failures.some((f) => f.type === 'unfilled-expected' && f.name === 'phone'), true);
check('  ...and it blocks, even though the field is optional', r.valid, false);
check('  ...and it is NOT double-reported as unfilled-optional',
  r.failures.some((f) => f.type === 'unfilled-optional'), false);

// A required field we tried to fill reports the write failure, not the
// generic emptiness — the two mean different things to whoever reads the log.
r = evaluateValidation(
  after([{ name: 'email', tag: 'input', value: '', required: true, visible: true, disabled: false }]),
  { expected: [{ ref: 'e1', name: 'email', value: 'jane@example.com' }] },
);
check('a required field we wrote to reports unfilled-expected, not empty-required',
  typesOf(r), ['unfilled-expected']);
check('  ...and says so in the detail',
  /also a required field/.test(r.failures[0].detail), true);

// ── 3. a value landed, but not the one we sent ────────────────────────────
r = evaluateValidation(
  after([{ name: 'country', tag: 'select', value: 'Francia', required: false, visible: true, disabled: false }]),
  { expected: [{ ref: 'e4', name: 'country', value: 'France' }] },
);
check('a neighbouring dropdown option is a value-mismatch',
  r.failures.some((f) => f.type === 'value-mismatch' && f.name === 'country'), true);
check('  ...it blocks', r.valid, false);

// Normalization: trim, collapse whitespace, case. A value that differs only
// that way is the same value, and firing here would deadlock every posting.
r = evaluateValidation(
  after([{ name: 'city', tag: 'input', value: '  Toulouse,   France ', required: false, visible: true, disabled: false }]),
  { expected: [{ ref: 'e5', name: 'city', value: 'toulouse, france' }] },
);
check('whitespace/case differences are not a mismatch', r.failures, []);

// ── 4. optional field nobody planned: blocking, then demoted ──────────────
const optional = after([
  { name: 'cover_letter', tag: 'textarea', value: '', required: false, visible: true, disabled: false, ref: 'e7' },
]);
check('an unplanned empty optional field blocks on first sight',
  evaluateValidation(optional).valid, false);
check('  ...as unfilled-optional',
  typesOf(evaluateValidation(optional)), ['unfilled-optional']);
check('  ...demoted to non-blocking once its ref was attempted',
  evaluateValidation(optional, { attemptedRefs: ['e7'] }).valid, true);
check('  ...but still reported, so the demotion is loggable (§4.8)',
  typesOf(evaluateValidation(optional, { attemptedRefs: ['e7'] })), ['unfilled-optional']);
check('  ...another field\'s ref does not demote it',
  evaluateValidation(optional, { attemptedRefs: ['e2'] }).valid, false);
// The DOM script emits no `ref` (it reads the DOM, not the a11y tree), so a
// field agy attempted by name must be demotable by name too, or every
// name-addressed field deadlocks.
check('  ...a ref-less field is demotable by name',
  evaluateValidation(
    after([{ name: 'cover_letter', tag: 'textarea', value: '', required: false, visible: true, disabled: false }]),
    { attemptedRefs: ['cover_letter'] },
  ).valid, true);

// ── 5. fully filled, no drift -> clean pass ───────────────────────────────
r = evaluateValidation(
  after([{ name: 'email', tag: 'input', value: 'jane@example.com', required: true, visible: true, disabled: false }]),
  { expected: [{ ref: 'e1', name: 'email', value: 'jane@example.com' }] },
);
check('a fully filled step passes with zero failures', [r.valid, r.failures.length], [true, 0]);

// ── The remaining failure types ───────────────────────────────────────────
r = evaluateValidation(after([
  { name: 'email', tag: 'input', value: 'nope', required: true, visible: true, disabled: false, invalid: true },
]));
check('aria-invalid blocks even when the field holds a value',
  [typesOf(r), r.valid], [['aria-invalid'], false]);

r = evaluateValidation(after([], { visibleAlerts: ['Please correct the errors below', ''] }));
check('each non-empty visible alert is one blocking failure',
  r.failures.map((f) => [f.type, f.detail]),
  [['visible-alert', 'Please correct the errors below']]);

r = evaluateValidation(after([], { url: 'https://x.com/apply/step2' }));
check('an unrequested URL change is unexpected-navigation',
  r.failures.map((f) => [f.type, f.detail]),
  [['unexpected-navigation', 'https://x.com/apply -> https://x.com/apply/step2']]);
check('  ...and is not a failure when we clicked Next on purpose',
  evaluateValidation(after([], { url: 'https://x.com/apply/step2' }), { expectedAdvance: true }).valid, true);

// Fields we cannot act on are not failures: a hidden or disabled control is
// not something the run can fill, and reporting it deadlocks the posting.
r = evaluateValidation(after([
  { name: 'hidden_ref', tag: 'input', value: '', required: true, visible: false, disabled: false },
  { name: 'locked', tag: 'input', value: '', required: true, visible: true, disabled: true },
]));
check('invisible and disabled controls are skipped entirely', [r.valid, r.failures], [true, []]);

// A checkbox is empty when unchecked, not when its value string is blank —
// consent boxes carry value="on" whether or not they are ticked.
r = evaluateValidation(after([
  { name: 'consent', tag: 'input', type: 'checkbox', value: 'on', checked: false, required: true, visible: true, disabled: false },
]));
check('an unticked required checkbox is empty-required', typesOf(r), ['empty-required']);
r = evaluateValidation(after([
  { name: 'consent', tag: 'input', type: 'checkbox', value: 'on', checked: true, required: true, visible: true, disabled: false },
]));
check('  ...and a ticked one is clean', [r.valid, r.failures.length], [true, 0]);

check('every emitted type is declared in FAILURE_TYPES',
  FAILURE_TYPES.length, 7);

// ── reconcileCaptures: the async-render guard ─────────────────────────────
const capA = {
  fields: [
    { name: 'email', tag: 'input', value: 'jane@example.com', required: true, visible: true, disabled: false },
    { name: 'work_history_0', tag: 'input', value: '', required: true, visible: true, disabled: false },
  ],
  visibleAlerts: [], url: 'https://x.com/apply', title: 'Apply',
};
const capB = {
  fields: [
    { name: 'email', tag: 'input', value: 'jane@example.com', required: true, visible: true, disabled: false },
    { name: 'work_history_0', tag: 'input', value: 'Acme Corp', required: true, visible: true, disabled: false },
  ],
  visibleAlerts: [], url: 'https://x.com/apply', title: 'Apply',
};
const { stable, settling } = reconcileCaptures(capA, capB);
check('a field still changing between captures is settling', settling, ['work_history_0']);
check('  ...and is absent from stable, so it can never be empty-required',
  stable.fields.map((f) => f.name), ['email']);
check('  ...which the gate then passes',
  evaluateValidation({ ...base, after: stable }).valid, true);
check('  ...where a single mid-settle capture would have failed it',
  evaluateValidation({ ...base, after: capA }).valid, false);

// A control that appears (or vanishes) between captures is the same condition
// seen from the other side: the page is not done building itself.
const appeared = reconcileCaptures(
  { fields: [], visibleAlerts: [], url: 'https://x.com/apply' },
  { fields: [{ name: 'salary', tag: 'input', value: '', visible: true }], visibleAlerts: [], url: 'https://x.com/apply' },
);
check('a control that appeared between captures is settling', appeared.settling, ['salary']);
const vanished = reconcileCaptures(
  { fields: [{ name: 'salary', tag: 'input', value: '', visible: true }], visibleAlerts: [], url: 'https://x.com/apply' },
  { fields: [], visibleAlerts: [], url: 'https://x.com/apply' },
);
check('a control that vanished between captures is settling too', vanished.settling, ['salary']);

// The later capture describes the page as it now stands.
check('stable takes url/title/alerts from the later capture',
  reconcileCaptures(
    { fields: [], url: 'https://x.com/apply', title: 'Apply', visibleAlerts: ['stale'] },
    { fields: [], url: 'https://x.com/apply/step2', title: 'Step 2', visibleAlerts: ['fresh'] },
  ).stable,
  { fields: [], visibleAlerts: ['fresh'], url: 'https://x.com/apply/step2', title: 'Step 2' });

// ── The DOM script is a string this module never runs itself (§1.5/§2.2) ──
check('DOM_VALIDATION_SCRIPT is an arrow-function string', typeof DOM_VALIDATION_SCRIPT, 'string');
check('  ...it is syntactically valid JS', (() => {
  try { new Function(`return (${DOM_VALIDATION_SCRIPT});`); return true; } catch { return false; }
})(), true);
check('  ...it falls back to data-automation-id for Workday\'s nameless markup',
  /data-automation-id/.test(DOM_VALIDATION_SCRIPT), true);
check('  ...and this module never calls browser_evaluate itself',
  /browser_evaluate\s*\(/.test(
    (await import('fs')).readFileSync(join(ROOT, 'lib/freemotion-validate.mjs'), 'utf-8'),
  ), false);

// ── CLI ───────────────────────────────────────────────────────────────────
const script = run(NODE, ['lib/freemotion-validate.mjs', '--script']);
check('--script prints the DOM script', script.startsWith('() => {'), true);

const cliInput = JSON.stringify({
  before: { url: 'https://x.com/apply', title: 'Apply' },
  captureA: capA,
  captureB: capB,
  expected: [{ ref: 'e1', name: 'email', value: 'jane@example.com' }],
});
const cliOut = JSON.parse(run(NODE, ['lib/freemotion-validate.mjs', '--captures', '-'], { input: cliInput }));
check('--captures reconciles both captures then validates',
  [cliOut.settling, cliOut.valid, cliOut.failures.length], [['work_history_0'], true, 0]);

// The form modes/apply-freemotion.md tells the orchestrator to call: captures
// on stdin, expected in a file, attempted refs as a list. If these two forms
// disagree, the mode file is the one that breaks in a live run.
const tmp = mkdtempSync(join(tmpdir(), 'fm-validate-'));
const expectedPath = join(tmp, 'expected.json');
writeFileSync(expectedPath, JSON.stringify([{ ref: 'e1', name: 'email', value: 'jane@example.com' }]));
const domInput = JSON.stringify({ before: { url: 'https://x.com/apply' }, captureA: capA, captureB: capB });
const domOut = JSON.parse(run(NODE,
  ['lib/freemotion-validate.mjs', '--dom-json', '-', '--expected', expectedPath], { input: domInput }));
check('--dom-json + --expected is the same verdict as --captures',
  [domOut.settling, domOut.valid], [['work_history_0'], true]);

// An unfilled optional field blocks; the same call with its ref in --attempted
// clears — the deadlock escape the mode file relies on.
const optionalCapture = {
  fields: [{ name: 'cover_letter', tag: 'textarea', value: '', required: false, visible: true, disabled: false, ref: 'e7' }],
  visibleAlerts: [], url: 'https://x.com/apply', title: 'Apply',
};
const optionalInput = JSON.stringify({ before: { url: 'https://x.com/apply' }, captureA: optionalCapture });
check('a bare capture with an unplanned empty field exits non-zero',
  run(NODE, ['lib/freemotion-validate.mjs', '--dom-json', '-'], { input: optionalInput }), null);
check('  ...and clears once --attempted names its ref',
  JSON.parse(run(NODE, ['lib/freemotion-validate.mjs', '--dom-json', '-', '--attempted', 'e7,e9'],
    { input: optionalInput })).valid, true);

check('passing both --dom-json and --captures is a usage error',
  run(NODE, ['lib/freemotion-validate.mjs', '--dom-json', '-', '--captures', '-'], { input: domInput }), null);

rmSync(tmp, { recursive: true, force: true });

// ── Found live on Thales/Workday, report #594 (Phase 8 smoke test) ─────────
// DOM_VALIDATION_SCRIPT used to stamp `checked` onto EVERY input, because every
// <input> carries a .checked property whatever its type. isEmptyField consulted
// `checked` before `value`, so a fully-filled text box arrived as
// {value: 'Mohammad', checked: false} and was reported empty. On the real form
// that was 4 filled fields failing the gate — a step that could never advance.
//
// The fixtures above never caught it because a hand-written field omits
// `checked`; the real script never does. So this case is written the way the
// browser actually produces it.

const asBrowserProduces = (over) => ({
  name: 'legalName--firstName', tag: 'input', type: 'text',
  value: 'Mohammad', checked: false, required: true,
  invalid: false, disabled: false, visible: true, ...over,
});

r = evaluateValidation(after([asBrowserProduces()]));
check('a filled text input carrying checked:false is NOT empty',
  [r.valid, r.failures], [true, []]);

r = evaluateValidation(after([
  asBrowserProduces(),
  asBrowserProduces({ name: 'emailAddress', value: 'm@example.com' }),
  asBrowserProduces({ name: 'postalCode', value: '31000', required: false }),
]));
check('  ...nor are three of them', [r.valid, r.failures.length], [true, 0]);

// The genuine empty still fails, so the fix did not just disable the check.
r = evaluateValidation(after([asBrowserProduces({ name: 'source--source', value: '' })]));
check('an actually-empty required field still blocks', typesOf(r), ['empty-required']);

// A real checkbox keeps using `checked`, which is the whole point of the field.
r = evaluateValidation(after([
  { name: 'preferredCheck', tag: 'input', type: 'checkbox', value: 'on', checked: false,
    required: true, visible: true, disabled: false },
]));
check('an unticked checkbox is still empty-required despite value="on"',
  typesOf(r), ['empty-required']);
r = evaluateValidation(after([
  { name: 'preferredCheck', tag: 'input', type: 'checkbox', value: 'on', checked: true,
    required: true, visible: true, disabled: false },
]));
check('  ...and a ticked one still passes', [r.valid, r.failures.length], [true, 0]);

// The script itself must no longer emit `checked` for a text input.
check('DOM_VALIDATION_SCRIPT gates `checked` on the control type',
  /checkbox\|radio\|switch/.test(DOM_VALIDATION_SCRIPT), true);
check('  ...and no longer tests for the property\'s mere presence',
  /'checked' in el/.test(DOM_VALIDATION_SCRIPT), false);
