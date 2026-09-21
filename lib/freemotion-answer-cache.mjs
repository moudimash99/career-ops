#!/usr/bin/env node

/**
 * freemotion-answer-cache.mjs — remember what we answered, per employer.
 *
 * WHY THIS EXISTS (Requirement 11). A screening question no rule covers costs
 * a model call to answer, and the answer is then thrown away. The same
 * employer asks the same question on its next posting, and it is answered
 * again — for a second fee, and possibly DIFFERENTLY, which is worse than the
 * fee: two applications to one company giving two different notice periods is
 * the kind of thing a recruiter notices.
 *
 * So an answer is cached against the employer AND the exact question, and
 * reused when both match.
 *
 * WHAT IS DELIBERATELY NOT CACHED. A cover letter, ever. The user decided
 * this: a different role gets a different letter even at the same employer,
 * and a reused letter is worse than no letter. Free text long enough to be
 * prose is therefore refused by {@link isCacheable} rather than left to a
 * caller to remember.
 *
 * WHY EVERY ENTRY CARRIES ITS ORIGIN. A wrong answer cached is a wrong answer
 * repeated. Each entry records the date and the posting it came from, so a bad
 * one can be traced back and pulled instead of quietly spreading across an
 * employer's whole pipeline.
 *
 * THE SAME QUESTION AT DIFFERENT EMPLOYERS is not a cache hit — it is a signal
 * that the question deserves a permanent rule in `config/apply-answers.yml`.
 * {@link ruleCandidates} finds those.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Where the cache lives. User layer: it is the user's own answers. */
export const CACHE_PATH = 'data/freemotion-answers.json';

/**
 * Longest answer that may be cached.
 *
 * Above this it is prose, and prose is a letter. See the note above on why a
 * letter is never reused.
 */
export const MAX_CACHEABLE_LENGTH = 200;

/** Normalise an employer or question so trivial differences still match. */
const key = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * May this answer be remembered at all?
 *
 * @param {string} question
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCacheable(question, value) {
  if (value === null || value === undefined) return false;
  const text = String(value);
  if (!text.trim()) return false;
  if (text.length > MAX_CACHEABLE_LENGTH) return false;
  // A field asking for a letter is not cacheable even when the draft is short.
  if (/lettre|motivation|cover letter|message|pourquoi|why do you|tell us/i.test(String(question ?? ''))) return false;
  return true;
}

/** Read the cache, tolerating a missing or corrupt file. */
export function loadCache(path = CACHE_PATH) {
  if (!existsSync(path)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
  } catch {
    // A corrupt cache must never stop an application. Losing remembered
    // answers costs a model call; refusing to run costs the job.
    return { entries: [] };
  }
}

/** Write the cache back. */
export function saveCache(cache, path = CACHE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 1), 'utf-8');
}

/**
 * The remembered answer for this employer and question, if there is one.
 *
 * @returns {{value: string, at: string, fromUrl: string}|null}
 */
export function lookup(cache, employer, question) {
  const e = key(employer);
  const q = key(question);
  if (!e || !q) return null;
  return cache.entries.find((x) => key(x.employer) === e && key(x.question) === q) ?? null;
}

/**
 * Remember an answer. Replaces any previous answer to the same question at the
 * same employer, so a correction sticks rather than competing with the mistake.
 *
 * @returns {{cached: boolean, reason?: string}}
 */
export function remember(cache, { employer, question, value, fromUrl, at = new Date() }) {
  if (!isCacheable(question, value)) return { cached: false, reason: 'not cacheable (prose, empty, or a letter field)' };
  if (!key(employer) || !key(question)) return { cached: false, reason: 'employer or question missing' };

  const existing = cache.entries.findIndex(
    (x) => key(x.employer) === key(employer) && key(x.question) === key(question),
  );
  const entry = {
    employer: String(employer),
    question: String(question),
    value: String(value),
    at: at.toISOString().slice(0, 10),
    fromUrl: String(fromUrl ?? ''),
  };
  if (existing >= 0) cache.entries[existing] = entry;
  else cache.entries.push(entry);
  return { cached: true };
}

/**
 * Drop entries, by employer or by question.
 *
 * The point of the origin fields: a bad answer must be removable without
 * throwing away everything else.
 *
 * @returns {number} how many were removed
 */
export function purge(cache, { employer, question } = {}) {
  const before = cache.entries.length;
  cache.entries = cache.entries.filter((x) => {
    const employerHit = employer ? key(x.employer) === key(employer) : true;
    const questionHit = question ? key(x.question) === key(question) : true;
    // Remove only what matches EVERY filter given.
    return !(employerHit && questionHit && (employer || question));
  });
  return before - cache.entries.length;
}

/**
 * Questions asked by more than one employer.
 *
 * These are the ones that should stop being cached answers and become a
 * permanent rule — a cache spreads one judgement call across one company, a
 * rule answers it everywhere and can be reviewed in one place.
 *
 * @returns {Array<{question: string, employers: string[]}>}
 */
export function ruleCandidates(cache) {
  const byQuestion = new Map();
  for (const entry of cache.entries) {
    const q = key(entry.question);
    if (!q) continue;
    if (!byQuestion.has(q)) byQuestion.set(q, { question: entry.question, employers: new Set() });
    byQuestion.get(q).employers.add(String(entry.employer));
  }
  return [...byQuestion.values()]
    .filter((x) => x.employers.size > 1)
    .map((x) => ({ question: x.question, employers: [...x.employers] }));
}
