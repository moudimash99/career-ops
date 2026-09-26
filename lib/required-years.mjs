// @ts-check
/**
 * lib/required-years.mjs — how many years of experience a posting asks for.
 *
 *   requiredYears(text)        → number | null   from posting text
 *   requiredYearsFromLabel(s)  → number | null   from a board's own field
 *                                                ("5 An(s)", "Expérience exigée de 36 Mois")
 *
 * Used by scan.mjs to drop postings asking for `too_many_years` or more
 * (config/targets.yml), and by the night list for postings whose text is only
 * fetched there (HelloWork, LinkedIn).
 *
 * Built to be wrong in the safe direction: a wrong number can throw a good job
 * away, a missed number only keeps one. So a number counts only right next to
 * an experience word (or "au moins / at least N years"), numbers above 20 are
 * ignored (company age: "depuis 30 ans"), phrases about the company or a part
 * of the requirement ("forte de 25 ans d'expérience", "dont 3 ans sur AWS")
 * are skipped, a range counts by its low end ("5 à 10 ans" → 5), and when a
 * posting states several numbers the smallest wins.
 */

const MAX_YEARS = 20;

const NUMBER_WORDS = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15,
};

/** Lowercase, straight quotes, plain spaces, number words as digits. */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[  \t\r\n]+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/\b(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|one|two|three|four|five|seven|eight|nine|ten|eleven|twelve|fifteen)\b(?=\s*(?:\(\d+\)\s*)?(?:\+\s*)?(?:ans?\b|années?|annees?|years?|yrs?|mois|months?))/g,
      (w) => String(NUMBER_WORDS[w]))
    .replace(/ {2,}/g, ' ');
}

const N = String.raw`(\d{1,2}(?:[.,]5)?)`;
// "5", "5+", "5 ou plus", "5 à 10", "5-10", "5 to 10"
const RANGE = String.raw`${N}\s*(?:\+|ou plus|et plus)?\s*(?:(?:à|a|-|to|/)\s*${N}\s*\+?)?`;
const YEARS = String.raw`(?:ans?\b|années?|annees?|an\(s\)|years?\b|yrs?\b)`;
const MONTHS = String.raw`(?:mois|months?)`;
const EXP = String.raw`(?:expérience|experience|exp\b|xp\b)`;

/** Each pattern's first capture is the (low) number; `unit` says years or months. */
const PATTERNS = [
  // "5 ans d'expérience", "5 à 7 ans minimum d'expérience", "10+ years of professional experience"
  { re: new RegExp(String.raw`${RANGE}\s*${YEARS}\s*(?:minimum\s+|min\.?\s+|au moins\s+|révolus\s+)?(?:d'|de\s+|d\s|of\s+)?(?:[a-zà-ÿ-]+\s+){0,3}?${EXP}`, 'g'), unit: 'y' },
  // "expérience de 5 ans", "expérience professionnelle minimum de 8 ans", "Expérience exigée de 10 An(s)", "experience: 5 years"
  { re: new RegExp(String.raw`${EXP}\s*(?:[a-zà-ÿ-]+\s+){0,3}?(?:de\s+|d'au moins\s+|d'environ\s+|of\s+|:\s*|\(\s*)?(?:au moins\s+|minimum\s+|plus de\s+|environ\s+|at least\s+)?${RANGE}\s*${YEARS}`, 'g'), unit: 'y' },
  { re: new RegExp(String.raw`${EXP}\s*(?:[a-zà-ÿ-]+\s+){0,3}?(?:de\s+|of\s+|:\s*|\(\s*)?${RANGE}\s*${MONTHS}`, 'g'), unit: 'm' },
  { re: new RegExp(String.raw`${RANGE}\s*${MONTHS}\s*(?:minimum\s+)?(?:d'|de\s+|of\s+)${EXP}`, 'g'), unit: 'm' },
  // "au moins 8 ans dans un poste similaire", "at least 7 years in", "minimum of 5 years"
  { re: new RegExp(String.raw`(?:au moins|au minimum|minimum(?: of)?|at least|min\.)\s+(?:de\s+)?${RANGE}\s*${YEARS}`, 'g'), unit: 'y' },
  // "5+ years in DevOps", "7 years working with Kubernetes"
  { re: new RegExp(String.raw`${RANGE}\s*${YEARS}\s+(?:in|with|as|working|building|designing|developing|leading|managing|dans|en tant que)\b`, 'g'), unit: 'y' },
];

// The phrase right before the number says it is not the candidate's requirement.
const NOT_A_REQUIREMENT_BEFORE = /(?:\b(?:depuis|since|over the|for over|il y a|fondée?|founded|créée?|existe|cumul\w*|dont|including|of which|forte? de|riche de|fort de|past|last|within|bac\s*\+?)\s*(?:plus de\s+|more than\s+|over\s+|près de\s+)?)$/;

/**
 * Smallest required years stated in a posting's text, or null.
 * @param {string} text
 * @returns {number|null}
 */
export function requiredYears(text) {
  const t = normalize(text);
  if (!t) return null;
  let best = null;
  for (const { re, unit } of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(t));) {
      // Look right before the NUMBER, not the match: "expérience dont 2 ans".
      const at = m.index + m[0].search(/\d/);
      const before = t.slice(Math.max(0, at - 30), at);
      if (NOT_A_REQUIREMENT_BEFORE.test(before)) continue;
      const raw = Number(m[1].replace(',', '.'));
      if (!Number.isFinite(raw)) continue;
      const years = unit === 'm' ? Math.floor(raw / 12) : raw;
      if (years > MAX_YEARS) continue;
      if (best === null || years < best) best = years;
    }
  }
  return best;
}

/**
 * A board's own experience field: "5 An(s)", "Expérience exigée de 3 An(s)",
 * "36 Mois", "Débutant accepté" (→ 0), or a bare number of years.
 * @param {string|number|null|undefined} label
 * @returns {number|null}
 */
export function requiredYearsFromLabel(label) {
  if (typeof label === 'number') return Number.isFinite(label) && label >= 0 && label <= MAX_YEARS ? label : null;
  const t = normalize(label);
  if (!t) return null;
  if (/d[ée]butant/.test(t)) return 0;
  const m = t.match(new RegExp(String.raw`${N}\s*(${YEARS}|${MONTHS})`));
  if (!m) return null;
  const raw = Number(m[1].replace(',', '.'));
  const years = /mois|month/.test(m[2]) ? Math.floor(raw / 12) : raw;
  return years <= MAX_YEARS ? years : null;
}
