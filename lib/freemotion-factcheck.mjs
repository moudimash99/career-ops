#!/usr/bin/env node

/**
 * freemotion-factcheck.mjs — refuse prose that claims something the user's own
 * files do not.
 *
 * WHY THIS EXISTS. A batch of generated cover letters carried six invented
 * facts, the worst of which was "ingénieur diplômé de l'ISAE-SUPAERO" — a
 * degree the candidate does not hold, addressed to an employer who could check.
 * Others moved a real 63% latency figure onto the wrong project and credited a
 * real 98% SLA to the wrong system. Every one of them reads perfectly; that is
 * the problem. Prose is checked by a machine before a human is asked to trust
 * it, because a human reading fluent text does not notice a number that moved.
 *
 * AGENTS.md is the law this enforces: "Keywords get reformulated, never
 * fabricated" and "Authorship claims are non-negotiable". This module does not
 * judge style, tone or truth in general. It answers one narrow question: does
 * every checkable claim in this draft appear in the user-authored files?
 *
 * WHAT IT CHECKS, AND WHY ONLY THIS.
 *
 *   - **Figures.** Percentages, and any number of two digits or more. Single
 *     digits are left alone deliberately: "a team of 5" and "3 years" are
 *     everywhere in ordinary prose, and flagging them would make the check
 *     noise that gets switched off. A figure that MATTERS is almost always
 *     two digits or a percentage.
 *   - **Credentials.** Degrees, doctorates, named certifications. These are
 *     the claims an employer can verify and the ones that end an application
 *     when they are wrong.
 *
 * It does NOT check whether a real figure is attached to the right project —
 * a machine cannot see that from the text — so a human still reads the draft.
 * This removes the class of error that fluent writing hides, not all of them.
 */

/** A percentage, or any number of two digits or more. */
const FIGURE_RE = /\b\d+(?:[.,]\d+)?\s*%|\b\d{2,}(?:[.,]\d+)?\b/g;

/**
 * Credential words. Matching one only starts the check — the phrase still has
 * to be absent from the sources to be reported.
 */
// No trailing \b: JavaScript word boundaries are ASCII-only, so a credential
// ending in an accent ("diplômé", "certifié") has a non-word character on both
// sides of the boundary and never matches. That silently let the exact phrase
// this module was written for — "ingénieur diplômé" — through unflagged.
const CREDENTIAL_RE = /(?<![a-z])(ing[ée]nieur dipl[ôo]m[ée]|dipl[ôo]me d'ing[ée]nieur|master|m\.?sc|bachelor|b\.?sc|phd|doctorat|mba|certifi[ée]e?d?|certification)[^.;,\n]{0,40}/gi;

/** Strip accents and case so "diplômé" and "diplome" compare equal. */
const normalize = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase();

/** Numbers written with a space or a non-breaking space between groups. */
const normalizeNumber = (s) => String(s).replace(/[\s ]/g, '').replace(',', '.');

/**
 * Every checkable claim in a draft.
 *
 * @param {string} text
 * @returns {{figures: string[], credentials: string[]}}
 */
export function extractClaims(text) {
  const body = String(text ?? '');
  const figures = [...new Set((body.match(FIGURE_RE) ?? []).map((f) => f.trim()))];
  const credentials = [...new Set((body.match(CREDENTIAL_RE) ?? []).map((c) => c.trim()))];
  return { figures, credentials };
}

/**
 * Which claims in the draft are not backed by the user's own files.
 *
 * @param {string} draft - the prose about to be sent.
 * @param {string[]} sources - cv.md, article-digest.md, profile text.
 * @returns {{ok: boolean, unsupported: Array<{kind: string, claim: string}>}}
 */
export function checkClaims(draft, sources = []) {
  const haystack = normalize(sources.join('\n'));
  const haystackNumbers = new Set((haystack.match(/\d+(?:[.,]\d+)?/g) ?? []).map(normalizeNumber));
  const { figures, credentials } = extractClaims(draft);
  const unsupported = [];

  for (const figure of figures) {
    const bare = normalizeNumber(figure.replace('%', '').trim());
    if (!haystackNumbers.has(bare)) unsupported.push({ kind: 'figure', claim: figure });
  }

  for (const credential of credentials) {
    // Compare on the credential WORD, not the whole phrase: a draft may say
    // "Master's in Data Science" where the CV says "M.Sc. Data Science", and
    // the point is whether the qualification exists at all, not the wording.
    const head = normalize(credential).split(/\s+/)[0].replace(/[^a-z.]/g, '');
    if (head && !haystack.includes(head)) unsupported.push({ kind: 'credential', claim: credential });
  }

  return { ok: unsupported.length === 0, unsupported };
}

/**
 * What to tell the writer so the next draft is better than the last.
 *
 * Names the offending claims and says the one thing that fixes them — drop it,
 * do not rephrase it — because a rewrite that keeps an invented number and
 * changes the sentence around it passes nothing.
 *
 * @param {Array<{kind: string, claim: string}>} unsupported
 * @returns {string}
 */
export function rejectionNote(unsupported) {
  const lines = unsupported.map((u) => `  - ${u.kind}: "${u.claim}"`);
  return [
    'Your draft claims things that do not appear in the candidate\'s CV or profile:',
    ...lines,
    '',
    'REMOVE them. Do not rephrase them, do not soften them, do not replace them with',
    'a different number. Write the letter without those claims. A shorter honest',
    'letter is correct; an invented qualification ends the application.',
  ].join('\n');
}
