#!/usr/bin/env node
/**
 * freemotion-night/codex-usage.mjs — how much of the Codex allowance the apply
 * runs use, job by job, and how many jobs are left before the next pause.
 *
 * Codex writes one session log per `codex exec` (~/.codex/sessions/YYYY/MM/DD/
 * rollout-*.jsonl). Its `rate_limits` events carry the plan's two windows:
 * `primary` (5 hours) and `secondary` (weekly), each with used_percent and
 * resets_at. The session's prompt names the job sheet (job-<N>.md), which ties
 * a session to a night job; the job's own tokens are in tmp/fm/usage/codex-<N>.json
 * (the `turn.completed` usage). Read only: nothing is written.
 *
 * Usage:
 *   node freemotion-night/codex-usage.mjs            this run (tmp/fm/night/run-id)
 *   node freemotion-night/codex-usage.mjs --all      every Codex job today and yesterday
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = join(homedir(), '.codex/sessions');
const all = process.argv.includes('--all');
const paris = (sec) => new Date(sec * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// Session logs from the last two days (a night run crosses midnight).
function sessionFiles() {
  const out = [];
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 864e5);
    const dir = join(SESSIONS, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(join(dir, f));
  }
  return out.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/** The job number a session worked on, and the last rate_limits it saw. */
function readSession(path) {
  const text = readFileSync(path, 'utf8');
  const job = (text.match(/night[\\/]+job-(\d+)\.md/) || [])[1];
  let limits = null;
  const find = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.rate_limits?.primary) return o.rate_limits;
    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    return null;
  };
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;
    try { limits = find(JSON.parse(line)) || limits; } catch { /* torn line */ }
  }
  return { job: job ? Number(job) : null, limits, mtime: statSync(path).mtimeMs };
}

/** Tokens a night job used, from its exec log. */
function jobTokens(n) {
  const p = join(ROOT, `tmp/fm/usage/codex-${n}.json`);
  if (!existsSync(p)) return null;
  const t = { input: 0, cached: 0, output: 0 };
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const u = JSON.parse(line).usage || {};
      t.input += u.input_tokens || 0; t.cached += u.cached_input_tokens || 0; t.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
    } catch { /* skip */ }
  }
  return t;
}

/** The outcome and company of a job in a run, from the submissions log. */
function outcomes(run) {
  const out = new Map();
  const p = join(ROOT, 'data/freemotion-submissions.tsv');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length > 7 && (all || c[7] === run)) out.set(c[1], { company: c[2], outcome: c[5] });
  }
  return out;
}
const urlOf = (n) => {
  const p = join(ROOT, `tmp/fm/night/job-${n}.md`);
  return existsSync(p) ? ((readFileSync(p, 'utf8').match(/^ {3}(https?:\/\/\S+)/m) || [])[1] || '') : '';
};

const run = existsSync(join(ROOT, 'tmp/fm/night/run-id')) ? readFileSync(join(ROOT, 'tmp/fm/night/run-id'), 'utf8').trim() : '';
const results = outcomes(run);
const sessions = sessionFiles().map(readSession);
const latest = [...sessions].reverse().find((s) => s.limits)?.limits;

console.log(`Codex allowance${latest ? '' : ': no rate-limit data found in today\'s session logs'}`);
if (latest) {
  const p = latest.primary, s = latest.secondary;
  console.log(`  5-hour window: ${p.used_percent}% used, resets ${paris(p.resets_at)}`);
  console.log(`  weekly:        ${s.used_percent}% used, resets ${paris(s.resets_at)}`);
}

// Night jobs, in the order they ran, with the 5-hour % after each.
// A job can open more than one session; its last one holds the % after the job.
const lastPerJob = new Map();
// A sheet names its run id, so a job number from an earlier run (same posting) is left out.
const inRun = (n) => { const p = join(ROOT, `tmp/fm/night/job-${n}.md`); return existsSync(p) && readFileSync(p, 'utf8').includes(run); };
for (const s of sessions) if (s.job && s.limits && (all || inRun(s.job))) lastPerJob.set(s.job, s);
const jobs = [...lastPerJob.values()].sort((a, b) => a.mtime - b.mtime);
if (!jobs.length) { console.log(`\nNo Codex night jobs yet${all ? '' : ` in run ${run}`}.`); process.exit(0); }
console.log(`\n${all ? 'Codex night jobs, today and yesterday' : `Run ${run}`}:`);
console.log('  job   5h%   +%   weekly%  tokens in (cached) / out   outcome            company');
let prev = null;
const deltas = [];
for (const s of jobs) {
  const r = results.get(urlOf(s.job)) || {};
  const t = jobTokens(s.job);
  const p = s.limits.primary.used_percent;
  const d = prev !== null && p >= prev ? p - prev : null;
  if (d !== null && r.outcome && r.outcome !== 'in-progress') deltas.push(d); // a running job has not used its share yet
  console.log(`  ${String(s.job).padEnd(5)} ${String(p).padStart(4)}  ${d === null ? '   ' : `+${d}`.padStart(3)}  ${String(s.limits.secondary.used_percent).padStart(6)}   ${t ? `${fmt(t.input)} (${fmt(t.cached)}) / ${fmt(t.output)}`.padEnd(24) : '-'.padEnd(24)} ${(r.outcome || '?').padEnd(18)} ${r.company || ''}`);
  prev = p;
}
if (deltas.length && latest) {
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const left = avg > 0 ? Math.floor((100 - latest.primary.used_percent) / avg) : null;
  console.log(`\n  average: ${avg.toFixed(1)}% of the 5-hour window per job${left !== null ? ` → about ${left} more job(s) before the pause (resets ${paris(latest.primary.resets_at)})` : ''}`);
}
