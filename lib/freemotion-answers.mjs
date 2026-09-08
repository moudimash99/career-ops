#!/usr/bin/env node

/**
 * freemotion-answers.mjs — resolve one form question to one answer, using
 * everything the candidate has already written down, and correctly recognizing
 * the single case where nothing written down decides it.
 *
 * THIS MODULE NEVER ABSTAINS AND NEVER GUESSES. Those are different things, and
 * the distinction is the whole design. Requirement 5 says every question gets
 * an answer in the turn it is found — there is no review queue, no pause, no
 * skip. But the last step of the priority order genuinely requires model
 * judgement ("the model answers", Requirement 5's own words), which a
 * deterministic script cannot produce. So this module resolves everything a
 * fixed set of rules CAN resolve and returns `needs-model-judgment` for the
 * rest, tagged with its category. `agy` answers those immediately, in the same
 * pass. That division is what makes Tier 1/2 cheap: nothing reaches the model
 * that a rule could already have answered.
 *
 * A `needs-model-judgment` return is NOT an abstention. It is a handoff, and
 * the caller is required to fill the field.
 *
 * PRIORITY ORDER (§1.3, with one deviation justified below):
 *
 *   1. A hand-written rule in `config/apply-answers.yml`.
 *   2. A hand-written essay in `config/apply-essays.yml`.
 *   3. For the six legally-consequential categories: the matching key under
 *      `config/profile.yml → application_answers`, then the
 *      `location.visa_status` / `compensation` fallback.
 *   4. The generic `fallback` bio in `config/apply-essays.yml`, for open-ended
 *      motivation prompts only.
 *   5. Mechanical entailment from `cv.md`.
 *   6. Otherwise → `needs-model-judgment`.
 *
 * WHY 3 SITS BETWEEN THE TWO HALVES OF THE ESSAYS FILE. §1.3 orders the essays
 * file wholesale ahead of the category check, on §1.7's reasoning that a rule
 * the user wrote by hand is at least as authoritative as a structured key. That
 * reasoning holds for a SPECIFIC hand-written essay and does not hold for the
 * file's generic `fallback`, which is a bio and is by definition not about this
 * question. Ordered literally, "Describe your salary expectations" — which
 * matches the fallback's motivation shape — would be answered with a paragraph
 * about Airflow instead of `application_answers.compensation`. Splitting the
 * essays file into its specific half (step 2) and its generic half (step 4),
 * with the protected categories between them, keeps §1.7's intent and removes
 * the one case where the literal order produces a wrong answer on a question
 * carrying legal consequences.
 *
 * FOUR SHAPES IN THE REAL FILES THAT LOOK LIKE RESOLUTIONS AND ARE NOT:
 *
 *   - `skip: true` (7 rules in the live file). Under the old per-vendor applier
 *     this meant "skip the whole job". There is no skip any more, so it means
 *     only "this rule offers nothing" and the question falls through (§4.2).
 *   - `answer: ""` (2 rules, both deliberate TODOs — a street address and a
 *     permit expiry date). An empty answer is the user saying "I have not
 *     written this down", which is precisely NOT a resolution. It falls
 *     through — and for the permit-expiry rule that means it lands in step 3's
 *     `work_authorization` category rather than reaching the model, which is
 *     what Requirement 6 demands of anything immigration-adjacent.
 *   - A rule with `choose:` and no `answer:` (the English-proficiency rule).
 *     The choices ARE the answer; the first is returned as `value` and the full
 *     ordered list as `choices` so the caller can try them against the real
 *     option labels.
 *   - `{{years_experience}}` — a token, not a literal. Expanded from `cv.md`
 *     date ranges, so it stays true as the CV changes.
 *
 * Usage:
 *   node lib/freemotion-answers.mjs --question "..." [--ref f2e20] [--role textbox]
 *     [--profile config/profile.yml] [--apply-answers config/apply-answers.yml]
 *     [--apply-essays config/apply-essays.yml] [--cv cv.md] [--article-digest article-digest.md]
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import * as yaml from 'js-yaml';

import { flagValue, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** @typedef {'work_authorization'|'background'|'credentials'|'compensation'|'availability'|'eeo'} ProtectedCategory */

