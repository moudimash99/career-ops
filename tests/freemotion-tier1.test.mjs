// tests/freemotion-tier1.test.mjs — the deterministic fill-plan builder.
//
// The assertion that matters most is a safety one: "Submit application" is a
// button on the real captured form, and the fill plan is EXECUTED BEFORE Tier 3
// validates anything. A click action emitted here would send a half-filled
// application to an employer and bypass the entire gate.
//
// The second is quieter and burns a posting just as surely: a rule that
// "resolves" to an empty string writes nothing into the field, and Tier 3 then
// reports it as unfilled — a self-inflicted validation failure. The live
// profile has `github: ""`, so this is not hypothetical.
//
// Run: node test-all.mjs --only freemotion-tier1

import { pass, fail, ROOT } from './helpers.mjs';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-tier1 — deterministic fill planning');

const { classifyFields, classifyButton, loadDeterministicRules, STANDARD_FIELD_RULES, FreemotionConfigError } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-tier1.mjs')).href);
const { parseAccessibilitySnapshot } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-snapshot.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const ctx = {
  profile: {
    candidate: {
      full_name: 'Jane Q Doe',
      email: 'jane@example.com',
      phone: '+33 7 00 00 00 00',
      linkedin: 'linkedin.com/in/jane-no-scheme',
      github: '',
      portfolio_url: 'https://jane.example',
      location: 'Toulouse, France',
    },
    location: { country: 'France' },
  },
  applyAnswers: {
    resume: 'documents/fallback-cv.pdf',
    rules: [
      { match: 'linkedin', answer: 'https://linkedin.com/in/jane-with-scheme' },
      { match: 'how did you hear', answer: 'Company job board', choose: ['Company job board', 'Other'] },
      { match: 'pronoun', skip: true },
      { match: 'address line 1|street address', answer: '' },
      { match: 'years of experience', answer: '{{years_experience}}' },
    ],
  },
  cvText: '## Experience\n### Role\n**Jan 2020 – Jan 2024 · Toulouse**\n',
};

const field = (ref, role, name, depth = 1) => ({ ref, role, name, attrs: [], depth });

// ============================================ the plan's acceptance assertion

{
  const fields = [
    field('e1', 'textbox', 'Email Address'),
    field('e2', 'textbox', 'LinkedIn'),
    field('e3', 'textbox', 'Favorite programming language'),
  ];
  const { fillPlan, remaining } = classifyFields(fields, ctx);
  check('two of three fields are planned deterministically', fillPlan.length, 2);
  check('  ...email from the built-in profile rule', fillPlan.find((a) => a.ref === 'e1')?.source, 'profile');
  check('  ...linkedin from the hand-written rule', fillPlan.find((a) => a.ref === 'e2')?.source, 'apply-answers');
  check('the unmatched field is handed onward', remaining.map((f) => f.ref), ['e3']);
  check('  ...and nothing else is', remaining.length, 1);
}

// ================================================= buttons never get an action

{
  const fields = [
    field('e1', 'textbox', 'Email Address'),
    field('b1', 'button', 'Submit application'),
    field('b2', 'button', 'Next'),
    field('b3', 'button', 'Attach'),
    field('b4', 'button', 'Toggle flyout'),
  ];
  const { fillPlan, remaining, controls } = classifyFields(fields, ctx);

  check('NO button is ever in the fill plan', fillPlan.some((a) => a.role === 'button'), false);
  check('  ...and no action is ever a click', fillPlan.some((a) => a.action === 'click'), false);
  check('no button is routed to the answer resolver either', remaining.some((f) => f.role === 'button'), false);
  check('buttons come back as classified controls', controls.length, 4);
  check('  ...submit is identified', controls.find((c) => c.ref === 'b1')?.kind, 'submit');
  check('  ...next is identified', controls.find((c) => c.ref === 'b2')?.kind, 'next');
  check('  ...attach is identified', controls.find((c) => c.ref === 'b3')?.kind, 'attach');
  check('  ...and an unremarkable button is "other"', controls.find((c) => c.ref === 'b4')?.kind, 'other');
}

for (const [name, kind] of [
  ['Submit application', 'submit'], ['Apply now', 'submit'], ['Send', 'submit'],
  ['Next', 'next'], ['Continue', 'next'], ['Save and continue', 'next'],
  ['Attach', 'attach'], ['Upload file', 'attach'], ['Choose file', 'attach'],
  ['Toggle flyout', 'other'], ['Dropbox', 'other'], ['', 'other'],
]) {
  check(`button "${name}" classifies as ${kind}`, classifyButton(name), kind);
}

