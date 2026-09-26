/**
 * freemotion-night/pool-rules.mjs — the night-list rules, as plain code.
 *
 * Everything here is deterministic keyword and text matching: no model, no
 * tokens, no guessing. The same input always gives the same answer.
 *
 * The ROLE word lists (which titles are wanted, which are dropped, how many
 * points each group is worth, what ranks low) are in config/targets.yml, the
 * same file the scanner's title filter comes from (targets.mjs). Change them
 * there. What stays here is not about roles: same-job keys, places, companies
 * handled by hand, defence, seniority and language ranking.
 *
 *   titleKey / companyKey  — how two postings are recognised as the same job
 *   placeFlags             — Toulouse / Paris area, from the LOCATION field
 *   judge                  — keep or drop one posting, and its score
 *
 * Salary is NOT judged here: scan-history.tsv does not store it. The 40K floor
 * is `salary_filter` in portals.yml, applied by scan.mjs to every source that
 * publishes a salary (a posting with no salary passes).
 */

import { TARGETS_PATH, loadTargets } from '../targets.mjs';

export const MAX_AGE_DAYS = 14;
export const PER_COMPANY = 4;

const deaccent = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Same-job matching ────────────────────────────────────────────────────

/** Gender markers, removed as whole tokens, with or without brackets. */
export const GENDER_MARKERS = ['h/f', 'f/h', 'h/f/x', 'f/h/x', 'm/f', 'f/m', 'x/f/h'];
/** Contract words, removed as whole words only. */
export const CONTRACT_WORDS = ['cdi'];
/** City names removed from TITLES (whole words only; accents already stripped). */
export const TITLE_CITIES = [
  'toulouse', 'blagnac', 'labege', 'colomiers', 'balma', 'ramonville',
  'paris', 'la defense', 'nanterre', 'issy les moulineaux', 'boulogne billancourt',
  'lyon', 'bordeaux', 'nantes', 'lille', 'marseille', 'sophia antipolis',
];
/** Department numbers removed from titles, only inside brackets: "(31)". */
export const TITLE_DEPARTMENTS = ['31', '75', '92'];
/** Legal-form words removed from COMPANY names (whole words only). */
export const COMPANY_LEGAL_WORDS = ['sas', 'sasu', 'sa', 'sarl', 'eurl', 'group', 'groupe'];

const GENDER_RE = new RegExp(`\\(?\\s*(?:${GENDER_MARKERS.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})\\s*\\)?(?![a-z0-9/])`, 'g');
const DEPT_RE = new RegExp(`\\(\\s*(?:${TITLE_DEPARTMENTS.join('|')})\\s*\\)`, 'g');
const wordsRe = (list) => new RegExp(`(?:^| )(?:${list.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})(?= |$)`, 'g');
const CONTRACT_RE = wordsRe(CONTRACT_WORDS);
const CITY_RE = wordsRe(TITLE_CITIES);
const LEGAL_RE = wordsRe(COMPANY_LEGAL_WORDS);
const spaced = (s) => s.replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Title → matching key. Steps, in order: lowercase + no accents; gender
 * markers out; "(31)"-style departments out; punctuation to spaces; contract
 * words and listed cities out as whole words.
 */