/**
 * The six categories Requirement 6 forbids inferring.
 *
 * Tested in this object's key order, so the more consequential categories are
 * checked first: a question mentioning both a visa and a start date is a visa
 * question.
 *
 * `work_authorization` deviates from the pattern the plan wrote down, and the
 * deviation is load-bearing. The plan's `/work authoriz|legally (able|permitted
 * |entitled) to work/` does NOT match "Are you legally authorised to work
 * full-time in the country where this job is based?" — the real question on the
 * real Greenhouse form captured in this repo's own `.playwright-mcp/` output.
 * Word order ("authorised to work", not "work authorisation") and the missing
 * "authorised" alternative both miss it, and a missed classification here sends
 * an immigration question to the model, which is the one thing Requirement 6
 * exists to prevent. Both spellings are matched in both word orders.
 */
export const PROTECTED_CATEGORY_PATTERNS = {
  work_authorization: /visa|sponsor|right to work|work\s+authoris|work\s+authoriz|authoris\w*\s+to\s+work|authoriz\w*\s+to\s+work|permit\s+(expir|valid)|titre de s[ée]jour/i,
  background: /criminal|conviction|felony|background check|arrest record|disciplinary|terminated for cause/i,
  credentials: /\bdegree\b|diploma|licen[cs]e|certification\b|security clearance|clearance (level|eligibility)|highest level of education/i,
  compensation: /salary|compensation expectation|desired (pay|salary|comp)|pay expectation|expected (annual )?(pay|comp)/i,
  availability: /notice period|available to start|earliest start|start date|when (can|could|would) you start|willing to relocat|willing to travel/i,
  // Broader than the plan's `disability status|veteran status`, because real
  // EEO forms do not phrase it that way: "Are you a protected veteran?" and
  // "Do you have a disability?" are the standard US wordings and both miss a
  // `… status` pattern. Bare `veteran` / `disab` are safe here specifically
  // because eeo is tested LAST — a question that is really about something
  // else has already matched its own category above.
  eeo: /\bgender\b|\brace\b|ethnic|disab|veteran|self.identif|\beeo\b/i,
};

/**
 * Per-category sub-question routing into `application_answers`.
 *
 * Each entry is `{pattern, path}`, tried in array order, most specific first —
 * "will you require sponsorship IN THE FUTURE" has to be checked before the
 * bare "sponsorship" pattern or it resolves to the wrong key and answers the
 * opposite of the truth.
 *
 * A path ending in `_*` is a wildcard: every key under that prefix is
 * enumerated and the one whose suffix appears as a whole word in the question
 * wins (`authorized_to_work_in_france` for "...authorised to work in France").
 * When the question names no country itself but refers to "this job" or "the
 * country where this job is based", the posting country from `ctx.jobCountry` is
 * appended before matching, so that phrasing still resolves inside
 * `application_answers` instead of degrading to the free-text fallback. With no
 * jobCountry the wildcard resolves to nothing and the Requirement-6 fallback
 * takes over.
 *
 * A STARTER SET, per §7: it covers every sub-question the live
 * `application_answers` block has a key for. An unmatched sub-question falls
 * through to the same handoff as any other unmatched field and never blocks.
 */
export const PROTECTED_SUBKEY_TABLE = {
  work_authorization: [
    { pattern: /(now or in the future|in the future|future)[\s\S]{0,40}sponsor|sponsor[\s\S]{0,40}(in the future|future)/i, path: 'work_authorization.requires_sponsorship_future' },
    { pattern: /sponsor/i, path: 'work_authorization.requires_sponsorship_now' },
    { pattern: /authoris|authoriz|right to work|legally/i, path: 'work_authorization.authorized_to_work_in_*' },
  ],
  background: [
    { pattern: /background check|consent/i, path: 'background.consent_to_background_check' },
    { pattern: /criminal|conviction|felony|arrest/i, path: 'background.criminal_record' },
  ],
  credentials: [
    { pattern: /clearance/i, path: 'credentials.security_clearance' },
    { pattern: /licen[cs]e|certification/i, path: 'credentials.licences' },
    { pattern: /degree|diploma|education/i, path: 'credentials.highest_degree' },
  ],
  compensation: [
    { pattern: /minimum|lowest|floor|least/i, path: 'compensation.minimum_annual_gross_eur' },
    { pattern: /single (number|figure)|number only|numeric|digits only/i, path: 'compensation.single_figure_answer' },
    { pattern: /salary|compensation|pay|comp\b/i, path: 'compensation.expected_annual_gross_eur' },
  ],
  availability: [
    { pattern: /notice period/i, path: 'availability.notice_period_days' },
    { pattern: /relocat/i, path: 'availability.willing_to_relocate' },
    { pattern: /travel/i, path: 'availability.willing_to_travel' },
    { pattern: /start|available/i, path: 'availability.earliest_start_date' },
  ],
  eeo: [
    { pattern: /gender/i, path: 'eeo_self_identification.gender' },
    { pattern: /race|ethnic/i, path: 'eeo_self_identification.race_ethnicity' },
    { pattern: /disab/i, path: 'eeo_self_identification.disability_status' },
    { pattern: /veteran|military/i, path: 'eeo_self_identification.veteran_status' },
  ],
};

