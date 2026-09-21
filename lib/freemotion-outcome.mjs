#!/usr/bin/env node

/**
 * freemotion-outcome.mjs — decide what a submit actually did, from the page's
 * own words.
 *
 * WHY THIS EXISTS. Finding G32: a 200 is not a submission. A fired request, a
 * button that vanished, a URL that changed, a green tick drawn by the page's
 * own JavaScript before the server answered — none of them prove an employer
 * received anything. The loop that wrote this module previously recorded
 * `submitted` the instant its click did not throw, which turns a silent
 * failure into a tracker row that says "applied" and a job quietly never
 * applied for. That is the worst failure this project has, because it is
 * invisible: nothing looks broken.
 *
 * So the outcome is read from the rendered text, against two lists, and the
 * answer has THREE values, not two:
 *
 *   - `submitted`  — a success phrase is on the page.
 *   - `refused`    — a refusal or error phrase is on the page.
 *   - `unknown`    — neither. NOT a failure, and emphatically not a retry:
 *                    check the inbox for an acknowledgement. Clicking Submit
 *                    a second time is how one candidate applies twice.
 *
 * A refusal outranks a success when both appear, because a page that says
 * "application sent" above "you already applied to this role within the last
 * 30 days" has not sent one.
 *
 * NO VENDOR NAME APPEARS IN THIS FILE. The phrases are the sentences employers'
 * software writes to candidates, in the languages this project applies in; they
 * are not tied to who built the form.
 */

/**
 * Sentences that mean the employer has it.
 *
 * Deliberately specific. "Merci" or "success" alone appear on pages that have
 * done nothing of the sort.
 */
export const SUCCESS_PHRASES = [
  /candidature (sauvegard[ée]e|envoy[ée]e|enregistr[ée]e|transmise|bien re[çc]ue)/i,
  /(nous )?accusons r[ée]ception/i,
  /(a )?bien [ée]t[ée] (envoy[ée]e|re[çc]ue|enregistr[ée]e|transmise|prise en compte)/i,
  /merci (pour votre|de votre) candidature/i,
  /votre candidature a [ée]t[ée] (envoy[ée]e|transmise|enregistr[ée]e)/i,
  /thank you for (applying|your application|your interest)/i,
  /(your )?application (has been )?(submitted|sent|received|completed)/i,
  /successfully (submitted|applied|sent)/i,
  /we(?:'| ha)ve received your application/i,
  // The verb can sit several words from the noun ("Bewerbung IST ERFOLGREICH
  // eingegangen"), so the gap is allowed rather than spelled out.
  /bewerbung\b.{0,24}\b(eingegangen|[üu]bermittelt|erhalten)/i,
  /solicitud (enviada|recibida|registrada)/i,
];

/**
 * Sentences that mean it did not go through — including the polite ones.
 *
 * "Already applied" belongs here, not in success: the employer has an
 * application, but THIS attempt sent nothing, and recording it as a fresh
 * submission inflates the only number the whole pipeline is judged on.
 */
export const REFUSAL_PHRASES = [
  /d[ée]j[àa] postul[ée]/i,
  /already applied/i,
  /within the last \d+ days/i,
  /(couldn'?t|could not|unable to) (submit|send|process)/i,
  /n'a pas pu [êe]tre (envoy[ée]e|trait[ée]e|enregistr[ée]e)/i,
  /une erreur (est survenue|s'est produite)/i,
  /(an )?error (occurred|has occurred)/i,
  // "champ obligatoire" and "ce champ EST obligatoire" are the same complaint.
  /champs?\b.{0,12}\bobligatoires?/i,
  /(this )?field is required/i,
  /veuillez (corriger|remplir|v[ée]rifier)/i,
  /please (correct|complete|fill in|check) /i,
  /session (expired|expir[ée]e)/i,
  /try again/i,
];

/**
 * The refusals that mean "we already have one from you", as opposed to "this
 * form is wrong".
 *
 * Worth separating because they call for opposite actions: a validation
 * failure is fixable on this page and worth another turn; an existing
 * application is final, and the honest ledger state for it is `already-applied`
 * rather than a failure of ours.
 */
export const ALREADY_APPLIED_PHRASES = [
  /d[ée]j[àa] postul[ée]/i,
  /already applied/i,
  /within the last \d+ days/i,
  /candidature (d[ée]j[àa]|existante)/i,
];

/**
 * Is this refusal an existing application rather than a broken form?
 *
 * @param {string} evidence
 * @returns {boolean}
 */
export function isAlreadyApplied(evidence) {
  const text = String(evidence ?? '');
  return ALREADY_APPLIED_PHRASES.some((re) => re.test(text));
}

/** Longest excerpt returned around a match, in characters. */
const CONTEXT = 140;

/**
 * Read the outcome from the page's text.
 *
 * @param {string} pageText - the rendered body text, whitespace already loose.
 * @returns {{outcome: 'submitted'|'refused'|'unknown', evidence: string|null, matched: string|null}}
 */
export function classifyOutcome(pageText) {
  const text = String(pageText ?? '').replace(/\s+/g, ' ');

  const find = (patterns) => {
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) {
        const start = Math.max(0, m.index - 40);
        return { matched: String(re), evidence: text.slice(start, start + CONTEXT).trim() };
      }
    }
    return null;
  };

  // Refusal first: a page can say both, and the refusal is the true one.
  const bad = find(REFUSAL_PHRASES);
  if (bad) return { outcome: 'refused', ...bad };

  const good = find(SUCCESS_PHRASES);
  if (good) return { outcome: 'submitted', ...good };

  return { outcome: 'unknown', evidence: null, matched: null };
}

/**
 * What a caller should DO with each outcome, in one line, for the run report.
 *
 * `unknown` is the one worth spelling out: the instinct is to click again, and
 * clicking again is the mistake.
 */
export function outcomeAdvice(outcome) {
  if (outcome === 'submitted') return 'The page confirmed it. Record and move on.';
  if (outcome === 'refused') return 'The page refused it. Read the reason; do not retry blindly.';
  return 'The page said neither. Check the inbox for an acknowledgement — do NOT click Submit again.';
}