// ======================================== an empty value is never a resolution

{
  const fields = [
    field('e1', 'textbox', 'GitHub'),         // profile github is ""
    field('e2', 'textbox', 'Street Address'), // rule answer is ""
    field('e3', 'textbox', 'What are your pronouns?'), // rule is skip:true
  ];
  const { fillPlan, remaining } = classifyFields(fields, ctx);
  check('an empty profile value produces no fill action', fillPlan.length, 0);
  check('  ...all three go onward instead', remaining.map((f) => f.ref), ['e1', 'e2', 'e3']);
  check('nothing is ever planned as an empty string', fillPlan.some((a) => a.value === ''), false);
}

// ============================================== precedence and name transforms

{
  const fields = [field('e1', 'textbox', 'LinkedIn Profile')];
  const { fillPlan } = classifyFields(fields, ctx);
  // The profile stores linkedin without a scheme; the user's own rule has the
  // full https form, and some URL validators reject the bare one.
  check('a hand-written rule beats the built-in', fillPlan[0].value, 'https://linkedin.com/in/jane-with-scheme');
}
{
  const fields = [
    field('e1', 'textbox', 'First Name'),
    field('e2', 'textbox', 'Last Name'),
    field('e3', 'textbox', 'Full Name'),
    field('e4', 'textbox', 'City'),
    field('e5', 'textbox', 'Country'),
  ];
  const plan = classifyFields(fields, ctx).fillPlan;
  const val = (ref) => plan.find((a) => a.ref === ref)?.value;
  // "First Name" must be tested before the bare name pattern, or the form gets
  // the full name in a field expecting one word.
  check('first name is the first word', val('e1'), 'Jane');
  check('last name is the LAST word, not everything after the first', val('e2'), 'Doe');
  check('full name is untouched', val('e3'), 'Jane Q Doe');
  check('city drops the country', val('e4'), 'Toulouse');
  check('country comes from location.country', val('e5'), 'France');
}

// ===================================================== action per widget kind

{
  const fields = [
    field('e1', 'textbox', 'Email'),
    field('e2', 'combobox', 'How did you hear about this role?'),
    field('e3', 'checkbox', 'Email'),
    field('e4', 'textbox', 'Resume/CV'),
  ];
  const plan = classifyFields(fields, ctx).fillPlan;
  const act = (ref) => plan.find((a) => a.ref === ref);
  check('a textbox is filled', act('e1')?.action, 'fill');
  check('a combobox is selected', act('e2')?.action, 'select');
  check('  ...carrying its ordered choices', act('e2')?.choices, ['Company job board', 'Other']);
  // This assertion used to read "a checkbox is checked" against e3 — a checkbox
  // labelled "Email", which the email rule answered with an address. That is the
  // Thales/Workday defect below, written down as if it were correct behaviour:
  // role-to-action mapping was the point, but the fixture paired it with a text
  // answer, so the test would have defended ticking a box with an email address.
  // The mapping is now proven with an affirmative answer instead (see the
  // consent-box case at the end of this file).
  check('a checkbox is NOT ticked by a text answer that only name-matched',
    act('e3'), undefined);
  check('a resume field is an upload', act('e4')?.action, 'upload');
}
{
  // pdfPath (this posting's tailored CV) beats apply-answers.yml's own resume.
  const fields = [field('e1', 'textbox', 'Resume/CV')];
  const tailored = classifyFields(fields, { ...ctx, pdfPath: 'output/tailored.pdf' }).fillPlan;
  check('the tailored CV wins when supplied', tailored[0].value, 'output/tailored.pdf');
  const fallback = classifyFields(fields, ctx).fillPlan;
  check('  ...falling back to apply-answers.yml resume', fallback[0].value, 'documents/fallback-cv.pdf');
  const none = classifyFields(fields, { ...ctx, applyAnswers: { rules: [] } }).fillPlan;
  check('  ...and with no CV at all it goes onward, never improvised', none.length, 0);
}

// ============================================================= token expansion

{
  const fields = [field('e1', 'textbox', 'Years of experience')];
  const plan = classifyFields(fields, ctx).fillPlan;
  check('a {{years_experience}} token is expanded, not typed literally', /^\d+$/.test(plan[0].value), true);
  check('  ...from the Experience section of the CV', plan[0].value, '4');
}

// ================================================================== robustness

