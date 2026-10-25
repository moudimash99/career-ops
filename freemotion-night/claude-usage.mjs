#!/usr/bin/env node
/**
 * freemotion-night/claude-usage.mjs — how much of each Claude subscription is used: the weekly window
 * and the 5-hour window, in %, with when each resets. run.sh prints it before every run.
 *
 * Claude Code reports both windows with every answer in print mode (`--output-format stream-json`, a
 * `rate_limit_event` whose `unifiedWindows` holds five_hour and seven_day: utilization 0..1, resetsAt in
 * epoch seconds). So the check is one tiny call per account: no tools, a one-line system prompt, about
 * 900 tokens. It goes through `claude` itself, which signs in as usual; the login files are not read.
 *
 * Accounts: the two a run uses: `sonnet` (this shell's CLAUDE_CONFIG_DIR) and `sonnet1` (CLAUDE1_DIR,
 * else the second account, same rule as run.sh). --all: every ~/.claude-account* folder and ~/.claude.
 * Each check is appended to tmp/fm/usage/claude-windows.tsv (time, folder, 5-hour %, week %, resets).
 *
 * Usage:
 *   node freemotion-night/claude-usage.mjs [--all] [--json]
 */

import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { secondClaudeDir } from '../lib/doc-writers.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const paris = (sec) => new Date(sec * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The last rate_limit_event's two windows in a stream-json output, as {fiveHour, week, status}; null if none. */
export function parseWindows(streamJson) {
  let info = null;
  for (const line of String(streamJson || '').split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try { info = JSON.parse(line).rate_limit_info || info; } catch { /* torn line */ }
  }
  const w = info?.unifiedWindows;
  if (!w) return null;
  const win = (x) => (x && Number.isFinite(x.utilization) ? { pct: Math.round(x.utilization * 100), resetsAt: x.resetsAt } : null);
  return { fiveHour: win(w.five_hour), week: win(w.seven_day), status: info.status };
}

/** One tiny call on the account in `dir`; resolves {windows, error}. */
export function probe(dir) {
  return new Promise((res) => {
    const args = ['-p', 'OK', '--model', 'haiku', '--system-prompt', 'Reply OK.', '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];
    const p = spawn('claude', args, { cwd: tmpdir(), env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, timeout: 120_000 });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => res({ windows: null, error: e.message }));
    p.on('close', (code) => {
      const windows = parseWindows(out);
      const said = (out.match(/"result":"([^"]{0,160})/) || [])[1];
      res({ windows, error: windows ? null : (said || err.trim().slice(-160) || `exit ${code}`) });
    });
    p.stdin.end();
  });
}

/** In a run (DRIVER_ORDER set): is this driver left out, or out now (tmp/fm/night/out/<driver>)? Its account
 *  then gets no call, not even this tiny one (burn.mjs keeps accounts untouched until a date). */
function idle(label, env = process.env) {
  if (!env.DRIVER_ORDER) return false;
  if (!env.DRIVER_ORDER.split(/\s+/).includes(label)) return true;
  try { return Number(readFileSync(join(ROOT, 'tmp/fm/night/out', label), 'utf8').trim()) * 1000 > Date.now(); } catch { return false; }
}

/** [{label, dir}] to check. */
function accounts(all) {
  const home = homedir();
  const own = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  if (!all) return [{ label: 'sonnet', dir: own }, { label: 'sonnet1', dir: secondClaudeDir() }].filter((a) => !idle(a.label));
  const dirs = [join(home, '.claude'), ...readdirSync(home).filter((d) => /^\.claude-account\d+$/.test(d)).sort().map((d) => join(home, d))];
  return dirs.filter((d) => existsSync(join(d, '.credentials.json'))).map((dir) => ({ label: '', dir }));
}

/** Append one reading to tmp/fm/usage/claude-windows.tsv (time, folder, 5-hour %, week %, resets). */
export function logWindows(dir, w) {
  mkdirSync(join(ROOT, 'tmp/fm/usage'), { recursive: true });
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  appendFileSync(join(ROOT, 'tmp/fm/usage/claude-windows.tsv'), [now, basename(dir), w.fiveHour?.pct ?? '', w.week?.pct ?? '', w.fiveHour?.resetsAt ?? '', w.week?.resetsAt ?? ''].join('\t') + '\n');
}

/** "week 12% (resets lun. 19 22:00) · 5 hours 6% (resets mar. 13 13:20)". */
export function describe(w) {
  const one = (name, x) => (x ? `${name} ${x.pct}% (resets ${paris(x.resetsAt)})` : `${name} ?`);
  return `${one('week', w.week)} · ${one('5 hours', w.fiveHour)}`;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: node freemotion-night/claude-usage.mjs [--all] [--json]');
    console.log('  The week and 5-hour use of the Claude accounts a run uses (--all: every ~/.claude-account*), one tiny call each.');
    return;
  }
  const all = process.argv.includes('--all');
  const json = process.argv.includes('--json');
  const list = accounts(all);
  const results = await Promise.all(list.map(async (a) => ({ ...a, ...(await probe(a.dir)) })));
  mkdirSync(join(ROOT, 'tmp/fm/usage'), { recursive: true });
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  for (const r of results) {
    if (r.windows) appendFileSync(join(ROOT, 'tmp/fm/usage/claude-windows.tsv'), [now, basename(r.dir), r.windows.fiveHour?.pct ?? '', r.windows.week?.pct ?? '', r.windows.fiveHour?.resetsAt ?? '', r.windows.week?.resetsAt ?? ''].join('\t') + '\n');
  }
  if (json) { console.log(JSON.stringify(results.map(({ label, dir, windows, error }) => ({ label, dir, windows, error })), null, 2)); return; }
  // "allowance:" lines: night-mail.py puts them in the round's emails.
  for (const r of results) {
    const who = `${r.label ? r.label + ' ' : ''}(${basename(r.dir)})`;
    console.log(`allowance: Claude ${who}: ${r.windows ? describe(r.windows) : `could not read (${r.error})`}`);
  }
}

if (isMainModule(import.meta.url)) main();
