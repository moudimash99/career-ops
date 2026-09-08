// tests/freemotion-fillplan.test.mjs — the write side of form filling.
//
// Requirement 1 says "any employer's site, no vendor-specific code". The read
// side has been generic for a while; the write side was a script hand-written
// per ATS, six of them in one night, each re-deriving the same mechanics and
// each free to forget one. This suite pins the mechanics that a forgotten rule
// broke on a live run:
//
//   - an ARIA combobox planned as a text fill (typing filters, never commits)
//   - a consent pair planned before the field it disables
//   - a resume parser planned after the fields it overwrites
//   - two cascading picklists planned in one batch, the second target already
//     re-rendered away
//
// Every fixture is described by its SHAPE, never by which vendor shipped it,
// because a plan builder that recognises vendors is the thing this replaces.
//
// Run: node test-all.mjs --only freemotion-fillplan

import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-fillplan — an ordered plan instead of an improvised script');

const mod = await import(pathToFileURL(join(ROOT, 'lib/freemotion-fillplan.mjs')).href);
const { buildFillPlan, phaseOf, opFor, matchAnswer, resolveChoice, OPS, PHASES } = mod;

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};
const ok = (label, cond) => (cond ? pass(label) : fail(label));

// --------------------------------------------------------- op classification

check('a plain text input is a single fill',
  opFor({ kind: 'field', role: 'textbox', tag: 'input' }), 'fill');

check('a textarea is a single fill',
  opFor({ kind: 'field', role: 'textbox', tag: 'textarea' }), 'fill');

check('a native select takes a value directly',
  opFor({ kind: 'field', role: 'combobox', tag: 'select', options: ['A', 'B'] }), 'select_option');

// The live failure: typing into an ARIA combobox filters its list and leaves
// the field with no committed value, so it reads back empty and fails
// validation with the field visibly full.
check('an ARIA combobox must be expanded and clicked, never filled',
  opFor({ kind: 'field', role: 'combobox', tag: 'input' }), 'expand_then_pick');

check('an ARIA combobox with options already read is still expand_then_pick',
  opFor({ kind: 'field', role: 'combobox', tag: 'input', options: ['Yes', 'No'] }), 'expand_then_pick');

check('a multi-select is a native select',
  opFor({ kind: 'field', role: 'listbox', tag: 'select', options: ['A'] }), 'select_option');

check('a standalone checkbox is a real click',
  opFor({ kind: 'field', role: 'checkbox', tag: 'input' }), 'click');

check('a radio group is a real click',
  opFor({ kind: 'group', role: 'radio' }), 'click');

check('an upload is the upload op', opFor({ kind: 'upload' }), 'upload');

ok('every op names the MCP call that performs it',
  Object.values(OPS).every((v) => /browser_/.test(v)));

// ------------------------------------------------------------------- phasing

check('a plain field is text phase',
  phaseOf({ kind: 'field', role: 'textbox', question: 'First name' }), 'text');

check('a consent checkbox is consent phase',
  phaseOf({ kind: 'field', role: 'checkbox', question: 'I agree to the privacy policy' }), 'consent');

check('a French consent line is recognised too',
  phaseOf({ kind: 'field', role: 'checkbox', question: "J'accepte la politique de confidentialite" }), 'consent');

check('a long picklist is a cascade parent',
  phaseOf({ kind: 'field', role: 'combobox', tag: 'select', question: 'Country', options: Array.from({ length: 200 }, (_, i) => `C${i}`) }), 'cascade');

check('a collapsed combobox with unknown options is assumed to cascade',
  phaseOf({ kind: 'field', role: 'combobox', tag: 'input', question: 'City' }), 'cascade');

check('a short picklist is an ordinary choice, not a cascade',
  phaseOf({ kind: 'field', role: 'combobox', tag: 'select', question: 'Gender', options: ['Male', 'Female'] }), 'choice');

check('phases run autofill-upload first and consent last',
  [PHASES[0], PHASES[PHASES.length - 1]], ['autofill-upload', 'consent']);

// -------------------------------------------------------- answer matching

const answers = [
  { question: 'Email', value: 'a@b.co' },
  { question: 'gender', choices: ['Male', 'Homme', 'M'] },
  { question: 'years of experience', value: '6' },
];

check('an exact question matches', matchAnswer({ question: 'Email' }, answers).value, 'a@b.co');

// Rendered labels carry decoration an answer key never has.
check('a required star and case do not break the match',
  matchAnswer({ question: 'EMAIL *' }, answers).value, 'a@b.co');

