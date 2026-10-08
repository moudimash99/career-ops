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
 * Also re-runs portals.yml location_filter (buildLocationFilter() from
 * scan.mjs) on every row: a row saved before today's block list grew (e.g.
 * the US "City, ST" entries added 2026-09-26) would otherwise still be in
 * scan-history.tsv and reach the model / the list.
 * Then the night-list rules (pool-rules.mjs), the apply route of each posting,
 * and the merge of duplicates.
 *
 * APPLY ROUTE — how each posting is applied to, from its source and link:
 *   apply-here         a form reachable directly (company ATS, WTJ, HelloWork,
 *                      France Travail recruiter/partner link, Free-Work employer
 *                      link, APEC partner link)                    → scheduled
 *   apec-account       APEC's own form, behind the APEC sign-in    → scheduled
 *   freework-account   Free-Work's own form, behind the Free-Work sign-in → scheduled
 *   francetravail-page France Travail's own page (FT account)      → scheduled (since 2026-10-08, #20)
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
 * MODEL — freemotion-night/llm-score.mjs, one plain Gemini API call per job
 * (never an agent). Jobs without a stored answer are scored best first, at most
 * --llm-max a night (default 300); an answer is stored once, ever, in
 * data/llm-scores.tsv. Every job that passed the gate first gets its posting
 * text (fetch-texts.mjs: HelloWork, WTJ, Free-Work, LinkedIn, France Travail,
 * company ATS APIs; fetched once and kept, a failure retried after 3 days, a
 * site that stops answering or a leftover backlog raised in
 * data/agent-inbox.md; --text-minutes caps it, default 120, --no-texts skips
 * it, --texts-only stops after it; APEC's text comes from apec-route.mjs,
 * at most --apec-max (30) a night), and a posting asking too_many_years or
 * more is dropped before any call. The answer then:
 *   overall < 2 (no-go)          → dropped
 *   the model reads 8+ years     → dropped, unless the text states fewer
 *   2–2.9 (stretch)              kept, ranked after every go job: applied to
 *                                only when the list has room left
 *   3+ (go)                      ranked by the fit, not the rule score (below)
 * A title that needs the model (none of our role words, a rescue word, or a
 * non-fit word next to a role word) waits until it has an answer. --no-llm, or no GEMINI_API_KEY:
 * no calls, stored answers still count.
 *
 * SECTORS (user, 2026-10-04) — config/targets.yml `sectors:`: defence,
 * government and clearance jobs get score 0, space jobs rank 1 lower. Title
 * and company words drop the obvious ones before any model call
 * (pool-rules.mjs); clearance words in the text count without a model; the
 * rest is the fit score's own sector answer (llm-sector.mjs).
 *
 * LIVE CHECK — before the list is written, the scheduled jobs are checked in
 * rank order (liveness-api.mjs, then one headless page at a time,
 * liveness-browser.mjs) and only live ones are kept: a dead or unclear link is
 * skipped and the next job takes its place until the list is full. HelloWork
 * leaves an expired posting's page up without its apply button: that reads
 * "uncertain" and is skipped too. Results are kept in data/posting-liveness.json
 * (dead 14 days, live or unclear 1 day). --no-live-check skips the step.
 *
 * Writes (tmp/fm/night/):
 *   pool.json    every kept job, ranked, with route, source, where else it was
 *                seen, and the model's fit / factors / summary when scored
 *   list.json    the top --top scheduled jobs, in make-jobs.mjs's input format
 *   merges.txt   every merge made, for spot checks
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { MAX_AGE_DAYS, capPerCompany, companyKey, judge, rankScore, titleKey } from './pool-rules.mjs';
import { applySectors, readSectors } from './llm-sector.mjs';
import { AGY_SCORE_MODEL, CLAUDE_SCORE_MODEL, DEFAULT_MODEL, FACTORS, GATE_SCHEMA, STRETCH_AT, agyGenerate, claudeGenerate, gateJobs, gateStore, geminiGateGenerate, geminiGenerate, scoreJobsAgy, jobKey, readGate, readScores, resolveCandidate, scoreJobs, verdictOf } from './llm-score.mjs';
import normalizeUrl from '../url-key.mjs';
import { readCurrentState } from '../lib/freemotion-submissions.mjs';
import { checkCompany, countByCompany, matchBlacklist } from '../lib/company-cap.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { loadTargets } from '../targets.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { requiredYears } from '../lib/required-years.mjs';
import { loadPostingTexts } from '../lib/posting-text.mjs';
import { fetchMissingTexts, raiseInInbox, textLine, textProblems } from './fetch-texts.mjs';
import { localToday } from '../lib/local-today.mjs';
import { checkLivenessViaApi } from '../liveness-api.mjs';
import { checkUrlLivenessWithFallback, jitteredDelayMs, newLivenessPage, sleep } from '../liveness-browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tmp/fm/night');
const APEC_CACHE = join(ROOT, 'data/apec-routes.json');
const DAY_MS = 86_400_000;