/**
 * Cues that make a generic bio an acceptable answer.
 *
 * `config/apply-essays.yml`'s own header scopes its `fallback` to "a required
 * free-text question that matches none of the above and reads as motivation or
 * background rather than a factual claim". This is that scope, as an allowlist
 * rather than a blocklist: a bio pasted into "What was the annual revenue
 * impact of your last project?" is a non-answer that LOOKS like an answer,
 * which is worse than handing the question to the model — the model can answer
 * it from the CV, the bio cannot.
 */
const MOTIVATION_CUE = /tell us|tell me|describe|why (are|do|would|this|you|our|us)|what (interests|excites|draws|motivates)|about yourself|anything else|additional information|cover letter|share (anything|more)|in your own words|introduce yourself|^why\b/i;

/** Roles that hold free text, and are therefore essay candidates. */
// `textbox` is what the Playwright accessibility tree calls BOTH `<input
// type=text>` and `<textarea>`, so a caller driving from a snapshot passes it
// for either. `textarea` is accepted alongside it because a caller reading the
// DOM directly (a `browser_evaluate` field inventory, which is the natural way
// to enumerate a form) passes the tag name instead — and being refused a canned
// essay there is silent: the question falls through to "needs-model-judgment"
// and gets an improvised answer while a hand-written one sat unused in
// `config/apply-essays.yml`. A textarea is free text under either vocabulary,
// so accepting both costs nothing and closes the gap.
const FREE_TEXT_ROLES = ['textbox', 'searchbox', 'textarea'];

/** A value written as a placeholder rather than an answer. */
const PLACEHOLDER = /^\s*(todo|tbd|n\/?a|fixme|xxx+|\?+)\b/i;

/**
 * Everything the resolver reads, loaded once per run.
 *
 * @typedef {Object} AnswerContext
 * @property {object} profile - Parsed `config/profile.yml`.
 * @property {{rules: object[]}} applyAnswers
 * @property {{essays: object[], fallback: string, never_auto: string[]}} applyEssays
 * @property {string} cvText
 * @property {string} articleDigestText
 */

/**
 * Read a dot-path out of an object without throwing on a missing branch.
 *
 * @param {object} obj
 * @param {string} path - e.g. `"compensation.expected_annual_gross_eur"`.
 * @returns {unknown}
 */
