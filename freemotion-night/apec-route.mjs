#!/usr/bin/env node

/**
 * freemotion-night/apec-route.mjs — for each APEC posting: is it live, and how
 * does it take applications? Zero model tokens.
 *
 * Why this exists. APEC's own posting page is a poor witness: to a visitor it
 * takes for a bot it can show "L'offre ... n'est plus disponible" on a live
 * posting (2026-09-21), and its "Postuler" button always goes through an APEC
 * sign-in page, even when the application really happens on a partner site.
 * APEC's data says both things plainly:
 *
 *   - Live: the search service (/cms/webservices/rechercheOffre, plain HTTP)
 *     returns exactly that offer when searched by its number, and nothing once
 *     it is gone.
 *   - Route: the offer-detail service (/cms/webservices/offre/public) carries
 *     `typeCandidature` — URL_ONLY (apply on the partner link in
 *     `adresseUrlCandidature`) or EMAIL_ONLY (apply on APEC itself, which needs
 *     the APEC sign-in).
 *
 * The detail service answers plain scripts with a DataDome CAPTCHA page, so it
 * is read from INSIDE one hidden Camoufox page on apec.fr — the same request
 * the site makes for itself. If a CAPTCHA shows up anyway, the script stops
 * and says so. It never tries to get around one.
 *
 * Input, first match wins: --ids (offer numbers), --in (a JSON array of rows
 * with an APEC `url`, e.g. a pool already filtered by the night-list rules —
 * the cheaper choice, since every offer costs one detail request), else the
 * APEC rows of data/scan-history.tsv from the last --days days (default 14).
 *
 * Memory: a posting's apply route never changes, so every answer (and every
 * posting found gone) is kept in data/apec-routes.json and never asked again.
 * Each run asks APEC only about NEW postings — at most --max (default 30),
 * --gap seconds apart (default 4) — and leaves the rest for the next run. On
 * 2026-09-23 about 150 quick requests in a row brought up the CAPTCHA page.
 *
 * Output (default tmp/fm/apec-pool.json): one row per routed offer (from memory
 * or asked now), in the shape tmp/fm/merge-pool.mjs reads —
 *   {co, title, loc, sal, ageDays, url, host, apecId, applyType, applyUrl}
 * plus a one-line summary on stdout. Exit 2 when a CAPTCHA page stopped it.
 *
 * Usage:
 *   node freemotion-night/apec-route.mjs [--ids 179467750W,179468553W | --in <rows.json> | --days 14]
 *                                        [--max 30] [--gap 4] [--out <file>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_URL = 'https://www.apec.fr/cms/webservices/rechercheOffre';
const DETAIL_PATH = '/cms/webservices/offre/public?numeroOffre=';
const OFFER_BASE = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const DAYS = Number(flag('--days', 14));
const OUT = resolve(ROOT, flag('--out', 'tmp/fm/apec-pool.json'));
const CACHE = join(ROOT, 'data/apec-routes.json');
const MAX = Number(flag('--max', 30)); // new postings asked about per run
const GAP = Number(flag('--gap', 4)); // seconds between offer-data requests
const IDS = flag('--ids', '');
const IN = flag('--in', '');
const idOf = (url) => (String(url || '').match(/^https:\/\/www\.apec\.fr\/.*\/detail-offre\/([A-Za-z0-9-]+)/) || [])[1];

/** Rows to route: --ids, else --in, else recent APEC rows of the scan history. */
function inputRows() {
  if (IDS) return IDS.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9-]+$/.test(s)).map((apecId) => ({ apecId }));
  if (IN) return JSON.parse(readFileSync(IN, 'utf8')).map((r) => ({ ...r, apecId: r.apecId || idOf(r.url) })).filter((r) => r.apecId);
  const [head, ...lines] = readFileSync(join(ROOT, 'data/scan-history.tsv'), 'utf8').split('\n').filter(Boolean);
  const cols = head.split('\t');
  const since = Date.now() - DAYS * 864e5;
  const rows = [];
  for (const line of lines) {
    const r = Object.fromEntries(line.split('\t').map((v, i) => [cols[i], v]));
    const apecId = idOf(r.url);
    const seen = Date.parse(r.posted_at || r.first_seen);
    if (!apecId || !Number.isFinite(seen) || seen < since) continue;
    rows.push({ apecId, co: r.company || '', title: r.title || '', loc: r.location || '', sal: '', ageDays: Math.floor((Date.now() - seen) / 864e5) });
  }
  return rows;
}