check('a longer rendered question matches a short answer key',
  matchAnswer({ question: 'How many years of experience do you have?' }, answers).value, '6');

check('an unrelated question matches nothing',
  matchAnswer({ question: 'Shoe size' }, answers), null);

check('a blank question matches nothing', matchAnswer({ question: '' }, answers), null);

// A two-character key would match almost any question by containment.
check('a very short answer key does not match by containment',
  matchAnswer({ question: 'Nationality' }, [{ question: 'ty', value: 'x' }]), null);

// ------------------------------------------------------------ choice ranking

// One rule, many renderings: this is what keeps the answers file free of
// per-site variants.
check('a ranked list picks the label this form actually offers',
  resolveChoice({ options: ['Homme', 'Femme'] }, { choices: ['Male', 'Homme', 'M'] }).value, 'Homme');

check('the first matching rank wins over a later one',
  resolveChoice({ options: ['Male', 'Homme'] }, { choices: ['Homme', 'Male'] }).value, 'Homme');

check('matching is case- and whitespace-insensitive',
  resolveChoice({ options: ['  MALE '] }, { choices: ['Male'] }).value, '  MALE ');

check('a partial option label still matches',
  resolveChoice({ options: ['Male / Homme'] }, { choices: ['Male'] }).value, 'Male / Homme');

check('an unknown option list passes the ranking through unmatched',
  resolveChoice({}, { choices: ['Male', 'Homme'] }), { value: 'Male', ranked: ['Male', 'Homme'], matched: false });

check('nothing in the ranking matching is reported, not guessed',
  resolveChoice({ options: ['Yes', 'No'] }, { choices: ['Male'] }).matched, false);

// ------------------------------------------------------------ the whole plan

const inventory = {
  fields: [
    { selector: '#first', label: 'First name', role: 'textbox', tag: 'input', required: true, visible: true, value: '' },
    { selector: '#country', label: 'Country', role: 'combobox', tag: 'select', required: true, visible: true, value: '',
      options: Array.from({ length: 60 }, (_, i) => (i === 3 ? 'France' : `C${i}`)) },
    { selector: '#city', label: 'City', role: 'combobox', tag: 'input', required: true, visible: true, value: '' },
    { selector: '#consent', label: 'I consent to the processing of my data', role: 'checkbox', tag: 'input',
      required: true, visible: true, checked: false },
    { selector: '#linkedin', label: 'LinkedIn', role: 'textbox', tag: 'input', required: false, visible: true, value: '' },
    { selector: '#hidden', label: 'Hidden', role: 'textbox', tag: 'input', required: true, visible: false, value: '' },
  ],
  groups: [
    { group: 'gender', question: 'Gender', role: 'radio', required: true, visible: true, answered: false,
      options: [{ label: 'Male', selector: '#g-m' }, { label: 'Female', selector: '#g-f' }, { label: 'Prefer not to say', selector: '#g-n' }] },
  ],
  uploads: [
    { selector: '#parse', label: 'Upload your CV to autofill this application', triggerText: 'Autofill',
      hiddenInput: true, triggerSelector: '#parse-btn', required: false, filled: false },
    { selector: '#resume', label: 'Resume', triggerText: 'Attach', hiddenInput: true, triggerSelector: '#resume-btn',
      required: true, filled: false },
  ],
  errors: [],
};

const planAnswers = [
  { question: 'First name', value: 'Mohammad' },
  { question: 'Country', choices: ['France'] },
  { question: 'City', value: 'Toulouse' },
  { question: 'Gender', choices: ['Male', 'Homme', 'M'] },
  { question: 'LinkedIn', value: 'https://linkedin.com/in/x' },
  { question: 'I consent to the processing of my data', value: 'Yes' },
  { question: 'Upload your CV to autofill this application', file: '/cv.pdf' },
  { question: 'Resume', file: '/cv.pdf' },
];

const plan = buildFillPlan(inventory, planAnswers);
const phases = plan.actions.map((a) => a.phase);
const rank = (p) => phases.indexOf(p);

// The resume parser rewrites every field it recognises, so a plan that runs it
// after the text phase silently discards that work.
check('the autofilling upload runs before anything it can overwrite',
  phases[0], 'autofill-upload');

// Answering one half of a mutually-exclusive consent disables the other, which
// a plan built earlier still lists as an open question.
check('the consent runs last', phases[phases.length - 1], 'consent');

