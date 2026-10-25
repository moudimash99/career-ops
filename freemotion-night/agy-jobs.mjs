#!/usr/bin/env node
/**
 * freemotion-night/agy-jobs.mjs — what each agy job did, kept for good, and the agy model test.
 *
 * agy keeps only its last ~500 conversations (~/.gemini/antigravity-cli/conversations/<id>.db), so the
 * per-job facts are copied out right after each job into data/agy-jobs.tsv (append-only, one row per
 * agy job; the last row of a job wins):
 *   num  driver  asked  model  conversation  secs  tools  tool_fails  tokens_in  tokens_out  at
 * `asked` is the model run.sh passed with --model ('' = agy's default); `model` is the one the
 * conversation says it ran on. A tool call is a step of type 132; status 7 means it failed.
 *
 * The test: `arm` draws the model for one job, by default Gemini 3.8 Flash High or Medium, 50/50.
 * AGY_MODELS="gemini-3.8-flash-high:50,gemini-3.8-flash-medium:50" changes the arms and weights;
 * AGY_MODELS=off draws nothing (agy's default).
 *
 * Usage:
 *   node freemotion-night/agy-jobs.mjs arm                          # prints the model for the next job
 *   node freemotion-night/agy-jobs.mjs record <num> <driver> [asked]  # after the job: one row
 *   node freemotion-night/agy-jobs.mjs backfill                     # every job agy still remembers
 *   node freemotion-night/agy-jobs.mjs report [--summary] [--since YYYY-MM-DD]
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const LEDGER = 'data/agy-jobs.tsv';
export const HEADER = ['num', 'driver', 'asked', 'model', 'conversation', 'secs', 'tools', 'tool_fails', 'tokens_in', 'tokens_out', 'at'];
const CONV = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
const DEFAULT_ARMS = 'gemini-3.8-flash-high:50,gemini-3.8-flash-medium:50';
const MODEL_RE = /gemini-\d+(?:\.\d+)?-(?:flash|pro)(?:-lite)?-(?:high|medium|low)|claude-(?:sonnet|opus|haiku)-[\d-]+(?:-thinking)?|gpt-oss-[\w-]+/g;

/** The arms from AGY_MODELS: [[model, weight], ...]; [] when the test is off. */
export function arms(spec = process.env.AGY_MODELS ?? DEFAULT_ARMS) {
  if (!spec || spec === 'off') return [];
  return spec.split(',').map((p) => p.trim().split(':')).filter(([m]) => m).map(([m, w]) => [m, Number(w ?? 1) || 0]).filter(([, w]) => w > 0);
}
export function drawArm(list = arms(), rng = Math.random) {
  const total = list.reduce((s, [, w]) => s + w, 0);
  if (!total) return '';
  let x = rng() * total;
  for (const [m, w] of list) { if ((x -= w) < 0) return m; }
  return list[list.length - 1][0];
}

