#!/usr/bin/env node
// @ts-check
/**
 * lib/site-bench.mjs — application sites put on the bench for a while, by rules, from what happened
 * there (W42 review; user, 2026-10-13). Never "apply by hand": a benched job is skipped.
 *
 * Every finished night job is logged with the site the form was really on (the employer's page after a
 * HelloWork hand-off, else the posting's own page):
 *   data/site-outcomes.tsv   at · run · job · posting_host · apply_url · outcome · note
 *
 * The rules (a site = its host, e.g. jobs.lever.co, recrute1-carrefour.icims.com):
 *   captcha     5+ CAPTCHAs in 3 days AND 80%+ of its attempts in those 3 days ended in one
 *               → benched 7 days from that CAPTCHA
 *   waf         a bot block ("Accès temporairement restreint", blocked-waf) → benched 30 min, then
 *               1 h, 2 h… (doubling, at most 24 h) while the blocks go on; a sent application resets it
 *   two-step    the account forces two-step verification (L61) → benched 30 days; when it happens
 *               again after that, for good
 *   limit       the employer's application limit (Ashby, L66) → that employer's board (host + its first
 *               path part, e.g. jobs.ashbyhq.com/acme) benched 90 days
 *
 *   node lib/site-bench.mjs check <url>        exit 3 and the reason when its site is benched, else 0
 *   node lib/site-bench.mjs log <num> <run>    log job <num>'s result (run.sh, after every job)
 *   node lib/site-bench.mjs list               what is benched now, and until when
 *   node lib/site-bench.mjs seed [days]        build the log from the last 7 days of jobs (once, a new file)
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from './is-main-module.mjs';
import normalizeUrl from '../url-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTCOMES_FILE = 'data/site-outcomes.tsv';
const COLUMNS = ['at', 'run', 'job', 'posting_host', 'apply_url', 'outcome', 'note'];
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const RULES = {
  captcha: { window: 3 * DAY, min: 5, share: 0.8, bench: 7 * DAY },
  waf: { first: 30 * MIN, max: DAY },
  twoStep: { bench: 30 * DAY },
  limit: { bench: 90 * DAY },
};
const TWO_STEP_RE = /two[- ]?step|2fa|\bmfa\b|multi[- ]?factor|deux [ée]tapes|double authentification|authentification (à|a) (deux|double)|authenticator/i;
const LIMIT_RE = /application limit|limiting applications|limit(e)? (of|on|de|d'|des) (applications|candidatures)|maximum (number of )?applications|nombre maximum de candidatures/i;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** The employer's own board on a shared host: host + its first path part. */
const boardOf = (u) => { try { const x = new URL(u); return `${x.hostname.toLowerCase().replace(/^www\./, '')}/${(x.pathname.split('/')[1] || '').toLowerCase()}`; } catch { return ''; } };

/** Where the form of a job was: the employer's page a HelloWork hand-off names, else the posting. */
export function applyUrlOf(sheetText, postingUrl) {
  return (String(sheetText || '').match(/Start at the employer's page: (https?:\/\/\S+)/) || [])[1] || postingUrl || '';
}

/** @param {string} text */
export function parseOutcomes(text) {
  return String(text || '').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const c = l.split('\t');
    return Object.fromEntries(COLUMNS.map((k, i) => [k, c[i] ?? '']));
  }).filter((r) => r.at && r.apply_url);
}

/**
 * What is benched at `now`: key (host, or host/board for the limit rule) → { until, why }.
 * @param {ReturnType<typeof parseOutcomes>} rows
 * @param {number} [now]
 * @returns {Map<string, { until: number, why: string }>}
 */
export function benchState(rows, now = Date.now()) {
  const out = new Map();
  const put = (key, until, why) => { if (until > now && (!out.has(key) || out.get(key).until < until)) out.set(key, { until, why }); };
  const sorted = [...rows].map((r) => ({ ...r, t: Date.parse(r.at), host: hostOf(r.apply_url) })).filter((r) => r.t && r.host).sort((a, b) => a.t - b.t);
  const byHost = new Map();
  for (const r of sorted) { if (!byHost.has(r.host)) byHost.set(r.host, []); byHost.get(r.host).push(r); }
  for (const [host, list] of byHost) {
    // captcha: the rule checked at each CAPTCHA, over the 3 days before it.
    const C = RULES.captcha;
    for (const r of list) {
      if (r.outcome !== 'captcha') continue;
      const win = list.filter((x) => x.t > r.t - C.window && x.t <= r.t);
      const n = win.filter((x) => x.outcome === 'captcha').length;
      if (n >= C.min && n / win.length >= C.share) put(host, r.t + C.bench, `CAPTCHA: ${n} of ${win.length} attempts in 3 days`);
    }
    // waf: doubling back-off while the blocks go on.
    let streak = 0, until = 0;
    for (const r of list) {
      if (r.outcome === 'submitted') { streak = 0; until = 0; continue; }
      if (r.outcome !== 'blocked-waf') continue;
      streak++;
      until = r.t + Math.min(RULES.waf.first * 2 ** (streak - 1), RULES.waf.max);
    }
    if (until) put(host, until, `bot block (${streak} in a row): backing off`);
    // two-step: 30 days, then for good when it is still there.
    const two = list.filter((r) => TWO_STEP_RE.test(r.note));
    if (two.length) {
      const again = two.some((r) => r.t >= two[0].t + RULES.twoStep.bench);
      put(host, again ? Infinity : two[0].t + RULES.twoStep.bench, again ? 'forces two-step verification (again after 30 days): for good' : 'forces two-step verification');
    }
    // limit: the employer's own board on the shared host.
    for (const r of list) if (LIMIT_RE.test(r.note)) put(boardOf(r.apply_url), r.t + RULES.limit.bench, "the employer's application limit");
  }
  return out;
}