{
  // A snapshot can list the same element twice when a form re-renders
  // mid-capture. Two writes to one field is the duplicate-value bug the
  // requirements brief's Lessons section names.
  const dup = [field('e1', 'textbox', 'Email Address'), field('e1', 'textbox', 'Email Address')];
  check('a repeated ref yields exactly one action', classifyFields(dup, ctx).fillPlan.length, 1);
}
{
  // An unlabelled widget is exactly what Tier 2 exists for — not droppable.
  const unnamed = [field('e1', 'textbox', '')];
  const r = classifyFields(unnamed, ctx);
  check('an unnamed field is never guessed at', r.fillPlan.length, 0);
  check('  ...and is handed onward, not dropped', r.remaining.length, 1);
}
for (const [label, input] of [['null', null], ['undefined', undefined], ['a string', 'nope'], ['an empty array', []]]) {
  try {
    const r = classifyFields(input, ctx);
    if (r && Array.isArray(r.fillPlan)) pass(`${label} input yields a plan shape, never a throw`);
    else fail(`${label} input yielded ${JSON.stringify(r)}`);
  } catch (err) {
    fail(`${label} input threw: ${err.message}`);
  }
}
try {
  const r = classifyFields([field('e1', 'textbox', 'Email')], {});
  check('an empty context plans nothing and throws nothing', r.remaining.length, 1);
} catch (err) {
  fail(`an empty context threw: ${err.message}`);
}
{
  const bad = { ...ctx, applyAnswers: { rules: [{ match: '[unclosed(', answer: 'x' }, { match: 'email', answer: 'ok@x.com' }] } };
  const plan = classifyFields([field('e1', 'textbox', 'Email')], bad).fillPlan;
  check('a typo\'d rule regex is skipped, and later rules still fire', plan[0]?.value, 'ok@x.com');
}

// ============================================================ config loading

try {
  loadDeterministicRules({ profilePath: join(ROOT, 'does-not-exist.yml') });
  fail('a missing profile should be fatal');
} catch (err) {
  check('a missing profile throws FreemotionConfigError', err instanceof FreemotionConfigError, true);
}
{
  // A missing apply-answers.yml degrades to the built-ins: a slower run, not a
  // wrong one.
  const loaded = loadDeterministicRules({ applyAnswersPath: join(ROOT, 'does-not-exist.yml') });
  check('a missing apply-answers.yml is not fatal', Array.isArray(loaded.applyAnswers.rules), true);
  check('  ...and the built-ins still fire', classifyFields([field('e1', 'textbox', 'Email')], loaded).fillPlan.length, 1);
}

check('the resume rule is last, so a "CV" in another label cannot shadow a real field',
  STANDARD_FIELD_RULES[STANDARD_FIELD_RULES.length - 1].action, 'upload');

// ================================ against this checkout's real captured form

