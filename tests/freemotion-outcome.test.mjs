// tests/freemotion-outcome.test.mjs — what a submit actually did.
//
// Finding G32: a 200 is not a submission. The loop used to record `submitted`
// the moment its click did not throw, which turns a silent failure into a
// tracker row saying "applied" for a job nobody applied for. These tests pin
// the three rules that stop that:
//
//   - a success is a SENTENCE the page wrote, not an absence of errors;
//   - a refusal beats a success when the page carries both;
//   - neither is `unknown`, which is not a failure and is never a retry.
//
// Phrases are employers' own wording, in the languages this project applies
// in. No vendor is named and none may be.
//
// Run: node test-all.mjs --only freemotion-outcome

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-outcome — the page decides, not the click');

const { classifyOutcome, outcomeAdvice } = await import(
  pathToFileURL(join(ROOT, 'lib/freemotion-outcome.mjs')).href
);

const check = (label, actual, expected) => {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (label, actual) => (actual ? pass(label) : fail(label));

// --- success, in the wording employers actually use ----------------------

const successes = [
  ['French acknowledgement', 'Nous accusons réception de votre candidature.'],
  ['French "saved"', 'Candidature sauvegardée'],
  ['French "sent"', 'Votre candidature a été envoyée avec succès'],
  ['French thanks', 'Merci pour votre candidature, nous reviendrons vers vous.'],
  ['English received', 'Thank you for applying. We have received your application.'],
  ['English submitted', 'Your application has been submitted'],
  ['German', 'Ihre Bewerbung ist erfolgreich eingegangen'],
  ['Spanish', 'Solicitud enviada correctamente'],
];
for (const [label, text] of successes) {
  check(`${label} reads as submitted`, classifyOutcome(text).outcome, 'submitted');
}
ok('a success carries the sentence it matched, for the report',
  classifyOutcome('Nous accusons réception de votre candidature.').evidence.length > 0);

// --- refusal, including the polite ones ----------------------------------

const refusals = [
  ['already applied, French', 'Vous avez déjà postulé à cette offre.'],
  ['already applied, English', 'You have already applied to this position'],
  ['a cooling-off window', 'You applied to this role within the last 30 days'],
  ['a validation complaint', 'Ce champ est obligatoire'],
  ['an English validation complaint', 'This field is required'],
  ['a server error', 'An error occurred, please try again'],
  ['an expired session', 'Your session expired'],
];
for (const [label, text] of refusals) {
  check(`${label} reads as refused`, classifyOutcome(text).outcome, 'refused');
}

// A tenant that has an application on file has NOT taken a new one. Counting
// it as a submission inflates the only number the pipeline is judged on.
check('"already applied" is a refusal, never a success',
  classifyOutcome('Merci pour votre candidature. Vous avez déjà postulé à cette offre.').outcome,
  'refused');

// --- the page that says both ----------------------------------------------

check('a refusal outranks a success on the same page',
  classifyOutcome('Application submitted. Unfortunately an error occurred.').outcome,
  'refused');

// --- neither ---------------------------------------------------------------

check('a page that says neither is unknown, not failed',
  classifyOutcome('Nos offres · Mentions légales · Contact').outcome, 'unknown');
check('an empty page is unknown', classifyOutcome('').outcome, 'unknown');
check('no text at all is unknown', classifyOutcome(null).outcome, 'unknown');
ok('unknown carries no invented evidence', classifyOutcome('nothing here').evidence === null);

ok('the advice for unknown says not to click Submit again',
  /do NOT click Submit again/i.test(outcomeAdvice('unknown')));
ok('the advice for a refusal says not to retry blindly',
  /do not retry blindly/i.test(outcomeAdvice('refused')));

// --- the words that must NOT be enough ------------------------------------
//
// A bare "merci" or "success" appears on pages that have done nothing of the
// sort — a cookie banner, a newsletter box, a marketing strapline.

check('a bare "merci" is not a submission', classifyOutcome('Merci de votre visite').outcome, 'unknown');
check('a bare "success" is not a submission',
  classifyOutcome('Success stories from our team').outcome, 'unknown');
check('the word "received" alone is not a submission',
  classifyOutcome('Awards received in 2025').outcome, 'unknown');

// --- whitespace ------------------------------------------------------------

check('a phrase broken across lines still matches',
  classifyOutcome('Nous accusons\n\n   réception   de votre candidature').outcome, 'submitted');
