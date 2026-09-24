// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// HelloWork provider — one of France's largest general job boards (the former
// RegionsJob / Cadremploi group). French employers post here far more than on
// the US-style ATSs the other providers cover, so it is the main source for
// regional roles (Toulouse, Lyon…) outside Paris. Target list: `job_boards:`.
//
// Transport: the public search page, server-rendered HTML, plain HTTP, no
// login and no cookie. Each result is a `data-cy="serpCard"` block carrying
// the posting id, title, company, location, contract, salary line and age.
//
//   GET https://www.hellowork.com/fr-fr/emploi/recherche.html?k=<query>&l=<place>&c=CDI&p=<page>
//
// The board is national, so a `hellowork:` block with explicit searches is
// REQUIRED — without one the provider throws rather than scanning an
// arbitrary slice (same rule as providers/apec.mjs).
//
//   - name: HelloWork
//     provider: hellowork
//     hellowork:
//       queries: ["devops", "ingénieur cloud"]
//       locations: ["Toulouse", "Paris", "France"]   # optional, default ["France"]
//       contract: CDI                                # optional, default CDI; "" = any
//       max_age_days: 14                             # optional; older cards are skipped (results are by relevance, not date)
//       max_pages: 3                                 # optional, per query+place, 30 cards a page
//     enabled: true
//
// AGE. Cards say "il y a 3 jours" / "il y a 14 heures" / "hier", not a date.
// That is turned into postedAt relative to the scan time, so it is accurate to
// the day, which is what the age filters need.
//
// Verified live on 2026-09-24: "devops" in Toulouse, CDI, page 1 → 30 cards,
// salaries like "40 000 - 48 000 € / an" (narrow no-break spaces).

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry, sleep } from './_http.mjs';

const SEARCH_URL = 'https://www.hellowork.com/fr-fr/emploi/recherche.html';
const POSTING_BASE = 'https://www.hellowork.com/fr-fr/emplois';
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 10;
// The 2026-09-23 prototype ran ~300 requests at this pace without a refusal.
const INTER_PAGE_DELAY_MS = 1000;
const DAY_MS = 86_400_000;

/** Text of the first capture group, entity-decoded and trimmed; '' when absent. */
function grab(block, re) {
  const m = block.match(re);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * "il y a 3 jours" → days ago. null when the card carries no age.
 * Exported for tests.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function parseHelloworkAgeDays(text) {
  const t = String(text || '');
  const m = t.match(/il y a (\d+)\s*(minute|heure|jour|semaine|mois)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'jour') return n;
    if (unit === 'semaine') return 7 * n;
    if (unit === 'mois') return 30 * n;
    return 0; // minutes / hours
  }
  if (/aujourd.hui|à l.instant|il y a quelques/i.test(t)) return 0;
  if (/\bhier\b/i.test(t)) return 1;
  return null;
}

/**
 * Salary line → yearly EUR range. Only the "/ an" form is read: a monthly or
 * hourly figure read as yearly would feed scan.mjs's salary_filter a wrong
 * number, which is worse than none. Exported for tests.
 *
 * @param {string} text - Decoded salary line, e.g. "40 000 - 48 000 € / an".
 * @returns {{ min: number, max: number, currency: string } | null}
 */
export function parseHelloworkSalary(text) {
  const t = String(text || '');
  if (!/€/.test(t) || !/\/\s*an\b/i.test(t)) return null;
  const nums = (t.replace(/[\s  ]/g, '').match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => Math.round(Number(n.replace(',', '.'))))
    .filter((n) => Number.isFinite(n) && n >= 1000 && n < 1_000_000);
  if (nums.length === 0) return null;
  return { min: Math.min(...nums), max: Math.max(...nums), currency: 'EUR' };
}

/**
 * Parse one search-results page into cards. Exported for tests.
 *
 * @param {string} html
 * @param {number} [now] - Scan time (epoch ms), for postedAt.
 * @returns {Array<{ id: string, title: string, company: string, location: string, contract: string, salaryText: string, postedAt?: number }>}
 */