function readPath(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

/**
 * Whether a value read out of `application_answers` is a real answer.
 *
 * `false` and `0` ARE answers — "do you have a criminal record: false" is the
 * whole point of the block — so this cannot be a truthiness test. Only
 * absent, empty, and placeholder values are non-answers.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean' || typeof value === 'number') return true;
  if (Array.isArray(value)) return true;
  const text = String(value).trim();
  return text !== '' && !PLACEHOLDER.test(text);
}

/**
 * Render a YAML value as the text a form expects.
 *
 * Booleans become Yes/No because that is what a form asks for; an empty list
 * becomes "None" because `licences: []` is an answer ("I hold none"), not a
 * gap. The raw value is returned for everything else and matched against real
 * option labels upstream — this module does not know what options the widget
 * offers.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatAnswerValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.join(', ');
  return String(value);
}

/**
 * Which protected category a question falls into, if any.
 *
 * @param {string} questionText
 * @returns {ProtectedCategory|null} The first pattern that matches, in
 *   {@link PROTECTED_CATEGORY_PATTERNS} key order.
 */
export function classifyCategory(questionText) {
  const text = String(questionText ?? '');
  if (text.trim() === '') return null;
  for (const [category, pattern] of Object.entries(PROTECTED_CATEGORY_PATTERNS)) {
    if (pattern.test(text)) return /** @type {ProtectedCategory} */ (category);
  }
  return null;
}

/**
 * Resolve a wildcard sub-key path (`prefix_*`) against the question text.
 *
 * @param {object} applicationAnswers
 * @param {string} path - Path whose final segment ends in `_*`.
 * @param {string} questionText
 * @returns {{path: string, value: unknown}|null}
 */
function resolveWildcard(applicationAnswers, path, questionText, jobCountry) {
  const cut = path.lastIndexOf('.');
  const blockPath = path.slice(0, cut);
  const prefix = path.slice(cut + 1, -1); // drop the trailing '*'
  const block = readPath(applicationAnswers, blockPath);
  if (block == null || typeof block !== 'object') return null;

  // "Are you legally authorised to work full-time in the country where this
  // job is based?" — the single most common protected question, and the exact
  // wording on the real captured Greenhouse form — names no country at all.
  // Without the posting's own country the wildcard cannot resolve and the
  // answer degrades to the free-text visa_status fallback, which then gets
  // typed into a Yes/No dropdown. The work order already knows the country;
  // appending it makes this deterministic and keeps the answer inside
  // `application_answers`, which is what Requirement 6 asks for.
  const haystack = /this (job|role|position)|the country where|based\b|the location/i.test(questionText) && jobCountry
    ? `${questionText} ${jobCountry}`
    : questionText;

  for (const key of Object.keys(block)) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (suffix === '') continue;
    // Whole-word only: a bare substring test makes "eu" match "Europe",
    // "neural" and "euro", and picks the EU key for a question about France.
    const asWords = suffix.replace(/_/g, '[ _-]');
    if (!new RegExp(`\\b${asWords}\\b`, 'i').test(haystack)) continue;
    const value = block[key];
    if (isUsableValue(value)) return { path: `${blockPath}.${key}`, value };
  }
  return null;
}

/**
 * Answer a question in one of the six protected categories.
 *
 * Resolution order: (1) a {@link PROTECTED_SUBKEY_TABLE} match with a usable
 * value → `source: 'profile'`. (2) ONLY for `work_authorization` and
 * `compensation`, the Requirement-6 fallback → `source: 'fallback'`. (3)
 * otherwise the same handoff every unmatched field gets, tagged with its
 * category so the audit log records what KIND of question the model answered.
 *
 * Step 3 is not a special "protected" abstention. It is the ordinary handoff —
 * but reaching it for a protected category is worth noticing, which is why the
 * category rides along on the return.
 *
 * @param {ProtectedCategory} category
 * @param {string} questionText
 * @param {object} applicationAnswers - The already-parsed `application_answers`
 *   block, or `{}` when absent.
 * @param {{visaStatus?: string, compensation?: {target_range?: string, minimum?: string, currency?: string}}} fallback
 * @returns {{status:'answered', value: string, source:'profile'|'fallback', key: string}
 *   | {status:'needs-model-judgment', category: ProtectedCategory}}
 */
export function resolveProtectedAnswer(category, questionText, applicationAnswers, fallback, { jobCountry } = {}) {
  const block = applicationAnswers ?? {};
  const text = String(questionText ?? '');

  for (const { pattern, path } of PROTECTED_SUBKEY_TABLE[category] ?? []) {
    if (!pattern.test(text)) continue;
    if (path.endsWith('_*')) {
      const hit = resolveWildcard(block, path, text, jobCountry);
      if (hit) return { status: 'answered', value: formatAnswerValue(hit.value), source: 'profile', key: hit.path };
      continue;
    }
    const value = readPath(block, path);
    if (isUsableValue(value)) {
      return { status: 'answered', value: formatAnswerValue(value), source: 'profile', key: path };
    }
  }

  // Requirement 6's explicit fallback, and only for the two categories it
  // names. The other four have no legally-safe generic answer to reach for —
  // there is no default criminal-record status — so they go to the model with
  // their category attached rather than being answered from nothing.
  const fb = fallback ?? {};
  if (category === 'work_authorization' && isUsableValue(fb.visaStatus)) {
    return { status: 'answered', value: String(fb.visaStatus), source: 'fallback', key: 'location.visa_status' };
  }
  if (category === 'compensation') {
    const comp = fb.compensation ?? {};
    const value = comp.target_range ?? comp.minimum;
    if (isUsableValue(value)) {
      const currency = comp.currency ? ` ${comp.currency}` : '';
      return { status: 'answered', value: `${value}${currency}`.trim(), source: 'fallback', key: 'compensation' };
    }
  }

  return { status: 'needs-model-judgment', category };
}

