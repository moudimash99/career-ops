/**
 * freemotion-night/pool-rules.mjs — the night-list rules, as plain code.
 *
 * Everything here is deterministic keyword and text matching: no model, no
 * tokens, no guessing. The same input always gives the same answer. The word
 * lists are the ones the user approved on 2026-09-24; change them here, in one
 * place, and nowhere else.
 *
 *   titleKey / companyKey  — how two postings are recognised as the same job
 *   placeFlags             — Toulouse / Paris area, from the LOCATION field
 *   judge                  — keep or drop one posting, and its score
 *
 * Salary is NOT judged here: scan-history.tsv does not store it. The 40K floor
 * is `salary_filter` in portals.yml, applied by scan.mjs to every source that
 * publishes a salary (a posting with no salary passes).
 */

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

// ── Keep / drop and score (the 2026-09-23 rules, frontend out 2026-09-24) ──

const MANUAL = /\b(airbus|thales|capgemini|sogeti|accenture|ntt|alan)\b/i; // companies the user handles by hand
const DEFENCE = /minist|défense|defense|armée|armees|naval group|mbda|safran|dassault|\bdga\b|gendarmerie|police/i;
const NOT_CDI_TITLE = /\b(stage|stagiaire|intern(ship)?|alternan\w*|apprenti\w*|trainee|freelance|int[ée]rim)\b/i;
const SENIORITY_OUT = /\b(principal|director|directeur|directrice|head of|vp|chief|staff|lead|manager)\b|product owner|chef de projet|tech ?lead|responsable|technicien|commercial|\bsales\b/i;
const FRONTEND = /front.?end|\breact\b|angular|\bvue(\.?js)?\b/i; // out, 100% (user, 2026-09-24)
const CLOUD = /cloud|aws|azure|gcp|devops|\bsre\b|site reliability|platform|infrastructure|kubernetes|devsecops|finops|mlops/i;
const DATA = /data engineer|ing[ée]nieur data|data platform|analytics engineer|big data|dataops/i;
const PYTHON = /python|backend|back-end|software engineer/i;
const SYSTEMS = /syst[eè]me|systems? engineer|\bmbse\b|\bivvq?\b|v&v|validation|v[ée]rification|int[ée]gration|integration|embarqu|embedded|segment sol|ground segment|g[ée]omat|geospati|\bsig\b|observation de la terre|earth observation/i;
const SOFT = /d[ée]veloppeur|developer|logiciel|software|full.?stack|\bml\b|machine learning|\bia\b|ai engineer|data scientist|data analyst|\bdata\b|donn[ée]es/i;
const OFFSTACK = /salesforce|\bgo\b|golang|\brust\b|\.net|c#|\bjava\b|\bphp\b|\bsap\b/i; // allowed, ranked low
const SENIOR = /\b(senior|sr\.?|expert|exp[ée]riment[ée]e?|confirm[ée]e?)\b/i;
const FRENCH_TITLE = /\b(h\/f|f\/h|h\/f\/x|ing[ée]nieur|d[ée]veloppeur|architecte|consultant\.?e?|expert\.e)\b/i;

/**
 * Judge one posting: { title, co, loc, ageDays }.
 * @returns {{ ok: true, fields: object } | { ok: false, why: string }}
 */
export function judge(x) {
  const t = x.title || '';
  const co = x.co || '';
  if (x.ageDays != null && x.ageDays > MAX_AGE_DAYS) return { ok: false, why: 'older than 14 days' };
  if (co && MANUAL.test(co)) return { ok: false, why: 'company handled by hand' };
  if (DEFENCE.test(`${co} ${t}`)) return { ok: false, why: 'defence/ministry' };
  if (NOT_CDI_TITLE.test(t)) return { ok: false, why: 'intern/freelance/interim' };
  if (SENIORITY_OUT.test(t)) return { ok: false, why: 'lead/manager/technician/sales' };
  if (FRONTEND.test(t)) return { ok: false, why: 'frontend' };
  const cloud = CLOUD.test(t), data = DATA.test(t), python = PYTHON.test(t), systems = SYSTEMS.test(t), soft = SOFT.test(t);
  if (!cloud && !data && !python && !systems && !soft) return { ok: false, why: 'role not in target list' };
  const offstack = OFFSTACK.test(t), senior = SENIOR.test(t), english = !FRENCH_TITLE.test(t);
  const { toulouse, paris } = placeFlags(x.loc || '');
  const age = x.ageDays ?? 7;
  const score = (english ? 5 : 0) + (cloud ? 2 : 0) + (data || python || systems ? 1.5 : 0) + (soft ? 0.5 : 0)
    + (toulouse ? 2 : 0) + (paris ? 1 : 0) - (senior ? 1.5 : 0) - age / 3 + (age <= 7 ? 2 : 0) - (offstack ? 4 : 0);
  const kind = offstack ? 'offstack' : cloud ? 'cloud' : data ? 'data' : systems ? 'systems' : python ? 'python' : 'software';
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
