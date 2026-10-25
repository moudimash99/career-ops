#!/usr/bin/env node
/**
 * freemotion-night/agy-usage.mjs — agy's allowance: how much of each model group's week and 5 hours is
 * left, and what the agy jobs of a run cost of it.
 *
 *   now        `agy -p /usage` (agy's own slash command, no model call) prints one line per window:
 *              "<group>\t<Weekly|Five Hour> Limit Remaining\t<NN%|disabled>\t<reset ISO>". Groups today:
 *              "Gemini Models" (the agy driver) and "Claude and GPT models" (agy-sonnet).
 *   per run    each reading is appended to tmp/fm/usage/agy-quota.tsv; `--since <ISO>` compares now with
 *              the first reading at or after that time and divides by the agy jobs started since
 *              (tmp/fm/usage/night-runs.tsv), so a run ends with "% per job" and "jobs a week".
 *
 * 2026-10-15: Gemini 3.8 Flash (High), 8 jobs used 6% of the week: ~0.75% a job, ~130 jobs a week.
 * The percentages are whole numbers, so a run of a few jobs gives a rough figure.
 *
 * Usage: node freemotion-night/agy-usage.mjs [--since <ISO>]
 * Writes only tmp/fm/usage/agy-quota.tsv.
 */

import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'tmp/fm/usage/agy-quota.tsv');
const RUNS = join(ROOT, 'tmp/fm/usage/night-runs.tsv');

/** The windows in `/usage` output: [{group, window: 'week'|'5h', left: number|null, reset}]. */
export function parseUsage(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [group, label, value, reset] = line.split('\t').map((s) => s?.trim());
    if (!group || !label || !/limit remaining/i.test(label)) continue;
    const window = /week/i.test(label) ? 'week' : /five hour|5.?h/i.test(label) ? '5h' : label;
    const pct = String(value).match(/^(\d+(?:\.\d+)?)%$/);
    out.push({ group, window, left: pct ? Number(pct[1]) : null, reset: reset || '' });
  }
  return out;
}

/**
 * What the run cost: for each window, the reading at `since` vs now. A window whose reset time moved
 * was renewed in between, so its difference means nothing and is left out.
 */
export function spent(before, now, jobs) {
  const rows = [];
  for (const n of now) {
    const b = before.find((x) => x.group === n.group && x.window === n.window);
    if (!b || b.left == null || n.left == null) continue;
    if (b.reset && n.reset && b.reset !== n.reset) { rows.push({ ...n, renewed: true }); continue; }
    const used = b.left - n.left;
    rows.push({ ...n, from: b.left, used, perJob: jobs ? used / jobs : null, jobsPerWindow: jobs && used > 0 ? Math.floor(100 / (used / jobs)) : null });
  }
  return rows;
}

function readUsage() {
  // An empty folder: no project instructions or files for agy to pick up, whatever it does with the line.
  const cwd = mkdtempSync(join(tmpdir(), 'agy-usage-'));
  // One retry: a call right after another agy call sometimes prints nothing.
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('agy', ['-p', '/usage', '--print-timeout', '50s'], {
      cwd, encoding: 'utf8', timeout: 70_000, windowsHide: true,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },  // Git Bash would turn "/usage" into a file path
    });
    const w = parseUsage(r.stdout || '');
    if (w.length) return w;
  }
  return [];
}

function logged() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [at, group, window, left, reset] = l.split('\t');
    return { at, group, window, left: left === '' ? null : Number(left), reset };
  });
}

function agyJobsSince(since) {
  if (!existsSync(RUNS)) return 0;
  return readFileSync(RUNS, 'utf8').split('\n').filter((l) => {
    const [, start, , driver] = l.split('\t');
    return driver && /^agy/.test(driver) && start >= since;
  }).length;
}

const short = (g) => (/gemini/i.test(g) ? 'Gemini' : /claude|gpt/i.test(g) ? 'Claude/GPT' : g);
const day = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? iso : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }); };

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: node freemotion-night/agy-usage.mjs [--since <ISO>]'); process.exit(0); }
  const since = argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : null;
  const now = readUsage();
  if (!now.length) { console.log('allowance: agy unavailable (agy -p /usage gave no limits)'); process.exit(0); }
  const at = new Date().toISOString();
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, now.map((w) => [at, w.group, w.window, w.left ?? '', w.reset].join('\t')).join('\n') + '\n');

  const parts = now.map((w) => `${short(w.group)} ${w.window} ${w.left == null ? 'off' : `${w.left}% left`}${w.left != null && w.reset ? ` (resets ${day(w.reset)})` : ''}`);
  console.log(`allowance: agy ${parts.join(', ')}`);

  if (since) {
    const first = logged().filter((r) => r.at >= since && r.at < at);
    const t0 = first[0]?.at;
    const before = first.filter((r) => r.at === t0);
    const jobs = agyJobsSince(since);
    for (const r of spent(before, now, jobs)) {
      if (r.window !== 'week') continue;
      if (r.renewed) { console.log(`agy ${short(r.group)} week: renewed during the run, no figure`); continue; }
      if (!r.used) continue;
      const each = r.perJob == null ? '' : `: ~${r.perJob.toFixed(2)}% a job, ~${r.jobsPerWindow} jobs a week`;
      console.log(`agy ${short(r.group)} week: ${r.from}% -> ${r.left}% left over ${jobs} agy job(s)${each}`);
    }
  }
}