/**
 * Month names a CV date range is actually written with — English and French,
 * abbreviated and full, since the target market is France.
 */
const MONTHS = {
  jan: 1, january: 1, janv: 1, janvier: 1,
  feb: 2, february: 2, févr: 2, fevr: 2, février: 2, fevrier: 2,
  mar: 3, march: 3, mars: 3,
  apr: 4, april: 4, avr: 4, avril: 4,
  may: 5, mai: 5,
  jun: 6, june: 6, juin: 6,
  jul: 7, july: 7, juil: 7, juillet: 7,
  aug: 8, august: 8, août: 8, aout: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, déc: 12, decembre: 12, décembre: 12,
};

// Longest-first so "january" is not matched as "jan" with a stray "uary" left
// over, which would make the year fail to parse and drop the whole range.
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/**
 * One end of a date range. The month alternation is spelled out rather than a
 * generic `[A-Za-z]{3,10}`: a generic word class would swallow the preceding
 * word on "Toulouse 2026", fail to parse it as a month, and silently discard a
 * range that a bare-year pattern would have read correctly.
 */
const POINT = `(?:(?:${MONTH_ALT})\\.?\\s+)?(?:\\d{1,2}[\\/.\\-]\\s*)?(?:19|20)\\d{2}`;
const PRESENT = "present|current|now|ongoing|today|to date|aujourd'hui|actuel";

/**
 * Narrow a CV to its Experience section, when it has one.
 *
 * Education, certifications and side projects all carry date ranges, and none
 * of them is professional experience. `config/apply-answers.yml`'s own comment
 * on the `{{years_experience}}` token already scopes it this way ("computed
 * from the Experience section of cv.md"); this is that scope.
 *
 * A CV with no recognizable Experience heading falls back to the whole text —
 * over-counting is the lesser evil against returning `null` and sending an
 * answerable question to the model.
 *
 * @param {string} text
 * @returns {string}
 */
