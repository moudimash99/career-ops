// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// France Travail (ex-Pôle Emploi) provider — the French public employment
// service. Its "Offres d'emploi v2" API is the single largest job dataset in
// France: every posting collected by the public service plus the partner
// boards that syndicate into it.
//
// Verified live on 2026-09-23/24: "devops", department 31, CDI, last 14 days →
// 36 offers. `origineOffre.urlOrigine` is always France Travail's own page;
// the recruiter's link is in `contact.urlPostulation` (4 of 36) or
// `origineOffre.partenaires[].url` (30 of 36, the partner board carrying it:
// jobposting.pro, Meteojob, Taleez…). That link is the job URL when present —
// Source Indexing Policy rule 2 — and France Travail's page is the fallback.
//
// CREDENTIALS. Unlike APEC, this API is not open. You must register an
// application at https://francetravail.io (free, self-serve):
//   1. create an account, then an application;
//   2. subscribe it to the "Offres d'emploi v2" API;
//   3. copy the client id and secret.
// Supply them as environment variables — never in portals.yml, which is user
// data and may be committed:
//   FRANCETRAVAIL_CLIENT_ID, FRANCETRAVAIL_CLIENT_SECRET
//
// The provider throws a clear, actionable error when they are absent rather
// than returning an empty array, because a silent empty result is
// indistinguishable from "no jobs matched" and would hide the whole source.
//
//   - name: France Travail
//     provider: francetravail
//     francetravail:
//       queries: ["devops", "ingénieur cloud"]
//       departments: ["31", "75"]   # optional, ordinary department numbers
//       contract_types: ["CDI"]     # optional, typeContrat codes (CDI, CDD, MIS…); default: any
//       published_within_days: 14   # optional, rounded up to what the API accepts (1, 3, 7, 14, 31)
//       max_hits: 150               # optional, per request, capped at 150 by the API
//       max_pages: 3                # optional, requests per query (150-299, 300-449…), max 7
//     enabled: true

import { sleep } from './_http.mjs';

const TOKEN_URL =
  'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const SEARCH_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const TOKEN_HOST = 'entreprise.francetravail.fr';
const SEARCH_HOST = 'api.francetravail.io';
// The v2 search endpoint caps a single range at 150 entries.
const DEFAULT_MAX_HITS = 150;
const MAX_HITS_CAP = 150;
// Further ranges page through a big result set (150-299, 300-449…). Our own
// ceiling, independent of the total the API reports; the API also refuses a
// range starting past ~1000.
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 7;
const INTER_PAGE_DELAY_MS = 400;
const SCOPE = 'api_offresdemploiv2 o2dsoffre';

/** Pin a URL to an expected https host. */
function assertHost(url, host) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`francetravail: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`francetravail: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== host) {
    throw new Error(`francetravail: untrusted hostname "${parsed.hostname}" — must be ${host}`);
  }
  return url;
}

/**
 * Read credentials from the environment.
 *
 * Exported for tests so the failure mode can be asserted without mutating the
 * real process environment.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{ clientId: string, clientSecret: string }}
 */
export function resolveCredentials(env) {
  const clientId = (env.FRANCETRAVAIL_CLIENT_ID || '').trim();
  const clientSecret = (env.FRANCETRAVAIL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'francetravail: missing FRANCETRAVAIL_CLIENT_ID / FRANCETRAVAIL_CLIENT_SECRET. ' +
        'Register an application at https://francetravail.io, subscribe it to ' +
        '"Offres d\'emploi v2", and export both values. Refusing to scan without ' +
        'them, because an empty result would look like an empty market.',
    );
  }
  return { clientId, clientSecret };
}

/**
 * Normalise configured departments into France Travail `departement` values.
 *
 * Same rules as the APEC provider: ordinary French department codes only. A
 * bad code is dropped rather than sent — the API answers an unknown one with
 * an empty set, which would masquerade as "no jobs in this region".
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

/**
 * Normalise a single France Travail offer. Exported for tests.
 *
 * Field mapping → the normalized Job shape, per the v2 contract:
 *   - title:    `intitule`.
 *   - url:      the first absolute https link among `contact.urlPostulation`
 *               (the recruiter's own apply link), `origineOffre.partenaires[].url`
 *               (the partner board carrying the offer) and
 *               `origineOffre.urlOrigine`; else the France Travail detail page
 *               built from `id`. The id is constrained to [A-Za-z0-9-] so it
 *               cannot escape the path.
 *   - company:  `entreprise.nom` — frequently absent, since many public-service
 *               postings are anonymised; falls back to the entry name.
 *   - location: `lieuTravail.libelle`, e.g. "31 - TOULOUSE".
 *   - postedAt: `dateCreation` (ISO 8601) → epoch ms.
 *   - description: `description`, already in the list payload.
 *   - salary:   `salaire.libelle`, yearly form only (see parseFranceTravailSalary).
 *
 * @param {any} o
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min:number,max:number,currency:string} } | null}
 */