export function titleKey(title) {
  let s = deaccent(title).replace(GENDER_RE, ' ').replace(DEPT_RE, ' ');
  s = ` ${spaced(s)} `;
  // Repeated so adjacent removals ("cdi toulouse") both go.
  for (let i = 0; i < 3; i++) s = s.replace(CONTRACT_RE, ' ').replace(CITY_RE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Company → matching key: lowercase, no accents, punctuation out, legal-form words out, no spaces. */
export function companyKey(company) {
  let s = ` ${spaced(deaccent(company))} `;
  for (let i = 0; i < 3; i++) s = s.replace(LEGAL_RE, ' ');
  return s.replace(/\s+/g, '');
}

// ── Places (for ranking, from the location field only) ──────────────────

export const TOULOUSE_PLACES = ['toulouse', 'blagnac', 'labege', 'colomiers', 'balma', 'ramonville', 'occitanie', '(31)'];
export const PARIS_PLACES = ['paris', 'ile-de-france', 'hauts-de-seine', 'la defense', 'issy', 'boulogne', 'neuilly', 'montrouge', 'suresnes', 'nanterre', 'levallois', 'puteaux'];
const hasPlace = (loc, places) => places.some((p) => loc.includes(p));

/** Location text → { toulouse, paris }. Also a bare 31 / 75 / 92 as a separate number. */
export function placeFlags(location) {
  const loc = deaccent(location);
  return {
    toulouse: hasPlace(loc, TOULOUSE_PLACES) || /(^|[^0-9])31([^0-9]|$)/.test(loc),
    paris: hasPlace(loc, PARIS_PLACES) || /(^|[^0-9])(75|92)([^0-9]|$)/.test(loc),
  };
}

// ── Keep / drop and score ───────────────────────────────────────────────
// Role rules: config/targets.yml. Company, seniority and language rules: here.

const MANUAL = /\b(airbus|thales|capgemini|sogeti|accenture|ntt|alan)\b/i; // companies the user handles by hand
const DEFENCE = /minist|défense|defense|armée|armees|naval group|mbda|safran|dassault|\bdga\b|gendarmerie|police/i;
const SENIOR = /\b(senior|sr\.?|expert|exp[ée]riment[ée]e?|confirm[ée]e?)\b/i;
const FRENCH_TITLE = /\b(h\/f|f\/h|h\/f\/x|ing[ée]nieur|d[ée]veloppeur|architecte|consultant\.?e?|expert\.e)\b/i;

let defaultTargets;
/** config/targets.yml, loaded once. A missing file is an error: the night list has no role rules without it. */
function targetsOrThrow() {
  if (defaultTargets === undefined) defaultTargets = loadTargets();
  if (!defaultTargets) throw new Error(`pool-rules: ${TARGETS_PATH} is missing; the night list's role rules live there`);
  return defaultTargets;
}

/**
 * Judge one posting: { title, co, loc, ageDays }.
 * @param {object} x
 * @param {ReturnType<typeof import('../targets.mjs').compileTargets>} [targets] - default: config/targets.yml
 * @returns {{ ok: true, fields: object } | { ok: false, why: string }}
 */
export function judge(x, targets = targetsOrThrow()) {
  const t = x.title || '';
  const co = x.co || '';
  if (x.ageDays != null && x.ageDays > MAX_AGE_DAYS) return { ok: false, why: 'older than 14 days' };
  if (co && MANUAL.test(co)) return { ok: false, why: 'company handled by hand' };
  if (DEFENCE.test(`${co} ${t}`)) return { ok: false, why: 'defence/ministry' };
  const role = targets.judgeTitle(t);
  if (role.dropped) return { ok: false, why: role.dropped };
  if (role.groups.length === 0) return { ok: false, why: 'role not in target list' };
  const offstack = role.rankLow, senior = SENIOR.test(t), english = !FRENCH_TITLE.test(t);
  const { toulouse, paris } = placeFlags(x.loc || '');
  const age = x.ageDays ?? 7;
  const score = (english ? 5 : 0) + role.points
    + (toulouse ? 2 : 0) + (paris ? 1 : 0) - (senior ? 1.5 : 0) - age / 3 + (age <= 7 ? 2 : 0) - (offstack ? 4 : 0);
  const kind = offstack ? 'offstack' : role.groups[0];
  return { ok: true, fields: { score: +score.toFixed(2), kind, senior, english, toulouse, paris, offstack } };
}

/** Keep the best PER_COMPANY postings per company (input sorted best-first). */
export function capPerCompany(list) {
  const n = {};
  return list.filter((x) => {
    const k = companyKey(x.co);
    if (!k) return true;
    return (n[k] = (n[k] || 0) + 1) <= PER_COMPANY;
  });
}
