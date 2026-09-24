// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// LinkedIn provider — DISCOVERY ONLY. Target list: `job_boards:`.
//
// Reads LinkedIn's public guest job search: the same HTML fragment a signed-out
// visitor's browser loads while scrolling linkedin.com/jobs. No login, no
// cookie, and the user's LinkedIn account is never involved.
//
//   GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
//       ?keywords=<q>&location=<place>&f_TPR=r<seconds>&start=<offset>
//   -> 10 <li> job cards per page (id, title, company, location, date);
//      `start` counts CARDS, not pages (measured 2026-09-24: start=0, 10, 25
//      return three disjoint sets of 10). Stepping by 25 skips 15 of every 25.
//
// Nobody applies ON LinkedIn from here: Easy Apply needs an account, and for
// "apply on the company site" postings LinkedIn hides the company's link from
// signed-out visitors. A LinkedIn row is a lead — the application goes through
// the employer's own site or another board. That is why the entry belongs LAST
// in `job_boards:`: the scanner keeps the first copy of a company + role it
// meets, so the same job found on HelloWork, WTJ, APEC… wins over LinkedIn.
//
//   - name: LinkedIn
//     provider: linkedin
//     linkedin:
//       queries: ["devops", "data engineer"]
//       locations: ["Toulouse, Occitanie, France", "France"]   # optional, default ["France"]
//       max_age_days: 14                                        # optional, default 14
//       max_pages: 10                                           # optional, 10 cards a page
//     enabled: true
//
// PACING. LinkedIn rate-limits the guest search (HTTP 429) after roughly ten
// quick pages from one address. Pages are 2.5 s apart and a 429 is retried
// with a long backoff; when retries run out, the pages already read are kept.
//
// Verified live on 2026-09-23 (prototype): 60 searches, ~550 postings in 14 days.

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING_BASE = 'https://www.linkedin.com/jobs/view';
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_CAP = 25;
const DEFAULT_MAX_AGE_DAYS = 14;
const INTER_PAGE_DELAY_MS = 2500;
const RETRY_POLICY = { retries: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 };

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function grab(block, re) {
  const m = block.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Parse one guest-search page into jobs. Exported for tests.
 *
 * @param {string} html
 * @returns {Array<{ title: string, url: string, company: string, location: string, postedAt?: number }>}
 */
export function parseLinkedinPage(html) {
  const out = [];
  for (const block of String(html || '').split('<li>').slice(1)) {
    const id = (block.match(/urn:li:jobPosting:(\d+)/) || [])[1];
    if (!id) continue;
    const title = grab(block, /base-search-card__title">([^<]*)</);
    if (!title) continue;
    /** @type {any} */
    const job = {
      title,
      url: `${POSTING_BASE}/${id}`,
      company: grab(block, /hidden-nested-link[^>]*>([^<]*)</),
      location: grab(block, /job-search-card__location">([^<]*)</),
    };
    const postedAt = toEpochMs((block.match(/datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1]);
    if (postedAt !== undefined) job.postedAt = postedAt;
    out.push(job);
  }
  return out;
}

/** Resolve config: required queries, optional places, age and page caps. */
function resolveConfig(entry) {
  const cfg = entry?.linkedin && typeof entry.linkedin === 'object' ? entry.linkedin : {};
  const clean = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  const queries = clean(cfg.queries);
  if (queries.length === 0) {
    throw new Error('linkedin: configure explicit searches via `linkedin: { queries: ["…"] }`');
  }
  const locations = clean(cfg.locations);
  const maxAgeDays = Number.isInteger(cfg.max_age_days) && cfg.max_age_days > 0 ? cfg.max_age_days : DEFAULT_MAX_AGE_DAYS;
  const maxPages = Number.isInteger(cfg.max_pages) && cfg.max_pages > 0 ? Math.min(cfg.max_pages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  return { queries, locations: locations.length ? locations : ['France'], maxAgeDays, maxPages };
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  detect(entry) {
    return entry?.provider === 'linkedin' ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const { queries, locations, maxAgeDays, maxPages } = resolveConfig(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pages = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const byUrl = new Map();
    let requests = 0;

    for (const place of locations) {
      for (const query of queries) {
        let start = 0;
        for (let page = 0; page < pages; page++) {
          const params = new URLSearchParams({
            keywords: query,
            location: place,
            f_TPR: `r${maxAgeDays * 86_400}`,
            start: String(start),
          });
          if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
          requests++;
          let html;
          try {
            html = await fetchTextWithRetry(ctx, `${SEARCH_URL}?${params}`, { redirect: 'error' }, RETRY_POLICY);
          } catch (err) {
            if (probing) throw err;
            console.warn(`linkedin: "${query}" in ${place}, page ${page + 1} failed (${err?.message}); keeping what was found so far`);
            break;
          }
          const jobs = parseLinkedinPage(html);
          if (jobs.length === 0) break;
          start += jobs.length;
          for (const job of jobs) if (!byUrl.has(job.url)) byUrl.set(job.url, job);
          if (probing) return [...byUrl.values()];
          // No short-page stop: a page is not reliably full even when more
          // results follow. An empty page ends the walk.
        }
      }
    }
    return [...byUrl.values()];
  },
};
