#!/usr/bin/env node
// Local parser for Capgemini's public "jobstream" job-search API.
//
// Capgemini is not on Greenhouse/Ashby/Lever/Workday — careers.capgemini.com is
// a custom front end over https://cg-jobstream-api.azurewebsites.net. That API
// is public, unauthenticated and returns plain JSON, so this is a zero-token
// scan like any other provider.
//
// Emits jobs-json-v1: [{ title, url, location }] on stdout.
//
// Usage:
//   node scripts/parsers/capgemini-jobs.mjs [--country=fr-fr] [--brand=<substr>]
//                                           [--max-pages=N] [--page-size=N]
//
// `--country` takes the API's locale-style code, NOT an ISO country code:
// France is `fr-fr` (`FR` and `fr-FR` both silently return zero results).
// `--brand` is an optional case-insensitive substring filter over the `brand`
// field, which distinguishes "Capgemini" from "Capgemini Engineering".

const API = 'https://cg-jobstream-api.azurewebsites.net/api/job-search';
const PAGE_SIZE_DEFAULT = 500;
const MAX_PAGES_DEFAULT = 10;
const REQUEST_TIMEOUT_MS = 12_000;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const country = arg('country', 'fr-fr');
const brandFilter = (arg('brand', '') || '').toLowerCase();
const pageSize = Number(arg('page-size', PAGE_SIZE_DEFAULT));
const maxPages = Number(arg('max-pages', MAX_PAGES_DEFAULT));

async function fetchPage(page) {
  const url = `${API}?country_code=${encodeURIComponent(country)}&page=${page}&size=${pageSize}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        // The API answers bare requests fine, but the site's own headers keep
        // us indistinguishable from the page the endpoint exists to serve.
        Referer: 'https://www.capgemini.com/',
        'User-Agent': 'career-ops-scan/1.0',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The API returns each posting's full HTML description. Carrying that through
// would blow the local-parser 2MB stdout budget on a board this size, so only
// the three fields jobs-json-v1 needs are kept.
function toJob(record) {
  const url = record.apply_job_url || '';
  const title = (record.title || '').trim();
  if (!url || !title) return null;
  if (brandFilter && !String(record.brand || '').toLowerCase().includes(brandFilter)) return null;
  return {
    title,
    url,
    location: (record.location || '').trim(),
  };
}

async function main() {
  const jobs = [];
  const seen = new Set();
  let total = Infinity;

  for (let page = 1; page <= maxPages && jobs.length < total; page++) {
    let payload;
    try {
      payload = await fetchPage(page);
    } catch (err) {
      // Partial results beat none: a mid-pagination failure still yields
      // everything already collected, and scan.mjs dedupes across runs anyway.
      if (jobs.length === 0) throw err;
      process.stderr.write(`capgemini-jobs: page ${page} failed (${err.message}), returning ${jobs.length} jobs\n`);
      break;
    }

    total = Number(payload.count ?? payload.total ?? 0);
    const batch = Array.isArray(payload.data) ? payload.data : [];
    if (batch.length === 0) break;

    for (const record of batch) {
      const job = toJob(record);
      // The same requisition can surface under several source refs; the apply
      // URL is the stable identity.
      if (job && !seen.has(job.url)) {
        seen.add(job.url);
        jobs.push(job);
      }
    }
  }

  process.stdout.write(JSON.stringify(jobs));
}

main().catch(err => {
  process.stderr.write(`capgemini-jobs: ${err.message}\n`);
  process.exit(1);
});
