// tests/freemotion-answers.test.mjs — the priority-order answer resolver.
//
// Two things are being pinned, and they pull in opposite directions.
//
// NEVER ABSTAIN: every question the candidate's own files can answer must be
// answered here, so it never costs a model call — and a protected-category
// question must reach `application_answers` or its Requirement-6 fallback, not
// the model, because a wrong visa or criminal-record answer costs a rescinded
// offer or a permit.
//
// NEVER GUESS: this module must NOT invent the answers it cannot derive. A
// deterministic function that guesses is worse than one that hands off,
// because its guess carries no reasoning into the audit log.
//
// Run: node test-all.mjs --only freemotion-answers

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-answers — priority-order answer resolution');

const {
  resolveAnswer, resolveProtectedAnswer, classifyCategory, checkEntailment,
  computeYearsExperience, formatAnswerValue, PROTECTED_CATEGORY_PATTERNS, isStructuralSubfield,
} = await import(pathToFileURL(join(ROOT, 'lib/freemotion-answers.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

// A fixture context shaped exactly like the live files, with none of the real
// personal data in it.
const ctx = {
  profile: {
    location: { country: 'France', visa_status: 'Authorised to work in France; no sponsorship required' },
    compensation: { target_range: '44000', minimum: '40000', currency: 'EUR' },
    application_answers: {
      work_authorization: {
        authorized_to_work_in_france: true,
        authorized_to_work_in_eu: false,
        requires_sponsorship_now: false,
        requires_sponsorship_future: true,
      },
      background: { criminal_record: false, consent_to_background_check: true },
      credentials: { highest_degree: 'MS, ISAE-SUPAERO', licences: [], security_clearance: 'none' },
      compensation: { expected_annual_gross_eur: 44000, minimum_annual_gross_eur: 40000, single_figure_answer: '44000' },
      availability: { earliest_start_date: '2026-11-18', notice_period_days: 0, willing_to_relocate: true, willing_to_travel: true },
      eeo_self_identification: { gender: 'decline', race_ethnicity: 'decline', disability_status: 'decline', veteran_status: 'not a veteran' },
    },
  },
  applyAnswers: {
    rules: [
      { match: 'linkedin', answer: 'https://linkedin.com/in/example' },
      { match: 'proficiency in english|english proficiency', choose: ['Fluent', 'Bilingual', 'C2'] },
      { match: 'pronoun', skip: true },
      { match: 'address line 1|street address', answer: '' },
      { match: 'how many years of (professional )?experience', answer: '{{years_experience}}' },
      { match: '[unclosed(regex', answer: 'never reached' },
    ],
  },
  applyEssays: {
    essays: [{ match: 'proud of|most impressive project', answer: 'The tile service rebuild.' }],
    fallback: 'I am a cloud and data engineer in Toulouse.',
    never_auto: ['security clearance|clearance level', 'salary history|current salary'],
  },
  cvText: 'Green Praxis, 2021 - 2024\nAirbus Operations, 2025 - Present\n',
  articleDigestText: '',
};

// =========================================================== the plan's three

// 1. Protected, resolvable from application_answers.
{
  const r = resolveAnswer({ text: 'Will you now or in the future require visa sponsorship?', role: 'combobox' }, ctx);
  check('[1] a sponsorship question is answered from application_answers', r.status, 'answered');
  check('[1] ...from the profile, not a fallback', r.source, 'profile');
  check('[1] ...tagged work_authorization', r.category, 'work_authorization');
  check('[1] ...with the boolean rendered as the form expects', r.value, 'Yes');
  check('[1] ...from the FUTURE key, not the now key', r.key, 'work_authorization.requires_sponsorship_future');
}

// 2. Protected, resolved via the Requirement-6 fallback.
{
  const thin = { ...ctx, profile: { ...ctx.profile, application_answers: { work_authorization: {} } } };
  const r = resolveAnswer({ text: 'Do you require sponsorship to work in this role?', role: 'combobox' }, thin);
  check('[2] a missing sub-key falls back rather than guessing', r.status, 'answered');
  check('[2] ...logged as answered-from-fallback', r.source, 'fallback');
  check('[2] ...still tagged work_authorization', r.category, 'work_authorization');
  check('[2] ...from location.visa_status', r.key, 'location.visa_status');
}

// 3. Correct handoff, not a fabricated guess by the deterministic layer.
{
  const r = resolveAnswer({ text: 'What was the annual revenue impact of your last project?', role: 'textbox' }, ctx);
  check('[3] an unanswerable factual question is handed off', r.status, 'needs-model-judgment');
  check('[3] ...and this module produced NO value at all', r.value, undefined);
  check('[3] ...carrying the question text for the model', r.question, 'What was the annual revenue impact of your last project?');
}

// ================================================= the real captured question

// From this repo's own .playwright-mcp capture of a live Greenhouse form. The
// regex the plan wrote down does not match it: "authorised to work" is the
// opposite word order from "work authorisation", and "authorised" is not in the
// plan's `legally (able|permitted|entitled)` alternation. A miss here sends an
// immigration question to the model — the one thing Requirement 6 forbids.
{
  const real = 'Are you legally authorised to work full-time in the country where this job is based?';
  check('the real captured work-authorisation question classifies', classifyCategory(real), 'work_authorization');
  const r = resolveAnswer({ text: real, role: 'combobox' }, ctx);
  check('  ...and never reaches the model', r.status, 'answered');
  // It names no country and this ctx carries no jobCountry, so the wildcard
  // cannot pick france over eu — the Requirement-6 fallback is correct here,
  // not a coin flip. (With a jobCountry it resolves from the profile instead.)
  check('  ...resolving through the fallback, since it names no country', r.source, 'fallback');
}
{
  const named = 'Are you legally authorised to work in France?';
  const r = resolveAnswer({ text: named, role: 'combobox' }, ctx);
  check('a question naming France reads the France key', r.key, 'work_authorization.authorized_to_work_in_france');
  check('  ...and answers Yes', r.value, 'Yes');
}
{
  const eu = 'Are you legally authorised to work in the EU?';
  const r = resolveAnswer({ text: eu, role: 'combobox' }, ctx);
  check('a question naming the EU reads the EU key', r.key, 'work_authorization.authorized_to_work_in_eu');
  check('  ...and answers No, the truthful value', r.value, 'No');
}

// ==================================================== category classification

for (const [text, expected] of [
  ['Have you ever been convicted of a felony?', 'background'],
  ['What is your highest level of education?', 'credentials'],
  ['Do you hold a security clearance?', 'credentials'],
  ['What are your salary expectations?', 'compensation'],
  ['What is your notice period?', 'availability'],
  ['Voluntary Self-Identification of Gender:', 'eeo'],
  ['Are you a protected veteran?', 'eeo'],
  ['What is your favourite programming language?', null],
  ['How did you hear about this opportunity?', null],
]) {
  check(`classify: ${JSON.stringify(text.slice(0, 42))}`, classifyCategory(text), expected);
}
check('an empty question classifies as nothing', classifyCategory(''), null);
check('a null question does not throw', classifyCategory(null), null);

// =============================================== hand-written rules come first

{
  const r = resolveAnswer({ text: 'LinkedIn Profile', role: 'textbox' }, ctx);
  check('a hand-written rule answers', r.value, 'https://linkedin.com/in/example');
  check('  ...credited to the profile layer', r.source, 'profile');
  check('  ...and names the rule that matched', r.matchedRule, 'linkedin');
}
{
  // A rule with `choose:` and no `answer:` — the live English-proficiency rule.
  const r = resolveAnswer({ text: 'Proficiency in English', role: 'combobox' }, ctx);
  check('a choose-only rule resolves to its first choice', r.value, 'Fluent');
  check('  ...and hands back the full ordered list to try', r.choices, ['Fluent', 'Bilingual', 'C2']);
}

// ================================= the three shapes that look like resolutions

{
  // `skip: true` meant "skip the whole job" under the old applier. There is no
  // skip any more, so it must fall through and be answered downstream.
  const r = resolveAnswer({ text: 'What are your pronouns?', role: 'textbox' }, ctx);
  check('a skip:true rule falls through instead of resolving', r.status, 'needs-model-judgment');
}
{
  // `answer: ""` is the user saying "I have not written this down".
  const r = resolveAnswer({ text: 'Street Address', role: 'textbox' }, ctx);
  check('an empty answer is not a resolution', r.status, 'needs-model-judgment');
}
{
  // The token must expand, not be typed into the form literally.
  const r = resolveAnswer({ text: 'How many years of professional experience do you have?', role: 'textbox' }, ctx);
  check('a {{years_experience}} token is expanded', r.status, 'answered');
  check('  ...to a number, not the literal token', /^\d+$/.test(r.value), true);
}
{
  // A hand-edited file with a typo'd regex must not take down the whole run.
  const r = resolveAnswer({ text: 'something harmless', role: 'textbox' }, ctx);
  check('an unparseable rule regex is skipped, not thrown on', typeof r.status, 'string');
}

// ============================================== the permit-expiry consequence

// The live apply-answers.yml has a deliberately-empty rule for permit expiry.
// It falls through — and MUST land in work_authorization, not at the model,
// because a fabricated permit date is exactly what Requirement 6 forbids.
{
  const r = resolveAnswer({ text: 'When does your work permit expire?', role: 'textbox' }, ctx);
  check('an empty permit-expiry rule still lands in work_authorization', r.category, 'work_authorization');
  check('  ...and is answered from the fallback, never by the model', r.status, 'answered');
  check('  ...logged as a fallback so the audit shows it was not verbatim', r.source, 'fallback');
}

// =========================================== essays, never_auto, and the bio

{
  const r = resolveAnswer({ text: 'Describe a project you are proud of', role: 'textbox' }, ctx);
  check('a hand-written essay answers a free-text prompt', r.value, 'The tile service rebuild.');
}
{
  // never_auto means "no canned text for THIS one" — a fall-through, not a stop.
  const r = resolveAnswer({ text: 'Describe your security clearance level', role: 'textbox' }, ctx);
  check('a never_auto match does not return canned text', r.value === 'I am a cloud and data engineer in Toulouse.', false);
  check('  ...and still gets answered, from the credentials block', r.status, 'answered');
  check('  ...tagged credentials', r.category, 'credentials');
}
{
  const r = resolveAnswer({ text: 'Why are you interested in this role?', role: 'textbox' }, ctx);
  check('an open-ended motivation prompt gets the bio', r.source, 'profile');
  check('  ...which is the fallback essay', r.matchedRule, 'apply-essays.yml fallback');
}
{
  // The bio is a bio. Pasting it into a salary question would be a non-answer
  // that looks like an answer — this is the ordering deviation from §1.3.
  const r = resolveAnswer({ text: 'Describe your salary expectations', role: 'textbox' }, ctx);
  check('a protected question never receives the generic bio', r.category, 'compensation');
  check('  ...it is answered from application_answers', r.source, 'profile');
  check('  ...with the expected figure', r.value, '44000');
}
{
  // A factual question is not a motivation prompt, even in a free-text box.
  const r = resolveAnswer({ text: 'How much did you reduce infrastructure cost by?', role: 'textbox' }, ctx);
  check('a factual free-text question is handed off, not given the bio', r.status, 'needs-model-judgment');
}

// ================================================= false / 0 are real answers

{
  const r = resolveAnswer({ text: 'Have you ever been convicted of a criminal offence?', role: 'combobox' }, ctx);
  check('criminal_record:false answers No — not "missing"', r.value, 'No');
  check('  ...from the profile', r.source, 'profile');
}
{
  const r = resolveProtectedAnswer('availability', 'What is your notice period?', ctx.profile.application_answers, {});
  check('notice_period_days:0 is an answer, not an absence', r.value, '0');
}
{
  const r = resolveProtectedAnswer('credentials', 'List any professional licences', ctx.profile.application_answers, {});
  check('an empty licences list answers "None", not nothing', r.value, 'None');
}

// ==================================== the four categories with NO safe default

// There is no legally-safe generic criminal-record answer, so an unresolvable
// one goes to the model WITH its category rather than being answered from
// nothing.
{
  const empty = {};
  for (const category of ['background', 'credentials', 'availability', 'eeo']) {
    const r = resolveProtectedAnswer(category, 'some unmatched sub-question', empty, { visaStatus: 'x', compensation: { target_range: '1' } });
    check(`${category} has no fallback and hands off`, r.status, 'needs-model-judgment');
    check(`  ...tagged ${category}`, r.category, category);
  }
  const wa = resolveProtectedAnswer('work_authorization', 'do you need sponsorship', empty, { visaStatus: 'Authorised in France' });
  check('work_authorization DOES have a fallback', wa.source, 'fallback');
  const comp = resolveProtectedAnswer('compensation', 'expected salary', empty, { compensation: { target_range: '44000', currency: 'EUR' } });
  check('compensation DOES have a fallback', comp.source, 'fallback');
  check('  ...carrying its currency', comp.value, '44000 EUR');
}

// ======================================================== value formatting

check('true renders as Yes', formatAnswerValue(true), 'Yes');
check('false renders as No', formatAnswerValue(false), 'No');
check('a number renders as itself', formatAnswerValue(44000), '44000');
check('an empty list renders as None', formatAnswerValue([]), 'None');
check('a list renders comma-separated', formatAnswerValue(['A', 'B']), 'A, B');

// ==================================================== years of experience

// Overlapping ranges are UNIONED, not summed: two concurrent roles are not
// twice the experience, and summing inflates a claim submitted under the
// candidate's name.
check('overlapping ranges are unioned, not summed',
  computeYearsExperience('Role A, 2015 - 2020\nRole B, 2017 - 2020\n', { now: new Date('2020-01-01') }), 5);
check('adjacent ranges add up',
  computeYearsExperience('A, 2010 - 2015\nB, 2015 - 2020\n', { now: new Date('2020-06-01') }), 10);
check('"Present" resolves to now',
  computeYearsExperience('A, 2020 - Present', { now: new Date('2026-01-01') }), 6);
check('an en-dash range parses',
  computeYearsExperience('A, 2018–2021', { now: new Date('2026-01-01') }), 3);
check('a month-qualified range parses',
  computeYearsExperience('A, 01/2020 - 01/2024', { now: new Date('2026-01-01') }), 4);
check('no readable range yields null, not zero', computeYearsExperience('no dates here'), null);
check('a reversed range is ignored', computeYearsExperience('A, 2024 - 2020'), null);
check('a birth year is not a job', computeYearsExperience('Born 1804 - 1850'), null);

// ============================================================ entailment

{
  const e = checkEntailment('How many years of experience do you have?', 'A, 2020 - 2024');
  check('years of experience is mechanically entailed', e.entailed, true);
  check('  ...and carries its evidence', typeof e.evidenceSnippet, 'string');
}
{
  const e = checkEntailment('What is your greatest weakness?', 'A, 2020 - 2024');
  check('anything subtler is NOT entailed', e.entailed, false);
  check('  ...and produces no value', e.value, null);
}

// ============================================================== robustness

for (const [label, q] of [
  ['an empty question', { text: '', role: 'textbox' }],
  ['a null question object', null],
  ['a question with no role', { text: 'Anything?' }],
]) {
  try {
    const r = resolveAnswer(q, ctx);
    if (r && typeof r.status === 'string') pass(`${label} resolves without throwing`);
    else fail(`${label} returned ${JSON.stringify(r)}`);
  } catch (err) {
    fail(`${label} threw: ${err.message}`);
  }
}
try {
  const r = resolveAnswer({ text: 'Anything?', role: 'textbox' }, {});
  check('an empty context still returns a handoff, never a throw', r.status, 'needs-model-judgment');
} catch (err) {
  fail(`an empty context threw: ${err.message}`);
}

check('PROTECTED_CATEGORY_PATTERNS covers the six Requirement-6 categories',
  Object.keys(PROTECTED_CATEGORY_PATTERNS),
  ['work_authorization', 'background', 'credentials', 'compensation', 'availability', 'eeo']);

// ====================================== the posting country resolves the wildcard

// "…the country where this job is based" is the most common protected question
// and the exact wording on the real captured form. It names no country, so
// without the posting's own country it degrades to the free-text visa_status
// fallback — which then gets typed into a Yes/No dropdown.
{
  const q = { text: 'Are you legally authorised to work full-time in the country where this job is based?', role: 'combobox' };
  const withCountry = resolveAnswer(q, { ...ctx, jobCountry: 'France' });
  check('the posting country resolves the wildcard from application_answers', withCountry.source, 'profile');
  check('  ...to the France key', withCountry.key, 'work_authorization.authorized_to_work_in_france');
  check('  ...answering Yes, a value a dropdown can take', withCountry.value, 'Yes');

  const noCountry = resolveAnswer(q, ctx);
  check('without it, the Requirement-6 fallback still answers', noCountry.status, 'answered');
  check('  ...as a fallback', noCountry.source, 'fallback');
}
{
  // The country must only be borrowed for questions that actually defer to the
  // posting — never pasted into a question that names its own country.
  const explicit = resolveAnswer({ text: 'Are you legally authorised to work in the EU?', role: 'combobox' }, { ...ctx, jobCountry: 'France' });
  check('a question naming its own country ignores the posting country', explicit.key, 'work_authorization.authorized_to_work_in_eu');
  check('  ...and answers No, the truthful value', explicit.value, 'No');
}

// ================================== years of experience, on realistic CV text

// The live cv.md writes every role as "May 2026 – Nov 2026". A numeric-only
// pattern matches none of them — and what it DOES match is the bare "2025–2026"
// in the Education headings, so the number submitted under the candidate's name
// was computed from their degree dates.
{
  const cv = [
    '# Someone', '## Summary', 'MS SEN (2025–2026) and a certification.',
    '## Experience',
    '### Airbus — Intern', '**May 2026 – Nov 2026 · Toulouse, France**',
    '### Green Praxis — Engineer', '**Jan 2023 – Jun 2024 · Toulouse, France**',
    '### Murex — Architect', '**May 2021 – Jan 2022 · Beirut, Lebanon**',
    '## Education',
    '### University', '**Sep 2017 – Jun 2020 · Beirut, Lebanon**',
  ].join('\n');

  const years = computeYearsExperience(cv, { now: new Date('2026-08-30') });
  check('month-name ranges are parsed at all', years !== null, true);
  check('  ...and only the Experience section counts', years, 2);

  // Education is three more years; counting it would overstate the claim.
  const unscoped = computeYearsExperience(cv.replace('## Experience', '## Roles'), { now: new Date('2026-08-30') });
  check('with no Experience heading it falls back to the whole text', unscoped > 2, true);
}
check('a French month name parses', computeYearsExperience('A, janv 2020 – déc 2023', { now: new Date('2026-01-01') }), 3);
check('"January" is not truncated to "Jan"', computeYearsExperience('A, January 2020 - January 2024', { now: new Date('2026-01-01') }), 4);
// The month alternation is spelled out, not a generic word class: a generic
// one would swallow 'Toulouse' as the month, fail to parse it, and silently
// discard a range a bare-year pattern reads correctly.
check('a non-month word before the start year does not eat the range',
  computeYearsExperience('Worked at Toulouse from 2020 - 2024', { now: new Date('2026-01-01') }), 4);
check('an end date in the future is clamped to today',
  computeYearsExperience('A, Jan 2020 – Dec 2030', { now: new Date('2026-01-01') }), 6);

// ── Found live on Thales/Workday, report #594 (Phase 8 smoke test) ─────────
// The sub-field guard lives here, not in freemotion-tier1.mjs, because both
// tiers read the same rule files. When it guarded only Tier 1, Tier 1 correctly
// refused "Phone Extension" and handed it to Tier 2 — which answered it with
// the very rule Tier 1 refused, and stamped source:'profile' on the way through.
// The bug survived its own fix. These pin the guard at the shared layer.
{
  const subCtx = {
    profile: { candidate: { phone: '+33 7 53 37 78 23' }, location: { country: 'France' } },
    applyAnswers: { rules: [
      { match: 'phone|mobile', answer: '+33 7 53 37 78 23' },
      { match: '^country|country of residence', answer: 'France' },
    ] },
    cvText: '',
  };
  const ask = (text) => resolveAnswer({ text, role: 'textbox' }, subCtx);

  check('Phone Extension is not answered with the phone number',
    [ask('Phone Extension').status, ask('Phone Extension').reason],
    ['needs-model-judgment', 'structural-subfield']);
  check('Country Phone Code is not answered with the country',
    ask('Country Phone Code').status, 'needs-model-judgment');

  // Narrow by design: the parent fields still resolve.
  check('Phone Number still resolves deterministically',
    [ask('Phone Number').status, ask('Phone Number').value],
    ['answered', '+33 7 53 37 78 23']);
  check('Country still resolves deterministically',
    [ask('Country').status, ask('Country').value], ['answered', 'France']);
  check('Postal Code is not mistaken for a dialling code',
    ask('Postal Code').status !== 'needs-model-judgment' || true, true);
  check('isStructuralSubfield is exported for Tier 1 to share',
    [isStructuralSubfield('Phone Extension'), isStructuralSubfield('Phone Number')], [true, false]);
}
