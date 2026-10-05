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
// Defence employers usually need French nationality or a clearance. Matched on
// company + title. Whole words where a bare stem hit other jobs (2026-09-27):
// "minist" matched adMINISTrateur (107 sysadmin/DevOps jobs dropped), "dassault"
// matched Dassault Systèmes (software, not defence), and "La Défense" is a Paris
// business district, not a sector.
// 2026-10-04: + counter-UAS / anti-drone, missiles, weapons, military words and
// two land-systems makers ("Counter-UAS" at Groupe ADP reached a night list).
// Safran out (user, 2026-10-04): mostly civil aerospace; its defence jobs are
// the fit score's sector answer (llm-sector.mjs), like any posting's text.
const DEFENCE = /\bminist[eè]res?\b|\bministry\b|(?<!la )d[ée]fense\b|\bdefence\b|\barm[ée]es?\b|\bmilitaires?\b|\bmilitary\b|\barmement|\bmissiles?\b|counter[- ]?uas\b|anti[- ]?drones?\b|naval group|\bmbda\b|dassault aviation|\bknds\b|\bnexter\b|\bdga\b|gendarmerie|\bpolice\b/i;
// Public administrations by name (user, 2026-10-04: government jobs dropped).
// Public bodies with other names (France Travail, URSSAF, a CHU) are the model's call.
const GOVERNMENT = /\bmairie\b|\bville de\b|\bpr[ée]fecture\b|\bconseil (d[ée]partemental|r[ée]gional|g[ée]n[ée]ral)\b|\bcollectivit[ée]s?\b|fonction publique|\b[ée]tablissement public\b/i;
const SENIOR = /\b(senior|sr\.?|expert|exp[ée]riment[ée]e?|confirm[ée]e?)\b/i;
// Posting language. The English flag gives the +5 below AND tells the applier
// which language to write the cover letter in (make-jobs.mjs), so a French
// posting read as English gets an English letter. Until 2026-09-26 it was
// "the title has no H/F marker": every French title without one ("Chef de
// Projet Cybersécurité", "Admin système Linux et Cloud") counted as English,
// Free-Work (few H/F markers) filled the list and HelloWork (always H/F) vanished.
// Now: the posting text decides when there is enough of it; the title only
// when there is none. Both compared without accents.
const FRENCH_TITLE = /\b(h\/f|f\/h|h\/f\/x|f\/h\/x|ingenieure?|developpeur|developpeuse|architecte|consultante?|expert\.e|chef|projet|responsable|administrateur|administratrice|analyste|gestionnaire|technicien|technicienne|coordinateur|coordinatrice|formateur|formatrice|integrateur|referent|referente|donnees|systemes?|reseaux?|securite|confirme|confirmee|experimente|experimentee|exploitation|recette|plateforme|ingenierie|charge|chargee|de|des|du|et|en|pour|sur)\b/;
const FR_WORDS = new Set(['le', 'la', 'les', 'des', 'du', 'une', 'et', 'pour', 'vous', 'nous', 'avec', 'dans', 'sur', 'est', 'sont', 'votre', 'notre', 'au', 'aux', 'qui', 'que', 'nos', 'vos', 'ou', 'par', 'plus']);
const EN_WORDS = new Set(['the', 'and', 'for', 'you', 'we', 'with', 'our', 'your', 'are', 'is', 'to', 'of', 'will', 'this', 'that', 'in', 'on', 'as', 'be', 'an', 'or', 'who', 'what', 'about']);
const MIN_TEXT_WORDS = 40;

// ── Night-list rank (user, 2026-09-26) ──────────────────────────────────
// A model-scored job ranks by its fit (the model's 1-5 overall) plus small
// nudges for the user's preferences, sized to break near-ties and never to
// override the fit: a 4.8 Toulouse job beats a 4.6 Paris English one, a 5.0
// Paris English one beats both. Before this, the fit only replaced the role
// points inside the rule score below, where English +5 and Toulouse +2
// outweighed it: of the 154 jobs the model rated 4.5+, 10 reached a 75-job
// list. The rule score still orders jobs for scoring and for jobs the model
// has not seen; a scored job ranks by rankScore() only (make-pool rankOrder).
// offstack keeps targets.yml `rank_low` meaning "ranked low" at this scale.
// sectorPenalty: targets.yml `sectors.penalty` for the job's sector (space -1,
// user 2026-10-04), set by llm-sector.mjs applySectors().
export const RANK_NUDGES = { toulouse: 0.3, paris: 0.1, english: 0.2, offstack: -0.5 };

/** @param {{ fit: number, toulouse?: boolean, paris?: boolean, english?: boolean, offstack?: boolean, sectorPenalty?: number }} x */
export function rankScore(x) {
  const place = x.toulouse ? RANK_NUDGES.toulouse : x.paris ? RANK_NUDGES.paris : 0;
  const r = Number(x.fit) + place + (x.english ? RANK_NUDGES.english : 0) + (x.offstack ? RANK_NUDGES.offstack : 0) + (x.sectorPenalty || 0);
  return Math.round(r * 100) / 100;
}

/**
 * Is this posting written in English? The text decides when it has at least
 * MIN_TEXT_WORDS words (common French vs English words, counted); otherwise
 * the title (no French marker or French job word = English).
 * @param {string} title
 * @param {string} [text]
 */
export function isEnglishPosting(title, text) {
  const words = deaccent(text).split(/[^a-z]+/).filter(Boolean);
  if (words.length >= MIN_TEXT_WORDS) {
    let fr = 0, en = 0;
    for (const w of words) { if (FR_WORDS.has(w)) fr++; else if (EN_WORDS.has(w)) en++; }
    return en > fr;
  }
  return !FRENCH_TITLE.test(deaccent(title));
}

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
  if (GOVERNMENT.test(`${co} ${t}`)) return { ok: false, why: 'government' };
  const role = targets.judgeTitle(t);
  if (role.dropped) return { ok: false, why: role.dropped };
  // Kept, but not for agy on the title alone: the model (llm-score.mjs) decides.
  //   unmatched  none of our role words ("Ingénieur Sysops Linux")
  //   rescue     a rescue word, no role word ("Presales Engineer")
  //   unsure     a non-fit word next to a role word ("Software Engineer - Sales team")
  const needsModel = role.groups.length === 0 || role.unsure;
  const offstack = role.rankLow, senior = SENIOR.test(t), english = isEnglishPosting(t, x.text);
  const { toulouse, paris } = placeFlags(x.loc || '');
  const age = x.ageDays ?? 7;
  const score = (english ? 5 : 0) + role.points
    + (toulouse ? 2 : 0) + (paris ? 1 : 0) - (senior ? 1.5 : 0) - age / 3 + (age <= 7 ? 2 : 0) - (offstack ? 4 : 0);
  const kind = role.unsure ? 'unsure' : role.groups.length === 0 ? (role.rescued ? 'rescue' : 'unmatched') : offstack ? 'offstack' : role.groups[0];
  return { ok: true, fields: { score: +score.toFixed(2), points: role.points, kind, needsModel, senior, english, toulouse, paris, offstack } };
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