function experienceSection(text) {
  const heading = /^(#{1,3})\s*(?:professional\s+|work\s+)?(?:experience|employment|expérience)\b.*$/im.exec(text);
  if (!heading) return text;
  const level = heading[1].length;
  const rest = text.slice(heading.index + heading[0].length);
  const next = new RegExp(`^#{1,${level}}\\s`, 'm').exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Total years of professional experience, computed from `cv.md`'s date ranges.
 *
 * Mirrors the `{{years_experience}}` token `config/apply-answers.yml` already
 * uses, so both paths report the same number and both stay true as the CV
 * changes.
 *
 * Ranges are UNIONED, not summed: two overlapping roles are not twice the
 * experience, and summing them inflates the answer on a CV with any concurrent
 * work — which is a false claim submitted under the candidate's name.
 *
 * @param {string} sourceText
 * @param {{now?: Date}} [options]
 * @returns {number|null} Whole years, or `null` when no range is readable.
 */
export function computeYearsExperience(sourceText, { now = new Date() } = {}) {
  const text = experienceSection(String(sourceText ?? ''));
  const nowYear = now.getFullYear() + (now.getMonth() + 1) / 12;

  // Month NAMES, not just numbers. The live cv.md writes every role as
  // "May 2026 – Nov 2026"; a numeric-only pattern matches none of them, and
  // what it does match is the bare "2025–2026" in the EDUCATION headings — so
  // the answer submitted under the candidate's name was computed from their
  // degree dates. Measured on the real file: 1 year before this, 3 after.
  const RANGE = new RegExp(`(${POINT})\\s*(?:-|–|—|to|until)\\s*(${POINT}|${PRESENT})`, 'gi');

  const toDecimalYear = (token) => {
    const t = String(token).trim();
    if (new RegExp(`^(?:${PRESENT})$`, 'i').test(t)) return nowYear;
    const named = new RegExp(`^(${MONTH_ALT})\\.?\\s+((?:19|20)\\d{2})$`, 'i').exec(t);
    if (named) return Number(named[2]) + MONTHS[named[1].toLowerCase()] / 12;
    const m = /^(?:(\d{1,2})[/.\-]\s*)?((?:19|20)\d{2})$/.exec(t);
    if (!m) return null;
    const year = Number(m[2]);
    const month = m[1] ? Number(m[1]) : 1;
    if (month < 1 || month > 12) return null;
    return year + month / 12;
  };

  const spans = [];
  let m;
  while ((m = RANGE.exec(text)) !== null) {
    const start = toDecimalYear(m[1]);
    const end = toDecimalYear(m[2]);
    if (start === null || end === null || end < start) continue;
    // A range starting before 1970 is a birth year or a citation, not a job.
    if (start < 1970 || start > nowYear + 1) continue;
    spans.push([start, Math.min(end, nowYear)]);
  }
  if (spans.length === 0) return null;

  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else { total += curEnd - curStart; [curStart, curEnd] = [s, e]; }
  }
  total += curEnd - curStart;
  return Math.max(0, Math.floor(total));
}

/**
 * Confirm STRONG, mechanical entailment only.
 *
 * Deliberately narrow. This is not an LLM call and must not behave like one:
 * anything subtler than a computed fact returns `entailed: false`, which is the
 * correct outcome, because guessing is step 6's job and step 6 is run by `agy`,
 * not by this module. A deterministic function that guesses is worse than one
 * that hands off, because its guess carries no reasoning into the audit log.
 *
 * @param {string} questionText
 * @param {string} sourceText - `cv.md` plus `article-digest.md` plus the
 *   profile narrative, concatenated.
 * @returns {{entailed: boolean, value: string|null, evidenceSnippet: string|null}}
 */
export function checkEntailment(questionText, sourceText) {
  const text = String(questionText ?? '');
  const none = { entailed: false, value: null, evidenceSnippet: null };
  if (text.trim() === '') return none;

  if (/how many years|years of (professional |relevant |total |work |industry )*experience|experience do you have/i.test(text)) {
    const years = computeYearsExperience(sourceText);
    if (years !== null) {
      return { entailed: true, value: String(years), evidenceSnippet: `computed from ${years} year(s) of date ranges in cv.md` };
    }
  }

  return none;
}

/**
 * Expand the tokens `config/apply-answers.yml` supports.
 *
 * @param {string} answer
 * @param {AnswerContext} ctx
 * @returns {string}
 */
function expandTokens(answer, ctx) {
  if (!answer.includes('{{')) return answer;
  return answer.replace(/\{\{\s*years_experience\s*\}\}/g, () => {
    const years = computeYearsExperience(`${ctx.cvText ?? ''}\n${ctx.articleDigestText ?? ''}`);
    return years === null ? '' : String(years);
  });
}

/**
 * First matching rule in an ordered `{match, ...}` list.
 *
 * A rule whose `match` is not a valid regex is SKIPPED, not thrown on: these
 * files are hand-edited, and one typo must not take down every application in
 * the run.
 *
 * @param {{match?: string}[]} rules
 * @param {string} questionText
 * @returns {object|null}
 */
function firstMatchingRule(rules, questionText) {
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || typeof rule.match !== 'string') continue;
    let re;
    try { re = new RegExp(rule.match, 'i'); } catch { continue; }
    if (re.test(questionText)) return rule;
  }
  return null;
}

/**
 * Whether any pattern in a list matches.
 *
 * @param {string[]} patterns
 * @param {string} questionText
 * @returns {boolean}
 */
function anyPatternMatches(patterns, questionText) {
  for (const p of Array.isArray(patterns) ? patterns : []) {
    if (typeof p !== 'string') continue;
    try { if (new RegExp(p, 'i').test(questionText)) return true; } catch { /* a typo'd pattern matches nothing */ }
  }
  return false;
}

/**
 * Resolve one question.
 *
 * @param {{text: string, ref?: string, role?: string}} question
 * @param {AnswerContext} ctx
 * @returns {{status:'answered', value: string, source: 'profile'|'fallback'|'entailed',
 *            category: ProtectedCategory|null, key?: string, choices?: string[], matchedRule?: string}
 *   | {status:'needs-model-judgment', category: ProtectedCategory|null, question: string}}
 */
/**
 * Sub-fields that must never inherit a rule written for the broader concept
 * their label contains.
 *
 * A form splits one human idea across several inputs — a phone number and its
 * extension, a country and its dialling code — and the narrower input's label
 * necessarily contains the broader word. A `/phone/` or `/^country/` rule then
 * matches it and writes the parent's value into the child. Found live on
 * Thales/Workday (#594): "Phone Extension" received the full phone number and
 * "Country Phone Code" received "France".
 *
 * Lives HERE, not in freemotion-tier1.mjs, because both tiers consult the same
 * rule files. Guarding only Tier 1 moves the field to Tier 2 and Tier 2 answers
 * it with the very rule Tier 1 refused — the bug survives the fix and gets a
 * `source: 'profile'` stamp on the way through.
 *
 * These resolve to `needs-model-judgment`: the deterministic layers know the
 * match is wrong but not what is right, and §1.3's rule is that an unresolved
 * field is answered by the orchestrator, never left blank.
 */
