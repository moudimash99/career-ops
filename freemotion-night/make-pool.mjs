#!/usr/bin/env node

/**
 * freemotion-night/make-pool.mjs — build tonight's job list from the scan
 * results. Zero model tokens: every step is plain code.
 *
 *   node freemotion-night/make-pool.mjs [--top 25] [--days 14] [--no-apec]
 *
 * Reads data/scan-history.tsv (every source the scanner covers) and, for the
 * "never twice" checks, the SAME files and functions the run-time claim in
 * freemotion-run.mjs uses:
 *   - data/freemotion-submissions.tsv (run log) — by URL, via url-key.mjs;
 *     every attempt counts except a practice run (`rehearsal`);
 *   - data/applications.md (tracker) — by company + title key (the tracker
 *     stores no URLs), any status;
 *   - data/blacklist.md — loadBlacklist() + matchBlacklist();
 *   - the per-company cap — countByCompany() + checkCompany().
 * Then the night-list rules (pool-rules.mjs), the apply route of each posting,
 * and the merge of duplicates.
 *
 * APPLY ROUTE — how each posting is applied to, from its source and link:
 *   apply-here         a form reachable directly (company ATS, WTJ, HelloWork,
 *                      France Travail recruiter/partner link, Free-Work employer
 *                      link, APEC partner link)                    → scheduled
 *   apec-account       APEC's own form, behind the APEC sign-in    → scheduled
 *   freework-account   Free-Work's own form (needs an account)     → kept apart
 *   francetravail-page France Travail's own page (FT account)      → kept apart
 *   apec-unrouted      APEC posting whose route is not known yet   → kept apart
 *   linkedin-lead      found only on LinkedIn (Phase C)            → kept apart
 *   blocked-site       its application site is on data/site-blacklist.md
 *                      (weekly review, site-review.mjs)            → kept apart
 * APEC routes come from data/apec-routes.json; postings not in it yet are
 * asked about through apec-route.mjs (at most 30 per run) unless --no-apec.
 *
 * SAME JOB — two rows are one job when they share an apply link (HelloWork by
 * job number, others without tracking parameters), or when their company key
 * AND title key are equal (pool-rules.mjs). The copy kept is the easiest to
 * apply to: route first, then source (company ATS / WTJ / HelloWork /
 * Free-Work, then France Travail, then APEC, then LinkedIn), then score.
 *
 * Writes (tmp/fm/night/):
 *   pool.json    every kept job, ranked, with route, source and where else it was seen
 *   list.json    the top --top scheduled jobs, in make-jobs.mjs's input format
 *   merges.txt   every merge made, for spot checks
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { MAX_AGE_DAYS, capPerCompany, companyKey, judge, titleKey } from './pool-rules.mjs';
import normalizeUrl from '../url-key.mjs';
import { readCurrentState } from '../lib/freemotion-submissions.mjs';
import { checkCompany, countByCompany, matchBlacklist } from '../lib/company-cap.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tmp/fm/night');
const APEC_CACHE = join(ROOT, 'data/apec-routes.json');
const DAY_MS = 86_400_000;

const SITE_BLACKLIST = join(ROOT, 'data/site-blacklist.md');

export const ROUTE_RANK = { 'apply-here': 0, 'apec-account': 1, 'freework-account': 2, 'francetravail-page': 2, 'apec-unrouted': 2, 'blocked-site': 2, 'linkedin-lead': 3 };
export const SCHEDULED = new Set(['apply-here', 'apec-account']);
const SOURCE_RANK = { francetravail: 1, apec: 2, linkedin: 3 }; // everything else 0

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isLinkedin = (u) => /(^|\.)linkedin\.com$/.test(hostOf(u));
const apecIdOf = (u) => (String(u || '').match(/^https:\/\/www\.apec\.fr\/.*\/detail-offre\/([A-Za-z0-9-]+)/) || [])[1];

/** One key per apply link: HelloWork by job number, otherwise host + path + non-tracking query. */
export function linkKey(u) {
  let p;
  try { p = new URL(u); } catch { return ''; }
  const hw = /(^|\.)hellowork\.com$/i.test(p.hostname) && p.pathname.match(/\/emplois\/(\d+)/);
  if (hw) return `hellowork:${hw[1]}`;
  for (const k of [...p.searchParams.keys()]) if (/^(utm_|src$|source$|from$|ref$|origin)/i.test(k)) p.searchParams.delete(k);
  return (p.hostname.replace(/^www\./, '') + p.pathname.replace(/\/$/, '') + p.search).toLowerCase();
}

/**
 * Apply route of one row. `apecRoute` is the cached APEC answer, or undefined.
 * @returns {{ route: string, url: string, apecUrl?: string } | { drop: string }}
 */
