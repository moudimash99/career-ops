// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// APEC provider — the Association pour l'emploi des cadres, France's national
// board for "cadre" (professional/managerial) roles. It is the single biggest
// French source this scanner was blind to: the ATS providers cover Greenhouse,
// Lever, Ashby, Workday and friends, which the French mid-market and the ESNs
// barely use. A full 7-day sweep of 10,891 ATS postings on 2026-09-12 produced
// two Toulouse rows; APEC alone returns thousands for a single keyword.
//
// Transport: the same public JSON endpoint the apec.fr search page calls. No
// authentication, no key, no cookie. POST a JSON body, get results back.
//
//   POST https://www.apec.fr/cms/webservices/rechercheOffre
//   { motsCles, pagination: { range, startIndex }, sorts, activeFiltre }
//   -> { resultats: [...], offreFilters: [...], totalCount }
//
// The board is national and enormous, so a `apec:` config block with explicit
// search queries is REQUIRED — without one the provider throws rather than
// silently scanning an arbitrary slice. This mirrors providers/wttj.mjs.
//
//   - name: APEC
//     provider: apec
//     apec:
//       queries: ["devops", "ingénieur cloud", "site reliability engineer"]
//       departments: ["31", "75"]   # optional, see below
//       max_hits: 100               # optional, per query, capped at 200
//     enabled: true
//
// LOCATION. APEC's search body takes a `lieux` array, and the values are the
// ordinary French department numbers as strings: "31" is Haute-Garonne, "75"
// is Paris. Verified on 2026-09-13 — `lieux: ["31"]` narrowed "devops" from
// 2465 national hits to 191, and every returned row was Toulouse, Balma or
// Colomiers.
//
// Why this matters enough to support here rather than leaving it to scan.mjs:
// results are date-sorted and truncated at `max_hits`, so on a national query
// the newest N are overwhelmingly Paris and a Toulouse role never appears in
// the slice at all. Filtering server-side is the difference between seeing the
// regional market and not seeing it. When `departments` is omitted the search
// stays national and scan.mjs's location_filter does the narrowing as usual.
//
// The response also exposes a LOCATION_FILTERING facet whose keys are opaque
// internal ids (799 = the whole country, plus small unlabelled buckets). Those
// are NOT the same namespace as `lieux` and are not used here.

const SEARCH_URL = 'https://www.apec.fr/cms/webservices/rechercheOffre';
const TRUSTED_HOST = 'www.apec.fr';
const OFFER_BASE = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre';
const DEFAULT_MAX_HITS = 100;
const MAX_HITS_CAP = 200;