export function normalizeFranceTravailOffer(o, fallbackCompany) {
  if (!o || typeof o !== 'object') return null;

  const title = typeof o.intitule === 'string' ? o.intitule.trim() : '';
  if (!title) return null;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return null;

  // Prefer the recruiter's link, then the partner board's, then the origin page,
  // each only if it is a plausible absolute https link — the fields are
  // third-party data. France Travail's own detail page is the fallback.
  const origin = o.origineOffre && typeof o.origineOffre === 'object' ? o.origineOffre : null;
  const partners = origin && Array.isArray(origin.partenaires) ? origin.partenaires : [];
  const candidates = [
    o.contact && o.contact.urlPostulation,
    ...partners.map((p) => p && p.url),
    origin && origin.urlOrigine,
  ];
  let url = `https://candidat.francetravail.fr/offres/recherche/detail/${id}`;
  for (const c of candidates) {
    if (typeof c !== 'string' || !c.trim()) continue;
    try {
      const parsed = new URL(c.trim());
      if (parsed.protocol === 'https:' && parsed.hostname) {
        url = c.trim();
        break;
      }
    } catch {
      // try the next candidate
    }
  }

  const company =
    (o.entreprise && typeof o.entreprise.nom === 'string' && o.entreprise.nom.trim()) ||
    (typeof fallbackCompany === 'string' && fallbackCompany.trim()) ||
    'France Travail';

  const location =
    (o.lieuTravail && typeof o.lieuTravail.libelle === 'string' && o.lieuTravail.libelle.trim()) ||
    '';

  /** @type {any} */
  const job = { title, url, company, location };

  const desc = typeof o.description === 'string' ? o.description.trim() : '';
  if (desc) job.description = desc;

  const created = typeof o.dateCreation === 'string' ? o.dateCreation : '';
  if (created) {
    const ts = Date.parse(created);
    if (Number.isFinite(ts) && ts > 0) job.postedAt = ts;
  }

  const salary = parseFranceTravailSalary(o.salaire && o.salaire.libelle);
  if (salary) job.salary = salary;

  return job;
}

/**
 * `salaire.libelle` → yearly EUR range. Exported for tests.
 *
 * Only the yearly form is read: "Annuel de 35000.0 Euros à 45000.0 Euros",
 * "Annuel de 40000 Euros sur 12 mois". "Mensuel de…", "Horaire de…" and prose
 * ("Selon profil") return null — reading a monthly or hourly figure as yearly
 * would feed scan.mjs's salary_filter a wrong number, which is worse than none.
 * Trailing "sur N mois" is the payment spread, not a figure, and is dropped.
 *
 * @param {unknown} text
 * @returns {{ min: number, max: number, currency: string } | null}
 */
export function parseFranceTravailSalary(text) {
  if (typeof text !== 'string' || !/^\s*annuel\b/i.test(text)) return null;
  const body = text.replace(/sur\s+\d+(?:[.,]\d+)?\s*mois.*$/i, '');
  const nums = (body.match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => Math.round(Number(n.replace(',', '.'))))
    .filter((n) => Number.isFinite(n) && n >= 1000 && n < 1_000_000);
  if (nums.length === 0) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency: 'EUR' };
}

// publieeDepuis accepts only these values (days).
const PUBLISHED_WITHIN_STEPS = [1, 3, 7, 14, 31];