ok('cascading picklists come before the text that depends on them',
  rank('cascade') < rank('text'));

ok('an invisible required field is not planned',
  !plan.actions.some((a) => a.target === '#hidden'));

ok('an optional field is planned too — a form is done when a human would say so',
  plan.actions.some((a) => a.target === '#linkedin'));

check('the country pick resolves to the label this form offers',
  plan.actions.find((a) => a.question === 'Country').value, 'France');

check('a radio group targets the chosen option, not the group',
  plan.actions.find((a) => a.question === 'Gender').target, '#g-m');

// The default in the config file was "Prefer not to say" and it was wrong on a
// real application that cannot be taken back.
check('gender resolves to Male, never to the decline option',
  plan.actions.find((a) => a.question === 'Gender').value, 'Male');

check('an upload targets the visible trigger, not the tiny input behind it',
  plan.actions.filter((a) => a.op === 'upload').map((a) => a.target), ['#parse-btn', '#resume-btn']);

check('the city combobox is expanded and clicked',
  plan.actions.find((a) => a.question === 'City').op, 'expand_then_pick');

check('a text action carries its slow-typing retry',
  plan.actions.find((a) => a.question === 'First name').retryOp, 'type_slow');

check('a consent action says how to verify its partner went quiet',
  /disabled/.test(plan.actions.find((a) => a.phase === 'consent').verify || ''), true);

check('the cascade count tells the caller how many one-at-a-time steps there are',
  plan.counts.cascadeOneAtATime, 2);

check('nothing is left unanswered when every question has an answer',
  [plan.counts.unanswered, plan.counts.noOptionMatch], [0, 0]);

// ------------------------------------------------------- gaps are reported

const gapPlan = buildFillPlan(inventory, [{ question: 'First name', value: 'Mohammad' }]);
ok('a question with no answer is reported, never invented',
  gapPlan.unanswered.some((u) => u.question === 'Gender'));
ok('an upload with no file is reported rather than skipped silently',
  gapPlan.unanswered.some((u) => u.question === 'Resume'));
ok('no action is emitted for an unanswered question',
  gapPlan.actions.every((a) => a.question === 'First name'));

const mismatch = buildFillPlan(
  { fields: [], groups: [{ group: 'g', question: 'Gender', role: 'radio', required: true, visible: true, answered: false,
    options: [{ label: 'Woman', selector: '#w' }, { label: 'Non-binary', selector: '#nb' }] }], uploads: [] },
  [{ question: 'Gender', choices: ['Male', 'Homme'] }],
);
check('a ranking that matches none of the offered labels is reported, not forced',
  [mismatch.counts.actions, mismatch.noOptionMatch.length], [0, 1]);
check('the report says what was wanted and what was on offer',
  [mismatch.noOptionMatch[0].wanted, mismatch.noOptionMatch[0].available],
  [['Male', 'Homme'], ['Woman', 'Non-binary']]);

const emptyAnswer = buildFillPlan(
  { fields: [{ selector: '#x', label: 'Phone', role: 'textbox', tag: 'input', required: true, visible: true, value: '' }], groups: [], uploads: [] },
  [{ question: 'Phone', value: '' }],
);
check('an answer that resolves to empty is a gap, not a blank fill',
  [emptyAnswer.counts.actions, emptyAnswer.unanswered[0].reason], [0, 'answer resolved to empty']);

// --------------------------------------------------------------- edge cases

check('an empty inventory plans nothing and reports nothing',
  buildFillPlan({}, []).counts, { actions: 0, unanswered: 0, noOptionMatch: 0, cascadeOneAtATime: 0 });

check('a null inventory does not throw', buildFillPlan(null, []).counts.actions, 0);

check('required-only mode drops the optional field',
  buildFillPlan(inventory, planAnswers, { includeOptional: false }).actions.some((a) => a.target === '#linkedin'), false);

check('required-only mode still plans the required upload',
  buildFillPlan(inventory, planAnswers, { includeOptional: false }).actions.some((a) => a.target === '#resume-btn'), true);

// A resume path given once should not have to be repeated per upload field.
check('a resume path is used for a resume upload with no explicit answer',
  buildFillPlan({ fields: [], groups: [], uploads: [{ selector: '#r', label: 'CV', hiddenInput: false, required: true, filled: false }] },
    [], { resumePath: '/cv.pdf' }).actions[0].file, '/cv.pdf');