const SITE_BLACKLIST = join(ROOT, 'data/site-blacklist.md');

export const ROUTE_RANK = { 'apply-here': 0, 'apec-account': 1, 'freework-account': 2, 'francetravail-page': 2, 'apec-unrouted': 2, 'blocked-site': 2, 'linkedin-lead': 3 };
export const SCHEDULED = new Set(['apply-here', 'apec-account', 'freework-account', 'francetravail-page']);
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

/**
 * Apply the model's stored answers to the judged candidates. Pure; exported
 * for tests.
 * @param {object[]} candidates - judge()d rows: title, co, url, score, points, needsModel
 * @param {Map<string, Record<string, string>>} scores - readScores()
 * @param {{ tooManyYears: number|null, textYears: Map<string, number> }} opts -
 *   textYears: years read from the posting text, by URL, where the text is known
 * @returns {{ kept: object[], dropped: Array<{ row: object, why: string }> }}
 */
/**
 * Titles clearly in our fields skip the quick gate (issue #10): a role group
 * worth 1.5+ points, not unmatched / unsure / rescued, not off-stack.
 */
export const strongTitle = (x) => (x.points || 0) >= 1.5 && !x.needsModel && !x.offstack;

/**
 * The quick gate's verdicts on the rule-kept jobs. Strong titles and jobs that
 * already have a full score pass; a stored no-go is dropped; a job the gate has
 * not answered yet (no key, quota) passes and is left to the full score.
 */
export function applyGate(candidates, gate, scored) {
  const passed = [];
  const dropped = [];
  for (const x of candidates) {
    const k = jobKey(x);
    const g = strongTitle(x) || scored.has(k) ? null : gate.get(k);
    if (g && !g.go) dropped.push({ ...x, gateReason: g.reason });
    else passed.push(x);
  }
  return { passed, dropped };
}

export function applyScores(candidates, scores, { tooManyYears, textYears }) {
  const kept = [];
  const dropped = [];
  const out = (row, why) => dropped.push({ row, why });
  for (const x of candidates) {
    const fromText = textYears.get(x.url) ?? null;
    if (tooManyYears !== null && fromText !== null && fromText >= tooManyYears) { out(x, `asks ${tooManyYears}+ years`); continue; }
    const s = scores.get(jobKey(x));
    if (!s) {
      if (x.needsModel) out(x, 'waiting for the model');
      else kept.push({ ...x, tier: 'go' }); // a role-word title, not scored yet
      continue;
    }
    const overall = Number(s.overall);
    const modelYears = s.years_required === '' || s.years_required == null ? null : Number(s.years_required);
    if (overall < STRETCH_AT) { out(x, 'model: no-go'); continue; }
    if (tooManyYears !== null && modelYears !== null && modelYears >= tooManyYears && fromText === null) { out(x, `asks ${tooManyYears}+ years (model)`); continue; }
    kept.push({
      ...x,
      tier: verdictOf(overall), // go, or stretch: applied to only when no go job is left
      score: +(x.score - (x.points || 0) + (overall - 2)).toFixed(2),
      fit: overall,
      rank: rankScore({ ...x, fit: overall }),
      factors: Object.fromEntries(FACTORS.map((f) => [f, Number(s[f])])),
      summary: s.summary,
    });
  }
  return { kept, dropped };
}

/** How long a liveness result is reused (data/posting-liveness.json). */
export const LIVE_KEEP_MS = { active: DAY_MS, uncertain: DAY_MS, expired: 14 * DAY_MS };