export function routeOf(row, apecRoute) {
  const host = hostOf(row.url);
  // Any LinkedIn link is a lead, whatever source carried it (partner links from
  // France Travail or Free-Work sometimes point at LinkedIn): never applied to.
  if (row.source === 'linkedin' || isLinkedin(row.url)) return { route: 'linkedin-lead', url: row.url };
  if (row.source === 'apec') {
    if (!apecRoute) return { route: 'apec-unrouted', url: row.url };
    if (apecRoute.gone) return { drop: 'APEC posting gone' };
    if (apecRoute.applyType === 'URL_ONLY' && /^https:\/\//.test(apecRoute.applyUrl || '') && !isLinkedin(apecRoute.applyUrl)) {
      return { route: 'apply-here', url: apecRoute.applyUrl, apecUrl: row.url };
    }
    return { route: 'apec-account', url: row.url };
  }
  if (row.source === 'freework' && /(^|\.)free-work\.com$/.test(host)) return { route: 'freework-account', url: row.url };
  if (row.source === 'francetravail' && host === 'candidat.francetravail.fr') return { route: 'francetravail-page', url: row.url };
  return { route: 'apply-here', url: row.url };
}

/**
 * Site blacklist — application sites agy is no longer sent to, decided in the
 * weekly review (freemotion-night/site-review.mjs). Markdown table rows
 * `| site | added | reason |`; a site also covers its subdomains.
 * @param {string} text
 * @returns {string[]} lowercase hosts
 */
export function parseSiteBlacklist(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cell = (line.match(/^\|\s*([^|]+?)\s*\|/) || [])[1];
    if (!cell) continue;
    const host = cell.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) out.push(host);
  }
  return out;
}

/** True when the URL's site is on the site blacklist (the site or a subdomain of it). */
export function isBlockedSite(url, hosts) {
  const h = hostOf(url).replace(/^www\./, '');
  return !!h && hosts.some((b) => h === b || h.endsWith(`.${b}`));
}

/**
 * Merge rows that are the same job. Input: rows with route, url, apecUrl?, co,
 * title, source, score. The first row of each group, in preference order, is
 * the one kept. Pure; exported for tests.
 * @returns {{ kept: object[], merges: Array<{ kept: object, dropped: object[], by: string[] }> }}
 */
export function mergeSameJobs(rows) {
  const ordered = [...rows].sort((a, b) =>
    (ROUTE_RANK[a.route] ?? 9) - (ROUTE_RANK[b.route] ?? 9)
    || (SOURCE_RANK[a.source] ?? 0) - (SOURCE_RANK[b.source] ?? 0)
    || b.score - a.score);
  const groups = [];
  const byLink = new Map();
  const byKey = new Map();
  for (const r of ordered) {
    const links = [r.url, r.apecUrl, r.origUrl].filter(Boolean).map(linkKey).filter(Boolean);
    const ck = companyKey(r.co);
    const key = ck ? `${ck}|${titleKey(r.title)}` : '';
    let g = null;
    let by = '';
    for (const l of links) if (byLink.has(l)) { g = byLink.get(l); by = 'same apply link'; break; }
    if (!g && key && byKey.has(key)) { g = byKey.get(key); by = 'same company + title'; }
    if (!g) {
      g = { kept: r, dropped: [], by: [] };
      groups.push(g);
    } else {
      g.dropped.push(r);
      g.by.push(by);
      if (!g.kept.seenOn.includes(r.source)) g.kept.seenOn.push(r.source);
    }
    for (const l of links) if (!byLink.has(l)) byLink.set(l, g);
    if (key && !byKey.has(key)) byKey.set(key, g);
  }
  return { kept: groups.map((g) => g.kept), merges: groups.filter((g) => g.dropped.length) };
}