check('an already-filled upload is not planned again',
  buildFillPlan({ fields: [], groups: [], uploads: [{ selector: '#r', label: 'CV', required: true, filled: true }] },
    [], { resumePath: '/cv.pdf' }).counts.actions, 0);

check('a disabled field is not planned',
  buildFillPlan({ fields: [{ selector: '#d', label: 'X', role: 'textbox', tag: 'input', visible: true, disabled: true, value: '' }], groups: [], uploads: [] },
    [{ question: 'X', value: 'y' }]).counts.actions, 0);

check('an already-answered field is not planned again',
  buildFillPlan({ fields: [{ selector: '#a', label: 'X', role: 'textbox', tag: 'input', visible: true, value: 'already' }], groups: [], uploads: [] },
    [{ question: 'X', value: 'y' }]).counts.actions, 0);

// No vendor may leak back into the plan builder.
const src = readFileSync(join(ROOT, 'lib/freemotion-fillplan.mjs'), 'utf-8');
const vendors = ['greenhouse', 'workday', 'lever', 'ashby', 'workable', 'icims', 'smartrecruiters', 'successfactors', 'radancy', 'taleo'];
check('no ATS vendor is named in the plan builder',
  vendors.filter((v) => new RegExp(v, 'i').test(src)), []);

// ------------------------------- a hidden control is clicked by its label

// Four force-clicks on four custom-styled radios all reported success and
// left every group unanswered: the real inputs were 0x0 behind painted
// labels, so the click landed on whatever was on top. Same shape as G6 for
// uploads, same remedy — click the visible thing.
const hiddenRadio = buildFillPlan({
  fields: [], uploads: [],
  groups: [{
    group: 'lvl', question: 'Level', role: 'radio', required: true, visible: true, answered: false,
    options: [
      { label: 'Fluent', selector: '#r-2', hidden: true, clickSelector: 'label[for="r-2"]' },
      { label: 'Basic', selector: '#r-1', hidden: true, clickSelector: 'label[for="r-1"]' },
    ],
  }],
}, [{ question: 'Level', choices: ['Fluent'] }]);
check('a hidden radio is clicked through its label', hiddenRadio.actions[0].target, 'label[for="r-2"]');
check('and it is still a click, not something cleverer', hiddenRadio.actions[0].op, 'click');

const visibleRadio = buildFillPlan({
  fields: [], uploads: [],
  groups: [{
    group: 'lvl', question: 'Level', role: 'radio', required: true, visible: true, answered: false,
    options: [{ label: 'Fluent', selector: '#v-2', hidden: false, clickSelector: '' }],
  }],
}, [{ question: 'Level', choices: ['Fluent'] }]);
check('an ordinary radio is still clicked directly', visibleRadio.actions[0].target, '#v-2');

const hiddenConsent = buildFillPlan({
  fields: [{ selector: '#gdpr', label: 'I agree to the privacy policy', role: 'checkbox', tag: 'input',
    required: true, visible: true, checked: false, hidden: true, clickSelector: 'label.consent' }],
  groups: [], uploads: [],
}, [{ question: 'I agree to the privacy policy', value: 'Yes' }]);
check('a hidden consent checkbox uses its label too', hiddenConsent.actions[0].target, 'label.consent');

// ------------------------------------------- a slider, and other people's forms

// A range input reports the same role as a number box and takes no typed
// value at all — a programmatic write is refused, and only a real interaction
// moves it. It also always HAS a value, because it renders at a starting
// position, so "non-empty" cannot mean "answered".
const slider = buildFillPlan({
  fields: [{ selector: '#s', label: 'How fluent are you in English?', role: 'spinbutton', tag: 'input',
    type: 'range', required: true, visible: true, value: '1', defaultValue: '1', min: 1, max: 5, step: 1 }],
  groups: [], uploads: [],
}, [{ question: 'How fluent are you in English?', value: '5' }]);
check('an untouched slider is planned, not read as answered', [slider.actions[0].op, slider.actions[0].value], ['set_range', '5']);

const movedSlider = buildFillPlan({
  fields: [{ selector: '#s', label: 'Fluency', role: 'spinbutton', tag: 'input',
    type: 'range', required: true, visible: true, value: '4', defaultValue: '1', min: 1, max: 5 }],
  groups: [], uploads: [],
}, [{ question: 'Fluency', value: '5' }]);
check('a slider already moved off its default is left alone', movedSlider.counts.actions, 0);