// The regression that matters cannot be written by hand: it needs a real ATS
// form. Skipped, not failed, on a checkout without captures.
const mcpDir = join(ROOT, '.playwright-mcp');
const capture = existsSync(mcpDir)
  ? readdirSync(mcpDir).filter((f) => f.endsWith('.yml'))
    .map((f) => join(mcpDir, f))
    .find((p) => { try { return /combobox "Are you legally/.test(readFileSync(p, 'utf-8')); } catch { return false; } })
  : undefined;

if (!capture) {
  pass('no real application-form capture available to cross-check (skipped)');
} else {
  const fields = parseAccessibilitySnapshot(readFileSync(capture, 'utf-8'));
  const { fillPlan, remaining, controls } = classifyFields(fields, ctx);

  check('the real form yields a non-empty fill plan', fillPlan.length > 0, true);
  check('  ...covering First Name', fillPlan.some((a) => /first name/i.test(a.name)), true);
  check('  ...and Email', fillPlan.some((a) => /email/i.test(a.name)), true);

  // The safety property, on the real button that would really submit.
  check('the real Submit button is NOT in the fill plan', fillPlan.some((a) => /submit/i.test(a.name)), false);
  check('  ...it is a classified control instead', controls.some((c) => c.kind === 'submit'), true);

  // The 8 "Toggle flyout" buttons must not reach the answer resolver as
  // interview questions — that is 8 wasted model calls per posting.
  check('no button reaches the answer resolver', remaining.some((f) => f.role === 'button'), false);
  check('the work handed to Tier 2 is smaller than the form', remaining.length < fields.length, true);
  console.log(`     (real form: ${fields.length} fields → ${fillPlan.length} planned, ${remaining.length} to Tier 2, ${controls.length} controls)`);
}

// ── Found live on Thales/Workday, report #594 (Phase 8 smoke test) ─────────
// Three fields the rules matched and answered WRONGLY. Each would have reached
// a real employer as a malformed application, and none is hypothetical — this
// is what the first live run actually produced before the guards existed.

const wdCtx = {
  profile: { candidate: { full_name: 'Mohammad Machaka', phone: '+33 7 53 37 78 23', email: 'm@example.com' }, location: { country: 'France' } },
  applyAnswers: {
    rules: [
      // The user's real rules, verbatim — these are what over-matched.
      { match: 'preferred name|preferred first name', answer: 'Mohammad' },
      { match: '^country|country of residence', answer: 'France' },
    ],
  },
  cvText: '',
};
const wdField = (ref, role, name) => ({ ref, role, name, attrs: [], depth: 1 });

// 1. A text answer must never tick a checkbox. Ticking "I have a preferred
//    name" opens a sub-form the candidate never asked for.
let wd = classifyFields([wdField('c1', 'checkbox', 'I have a preferred name')], wdCtx);
check('a text answer does not tick a checkbox it merely name-matched',
  wd.fillPlan.length, 0);
check('  ...the checkbox goes to Tier 2 to be decided, not left silently unticked',
  wd.remaining.map((f) => f.name), ['I have a preferred name']);

// A genuine consent checkbox with an affirmative answer still fills.
wd = classifyFields([wdField('c2', 'checkbox', 'I agree to the privacy policy')], {
  ...wdCtx,
  applyAnswers: { rules: [{ match: 'privacy policy|i agree', answer: 'Yes' }] },
});
check('an affirmative answer still ticks a real consent box',
  wd.fillPlan.map((a) => [a.action, a.value]), [['check', 'Yes']]);

// 2. "Phone Extension" must not receive the phone number.
wd = classifyFields([wdField('p1', 'textbox', 'Phone Extension'), wdField('p2', 'textbox', 'Phone Number')], wdCtx);
check('the phone rule fills Phone Number but not Phone Extension',
  wd.fillPlan.map((a) => a.name), ['Phone Number']);
check('  ...the extension is handed to Tier 2 rather than guessed',
  wd.remaining.map((f) => f.name), ['Phone Extension']);

// 3. "Country Phone Code" must not receive the country.
wd = classifyFields([wdField('k1', 'textbox', 'Country Phone Code'), wdField('k2', 'textbox', 'Country')], wdCtx);
check('the country rule fills Country but not Country Phone Code',
  wd.fillPlan.map((a) => a.name), ['Country']);

// The guard is narrow: neighbouring fields that merely contain "code" or
// "ext" as part of another word must keep filling.
wd = classifyFields([wdField('z1', 'textbox', 'Postal Code')], {
  ...wdCtx,
  applyAnswers: { rules: [{ match: '\bzip\b|postal code|postcode', answer: '31000' }] },
});
check('Postal Code is not mistaken for a dialling code',
  wd.fillPlan.map((a) => [a.name, a.value]), [['Postal Code', '31000']]);

for (const safe of ['Next of Kin', 'Contextual Question', 'Extra Information']) {
  const r = classifyFields([wdField('s1', 'textbox', safe)], {
    ...wdCtx,
    applyAnswers: { rules: [{ match: '.', answer: 'x' }] },
  });
  check(`"${safe}" is not caught by the sub-field guard`, r.fillPlan.length, 1);
}

// ── Found live on VISEO's custom French form (Phase 8, second target) ─────
// "Nom" beside "Prénom" is the surname. Matching it unanchored fills the
// candidate's surname into "Nom de l'entreprise" (company) and "Nom du poste"
// (job title) — a malformed application that reads as a careless one.
{
  const frCtx = { profile: { candidate: { full_name: 'Mohammad Machaka' } }, applyAnswers: { rules: [] }, cvText: '' };
  const one = (name) => classifyFields([{ ref: 'x', role: 'textbox', name, attrs: [], depth: 1 }], frCtx).fillPlan;

  check('bare "Nom*" resolves to the surname', one('Nom*').map((a) => a.value), ['Machaka']);
  check('  ...as does "Nom" and "Nom :"',
    [one('Nom').length, one('Nom :').length], [1, 1]);
  check('"Nom de l\'entreprise" is NOT the surname', one("Nom de l'entreprise").length, 0);
  check('"Nom du poste" is NOT the surname', one('Nom du poste').length, 0);
  check('"Prénom*" still resolves to the given name', one('Prénom*').map((a) => a.value), ['Mohammad']);
  check('"Nom de famille" still resolves', one('Nom de famille').map((a) => a.value), ['Machaka']);
}