/** One posting: the free ATS API first, else one headless page (opened once, reused). */
function browserChecker({ throttleMs = 2000 } = {}) {
  let browser = null, page = null;
  return {
    async check(url) {
      const api = await checkLivenessViaApi(url);
      if (api) return api;
      if (!browser) {
        const { chromium } = await import('playwright');
        browser = await chromium.launch({ headless: true });
        page = await newLivenessPage(browser);
      }
      const r = await checkUrlLivenessWithFallback(page, url, {});
      await sleep(jitteredDelayMs(throttleMs));
      return r;
    },
    async close() { if (browser) await browser.close(); },
  };
}

/**
 * The first `top` candidates (already in rank order) whose posting is live.
 * Sequential: never Playwright in parallel. Cached results are reused while fresh.
 * @param {Array<{ url: string }>} candidates
 * @param {number} top
 * @param {{ check?: (url: string) => Promise<{ result: string, reason?: string }>, cachePath?: string, now?: number }} [opts]
 */
export async function takeLive(candidates, top, { check, cachePath = join(ROOT, 'data/posting-liveness.json'), now = Date.now() } = {}) {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
  const fresh = (c) => c && now - c.at < (LIVE_KEEP_MS[c.result] ?? DAY_MS);
  const own = check ? null : browserChecker();
  const checkOne = check || own.check;
  const live = [];
  const dropped = [];
  let checked = 0;
  try {
    for (const x of candidates) {
      if (live.length >= top) break;
      let c = cache[x.url];
      if (!fresh(c)) {
        let r;
        try { r = await checkOne(x.url); } catch (err) { r = { result: 'uncertain', reason: `check failed: ${err.message}` }; }
        c = cache[x.url] = { result: r.result, reason: r.reason || '', at: now };
        checked++;
      }
      if (c.result === 'active') live.push(x);
      else dropped.push({ ...x, live: c.result, liveReason: c.reason });
    }
  } finally {
    if (own) await own.close();
  }
  for (const [u, c] of Object.entries(cache)) if (now - c.at > LIVE_KEEP_MS.expired) delete cache[u];
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  return { live, dropped, checked };
}

/**
 * Night-list order: scheduled routes first, then go before stretch, then
 * model-scored jobs by rank (fit + small Toulouse / Paris / English nudges,
 * pool-rules.mjs rankScore) ahead of jobs the model has not seen yet, which
 * keep the rule score; newest first on a tie.
 */
export const TIER_RANK = { go: 0, stretch: 1 };
export function rankOrder(a, b) {
  return (SCHEDULED.has(b.route) - SCHEDULED.has(a.route))
    || ((TIER_RANK[a.tier] ?? 0) - (TIER_RANK[b.tier] ?? 0))
    || ((b.rank != null) - (a.rank != null))
    || (a.rank != null ? b.rank - a.rank : b.score - a.score)
    || ((a.ageDays ?? 99) - (b.ageDays ?? 99));
}

/**
 * Score the candidates that have no stored answer yet, best first. Fetches
 * HelloWork / LinkedIn text first and leaves out postings whose text asks
 * too many years. Returns the years read from every text it saw.
 */
async function runModel(candidates, { max, rpm, model, tooManyYears, candidate, apiKey, cli, parallel, batch, since }) {
  const dataRoot = getCareerOpsRoot();
  const stored = readScores();
  const seen = new Set();
  const toScore = [...candidates].sort((a, b) => b.score - a.score).filter((x) => {
    const k = jobKey(x);
    if (stored.has(k) || seen.has(k)) return false;
    if (since && !(x.seen >= since)) return false;
    seen.add(k);
    return true;
  }).slice(0, max);
  // The texts were fetched right after the gate (fetch-texts.mjs).
  const texts = loadPostingTexts(dataRoot, toScore.map((x) => x.url));
  const textYears = new Map();
  for (const [url, text] of texts) {
    const y = requiredYears(text);
    if (y !== null) textYears.set(url, y);
  }
  const toAsk = toScore
    .filter((x) => !(tooManyYears !== null && (textYears.get(x.url) ?? -1) >= tooManyYears))
    .map((x) => ({ ...x, text: texts.get(x.url) }));
  const t0 = Date.now();
  const r = cli
    ? await scoreJobsAgy(toAsk, { candidate, driver: cli, model, parallel, max, ...(batch && { batch }), log: (m) => console.warn(m) })
    : await scoreJobs(toAsk, { generate: await geminiGenerate({ apiKey, model }), candidate, model, max, rpm, log: (m) => console.warn(m) });
  console.log(`  model: ${r.scored} scored, ${r.failed} failed${r.stoppedByQuota ? ', stopped at the daily quota' : ''} | ${toScore.length - toAsk.length} left out for their years | ${toAsk.filter((x) => x.text).length} of ${toAsk.length} with text | ${Math.round((Date.now() - t0) / 1000)} s`);
  return textYears;
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
    rows.push({ url: r.url, title: r.title || '', co: r.company || '', loc: r.location || '', ageDays, seen: (r.first_seen || '').slice(0, 10), source: (r.portal || '').replace(/-(api|full)$/, '') });
  }
  return rows;
}

