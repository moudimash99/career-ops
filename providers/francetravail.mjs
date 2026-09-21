// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// France Travail (ex-Pôle Emploi) provider — the French public employment
// service. Its "Offres d'emploi v2" API is the single largest job dataset in
// France: every posting collected by the public service plus the partner
// boards that syndicate into it.
//
// STATUS — READ BEFORE TRUSTING A RUN. The request/response mapping below is
// written from France Travail's published API contract, but it has NOT yet
// been exercised against the live endpoint, because that needs credentials
// this machine does not have (see below). The pure functions are unit-tested;
// the field mapping is not. Treat the first live run as a verification step:
// check that titles, companies, locations and dates land in the right columns
// before relying on a sweep. Remove this notice once that has happened.
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
//       max_hits: 150               # optional, per query, capped at 150 by the API
//     enabled: true

const TOKEN_URL =
  'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const SEARCH_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const TOKEN_HOST = 'entreprise.francetravail.fr';
const SEARCH_HOST = 'api.francetravail.io';
// The v2 search endpoint caps a single range at 150 entries.
const DEFAULT_MAX_HITS = 150;
const MAX_HITS_CAP = 150;
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
 *   - url:      `origineOffre.urlOrigine` when present (the canonical public
 *               posting), else the France Travail detail page built from `id`.
 *               The id is constrained to [A-Za-z0-9-] so it cannot escape the
 *               path.
 *   - company:  `entreprise.nom` — frequently absent, since many public-service
 *               postings are anonymised; falls back to the entry name.
 *   - location: `lieuTravail.libelle`, e.g. "31 - TOULOUSE".
 *   - postedAt: `dateCreation` (ISO 8601) → epoch ms.
 *   - description: `description`, already in the list payload.
 *   - salary:   NOT parsed. `salaire.libelle` is free prose ("Annuel de 40000
 *               à 45000 Euros sur 12 mois", "Selon profil", "Horaire de 15
 *               Euros") and mis-reading an hourly or monthly figure as annual
 *               would feed scan.mjs's salary_filter a wrong number. Omitted
 *               until the live shape can be sampled.
 *
 * @param {any} o
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number } | null}
 */
export function normalizeFranceTravailOffer(o, fallbackCompany) {
  if (!o || typeof o !== 'object') return null;

  const title = typeof o.intitule === 'string' ? o.intitule.trim() : '';
  if (!title) return null;

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id || !/^[A-Za-z0-9-]+$/.test(id)) return null;

  // Prefer the employer's own posting URL when the API exposes one, but only
  // if it is a plausible absolute https link — the field is third-party data.
  let url = `https://candidat.francetravail.fr/offres/recherche/detail/${id}`;
  const origin = o.origineOffre && typeof o.origineOffre === 'object' ? o.origineOffre : null;
  const candidate = origin && typeof origin.urlOrigine === 'string' ? origin.urlOrigine.trim() : '';
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname) url = candidate;
    } catch {
      // keep the France Travail detail URL
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

  return job;
}

/** Resolve config: required queries, optional departments and hit cap. */
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
  return { queries, departments, maxHits };
}

/** @type {Provider} */
export default {
  id: 'francetravail',

  detect(entry) {
    return entry?.provider === 'francetravail' ? { url: `https://${SEARCH_HOST}` } : null;
  },

  async fetch(entry, ctx) {
    const { queries, departments, maxHits } = resolveConfig(entry);
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

    for (const query of queries) {
      const params = new URLSearchParams({
        motsCles: query,
        // `range` is inclusive and zero-based: 0-149 is 150 entries.
        range: `0-${maxHits - 1}`,
      });
      if (departments.length > 0) params.set('departement', departments.join(','));

      const url = assertHost(`${SEARCH_URL}?${params.toString()}`, SEARCH_HOST);

      const json = /** @type {any} */ (
        await ctx.fetchJson(url, {
          redirect: 'error',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        })
      );

      // A 204 (no content) is a legitimate "nothing matched" and the fetch
      // helper may surface it as null — that is not a shape error.
      if (json === null || json === undefined) continue;
      if (!Array.isArray(json.resultats)) {
        throw new Error(
          `francetravail: unexpected response for query "${query}" — expected { resultats: [...] }`,
        );
      }

      for (const offer of json.resultats) {
        const job = normalizeFranceTravailOffer(offer, entry?.name);
        if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
      }
    }

    return [...byUrl.values()];
  },
};