/** Tool calls, failed ones and the model, from agy's own record of one conversation; null when it is gone. */
export function readConversation(id, dir = CONV) {
  const p = join(dir, `${id}.db`);
  if (!id || !existsSync(p)) return null;
  let db;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    const t = db.prepare('select count(*) n, coalesce(sum(status = 7), 0) f from steps where step_type = 132').get();
    const seen = new Map();
    for (const r of db.prepare('select data from gen_metadata').all()) {
      for (const m of Buffer.from(r.data).toString('latin1').matchAll(MODEL_RE)) seen.set(m[0], (seen.get(m[0]) || 0) + 1);
    }
    const model = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return { tools: Number(t.n), fails: Number(t.f), model };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function row(root, num, driver, asked) {
  const p = join(root, 'tmp/fm/usage', `${driver}-${num}.json`);
  let j = null;
  try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (!j?.conversation_id) return null;
  const c = readConversation(j.conversation_id);
  if (!c) return null;
  return [num, driver, asked || '', c.model, j.conversation_id, Math.round(j.duration_seconds || 0), c.tools, c.fails,
    j.usage?.input_tokens ?? '', j.usage?.output_tokens ?? '', new Date().toISOString()];
}
function append(root, rows) {
  const p = join(root, LEDGER);
  const head = existsSync(p) ? '' : HEADER.join('\t') + '\n';
  if (rows.length) appendFileSync(p, head + rows.map((r) => r.join('\t')).join('\n') + '\n');
}
/** The ledger, the last row per job: Map num → row object. */
export function readLedger(root = getCareerOpsRoot()) {
  const out = new Map();
  let text = '';
  try { text = readFileSync(join(root, LEDGER), 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/).slice(1)) {
    const c = line.split('\t');
    if (c.length < HEADER.length) continue;
    const r = Object.fromEntries(HEADER.map((h, i) => [h, c[i]]));
    for (const k of ['secs', 'tools', 'tool_fails', 'tokens_in', 'tokens_out']) r[k] = r[k] === '' ? null : Number(r[k]);
    out.set(Number(r.num), r);
  }
  return out;
}

function backfill(root) {
  const known = readLedger(root), rows = [];
  for (const f of readdirSync(join(root, 'tmp/fm/usage'))) {
    const m = f.match(/^(agy(?:-sonnet)?)-(\d+)\.json$/);
    if (!m || known.has(Number(m[2]))) continue;
    const r = row(root, Number(m[2]), m[1], '');
    if (r) rows.push(r);
  }
  rows.sort((a, b) => a[0] - b[0]);
  append(root, rows);
  return rows.length;
}

const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; };
/** Per model: jobs, sent, minutes and tool calls per sent job, and failed tool calls over all jobs. */
export async function report(root = getCareerOpsRoot(), since = null) {
  const { jobs } = await import('./hub-records.mjs');
  const result = new Map(jobs(root).map((r) => [r.d.id, r.d]));
  const L = readLedger(root), groups = {};
  for (const [num, r] of L) {
    const j = result.get(num);
    // Only the agy try that gave the job its result: a limit hit hands the job to the next driver.
    if (!j || j.driver !== r.driver || (since && j.start < since)) continue;
    const key = (r.asked ? 'test: ' : 'before: ') + (r.model || r.asked || 'unknown');
    const g = groups[key] ||= { group: key, jobs: 0, sent: 0, mins: [], tools: [], calls: 0, fails: 0 };
    g.jobs++; g.calls += r.tools || 0; g.fails += r.tool_fails || 0;
    if (j.result === 'sent') { g.sent++; g.mins.push((j.end - j.start) / 60000); g.tools.push(r.tools || 0); }
  }
  return Object.values(groups).map((g) => ({
    group: g.group, jobs: g.jobs, sent: g.sent, sentRate: g.jobs ? g.sent / g.jobs : null,
    minPerSent: median(g.mins), toolsPerSent: median(g.tools), failRate: g.calls ? g.fails / g.calls : null,
  })).sort((a, b) => a.group.localeCompare(b.group));
}

async function main() {
  const [cmd, ...a] = process.argv.slice(2), root = getCareerOpsRoot();
  const usage = 'Usage: node freemotion-night/agy-jobs.mjs arm | record <num> <driver> [asked] | backfill | report [--summary] [--since YYYY-MM-DD]';
  if (cmd === '--help' || cmd === '-h') {
    console.log(usage);
  } else if (cmd === 'arm') {
    console.log(drawArm());
  } else if (cmd === 'record') {
    const [num, driver = 'agy', asked = ''] = a;
    const r = row(root, Number(num), driver, asked);
    if (!r) { console.error(`agy-jobs: no conversation found for job ${num}`); return; }
    append(root, [r]);
    console.log(`agy job ${num}: ${r[3] || 'model unknown'}, ${r[6]} tool calls, ${r[7]} failed`);
  } else if (cmd === 'backfill') {
    console.log(`agy-jobs: ${backfill(root)} jobs added to ${LEDGER}`);
  } else if (cmd === 'report') {
    const i = a.indexOf('--since'), since = i >= 0 ? Date.parse(a[i + 1]) : null;
    const g = await report(root, since);
    if (!a.includes('--summary')) { console.log(JSON.stringify(g, null, 2)); return; }
    const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%'), n = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
    console.log(['group', 'jobs', 'sent', 'sent %', 'min/sent', 'tools/sent', 'failed tools'].join('\t'));
    for (const r of g) console.log([r.group, r.jobs, r.sent, pct(r.sentRate), n(r.minPerSent), n(r.toolsPerSent, 0), pct(r.failRate)].join('\t'));
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