export const STRUCTURAL_SUBFIELDS = [
  /\bextensions?\b|\bext\.?$/i,
  /\bphone\s*code\b|\b(country|dialling|dialing|area)\s*code\b/i,
];

/**
 * Is this field a narrower sub-field of the concept its label names?
 *
 * @param {string} name - The field's label / accessible name.
 * @returns {boolean}
 */
export function isStructuralSubfield(name) {
  return STRUCTURAL_SUBFIELDS.some((re) => re.test(String(name ?? '')));
}

export function resolveAnswer(question, ctx) {
  const text = String(question?.text ?? '');
  const role = String(question?.role ?? '').toLowerCase();
  const context = ctx ?? {};
  const category = classifyCategory(text);

  // Before any rule runs: a sub-field's label contains the broader concept's
  // word, so every rule below would match it and answer with the parent's
  // value. Handing it to the orchestrator is the only correct deterministic
  // outcome.
  if (isStructuralSubfield(text)) {
    return { status: 'needs-model-judgment', category, question: text, reason: 'structural-subfield' };
  }

  // 1. A hand-written rule in config/apply-answers.yml. Checked first even for
  //    a question that would also classify into a protected category (§1.7): a
  //    rule the user wrote by hand is at least as authoritative as a structured
  //    key, and is usually more specific.
  const rule = firstMatchingRule(context.applyAnswers?.rules, text);
  if (rule && rule.skip !== true) {
    const choices = Array.isArray(rule.choose) ? rule.choose.filter((c) => typeof c === 'string' && c.trim() !== '') : [];
    const answer = typeof rule.answer === 'string' ? expandTokens(rule.answer, context).trim() : '';
    // An empty answer is the user saying "I have not written this down" — the
    // two live TODO rules. Not a resolution; fall through.
    if (answer !== '') {
      return { status: 'answered', value: answer, source: 'profile', category, matchedRule: rule.match, ...(choices.length ? { choices } : {}) };
    }
    if (choices.length > 0) {
      return { status: 'answered', value: choices[0], source: 'profile', category, matchedRule: rule.match, choices };
    }
  }

  // 2. A hand-written essay, for free text only. `never_auto` means "no canned
  //    text for this one" and falls through — it is not a stop (§1.7).
  const isFreeText = FREE_TEXT_ROLES.includes(role) || role === '';
  const neverAuto = anyPatternMatches(context.applyEssays?.never_auto, text);
  if (isFreeText && !neverAuto) {
    const essay = firstMatchingRule(context.applyEssays?.essays, text);
    if (essay && typeof essay.answer === 'string' && essay.answer.trim() !== '') {
      return { status: 'answered', value: expandTokens(essay.answer, context).trim(), source: 'profile', category, matchedRule: essay.match };
    }
  }

  // 3. The six protected categories, from the structured block. Ahead of the
  //    generic bio in step 4 — see the header note on why the plan's literal
  //    order is wrong here.
  if (category) {
    const resolved = resolveProtectedAnswer(
      category,
      text,
      context.profile?.application_answers ?? {},
      {
        visaStatus: context.profile?.location?.visa_status,
        compensation: context.profile?.compensation,
      },
      { jobCountry: context.jobCountry },
    );
    if (resolved.status === 'answered') {
      return { status: 'answered', value: resolved.value, source: resolved.source, category, key: resolved.key };
    }
    // Falls through to entailment/handoff, still tagged with its category.
  }

  // 4. The generic bio, for open-ended prompts only, and never for a protected
  //    category — a bio is not an answer to a salary or visa question.
  if (isFreeText && !neverAuto && !category && MOTIVATION_CUE.test(text)) {
    const fallbackEssay = context.applyEssays?.fallback;
    if (typeof fallbackEssay === 'string' && fallbackEssay.trim() !== '') {
      return { status: 'answered', value: fallbackEssay.trim(), source: 'profile', category: null, matchedRule: 'apply-essays.yml fallback' };
    }
  }

  // 5. Mechanical entailment from the CV.
  const entail = checkEntailment(text, `${context.cvText ?? ''}\n${context.articleDigestText ?? ''}`);
  if (entail.entailed) {
    return { status: 'answered', value: entail.value, source: 'entailed', category, key: entail.evidenceSnippet };
  }

  // 6. Handoff. NOT an abstention: the caller must answer and fill this field
  //    in the same pass (Requirement 5).
  return { status: 'needs-model-judgment', category, question: text };
}