/** Resolve config: required queries, optional departments, contract types, age and hit cap. */
function resolveConfig(entry) {
  const cfg =
    entry?.francetravail && typeof entry.francetravail === 'object' ? entry.francetravail : {};
  const queries = Array.isArray(cfg.queries)
    ? cfg.queries.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.trim())
    : [];
  if (queries.length === 0) {
    throw new Error(
      'francetravail: the board is national — configure explicit searches via ' +
        '`francetravail: { queries: ["…"] }`',
    );
  }
  const departments = normalizeDepartments(cfg.departments);
  const maxHits =
    Number.isInteger(cfg.max_hits) && cfg.max_hits > 0
      ? Math.min(cfg.max_hits, MAX_HITS_CAP)
      : DEFAULT_MAX_HITS;
  // Contract codes are short uppercase tokens (CDI, CDD, MIS, SAI…); anything
  // else is dropped rather than sent.
  const contractTypes = Array.isArray(cfg.contract_types)
    ? cfg.contract_types.filter((c) => typeof c === 'string' && /^[A-Z]{2,4}$/.test(c.trim())).map((c) => c.trim())
    : [];
  const days = Number(cfg.published_within_days);
  const publishedWithin = Number.isFinite(days) && days > 0
    ? PUBLISHED_WITHIN_STEPS.find((s) => s >= days) ?? PUBLISHED_WITHIN_STEPS[PUBLISHED_WITHIN_STEPS.length - 1]
    : null;
  const maxPages = Number.isInteger(cfg.max_pages) && cfg.max_pages > 0 ? Math.min(cfg.max_pages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return { queries, departments, maxHits, contractTypes, publishedWithin, maxPages };
}

/** @type {Provider} */
export default {
  id: 'francetravail',

  detect(entry) {
    return entry?.provider === 'francetravail' ? { url: `https://${SEARCH_HOST}` } : null;
  },

  async fetch(entry, ctx) {
    const { queries, departments, maxHits, contractTypes, publishedWithin, maxPages } = resolveConfig(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const pages = Math.min(maxPages, ctxMaxPages > 0 ? ctxMaxPages : Infinity);
    const { clientId, clientSecret } = resolveCredentials(
      entry?._env || (typeof process !== 'undefined' ? process.env : {}),
    );

    // 1. Client-credentials token. One per fetch() call; the token outlives a
    //    single scan comfortably (24h), so there is no refresh logic here.
    const tokenBody = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
    }).toString();

    const tokenRes = /** @type {any} */ (
      await ctx.fetchJson(assertHost(TOKEN_URL, TOKEN_HOST), {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      })
    );

    const token = tokenRes && typeof tokenRes.access_token === 'string' ? tokenRes.access_token : '';
    if (!token) {
      throw new Error(
        'francetravail: the token endpoint returned no access_token — check that the ' +
          'application is subscribed to "Offres d\'emploi v2" and the credentials are current',
      );
    }

    // 2. One search per configured term, deduped by posting URL.
    const byUrl = new Map();

    let requests = 0;
    for (const query of queries) {
      for (let page = 0; page < pages; page++) {
        const first = page * maxHits;
        const params = new URLSearchParams({
          motsCles: query,
          // `range` is inclusive and zero-based: 0-149 is 150 entries.
          range: `${first}-${first + maxHits - 1}`,
        });
        if (departments.length > 0) params.set('departement', departments.join(','));
        if (contractTypes.length > 0) params.set('typeContrat', contractTypes.join(','));
        if (publishedWithin) params.set('publieeDepuis', String(publishedWithin));

        const url = assertHost(`${SEARCH_URL}?${params.toString()}`, SEARCH_HOST);
        if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        requests++;

        let json;
        try {
          json = /** @type {any} */ (
            await ctx.fetchJson(url, {
              redirect: 'error',
              headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            })
          );
        } catch (err) {
          // A search with no match answers 204 with an EMPTY body, which the
          // shared JSON reader reports as a parse error (seen live 2026-09-24).
          // That is "nothing matched", not a broken source.
          if (err instanceof SyntaxError && /end of JSON input/i.test(err.message)) break;
          throw err;
        }

        // A 204 (no content) is a legitimate "nothing matched" and the fetch
        // helper may surface it as null — that is not a shape error.
        if (json === null || json === undefined) break;
        if (!Array.isArray(json.resultats)) {
          throw new Error(
            `francetravail: unexpected response for query "${query}" — expected { resultats: [...] }`,
          );
        }

        for (const offer of json.resultats) {
          const job = normalizeFranceTravailOffer(offer, entry?.name);
          if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        // A short page is the last one.
        if (json.resultats.length < maxHits) break;
        if (page === pages - 1 && pages === maxPages) {
          console.warn(`francetravail: "${query}" filled ${pages} pages of ${maxHits}; raise max_pages on this entry to see the rest`);
        }
      }
    }

    return [...byUrl.values()];
  },
};