export function parseHelloworkPage(html, now = Date.now()) {
  const out = [];
  for (const block of String(html || '').split('data-cy="serpCard"').slice(1)) {
    const id = (block.match(/href="\/fr-fr\/emplois\/(\d+)\.html"/) || [])[1];
    if (!id) continue;
    const title = grab(block, /<p class="typo-l[^"]*">([^<]+)<\/p>/);
    if (!title) continue;
    const card = {
      id,
      title,
      company: grab(block, /<p class="typo-s inline">([^<]+)<\/p>/),
      location: grab(block, /data-cy="localisationCard"\s*>\s*([^<]+)</),
      contract: grab(block, /data-cy="contractCard"\s*>\s*([^<]+)</),
      salaryText: grab(block, /typo-s-bold w-fit border-0">([^<]+)</),
    };
    const age = parseHelloworkAgeDays(block);
    if (age !== null) card.postedAt = now - age * DAY_MS;
    out.push(card);
  }
  return out;
}

/** Resolve config: required queries, optional places, contract and page cap. */
function resolveConfig(entry) {
  const cfg = entry?.hellowork && typeof entry.hellowork === 'object' ? entry.hellowork : {};
  const clean = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : []);
  const queries = clean(cfg.queries);
  if (queries.length === 0) {
    throw new Error('hellowork: the board is national — configure explicit searches via `hellowork: { queries: ["…"] }`');
  }
  const locations = clean(cfg.locations);
  const contract = typeof cfg.contract === 'string' ? cfg.contract.trim() : 'CDI';
  const maxPages = Number.isInteger(cfg.max_pages) && cfg.max_pages > 0 ? Math.min(cfg.max_pages, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
  const maxAgeDays = Number.isInteger(cfg.max_age_days) && cfg.max_age_days > 0 ? cfg.max_age_days : null;
  return { queries, locations: locations.length ? locations : ['France'], contract, maxPages, maxAgeDays };
}

/** @type {Provider} */
export default {
  id: 'hellowork',

  detect(entry) {
    return entry?.provider === 'hellowork' ? { url: SEARCH_URL } : null;
  },

  async fetch(entry, ctx) {
    const { queries, locations, contract, maxPages, maxAgeDays } = resolveConfig(entry);
    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pages = Math.min(maxPages, probing ? ctxMaxPages : Infinity);
    const now = Date.now();
    const cutoff = maxAgeDays ? now - maxAgeDays * DAY_MS : null;
    const byId = new Map();
    let requests = 0;

    for (const place of locations) {
      for (const query of queries) {
        for (let page = 1; page <= pages; page++) {
          const params = new URLSearchParams({ k: query, l: place });
          if (contract) params.set('c', contract);
          params.set('p', String(page));
          if (requests > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
          requests++;
          let html;
          try {
            html = await fetchTextWithRetry(ctx, `${SEARCH_URL}?${params}`, { redirect: 'error' });
          } catch (err) {
            if (probing) throw err; // verify-portals reads the budget cut-off by its type
            console.warn(`hellowork: "${query}" in ${place}, page ${page} failed (${err?.message}); keeping what was found so far`);
            break;
          }
          const cards = parseHelloworkPage(html, now);
          if (cards.length === 0) break;
          for (const c of cards) {
            if (byId.has(c.id)) continue;
            if (contract && c.contract && !c.contract.toUpperCase().includes(contract.toUpperCase())) continue;
            if (cutoff && c.postedAt !== undefined && c.postedAt < cutoff) continue;
            /** @type {any} */
            const job = { title: c.title, url: `${POSTING_BASE}/${c.id}.html`, company: c.company, location: c.location };
            if (c.postedAt !== undefined) job.postedAt = c.postedAt;
            const salary = parseHelloworkSalary(c.salaryText);
            if (salary) job.salary = salary;
            byId.set(c.id, job);
          }
          if (probing) return [...byId.values()];
        }
      }
    }
    return [...byId.values()];
  },
};