/** The bench entry that covers `url` (its host, or its board on a shared host), or null. */
export function benchedFor(state, url) {
  return state.get(hostOf(url)) || state.get(boardOf(url)) || null;
}

export function readOutcomes(root = ROOT) {
  const p = join(root, OUTCOMES_FILE);
  return existsSync(p) ? parseOutcomes(readFileSync(p, 'utf8')) : [];
}

/** Log one finished job (run.sh, after every job). */
export function logJob(root, num, run) {
  const sheetPath = join(root, `tmp/fm/night/job-${num}.md`);
  if (!existsSync(sheetPath)) return null;
  const sheet = readFileSync(sheetPath, 'utf8');
  const posting = (sheet.match(/^ {3}(https?:\/\/\S+)/m) || [])[1] || '';
  const ledger = join(root, 'data/freemotion-submissions.tsv');
  const key = normalizeUrl(posting);
  let outcome = '', note = '';
  if (existsSync(ledger)) {
    for (const l of readFileSync(ledger, 'utf8').split(/\r?\n/)) {
      const c = l.split('\t');
      if (c[0] && c[0] === key && c[7] === run && c[5] !== 'in-progress') { outcome = c[5]; note = c[8] || ''; }
    }
  }
  if (!outcome || outcome === 'skipped') return null;
  const p = join(root, OUTCOMES_FILE);
  if (!existsSync(p)) writeFileSync(p, COLUMNS.join('\t') + '\n');
  const row = [new Date().toISOString(), run, num, hostOf(posting), applyUrlOf(sheet, posting), outcome, note.replace(/[\t\r\n]+/g, ' ').slice(0, 300)];
  appendFileSync(p, row.join('\t') + '\n');
  return row;
}

/**
 * Build data/site-outcomes.tsv from the run log and the job sheets of the last `days` days, so the rules
 * have a history from the first night (a new file only; an existing one is left alone).
 */
export function seed(root, days = 7, now = Date.now()) {
  const p = join(root, OUTCOMES_FILE);
  if (existsSync(p)) return { written: 0, why: `${OUTCOMES_FILE} already exists` };
  const night = join(root, 'tmp/fm/night');
  const jobs = new Map();   // url key|run → { num, sheet }
  for (const f of existsSync(night) ? readdirSync(night) : []) {
    const m = f.match(/^job-(\d+)\.json$/);
    if (!m) continue;
    try {
      const j = JSON.parse(readFileSync(join(night, f), 'utf8'));
      const sheetPath = join(night, `job-${m[1]}.md`);
      if (j.url && j.run) jobs.set(`${normalizeUrl(j.url)}|${j.run}`, { num: m[1], sheet: existsSync(sheetPath) ? readFileSync(sheetPath, 'utf8') : '' });
    } catch { /* a torn sheet */ }
  }
  const last = new Map();
  for (const l of readFileSync(join(root, 'data/freemotion-submissions.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
    const c = l.split('\t');
    if (!c[0] || !c[5] || ['in-progress', 'rehearsal', 'skipped'].includes(c[5])) continue;
    if (Date.parse(c[6]) < now - days * DAY) continue;
    last.set(`${c[0]}|${c[7]}`, c);
  }
  const rows = [];
  for (const [k, c] of last) {
    const job = jobs.get(k);
    if (!job) continue;
    rows.push([c[6], c[7], job.num, hostOf(c[1]), applyUrlOf(job.sheet, c[1]), c[5], String(c[8] || '').replace(/[\t\r\n]+/g, ' ').slice(0, 300)]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  writeFileSync(p, [COLUMNS.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n') + '\n');
  return { written: rows.length };
}

const until = (t) => (t === Infinity ? 'for good' : `until ${new Date(t).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'check' && a) {
    const hit = benchedFor(benchState(readOutcomes()), a);
    if (hit) { console.log(`benched ${until(hit.until)}: ${hit.why}`); process.exit(3); }
    return;
  }
  if (cmd === 'log' && a && b) { logJob(ROOT, a, b); return; }
  if (cmd === 'seed') { const r = seed(ROOT, Number(a) || 7); console.log(r.why || `${r.written} jobs written to ${OUTCOMES_FILE}`); return; }
  if (cmd === 'list') {
    const s = benchState(readOutcomes());
    if (!s.size) console.log('No site is benched.');
    for (const [k, v] of s) console.log(`${k}  ${until(v.until)}  ${v.why}`);
    return;
  }
  console.log('Usage: node lib/site-bench.mjs check <url> | log <num> <run> | list | seed [days]');
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1);
}

if (isMainModule(import.meta.url)) main();