function readApecCache() {
  return existsSync(APEC_CACHE) ? JSON.parse(readFileSync(APEC_CACHE, 'utf8')) : {};
}

/**
 * The jobs the night list may take, before the model: from the scan history of
 * the last `days` days, minus what was tried or applied to, blacklisted,
 * outside France, over the company cap or outside the rules (pool-rules.mjs).
 * Shared by make-pool and score-loop.mjs, so both pick from the same jobs.
 * @param {{ days?: number, drop?: (why: string) => void }} [opts]
 * @returns {Promise<{ rows: object[], candidates: object[] }>}
 */
export async function selectCandidates({ days = MAX_AGE_DAYS, drop = () => {} } = {}) {
  // "Never twice" inputs — the same ones the run-time claim uses.
  const { loadBlacklist, buildLocationFilter, PORTALS_PATH } = await import('../scan.mjs');
  const blacklist = loadBlacklist();
  // The scan's own location filter (portals.yml location_filter), run again
  // here: rows saved before a block entry was added (US "City, ST" boards
  // until 2026-09-26) would otherwise reach the model and the list.
  const { default: yaml } = await import('js-yaml');
  const inFrance = buildLocationFilter(existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf8'))?.location_filter : null);
  const trackerText = readFileSync(join(ROOT, 'data/applications.md'), 'utf8');
  const trackerLines = trackerText.split(/\r?\n/);
  const colmap = resolveColumns(trackerLines);
  const trackerKeys = new Set(trackerLines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean)
    .map((r) => `${companyKey(r.company)}|${titleKey(r.role)}`));
  const capCounts = countByCompany(trackerText);
  const runLog = readCurrentState();

  const rows = readScanHistory(days);
  // Posting texts already cached (scan, earlier fetches): judge() reads the
  // posting's language from them. Passed in, not kept on the row, so pool.json
  // stays small.
  const cachedTexts = loadPostingTexts(getCareerOpsRoot(), rows.map((r) => r.url));
  const candidates = [];
  for (const x of rows) {
    const logged = runLog.get(normalizeUrl(x.url));
    if (logged && logged.outcome !== 'rehearsal') { drop('already tried (run log)'); continue; }
    if (x.co && trackerKeys.has(`${companyKey(x.co)}|${titleKey(x.title)}`)) { drop('already in tracker'); continue; }
    if (x.co && matchBlacklist(blacklist, x.co)) { drop('blacklisted company'); continue; }
    if (!inFrance(x.loc || '', x.url, x.title)) { drop('outside France (location filter)'); continue; }
    if (x.co && !checkCompany(x.co, capCounts).allowed) { drop('company cap reached'); continue; }
    const v = judge({ ...x, text: cachedTexts.get(x.url) });
    if (!v.ok) { drop(v.why); continue; }
    candidates.push({ ...x, ...v.fields });
  }

  return { rows, candidates };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  const TOP = Number(flag('--top', 25));
  const DAYS = Number(flag('--days', MAX_AGE_DAYS));
  const askApec = !argv.includes('--no-apec');
  // Every job that passed the gate is scored (issue #10); the free daily quota
  // stops the run cleanly and the rest continues the next night.
  const LLM_MAX = Number(flag('--llm-max', 5000));
  const drops = {};
  const drop = (why) => (drops[why] = (drops[why] || 0) + 1);
  let gateLine = '';

  const { rows, candidates } = await selectCandidates({ days: DAYS, drop });

  // The model (issue #10): a quick batched go / no-go on the titles that are
  // not clearly ours, then the full score for every job that passed.
  const targets = loadTargets();

  // Quick title check mode (issue #21): config/targets.yml gate.mode, or --gate strict|loose for one run.
  const gateFlag = flag('--gate', '');
  if (gateFlag && !['strict', 'loose'].includes(gateFlag)) { console.error('--gate must be strict or loose'); process.exit(1); }
  const gate = { ...(targets?.gate || { mode: 'loose', experience: {} }), ...(gateFlag ? { mode: gateFlag } : {}) };
  const tooManyYears = targets?.tooManyYears ?? null;
  let textYears = new Map();
  let apiKey = '';
  let who = null;
  // --scorer agy | claude (user, 2026-09-30): the quick check and the fit score
  // go through agy's Claude allowance, or tool-free Haiku on the Claude plan
  // (20 jobs a call, --batch), instead of the Gemini API.
  const scorer = flag('--scorer', 'gemini');
  const cli = scorer === 'agy' || scorer === 'claude' ? scorer : null;
  const useAgy = !!cli;
  // --score-since <YYYY-MM-DD|today> (user, 2026-09-30): only jobs the scan first
  // found from that day on get a new fit score; older stored scores still count.
  const sinceArg = flag('--score-since', '');
  const scoreSince = sinceArg === 'today' ? localToday() : sinceArg;
  if (useAgy && !argv.includes('--no-llm')) {
    if (!targets?.candidate) console.warn('make-pool: config/targets.yml has no candidate: block; no model answers tonight.');
    else who = resolveCandidate(targets.candidate).candidate;
  } else if (!argv.includes('--no-llm')) {
    try { (await import('dotenv')).config({ path: join(ROOT, '.env'), quiet: true }); } catch { /* optional */ }
    apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) console.warn('make-pool: no GEMINI_API_KEY, so no new model answers tonight; titles that need one wait.');
    else if (!targets?.candidate) console.warn('make-pool: config/targets.yml has no candidate: block; no model answers tonight.');
    else who = resolveCandidate(targets.candidate).candidate;
  }
  const model = flag('--model', cli === 'claude' ? CLAUDE_SCORE_MODEL : cli === 'agy' ? AGY_SCORE_MODEL : process.env.GEMINI_MODEL || DEFAULT_MODEL);
  const hideKey = (err) => (apiKey ? String(err.message || err).split(apiKey).join('[key]') : String(err.message || err));
  const scoredBefore = readScores();
  if (who) {
    try {
      const g = await gateJobs(candidates.filter((x) => !strongTitle(x) && !scoredBefore.has(jobKey(x))), {
        generate: cli ? (cli === 'claude' ? claudeGenerate : agyGenerate)({ model, schema: GATE_SCHEMA }) : await geminiGateGenerate({ apiKey, model }), candidate: who, gate, model: cli ? `${cli}/${model}` : model, log: (m) => console.warn(m),
      });
      gateLine = `  gate (${gate.mode}): ${g.asked} titles asked (${g.go} go, ${g.noGo} no-go${g.failed ? `, ${g.failed} failed` : ''})`;
    } catch (err) {
      console.warn(`make-pool: gate step failed (${hideKey(err)}); stored answers still apply.`);
    }
  }
  const gated = applyGate(candidates, readGate(undefined, gateStore(who, gate)), scoredBefore);
  for (const d of gated.dropped) drop('gate: no-go');
  candidates.length = 0;
  candidates.push(...gated.passed);

  // Posting text for every job that passed, before the full score: fetched
  // once, kept, a failure retried after 3 days (fetch-texts.mjs). No model.
  // A fetched text can change the posting's language, so those are judged again.
  let textRun = null;
  if (!argv.includes('--no-texts')) {
    const order = [...candidates].sort((a, b) => b.score - a.score);
    textRun = await fetchMissingTexts(order, {
      root: getCareerOpsRoot(), today: localToday(), maxMinutes: Number(flag('--text-minutes', 120)), log: (m) => console.warn(m),
    });
    for (const x of candidates) {
      const text = textRun.got.get(x.url);
      if (!text) continue;
      const v = judge({ ...x, text });
      if (v.ok) Object.assign(x, v.fields);
    }
    const raised = raiseInInbox(ROOT, textProblems(textRun));
    if (raised.length) console.warn(`make-pool: raised in data/agent-inbox.md: ${raised.join('; ')}`);
  }
  // APEC: ask about postings not in the route memory yet, or routed before
  // their text was kept, best first, at most --apec-max (30). Before the
  // model, so it reads APEC's full text, not the search excerpt.
  let apecCache = readApecCache();
  const apecTodo = (x) => { const c = apecCache[apecIdOf(x.url)]; return !c || (!c.gone && !c.text); };
  const unrouted = candidates.filter((x) => x.source === 'apec' && apecTodo(x)).sort((a, b) => b.score - a.score);
  if (askApec && unrouted.length) {
    mkdirSync(OUT, { recursive: true });
    const inFile = join(OUT, 'apec-ask.json');
    writeFileSync(inFile, JSON.stringify(unrouted.map((x) => ({ url: x.url, co: x.co, title: x.title, loc: x.loc, ageDays: x.ageDays }))));
    const r = spawnSync(process.execPath, [join(ROOT, 'freemotion-night/apec-route.mjs'), '--in', inFile, '--max', String(flag('--apec-max', 30)), '--out', join(OUT, 'apec-routed.json')], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status === 2) console.warn('make-pool: APEC showed a CAPTCHA; unrouted APEC postings stay kept apart this run.');
    else if (r.status !== 0) console.warn(`make-pool: apec-route failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
    apecCache = readApecCache();
    // Their full text can change the posting's language: judge them again.
    const apecTexts = loadPostingTexts(getCareerOpsRoot(), unrouted.map((x) => x.url));
    for (const x of unrouted) {
      const text = apecTexts.get(x.url);
      const v = text ? judge({ ...x, text }) : null;
      if (v?.ok) Object.assign(x, v.fields);
    }
  }

  if (argv.includes('--texts-only')) {
    console.log(`make-pool --texts-only: ${rows.length} scanned jobs, ${candidates.length} passed the rules and the gate`);
    if (textRun) console.log(textLine(textRun));
    return;
  }
  if (who) {
    try {
      textYears = await runModel(candidates, { max: LLM_MAX, rpm: Number(flag('--rpm', 12)), model, tooManyYears, candidate: who, apiKey, cli, parallel: Number(flag('--parallel', 3)), batch: Number(flag('--batch', 0)) || null, since: scoreSince });
    } catch (err) {
      console.warn(`make-pool: model step failed (${hideKey(err)}); stored scores still apply.`);
    }
  }
  const scores = readScores();
  // The text's own number beats the model's reading: load the texts of jobs
  // the model says ask too many years, so a stated "5 ans" keeps them.
  if (tooManyYears !== null) {
    const doubt = candidates.filter((x) => !textYears.has(x.url) && Number(scores.get(jobKey(x))?.years_required) >= tooManyYears).map((x) => x.url);
    for (const [url, text] of loadPostingTexts(getCareerOpsRoot(), doubt)) {
      const y = requiredYears(text);
      if (y !== null) textYears.set(url, y);
    }
  }
  const applied = applyScores(candidates, scores, { tooManyYears, textYears });
  for (const d of applied.dropped) drop(d.why);
  candidates.length = 0;
  candidates.push(...applied.kept);


  const blockedSites = existsSync(SITE_BLACKLIST) ? parseSiteBlacklist(readFileSync(SITE_BLACKLIST, 'utf8')) : [];
  const routed = [];
  for (const x of candidates) {
    const rt = routeOf(x, x.source === 'apec' ? apecCache[apecIdOf(x.url)] : undefined);
    if ('drop' in rt) { drop(rt.drop); continue; }
    const route = SCHEDULED.has(rt.route) && isBlockedSite(rt.url, blockedSites) ? 'blocked-site' : rt.route;
    routed.push({ ...x, origUrl: x.url, url: rt.url, apecUrl: rt.apecUrl, route, seenOn: [x.source] });
  }

  const { kept, merges } = mergeSameJobs(routed);

  // Sectors (user, 2026-10-04): targets.yml `sectors:`. The fit score's own
  // answer (llm-sector.mjs, stored in data/llm-sector.tsv) gives defence,
  // government and clearance jobs score 0 and ranks space lower; clearance
  // words in the text count without an answer. No model call here.
  const sectorConfig = targets?.sectors ?? { drop: [], penalty: {} };
  let sectorLine = '';
  let sectorKept = kept;
  if (sectorConfig.drop.length || Object.keys(sectorConfig.penalty).length) {
    const sectorTexts = loadPostingTexts(getCareerOpsRoot(), kept.map((x) => x.origUrl || x.url));
    const byUrl = new Map(kept.map((x) => [x.url, sectorTexts.get(x.origUrl || x.url)]));
    const applied = applySectors(kept, readSectors(), byUrl, sectorConfig);
    for (const d of applied.dropped) drop(d.why);
    sectorKept = applied.kept;
    const penalized = sectorKept.filter((x) => x.sectorPenalty).length;
    sectorLine = `  sectors: ${applied.dropped.length} at score 0, ${penalized} ranked lower, ${applied.unanswered} not judged yet`;
  }
  const ranked = capPerCompany([...sectorKept].sort(rankOrder));
  const scheduled = ranked.filter((x) => SCHEDULED.has(x.route));
  const liveCheck = argv.includes('--no-live-check') ? null : await takeLive(scheduled, TOP);
  const list = (liveCheck ? liveCheck.live : scheduled.slice(0, TOP))
    .map((x) => ({ co: x.co, title: x.title, url: x.url, english: x.english, toulouse: x.toulouse, paris: x.paris, route: x.route, source: x.source, tier: x.tier, ...(x.fit != null ? { fit: x.fit } : {}), ...(x.sector ? { sector: x.sector } : {}) }));

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'pool.json'), JSON.stringify(ranked.map(({ origUrl, ...x }) => x), null, 1));
  writeFileSync(join(OUT, 'list.json'), JSON.stringify(list, null, 1));
  if (liveCheck) writeFileSync(join(OUT, 'dead.txt'), liveCheck.dropped.map((x) => `${x.live.padEnd(9)} ${x.co} | ${x.title} | ${x.url}${x.liveReason ? `  (${x.liveReason})` : ''}`).join('\n') + '\n');
  const line = (x) => `${x.source.padEnd(13)} ${x.route.padEnd(18)} ${x.co} | ${x.title} | ${x.url}`;
  writeFileSync(join(OUT, 'merges.txt'), merges.map((g) =>
    [`KEPT    ${line(g.kept)}`, ...g.dropped.map((d, i) => `  merged ${line(d)}   (${g.by[i]})`)].join('\n')).join('\n\n') + '\n');

  const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1])));
  console.log(`make-pool: ${rows.length} scanned jobs from the last ${DAYS} days`);
  console.log(`  dropped: ${sorted(drops)}`);
  if (gateLine) console.log(gateLine);
  if (textRun) console.log(textLine(textRun));
  console.log(`  passed the rules: ${routed.length} | merged away as duplicates: ${routed.length - kept.length} (${merges.length} groups, see merges.txt)`);
  if (sectorLine) console.log(sectorLine);
  console.log(`  kept: ${ranked.length} after the ${4}-per-company cap | by route: ${sorted(count(ranked, (x) => x.route))}`);
  console.log(`  scheduled pool by source: ${sorted(count(ranked.filter((x) => SCHEDULED.has(x.route)), (x) => x.source))}`);
  if (liveCheck) console.log(`  live check: ${liveCheck.checked} checked (the rest cached), ${liveCheck.dropped.length} skipped as dead or unclear (see dead.txt)`);
  console.log(`  tonight's list: ${list.length} jobs | Toulouse ${list.filter((x) => x.toulouse).length} · Paris ${list.filter((x) => x.paris).length} · English ${list.filter((x) => x.english).length} · model-scored ${list.filter((x) => x.fit != null).length} · stretch ${list.filter((x) => x.tier === 'stretch').length} -> ${join('tmp/fm/night', 'list.json')}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`make-pool: ${err.stack || err.message}`);
    process.exit(1);
  });
}
