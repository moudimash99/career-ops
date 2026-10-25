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
 * The test: `arm` draws the model for one job, by default the newest Gemini Flash Medium or Low, 50/50
 * (High and Medium did the same, 2026-10-25). AGY_MODELS="flash-high:50,gemini-3.8-flash-medium:50" changes
 * the arms and weights: a family name is the newest Gemini of that family (`agy models`, read once a day),
 * a full name is kept. AGY_MODELS=off draws nothing (agy's default).
 * The cost: `weekCost` sets the Gemini week's % between agy's readings against the jobs each model ran
 * in between (least squares), so the report says what a job costs of the week, per model.
 *
 * Usage:
 *   node freemotion-night/agy-jobs.mjs arm                          # prints the model for the next job
 *   node freemotion-night/agy-jobs.mjs record <num> <driver> [asked]  # after the job: one row
 *   node freemotion-night/agy-jobs.mjs backfill                     # every job agy still remembers
 *   node freemotion-night/agy-jobs.mjs report [--summary] [--since YYYY-MM-DD]
 */
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const LEDGER = 'data/agy-jobs.tsv';
export const HEADER = ['num', 'driver', 'asked', 'model', 'conversation', 'secs', 'tools', 'tool_fails', 'tokens_in', 'tokens_out', 'at'];
const CONV = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
// Flash High and Medium did the same (2026-10-25: 84% and 85% sent, 5 min each), so the cheaper pair is next.
const DEFAULT_ARMS = 'flash-medium:50,flash-low:50';
const MODEL_RE = /gemini-\d+(?:\.\d+)?-(?:flash|pro)(?:-lite)?-(?:high|medium|low)|claude-(?:sonnet|opus|haiku)-[\d-]+(?:-thinking)?|gpt-oss-[\w-]+/g;

/** The arms from AGY_MODELS: [[model, weight], ...]; [] when the test is off. A family name ("flash-medium")
 *  stands for the newest Gemini of that family agy offers, so a new Gemini is tested without a change here. */
export function arms(spec = process.env.AGY_MODELS ?? DEFAULT_ARMS, list = null) {
  if (!spec || spec === 'off') return [];
  return spec.split(',').map((p) => p.trim().split(':')).filter(([m]) => m).map(([m, w]) => [newest(m, list), Number(w ?? 1) || 0]).filter(([m, w]) => m && w > 0);
}

/** The newest model of a family ("flash-medium" -> "gemini-3.8-flash-medium") among agy's models; a full
 *  name is kept as it is. `list` defaults to `agy models`, read at most once a day (MODELS_CACHE). */
export function newest(name, list = null) {
  if (/^(gemini|claude|gpt)-/.test(name)) return name;
  const all = list || agyModels();
  const fam = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${name.replace(/[^\w-]/g, '')}$`);
  const hits = all.map((m) => [m, fam.exec(m)]).filter(([, x]) => x).sort((a, b) => Number(b[1][1]) - Number(a[1][1]));
  return hits[0]?.[0] || '';
}
const MODELS_CACHE = 'tmp/fm/usage/agy-models.json';
function agyModels(root = getCareerOpsRoot()) {
  const p = join(root, MODELS_CACHE);
  try { const c = JSON.parse(readFileSync(p, 'utf8')); if (Date.now() - c.at < 864e5 && c.models.length) return c.models; } catch { /* none yet */ }
  const r = spawnSync('agy', ['models'], { cwd: tmpdir(), encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const models = String(r.stdout || '').split(/\r?\n/).map((l) => l.split('\t')[0].trim()).filter((m) => /^[a-z]+-[\w.-]+$/.test(m));
  if (models.length) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify({ at: Date.now(), models })); return models; }
  try { return JSON.parse(readFileSync(p, 'utf8')).models; } catch { return []; }
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

/**
 * What an agy job costs of agy's Gemini week, per model: the week's % between two readings
 * (tmp/fm/usage/agy-quota.tsv, read every 30 minutes by burn.mjs) set against the jobs each model ran in
 * between, by least squares: used_i = sum over models of cost_m * jobs_im. Only intervals inside one
 * week, whose jobs all ran under the test. The readings are whole %, so a model needs some 20 intervals
 * before its figure means much. Includes any CV or letter agy wrote in between.
 */
export function weekCost(root = getCareerOpsRoot()) {
  let q = [];
  try { q = readFileSync(join(root, 'tmp/fm/usage/agy-quota.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t')); } catch { return []; }
  const reads = q.filter((r) => /gemini/i.test(r[1]) && r[2] === 'week' && r[3] !== '').map((r) => ({ t: Date.parse(r[0]), left: Number(r[3]), reset: r[4] }));
  const jobs = [...readLedger(root).values()].filter((r) => r.driver === 'agy').map((r) => ({ model: r.asked ? r.model || r.asked : '', at: Date.parse(r.at) }));
  const rows = [];
  for (let i = 1; i < reads.length; i++) {
    const a = reads[i - 1], b = reads[i];
    if (a.reset !== b.reset || b.left > a.left) continue;
    const js = jobs.filter((j) => j.at > a.t && j.at <= b.t);
    if (!js.length || js.some((j) => !j.model)) continue;
    const n = {};
    for (const j of js) n[j.model] = (n[j.model] || 0) + 1;
    rows.push({ used: a.left - b.left, n });
  }
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.n)))].sort();
  if (!models.length) return [];
  // Normal equations (X'X) c = X'y, solved by Gaussian elimination.
  const k = models.length, A = models.map(() => Array(k + 1).fill(0));
  for (const r of rows) {
    const x = models.map((m) => r.n[m] || 0);
    for (let i = 0; i < k; i++) { for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; A[i][k] += x[i] * r.used; }
  }
  for (let c = 0; c < k; c++) {
    const p = A.slice(c).reduce((best, row, i) => (Math.abs(row[c]) > Math.abs(A[best][c]) ? i + c : best), c);
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-9) return models.map((m) => ({ model: m, perJob: null, jobs: rows.reduce((s, r) => s + (r.n[m] || 0), 0), intervals: rows.length }));
    for (let i = 0; i < k; i++) if (i !== c) { const f = A[i][c] / A[c][c]; for (let j = c; j <= k; j++) A[i][j] -= f * A[c][j]; }
  }
  return models.map((m, i) => ({ model: m, perJob: A[i][k] / A[i][i], jobs: rows.reduce((s, r) => s + (r.n[m] || 0), 0), intervals: rows.length }));
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
    const cost = new Map(weekCost(root).map((c) => [c.model, c]));
    for (const r of g) { const c = cost.get(r.group.replace(/^(test|before): /, '')); r.weekPerJob = r.group.startsWith('test: ') && c ? c.perJob : null; }
    if (!a.includes('--summary')) { console.log(JSON.stringify(g, null, 2)); return; }
    const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%'), n = (x, d = 1) => (x == null ? '—' : x.toFixed(d));
    console.log(['group', 'jobs', 'sent', 'sent %', 'min/sent', 'tools/sent', 'failed tools', 'week %/job'].join('\t'));
    for (const r of g) console.log([r.group, r.jobs, r.sent, pct(r.sentRate), n(r.minPerSent), n(r.toolsPerSent, 0), pct(r.failRate), r.weekPerJob == null ? '—' : r.weekPerJob.toFixed(2)].join('\t'));
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