/**
 * Load every file the resolver reads.
 *
 * A missing `config/profile.yml` is fatal — nothing downstream can run without
 * the candidate's own data. Every other file is optional and degrades: a run
 * with no `apply-answers.yml` simply sends more questions to the model.
 *
 * @param {{profilePath?: string, applyAnswersPath?: string, applyEssaysPath?: string,
 *          cvPath?: string, articleDigestPath?: string, root?: string}} [paths]
 * @returns {AnswerContext}
 * @throws {Error} When the profile is missing or unparseable.
 */
export function loadAnswerContext(paths = {}) {
  const root = paths.root ?? getCareerOpsRoot();
  const at = (p, fallback) => {
    const chosen = p ?? fallback;
    return isAbsolute(chosen) ? chosen : join(root, chosen);
  };

  const readYaml = (path, optional) => {
    if (!existsSync(path)) {
      if (optional) return null;
      throw new Error(`missing required file: ${path}`);
    }
    try {
      return yaml.load(readFileSync(path, 'utf-8')) ?? null;
    } catch (err) {
      if (optional) return null;
      throw new Error(`unparseable YAML in ${path}: ${err.message}`);
    }
  };
  const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : '');

  const profile = readYaml(at(paths.profilePath, 'config/profile.yml'), false);
  if (!profile || typeof profile !== 'object') {
    throw new Error('config/profile.yml did not parse to an object');
  }

  return {
    profile,
    applyAnswers: readYaml(at(paths.applyAnswersPath, 'config/apply-answers.yml'), true) ?? { rules: [] },
    applyEssays: readYaml(at(paths.applyEssaysPath, 'config/apply-essays.yml'), true) ?? { essays: [], fallback: '', never_auto: [] },
    cvText: readText(at(paths.cvPath, 'cv.md')),
    articleDigestText: readText(at(paths.articleDigestPath, 'article-digest.md')),
  };
}

const USAGE = `Usage:
  node lib/freemotion-answers.mjs --question "<question text>" [options]

Options:
  --ref <ref>              MCP element ref (echoed back in the result)
  --role <role>            snapshot role, e.g. textbox / combobox / radio
  --job-country <country>  the POSTING country. Resolves "authorised to work in
                           the country where this job is based" from
                           application_answers instead of the free-text fallback.
  --profile <path>         default config/profile.yml   (required to exist)
  --apply-answers <path>   default config/apply-answers.yml   (optional)
  --apply-essays <path>    default config/apply-essays.yml    (optional)
  --cv <path>              default cv.md                      (optional)
  --article-digest <path>  default article-digest.md          (optional)
  --root <path>            data root override (tests)

Prints one JSON object:
  {"status":"answered","value":"...","source":"profile|fallback|entailed","category":...}
  {"status":"needs-model-judgment","category":...,"question":"..."}

A needs-model-judgment result is a HANDOFF, not permission to leave the field
blank: decide the most probable answer for this candidate, fill it, and log it
with source 'inferred' plus your reasoning.`;

const VALUE_FLAGS = ['--question', '--ref', '--role', '--job-country', '--profile', '--apply-answers', '--apply-essays', '--cv', '--article-digest', '--root'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

/**
 * CLI entry.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const questionText = flagValue(argv, '--question');
  if (!questionText) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const ctx = loadAnswerContext({
    root: flagValue(argv, '--root'),
    profilePath: flagValue(argv, '--profile'),
    applyAnswersPath: flagValue(argv, '--apply-answers'),
    applyEssaysPath: flagValue(argv, '--apply-essays'),
    cvPath: flagValue(argv, '--cv'),
    articleDigestPath: flagValue(argv, '--article-digest'),
  });

  const ref = flagValue(argv, '--ref');
  const jobCountry = flagValue(argv, '--job-country');
  const result = resolveAnswer(
    { text: questionText, ref, role: flagValue(argv, '--role') },
    jobCountry ? { ...ctx, jobCountry } : ctx,
  );
  console.log(JSON.stringify(ref ? { ref, ...result } : result, null, 2));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