check('a number box is still an ordinary fill',
  opFor({ kind: 'field', role: 'spinbutton', tag: 'input', type: 'number' }), 'fill');

// A careers page carries other forms. One live page offered a footer field
// labelled "Email address without domain" — a mailing list — and filling every
// field on the page puts the candidate's address into it.
const twoForms = buildFillPlan({
  fields: [
    { selector: '#first', label: 'First name', role: 'textbox', tag: 'input', required: true, visible: true, value: '', formIndex: 0 },
    { selector: '#news', label: 'Email address without domain', role: 'textbox', tag: 'input', required: true, visible: true, value: '', formIndex: 1 },
  ],
  groups: [],
  uploads: [{ selector: '#cv', label: 'Upload CV', required: true, filled: false, formIndex: 0 }],
}, [{ question: 'First name', value: 'Mohammad' }, { question: 'Email address without domain', value: 'x@y.z' }],
  { resumePath: '/cv.pdf' });
check('only the form holding the application is filled', twoForms.actions.map((a) => a.target), ['#cv', '#first']);

// Plenty of ATS render their fields outside a <form> element entirely.
const noForm = buildFillPlan({
  fields: [{ selector: '#a', label: 'First name', role: 'textbox', tag: 'input', required: true, visible: true, value: '', formIndex: -1 }],
  groups: [], uploads: [],
}, [{ question: 'First name', value: 'Mohammad' }]);
check('a field belonging to no form is kept', noForm.counts.actions, 1);

// One form on the page means no filtering to do, whatever its index.
const oneForm = buildFillPlan({
  fields: [{ selector: '#a', label: 'First name', role: 'textbox', tag: 'input', required: true, visible: true, value: '', formIndex: 3 }],
  groups: [], uploads: [],
}, [{ question: 'First name', value: 'Mohammad' }]);
check('a single form is never filtered out', oneForm.counts.actions, 1);

// ---------------------------------------------- no invisible control characters

// A backslash escape mangled into the literal control character it names is
// invisible in an editor and changes behaviour silently: `cv\b` written as
// "cv" plus a real backspace made AUTOFILL_UPLOAD_RE stop matching "Upload
// CV", so a parseable resume was planned after the fields it overwrites and
// nothing looked wrong anywhere. Cheap to check, impossible to eyeball.
const CONTROL_CHARS = { 0: 'NUL', 8: 'backspace', 11: 'vertical tab', 12: 'form feed', 27: 'escape' };
const sources = ['lib/freemotion-fillplan.mjs', 'lib/freemotion-inventory.mjs', 'lib/voice-check.mjs'];
const offenders = [];
for (const rel of sources) {
  const text = readFileSync(join(ROOT, rel), 'utf-8');
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (CONTROL_CHARS[code]) offenders.push(`${rel}: ${CONTROL_CHARS[code]} at offset ${i}`);
  }
}
check('no source file carries a literal control character', offenders, []);

// --------------------------------------------------- answering a slider

const { resolveRange } = mod;

check('a numeric answer goes straight onto the slider',
  resolveRange({ min: 1, max: 5 }, { value: '3' }).value, '3');

// The answer engine returns a LABEL for a language question, and there is no
// honest way to type "Fluent" into a 1-to-5 slider. But top-of-scale is what
// Fluent means on one, so the mapping is sound.
check('a top-of-scale label becomes the maximum',
  resolveRange({ min: 1, max: 5 }, { value: 'Fluent', choices: ['Fluent', 'C1'] }).value, '5');

check('the scale maximum is read from the control, not assumed',
  resolveRange({ min: 0, max: 10 }, { value: 'Fluent' }).value, '10');

check('a French top-of-scale label works the same way',
  resolveRange({ min: 1, max: 4 }, { value: 'Courant' }).value, '4');

// Maxing out a slider that measures years or salary would be a claim the plan
// invented, so anything that is neither a number nor top-of-scale is a
// judgment call.
check('a middling label is reported, never rounded up',
  resolveRange({ min: 1, max: 5 }, { value: 'Intermediate' }).value, null);

check('and the reason says why it could not be answered',
  /neither numeric nor top-of-scale/.test(resolveRange({ min: 1, max: 5 }, { value: 'Intermediate' }).reason), true);

check('a top-of-scale answer with no known maximum is still not guessed',
  resolveRange({}, { value: 'Fluent' }).value, null);

check('a negative number is a valid slider value',
  resolveRange({ min: -5, max: 5 }, { value: '-2' }).value, '-2');
