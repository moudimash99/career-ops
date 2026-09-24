// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Free-Work provider — French tech/IT job board (permanent roles and
// freelance missions). Target list: `job_boards:`.
//
// Transport: the public JSON API behind free-work.com's own search page, plain
// HTTP, no login, no key. Paginated, newest first.
//
//   GET https://www.free-work.com/api/job_postings?searchKeywords=<q>&locationKeys=<key>
//       &contracts=permanent&itemsPerPage=50&page=<n>&order=date
//   -> { "hydra:member": [ { id, title, slug, company, location, publishedAt,
//        applicationType, applicationUrl, minAnnualSalary, maxAnnualSalary,
//        description, job: { slug }, ... } ], "hydra:totalItems": n }
//
// The board is national, so a `freework:` block with explicit searches is
// REQUIRED (same rule as providers/apec.mjs).
//
//   - name: Free-Work
//     provider: freework
//     freework:
//       queries: ["devops", "data engineer"]
//       location_keys: ["fr~occitanie~~", ""]   # optional; "" = all of France (default [""])
//       contracts: ["permanent"]                # optional, default permanent (CDI)
//       max_age_days: 14                        # optional; paging stops at older postings
//       max_pages: 4                            # optional, 50 postings a page
//     enabled: true
//
// URL. When a posting is applied to on the employer's own site
// (`applicationType: "url"` with an https `applicationUrl`), that link is the
// job URL — Source Indexing Policy rule 2, the shortest path to the employer,
// and it lets the scanner's dedup meet the same posting found on the
// employer's ATS. Every other posting (applicationType "turnover" and the
// like: the application goes through Free-Work's own form, which needs a
// Free-Work account) keeps its free-work.com page.
//
// Verified live on 2026-09-24: "devops" in Occitanie, permanent → 27 postings.

import { htmlToText } from './_html-to-text.mjs';
import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const API_URL = 'https://www.free-work.com/api/job_postings';
const SITE_BASE = 'https://www.free-work.com/fr/tech-it';
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;
const MAX_PAGES_CAP = 20;
const INTER_PAGE_DELAY_MS = 800;
const DAY_MS = 86_400_000;

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** https employer link, or '' — the field is third-party data. */
function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' && u.hostname ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * Normalize one Free-Work posting. Exported for tests.
 *
 * @param {any} x
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min:number,max:number,currency:string} } | null}
 */
export function normalizeFreeworkPosting(x) {
  if (!x || typeof x !== 'object') return null;
  const title = typeof x.title === 'string' ? x.title.trim() : '';
  if (!title) return null;
  const slug = typeof x.slug === 'string' ? safeEncodeURIComponent(x.slug.trim()) : null;
  const jobSlug = typeof x.job?.slug === 'string' && x.job.slug.trim() ? safeEncodeURIComponent(x.job.slug.trim()) : 'job';
  if (!slug || !jobSlug) return null;
  const sitePage = `${SITE_BASE}/${jobSlug}/job-mission/${slug}`;
  const employerLink = x.applicationType === 'url' ? httpsUrl(x.applicationUrl) : '';

  const company = typeof x.company === 'string' ? x.company.trim() : typeof x.company?.name === 'string' ? x.company.name.trim() : '';
  const location = typeof x.location?.label === 'string' ? x.location.label.trim() : '';
  /** @type {any} */
  const job = { title, url: employerLink || sitePage, company, location };
  const postedAt = toEpochMs(x.publishedAt);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const min = Number(x.minAnnualSalary);
  const max = Number(x.maxAnnualSalary);
  if (Number.isFinite(max) && max > 0) {
    job.salary = { min: Number.isFinite(min) && min > 0 ? min : max, max, currency: 'EUR' };
  }
  if (typeof x.description === 'string' && x.description.trim()) {
    const text = htmlToText(x.description);
    if (text) job.description = text;
  }
  return job;
}

/** Resolve config: required queries, optional location keys, contracts, age and page caps. */
function resolveConfig(entry) {
  const cfg = entry?.freework && typeof entry.freework === 'object' ? entry.freework : {};
  const clean = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string').map((s) => s.trim()) : []);
  const queries = clean(cfg.queries).filter(Boolean);
  if (queries.length === 0) {
    throw new Error('freework: the board is national — configure explicit searches via `freework: { queries: ["…"] }`');
  }
  // Location keys look like "fr~occitanie~~"; anything else is dropped rather than sent.
  const keys = clean(cfg.location_keys).filter((k) => k === '' || /^[a-z]{2}(~[a-z0-9-]*){0,3}$/.test(k));
  const contracts = clean(cfg.contracts).filter((c) => /^[a-z_]+$/.test(c));
  const maxAgeDays = Number.isInteger(cfg.max_age_days) && cfg.max_age_days > 0 ? cfg.max_age_days : null;
  const maxPages = Number.isInteger(cfg.max_pages) && cfg.max_pages > 0 ? Math.min(cfg.max_pages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return { queries, keys: keys.length ? keys : [''], contracts: contracts.length ? contracts : ['permanent'], maxAgeDays, maxPages };
}

/** @type {Provider} */
export default {
  id: 'freework',

  detect(entry) {
    return entry?.provider === 'freework' ? { url: API_URL } : null;
  },

  async fetch(entry, ctx) {
    const { queries, keys, contracts, maxAgeDays, maxPages } = resolveConfig(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pages = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const cutoff = maxAgeDays ? Date.now() - maxAgeDays * DAY_MS : null;
    const byUrl = new Map();
    let requests = 0;

    for (const key of keys) {
      for (const query of queries) {
        for (let page = 1; page <= pages; page++) {
          const params = new URLSearchParams({ searchKeywords: query });
          if (key) params.set('locationKeys', key);
          for (const c of contracts) params.append('contracts', c);
          params.set('itemsPerPage', String(PAGE_SIZE));
          params.set('page', String(page));
          params.set('order', 'date');
          if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
          requests++;
          let json;
          try {
            json = await fetchJsonWithRetry(ctx, `${API_URL}?${params}`, { redirect: 'error', headers: { accept: 'application/ld+json' } });
          } catch (err) {
            if (probing) throw err;
            console.warn(`freework: "${query}"${key ? ` in ${key}` : ''}, page ${page} failed (${err?.message}); keeping what was found so far`);
            break;
          }
          if (json === null || json === undefined) break;
          const members = /** @type {any} */ (json)['hydra:member'];
          if (!Array.isArray(members)) {
            throw new Error(`freework: unexpected response for "${query}" — expected { "hydra:member": [...] }, got keys ${Object.keys(json || {}).join(', ')}`);
          }
          if (members.length === 0) break;
          let older = 0;
          for (const x of members) {
            const postedAt = toEpochMs(x?.publishedAt);
            if (cutoff && postedAt !== undefined && postedAt < cutoff) { older++; continue; }
            const cc = x?.location?.countryCode;
            if (key === '' && cc && cc !== 'FR') continue; // "all of France" must not pull in Belgium or Switzerland
            const job = normalizeFreeworkPosting(x);
            if (job && !byUrl.has(job.url)) byUrl.set(job.url, job);
          }
          if (probing) return [...byUrl.values()];
          // Newest first: a page made only of too-old postings means the rest are older still.
          if (older === members.length || members.length < PAGE_SIZE) break;
        }
      }
    }
    return [...byUrl.values()];
  },
};