/** Pin a URL to the expected https host. */
function assertApecUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`apec: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`apec: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`apec: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Parse APEC's `salaireTexte` into the scanner's salary shape.
 *
 * Observed forms: "65 - 75 k€ brut annuel", "45 k€ brut annuel",
 * "A partir de 40 k€". The figures are in thousands of euros, so "65" is
 * 65000. Anything that does not yield at least one number returns null —
 * salary is optional and a wrong number is worse than none, because
 * scan.mjs's salary_filter would gate on it.
 *
 * Exported for tests.
 *
 * @param {unknown} text
 * @returns {{ min: number, max: number, currency: string } | null}
 */
export function parseApecSalary(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Only trust the "k€" form; a bare number could be anything (hours, days).
  if (!/k\s*€|k\s*eur/i.test(text)) return null;
  const nums = (text.match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => Number(n.replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1000);
  if (nums.length === 0) return null;
  const scaled = nums.map((n) => Math.round(n * 1000));
  const min = Math.min(...scaled);
  const max = Math.max(...scaled);
  return { min, max, currency: 'EUR' };
}

/**
 * Normalize a single APEC search hit. Exported for tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `intitule` (items without one are dropped).
 *   - url:      built from `numeroOffre` against the public detail path. The
 *               id is constrained to [A-Za-z0-9-] so it can never inject a
 *               path segment or escape the host.
 *   - company:  `nomCommercial`. APEC allows confidential postings, where this
 *               is empty — the entry name is used, then "APEC", matching the
 *               contract's "populated downstream" note.
 *   - location: `lieuTexte`, e.g. "Paris 16 - 75" or "Toulouse - 31".
 *   - postedAt: `datePublication` (ISO 8601) → epoch ms, omitted when absent
 *               or unparseable.
 *   - salary:   parsed from `salaireTexte` when it carries a k€ figure.
 *   - description: `texteOffre`, which the list payload already carries, so
 *               no extra request is made. This feeds scan.mjs's content_filter.
 *
 * @param {any} h
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min:number,max:number,currency:string} } | null}
 */
export function normalizeApecHit(h, fallbackCompany) {
  if (!h || typeof h !== 'object') return null;

  const title = typeof h.intitule === 'string' ? h.intitule.trim() : '';
  if (!title) return null;

  const id = typeof h.numeroOffre === 'string' ? h.numeroOffre.trim() : '';
  // The id goes straight into a URL path — keep it to characters that cannot
  // introduce a segment, a query, or a host.
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return null;

  const url = `${OFFER_BASE}/${id}`;

  const company =
    (typeof h.nomCommercial === 'string' && h.nomCommercial.trim()) ||
    (typeof fallbackCompany === 'string' && fallbackCompany.trim()) ||
    'APEC';

  const location = typeof h.lieuTexte === 'string' ? h.lieuTexte.trim() : '';

  /** @type {any} */
  const job = { title, url, company, location };

  const desc = typeof h.texteOffre === 'string' ? h.texteOffre.trim() : '';
  if (desc) job.description = desc;

  const published = typeof h.datePublication === 'string' ? h.datePublication : '';
  if (published) {
    const ts = Date.parse(published);
    if (Number.isFinite(ts) && ts > 0) job.postedAt = ts;
  }

  const salary = parseApecSalary(h.salaireTexte);
  if (salary) job.salary = salary;

  return job;
}

/**
 * Normalize the configured department list into APEC `lieux` values.
 *
 * Accepts numbers or strings and keeps only plausible French department codes:
 * two digits ("31"), the Corsican "2A"/"2B", and three digits for the overseas
 * departments ("971"). A bad entry is dropped rather than sent, because APEC
 * answers an unrecognised code with an empty result set — which looks exactly
 * like "no jobs here" and would silently hide a whole region.
 *
 * Exported for tests.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDepartments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    const s = typeof d === 'number' ? String(d) : typeof d === 'string' ? d.trim() : '';
    if (!s) continue;
    if (!/^(\d{2,3}|2[AB])$/i.test(s)) continue;
    const up = s.toUpperCase();
    if (!out.includes(up)) out.push(up);
  }
  return out;
}

/** Resolve config: required queries list, optional departments and hit cap. */
function resolveConfig(entry) {
  const cfg = entry?.apec && typeof entry.apec === 'object' ? entry.apec : {};
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    : [];
  if (queries.length === 0) {
    throw new Error(
      'apec: the APEC board is national — configure explicit searches via `apec: { queries: ["…"] }`',
    );
  }
  const departments = normalizeDepartments(cfg.departments);
  const maxHits =
    Number.isInteger(cfg.max_hits) && cfg.max_hits > 0
      ? Math.min(cfg.max_hits, MAX_HITS_CAP)
      : DEFAULT_MAX_HITS;
  return { queries, departments, maxHits };
}

/** @type {Provider} */
export default {
  id: 'apec',

  detect(entry) {
    return entry?.provider === 'apec' ? { url: `https://${TRUSTED_HOST}` } : null;
  },

  async fetch(entry, ctx) {
    const { queries, departments, maxHits } = resolveConfig(entry);
    const url = assertApecUrl(SEARCH_URL);

    // One search per configured term; dedup across terms by posting URL, since
    // "devops" and "ingénieur cloud" overlap heavily.
    const byUrl = new Map();

    for (const query of queries) {
      /** @type {any} */
      const payload = {
        motsCles: query,
        pagination: { range: maxHits, startIndex: 0 },
        // Newest first: the scanner's whole job is finding what is new, and it
        // keeps the per-query slice meaningful when maxHits truncates.
        sorts: [{ type: 'DATE', direction: 'DESCENDING' }],
        activeFiltre: true,
      };
      // Omit `lieux` entirely when unconfigured — an empty array is not the
      // same as absent and has not been verified against the API.
      if (departments.length > 0) payload.lieux = departments;
      const body = JSON.stringify(payload);

      const json = /** @type {any} */ (
        await ctx.fetchJson(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
        })
      );

      if (!json || !Array.isArray(json.resultats)) {
        throw new Error(
          `apec: unexpected response for query "${query}" — expected { resultats: [...] }`,
        );
      }

      for (const hit of json.resultats) {
        const job = normalizeApecHit(hit, entry?.name);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }

    return [...byUrl.values()];
  },
};