function readScanHistory(days) {
  const [head, ...lines] = readFileSync(join(ROOT, 'data/scan-history.tsv'), 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = head.split('\t');
  const now = Date.now();
  const seen = new Set();
  const rows = [];
  for (const line of lines) {
    const r = Object.fromEntries(line.split('\t').map((v, i) => [cols[i], v]));
    if (r.status !== 'added' || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const posted = Date.parse(r.posted_at || r.first_seen);
    const ageDays = Number.isFinite(posted) ? Math.floor((now - posted) / DAY_MS) : null;
    if (ageDays != null && ageDays > days) continue;
    rows.push({ url: r.url, title: r.title || '', co: r.company || '', loc: r.location || '', ageDays, source: (r.portal || '').replace(/-(api|full)$/, '') });
  }
  return rows;
}

function readApecCache() {
  return existsSync(APEC_CACHE) ? JSON.parse(readFileSync(APEC_CACHE, 'utf8')) : {};
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const TOP = Number(flag('--top', 25));
  const DAYS = Number(flag('--days', MAX_AGE_DAYS));
  const askApec = !argv.includes('--no-apec');
  const drops = {};
  const drop = (why) => (drops[why] = (drops[why] || 0) + 1);

  // "Never twice" inputs — the same ones the run-time claim uses.
  const { loadBlacklist } = await import('../scan.mjs');
  const blacklist = loadBlacklist();
  const trackerText = readFileSync(join(ROOT, 'data/applications.md'), 'utf8');
  const trackerLines = trackerText.split(/\r?\n/);
  const colmap = resolveColumns(trackerLines);
  const trackerKeys = new Set(trackerLines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean)
    .map((r) => `${companyKey(r.company)}|${titleKey(r.role)}`));
  const capCounts = countByCompany(trackerText);
  const runLog = readCurrentState();

  const rows = readScanHistory(DAYS);
  const candidates = [];
  for (const x of rows) {
    const logged = runLog.get(normalizeUrl(x.url));
    if (logged && logged.outcome !== 'rehearsal') { drop('already tried (run log)'); continue; }
    if (x.co && trackerKeys.has(`${companyKey(x.co)}|${titleKey(x.title)}`)) { drop('already in tracker'); continue; }
    if (x.co && matchBlacklist(blacklist, x.co)) { drop('blacklisted company'); continue; }
    if (x.co && !checkCompany(x.co, capCounts).allowed) { drop('company cap reached'); continue; }
    const v = judge(x);
    if (!v.ok) { drop(v.why); continue; }
    candidates.push({ ...x, ...v.fields });
  }

  // APEC: ask about postings not in the route memory yet, best first, at most 30.
  let apecCache = readApecCache();
  const unrouted = candidates.filter((x) => x.source === 'apec' && !apecCache[apecIdOf(x.url)]).sort((a, b) => b.score - a.score);
  if (askApec && unrouted.length) {
    mkdirSync(OUT, { recursive: true });
    const inFile = join(OUT, 'apec-ask.json');
    writeFileSync(inFile, JSON.stringify(unrouted.map((x) => ({ url: x.url, co: x.co, title: x.title, loc: x.loc, ageDays: x.ageDays }))));
    const r = spawnSync(process.execPath, [join(ROOT, 'freemotion-night/apec-route.mjs'), '--in', inFile, '--max', '30', '--out', join(OUT, 'apec-routed.json')], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status === 2) console.warn('make-pool: APEC showed a CAPTCHA; unrouted APEC postings stay kept apart this run.');
    else if (r.status !== 0) console.warn(`make-pool: apec-route failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
    apecCache = readApecCache();
  }

  const blockedSites = existsSync(SITE_BLACKLIST) ? parseSiteBlacklist(readFileSync(SITE_BLACKLIST, 'utf8')) : [];
  const routed = [];
  for (const x of candidates) {
    const rt = routeOf(x, x.source === 'apec' ? apecCache[apecIdOf(x.url)] : undefined);
    if ('drop' in rt) { drop(rt.drop); continue; }
    const route = SCHEDULED.has(rt.route) && isBlockedSite(rt.url, blockedSites) ? 'blocked-site' : rt.route;
    routed.push({ ...x, origUrl: x.url, url: rt.url, apecUrl: rt.apecUrl, route, seenOn: [x.source] });
  }

  const { kept, merges } = mergeSameJobs(routed);
  const ranked = capPerCompany([...kept].sort((a, b) => (SCHEDULED.has(b.route) - SCHEDULED.has(a.route)) || b.score - a.score));
  const list = ranked.filter((x) => SCHEDULED.has(x.route)).slice(0, TOP)
    .map((x) => ({ co: x.co, title: x.title, url: x.url, english: x.english, toulouse: x.toulouse, paris: x.paris, route: x.route, source: x.source }));

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'pool.json'), JSON.stringify(ranked.map(({ origUrl, ...x }) => x), null, 1));
  writeFileSync(join(OUT, 'list.json'), JSON.stringify(list, null, 1));
  const line = (x) => `${x.source.padEnd(13)} ${x.route.padEnd(18)} ${x.co} | ${x.title} | ${x.url}`;
  writeFileSync(join(OUT, 'merges.txt'), merges.map((g) =>
    [`KEPT    ${line(g.kept)}`, ...g.dropped.map((d, i) => `  merged ${line(d)}   (${g.by[i]})`)].join('\n')).join('\n\n') + '\n');

  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1])));
  console.log(`make-pool: ${rows.length} scanned jobs from the last ${DAYS} days`);
  console.log(`  dropped: ${sorted(drops)}`);
  console.log(`  passed the rules: ${routed.length} | merged away as duplicates: ${routed.length - kept.length} (${merges.length} groups, see merges.txt)`);
  console.log(`  kept: ${ranked.length} after the ${4}-per-company cap | by route: ${sorted(count(ranked, (x) => x.route))}`);
  console.log(`  scheduled pool by source: ${sorted(count(ranked.filter((x) => SCHEDULED.has(x.route)), (x) => x.source))}`);
  console.log(`  tonight's list: ${list.length} jobs | Toulouse ${list.filter((x) => x.toulouse).length} · Paris ${list.filter((x) => x.paris).length} · English ${list.filter((x) => x.english).length} -> ${join('tmp/fm/night', 'list.json')}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`make-pool: ${err.stack || err.message}`);
    process.exit(1);
  });
}