/** Search APEC by offer number: the hit when the offer is live, else null. */
async function searchById(id) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ motsCles: id, pagination: { range: 5, startIndex: 0 }, activeFiltre: true }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const json = await res.json();
  return (json.resultats || []).find((r) => r.numeroOffre === id) || null;
}

const toRow = (r, route) => ({
  co: (r.co || '').trim(), title: (r.title || '').trim(), loc: (r.loc || '').trim(), sal: r.sal || '', ageDays: r.ageDays ?? null,
  url: `${OFFER_BASE}/${r.apecId}`, host: 'www.apec.fr', apecId: r.apecId, applyType: route.applyType, applyUrl: route.applyUrl,
});

// A posting's apply route never changes, so each answer is kept in CACHE and
// only new postings are asked about: at most --max per run, --gap seconds apart.
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const seenIds = new Set();
const rows = inputRows().filter((r) => !seenIds.has(r.apecId) && seenIds.add(r.apecId));
if (rows.length === 0) {
  console.log('apec-route: no APEC offers to check');
  process.exit(0);
}
const out = [];
const toAsk = [];
let cachedGone = 0;
for (const r of rows) {
  const c = cache[r.apecId];
  if (!c) toAsk.push(r);
  else if (c.gone) cachedGone++;
  else out.push(toRow(r, c));
}
const asking = toAsk.slice(0, MAX);
const later = toAsk.length - asking.length;

// 1. Liveness of the new ones, plain HTTP. A live hit also refreshes the row's details.
const live = [];
let gone = 0;
for (const r of asking) {
  try {
    const hit = await searchById(r.apecId);
    if (!hit) { gone++; cache[r.apecId] = { gone: true, checkedAt: new Date().toISOString() }; }
    else {
      const posted = Date.parse(hit.datePublication);
      live.push({ ...r, co: hit.nomCommercial || r.co, title: hit.intitule || r.title, loc: hit.lieuTexte || r.loc, sal: hit.salaireTexte || r.sal,
        ageDays: Number.isFinite(posted) ? Math.floor((Date.now() - posted) / 864e5) : r.ageDays });
    }
  } catch (e) {
    console.error(`apec-route: search failed for ${r.apecId}: ${e.message}`);
  }
  await sleep(1500);
}

// 2. Route of the new live ones, read inside one hidden Camoufox page on apec.fr.
let blocked = '';
let routed = 0;
if (live.length) {
  const { Camoufox } = await import('camoufox-js');
  const browser = await Camoufox({ headless: true, geoip: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${OFFER_BASE}/${live[0].apecId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    for (const r of live) {
      const res = await page.evaluate(async (path) => {
        const x = await fetch(path);
        return { status: x.status, text: await x.text() };
      }, DETAIL_PATH + encodeURIComponent(r.apecId));
      let d = null;
      try { d = JSON.parse(res.text); } catch { /* not JSON */ }
      if (!d) {
        blocked = /captcha-delivery|captcha/i.test(res.text) ? `CAPTCHA page (HTTP ${res.status})` : `unexpected answer (HTTP ${res.status})`;
        console.error(`apec-route: stopped at ${r.apecId}: ${blocked}. Not working around it.`);
        break;
      }
      const route = {
        applyType: d.typeCandidature || 'UNKNOWN',
        applyUrl: typeof d.adresseUrlCandidature === 'string' ? d.adresseUrlCandidature : '',
        checkedAt: new Date().toISOString(),
      };
      cache[r.apecId] = route;
      out.push(toRow(r, route));
      routed++;
      await sleep(GAP * 1000);
    }
  } finally {
    await browser.close();
  }
}

mkdirSync(dirname(CACHE), { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache, null, 1));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
const byType = out.reduce((m, x) => ((m[x.applyType] = (m[x.applyType] || 0) + 1), m), {});
console.log(`apec-route: ${rows.length} postings | from memory: ${rows.length - toAsk.length - cachedGone} routed, ${cachedGone} gone`
  + ` | asked now: ${asking.length} (${live.length} live, ${gone} gone, ${routed} routed)`
  + (later ? ` | ${later} left for the next run` : '')
  + ` | written: ${out.length} ${JSON.stringify(byType)}`
  + (blocked ? ` | STOPPED: ${blocked}` : '') + ` -> ${OUT.replace(ROOT, '.').replace(/\\/g, '/')}`);
if (blocked) process.exit(2);
