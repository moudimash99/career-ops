#!/usr/bin/env node
/**
 * freemotion-night/burn.mjs — auto-apply: applications nonstop, a round whenever none is going, each driver
 * by its own rule (user, 2026-10-19; rules 2026-10-25). The file and the "FreeMotion burn" task keep their
 * old name; "burn" is now one of the rules, below.
 *
 *   node freemotion-night/burn.mjs tick      what the "FreeMotion burn" task runs every 10 minutes
 *   node freemotion-night/burn.mjs on|off    turn auto-apply on or off (off also lifts its driver pauses)
 *   node freemotion-night/burn.mjs status    settings, driver order, rules, and what each driver may do now
 *   node freemotion-night/burn.mjs install   keep this shell's PATH for the task, then create the task
 *   node freemotion-night/burn.mjs round [--jobs N]     start one round now, by hand, with these drivers
 *   node freemotion-night/burn.mjs driver <id> on|off   let a driver take jobs, or keep it out until turned on
 *   node freemotion-night/burn.mjs migrate   write the old settings (scheduled, monthly, last_resort,
 *                                            reserve) out as one rule per driver
 *
 * Rounds: whenever no run is going, one round (full-night.sh with MAX_ROUNDS=1, `round_jobs` jobs, no
 * scan) in the "FreeMotion night" task. Its drivers are `drivers`, the one whose week resets soonest
 * first, so the allowance lost soonest is used first; burn and reserve drivers after all others.
 * run.sh moves to the next driver at a limit, as always. Settings: data/burn-settings.json (DEFAULTS below).
 *
 * Each driver has one rule (`rules`, lib/driver-rules.mjs, set from the dashboard's driver panel):
 *  - full: takes jobs until its own limit.
 *  - burn: kept for writing CVs and letters; applies only with what would go unused, starting late enough
 *    that the rest of its week is used just by the reset (burnGate). Codex: it writes about half the CVs.
 *  - reserve: takes jobs while it keeps a share of its week and 5 hours (reserveGate).
 *  - monthly (copilot): spreads its monthly credits evenly over the month (monthlyGate).
 *  - schedule: a Claude account the user also works on, until its `until`. Nothing watches the user: the
 *    window's % says it all. In working hours (`work`) it applies only on schedule, so the window reaches
 *    100 - `buffer`% just at its reset (`minutes_per_pct` per %, plus `margin_minutes`); when the user works
 *    too, the % climbs faster, it gets ahead of schedule and pauses (`pause_ahead_minutes`). Outside working
 *    hours: at once. `week_keep`% of the week stays the user's, except in the last `week_free_hours`. After
 *    `until` the account is left out altogether, also as the CV/letter writers' second Claude account.
 *    Measured on sonnet1 (night of 2026-10-19): a full 5-hour window is about 27 applications in about
 *    3 hours, about 8% of the week.
 * Besides its rule: `not_before` drivers are left alone until a date (paused, and not the CV/letter writers'
 * Claude account), `off` drivers are paused until turned on again, whatever their rule says. A burn or
 * reserve Claude account never writes CVs and letters.
 *
 * A driver is paused through run.sh's own out file (tmp/fm/night/out/<driver>), which run.sh reads before
 * every job: the other drivers go on. Only pauses this script wrote are lifted by it.
 * Readings: every `read_every_minutes` (30) the tick reads agy's windows (agy -p /usage, no model call) and
 * each Claude account still in use (claude-usage.mjs's tiny call; right after a reset it opens the next
 * 5-hour window), so the dashboard's usage is never hours old. Codex's come from its own session logs.
 * Log: tmp/fm/burn/burn.log.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isMainModule } from '../lib/is-main-module.mjs';
import { probe, logWindows } from './claude-usage.mjs';
import { WRITER_ORDER } from '../lib/doc-writers.mjs';
import { ruleOf, comesLast, migrate } from '../lib/driver-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = join(ROOT, 'data/burn-settings.json');
const DIR = join(ROOT, 'tmp/fm/burn');
const STATE = join(DIR, 'state.json');
const ENV_FILE = join(DIR, 'env.json');
const LOG = join(DIR, 'burn.log');
const NIGHT_START = join(ROOT, 'tmp/fm/night/night-start.json');
const OUT = join(ROOT, 'tmp/fm/night/out');
const MIN = 60_000;
const FOREVER = 10 * 365 * 24 * 60 * MIN;

export const DEFAULTS = {
  enabled: true,
  drivers: ['sonnet1', 'agy', 'agy-sonnet', 'sonnet', 'copilot', 'codex'],
  accounts: { sonnet1: '.claude-account1', sonnet: '.claude-account2' },
  rules: { sonnet1: { kind: 'schedule', until: '2026-10-20T16:00:00+02:00' }, copilot: { kind: 'monthly' }, codex: { kind: 'burn' } },
  not_before: {},
  off: [],
  read_every_minutes: 30,
  round_jobs: 50,
  min_round_gap_minutes: 30,
  work: { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' },
  buffer: 10,
  minutes_per_pct: 2,
  margin_minutes: 10,
  pause_ahead_minutes: 30,
  week_keep: 15,
  week_free_hours: 24,
  credits_per_job: 10,
  mail: true,
};

export function settings(file = SETTINGS) {
  let s = {};
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { /* defaults */ }
  return { ...DEFAULTS, ...s, work: { ...DEFAULTS.work, ...(s.work || {}) } };
}

// ── The rules ─────────────────────────────────────────────────────────────
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const when = (ms) => new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Is `ms` inside working hours (Paris time)? */
export function atWork(ms, work) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const min = Number(p.hour) * 60 + Number(p.minute);
  return work.days.includes(DAYS[p.weekday]) && min >= hm(work.from) && min < hm(work.to);
}

/** The highest % of the window applications may reach at `t`: 100, less the buffer while working or
 *  when the window is still open once work starts. */
export function capAt(t, reset, s) {
  for (let x = t; x < reset; x += 5 * MIN) if (atWork(x, s.work)) return 100 - s.buffer;
  return 100;
}

/**
 * May a scheduled driver (an account the user works on) take jobs now?
 * win: {fivePct, fiveReset, weekPct, weekReset} (ms); active: it may take jobs since the last look.
 * Returns {allow, why, until?, read?}: `until` = when to look again, `read` = the reading is too old.
 */
export function decide({ now, win, s, active = false }) {
  if (!win) return { allow: false, why: 'no reading of the windows yet', read: true };
  if (now >= win.fiveReset) return { allow: false, why: 'the 5-hour window reset', read: true };
  const free = s.week_free_hours * 60 * MIN;
  const weekCap = win.weekReset - now <= free ? 100 : 100 - s.week_keep;
  if (win.weekPct >= weekCap) return { allow: false, why: `week at ${win.weekPct}%: the rest stays yours until ${s.week_free_hours} h before it resets`, until: win.weekReset - free };
  const cap = capAt(now, win.fiveReset, s);
  if (win.fivePct >= cap) return { allow: false, why: `5-hour window at ${win.fivePct}%, the most for now is ${cap}%`, until: win.fiveReset };
  if (!atWork(now, s.work)) return { allow: true, why: `outside working hours: window at ${win.fivePct}%, up to ${cap}%` };
  const capEnd = capAt(win.fiveReset - MIN, win.fiveReset, s);
  const need = (capEnd - win.fivePct) * s.minutes_per_pct + s.margin_minutes;
  const ahead = (win.fiveReset - now) / MIN - need;
  if (ahead > (active ? s.pause_ahead_minutes : 0)) {
    return { allow: false, why: `working hours: window at ${win.fivePct}%, the rest needs ${Math.round(need)} min, so from ${when(now + ahead * MIN)}${active ? ' (you are using it too)' : ''}`, until: now + ahead * MIN };
  }
  return { allow: true, why: `on schedule: window at ${win.fivePct}%, up to ${capEnd}% by the reset (${when(win.fiveReset)})` };
}

/** May a monthly driver take a job now, with its credits spread evenly over the month? */
export function monthlyGate({ now, used, entitlement, resetMs, perJob }) {
  const start = new Date(resetMs); start.setUTCMonth(start.getUTCMonth() - 1);
  const span = resetMs - start.getTime();
  if (entitlement - used < perJob) return { allow: false, why: `${Math.round(used)} of ${entitlement} credits used this month`, until: resetMs };
  const share = (entitlement * (now - start.getTime())) / span;
  if (used + perJob <= share) return { allow: true, why: `${Math.round(used)} of ${entitlement} credits used, ${Math.round(share)} so far this month` };
  const until = start.getTime() + ((used + perJob) / entitlement) * span;
  return { allow: false, why: `spread over the month: ${Math.round(used)} of ${entitlement} credits used, the next job's share from ${when(until)}`, until };
}

/** May a last-resort driver take a job: does it keep its reserve? limits: {fivePct, fiveReset, weekPct,
 *  weekReset} (ms) from its newest reading; a window past its reset counts as unused. With
 *  `reserve.last_hours`, only in the last that many hours before its week resets. */
export function reserveGate({ now, limits, reserve }) {
  if (!limits) return { allow: false, why: 'no reading of its windows yet', until: now + 60 * MIN };
  const five = now >= limits.fiveReset ? 0 : limits.fivePct;
  const week = now >= limits.weekReset ? 0 : limits.weekPct;
  const from = limits.weekReset - (reserve.last_hours || 0) * 60 * MIN;
  if (reserve.last_hours && now >= limits.weekReset) return { allow: false, why: 'its week reset: reading it again', until: now + 10 * MIN };
  if (reserve.last_hours && now < from) return { allow: false, why: `kept until the last ${reserve.last_hours} h of its week (week at ${week}%, from ${when(from)})`, until: from };
  if (100 - week <= reserve.week) return { allow: false, why: `week at ${week}%: the last ${reserve.week}% stays for CVs and your work`, until: limits.weekReset };
  if (100 - five <= reserve.five_hour) return { allow: false, why: `5-hour window at ${five}%: the last ${reserve.five_hour}% stays for CVs`, until: limits.fiveReset };
  return { allow: true, why: `last resort: week at ${week}%, 5 hours at ${five}%, above its reserve` };
}

/**
 * May a burn driver take a job: would the rest of its week otherwise go unused? It starts when the rest,
 * at rule.minutes_per_pct minutes of applying per %, plus rule.margin_minutes, just fits before the week
 * resets; until then the week stays for writing CVs and letters.
 */
export function burnGate({ now, limits, rule }) {
  if (!limits) return { allow: false, why: 'no reading of its windows yet', until: now + 60 * MIN };
  if (now >= limits.weekReset) return { allow: false, why: 'its week reset: reading it again', until: now + 10 * MIN };
  const week = Math.round(limits.weekPct), left = 100 - week;
  if (left <= 0) return { allow: false, why: 'its week is used up', until: limits.weekReset };
  const start = limits.weekReset - (left * rule.minutes_per_pct + rule.margin_minutes) * MIN;
  if (now < start) return { allow: false, why: `kept for CVs and letters: week at ${week}%; burns the rest from ${when(start)}, so it is used up by the reset (${when(limits.weekReset)})`, until: start };
  return { allow: true, why: `burning what is left before its week resets (${when(limits.weekReset)}): week at ${week}%` };
}

/** May driver `d` be used at all at `now`: listed, not past its `scheduled.until`, not before its `not_before`. */
export function usableAt(d, now, s) {
  if (!s.drivers.includes(d)) return false;
  const r = ruleOf(s, d), until = r.kind === 'schedule' && r.until;
  if (until && now >= Date.parse(until)) return false;
  const from = s.not_before?.[d];
  return !(from && now < Date.parse(from));
}

/** A round's drivers and Claude accounts. A driver waiting for its `not_before` stays in the order: its
 *  pause (run.sh's out file) lifts by itself on the day, even in the middle of a round. */
export function roundPlan(s, now, resets) {
  const expired = (d) => { const r = ruleOf(s, d); return r.kind === 'schedule' && r.until && now >= Date.parse(r.until); };
  const last = (d) => comesLast(s, d);
  const drivers = order(s.drivers.filter((d) => !expired(d) && !last(d)), resets).concat(s.drivers.filter(last));
  const writes = (d) => usableAt(d, now, s) && !last(d);   // a burn or reserve account never writes CVs
  const second = writes('sonnet1') ? s.accounts.sonnet1 : s.accounts.sonnet;
  const writer = writes('sonnet1') || writes('sonnet');
  return { drivers, second, docsWriters: writer ? null : WRITER_ORDER.filter((w) => w !== 'sonnet1') };
}

/** Drivers, the one whose week resets soonest first; no known reset = after, in the listed order. */
export function order(drivers, resets) {
  return drivers.map((d, i) => ({ d, i, r: resets[d] ?? Infinity })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.d);
}

// ── The task ──────────────────────────────────────────────────────────────
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 16);
const say = (line) => { mkdirSync(DIR, { recursive: true }); appendFileSync(LOG, `${stamp()} ${line}\n`); console.log(line); };
const accountDir = (name) => join(homedir(), name);
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : []);

/** Each driver's week reset (ms) from the last readings the runs logged. */
function weekResets(s) {
  const out = {};
  for (const [driver, folder] of Object.entries(s.accounts)) {
    const last = lines(join(ROOT, 'tmp/fm/usage/claude-windows.tsv')).filter((r) => r[1] === folder).pop();
    if (last?.[5]) out[driver] = Number(last[5]) * 1000;
  }
  for (const r of lines(join(ROOT, 'tmp/fm/usage/agy-quota.tsv'))) {
    if (r[2] !== 'week') continue;
    const driver = /gemini/i.test(r[1]) ? 'agy' : /claude|gpt/i.test(r[1]) ? 'agy-sonnet' : null;
    if (driver && Date.parse(r[4])) out[driver] = Date.parse(r[4]);
  }
  return out;
}

/** agy's windows (one group: Gemini for agy, Claude/GPT for agy-sonnet) from the newest readings. */
function readAgy(d) {
  const g = d === 'agy' ? /gemini/i : /claude|gpt/i, rows = lines(join(ROOT, 'tmp/fm/usage/agy-quota.tsv')).filter((r) => g.test(r[1]) && r[3] !== '');
  const last = (w) => rows.filter((r) => r[2] === w).pop();
  const wk = last('week'), fv = last('5h');
  if (!wk) return null;
  return { at: Date.parse(wk[0]), weekPct: 100 - Number(wk[3]), weekReset: Date.parse(wk[4]), fivePct: fv ? 100 - Number(fv[3]) : 0, fiveReset: fv ? Date.parse(fv[4]) : 0 };
}

async function readClaude(folder) {
  const r = await probe(accountDir(folder));
  if (!r.windows?.fiveHour || !r.windows?.week) { say(`could not read ${folder}: ${r.error}`); return null; }
  logWindows(accountDir(folder), r.windows);
  const w = r.windows;
  return { at: Date.now(), fivePct: w.fiveHour.pct, fiveReset: w.fiveHour.resetsAt * 1000, weekPct: w.week.pct, weekReset: w.week.resetsAt * 1000 };
}

/** Codex's windows from its newest session log in the last 8 days (each logs a rate_limits event). */
function readCodex() {
  const root = join(homedir(), '.codex/sessions');
  for (let back = 0; back < 8; back++) {
    const d = new Date(Date.now() - back * 864e5);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of files) {
      const m = [...readFileSync(f, 'utf8').matchAll(/"primary":\{"used_percent":([\d.]+),"window_minutes":\d+,"resets_at":(\d+)\},"secondary":\{"used_percent":([\d.]+),"window_minutes":\d+,"resets_at":(\d+)\}/g)].pop();
      if (m) return { at: statSync(f).mtimeMs, fivePct: Number(m[1]), fiveReset: Number(m[2]) * 1000, weekPct: Number(m[3]), weekReset: Number(m[4]) * 1000 };
    }
  }
  return null;
}

function readCopilot() {
  try {
    const j = JSON.parse(execFileSync('gh', ['api', 'copilot_internal/user'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }));
    const p = j.quota_snapshots?.premium_interactions;
    if (!p || !j.quota_reset_date) return null;
    return { at: Date.now(), used: Number(p.entitlement) - Number(p.quota_remaining), entitlement: Number(p.entitlement), resetMs: Date.parse(j.quota_reset_date) };
  } catch { return null; }
}

/** Pause a driver until `until` through run.sh's out file, unless run.sh already has it out for longer. */
function pause(st, d, until, why) {
  const epoch = Math.ceil(until / 1000);
  const file = join(OUT, d);
  const cur = Number(existsSync(file) ? readFileSync(file, 'utf8').trim() : 0) || 0;
  if (cur > epoch && st.paused?.[d] !== cur) return;
  mkdirSync(OUT, { recursive: true });
  if (cur !== epoch) writeFileSync(file, `${epoch}\n`);
  st.paused = { ...st.paused, [d]: epoch };
  if (st.why?.[d] !== why) say(`${d}: paused, ${why}`);
  st.why = { ...st.why, [d]: why };
}

/** Lift this script's own pause of a driver; a limit run.sh marked stays. */
function resume(st, d, why) {
  const file = join(OUT, d);
  const cur = Number(existsSync(file) ? readFileSync(file, 'utf8').trim() : 0) || 0;
  if (st.paused?.[d] && cur === st.paused[d]) rmSync(file, { force: true });
  if (st.paused) delete st.paused[d];
  if (st.why?.[d] !== why) say(`${d}: may apply, ${why}`);
  st.why = { ...st.why, [d]: why };
}

const OFF_WHY = 'you turned it off';

function liftAll(st) {
  for (const d of Object.keys(st.paused || {})) resume(st, d, 'auto-apply is off');
}

/** Fresh readings for the dashboard and the rules: agy's windows and each Claude account still in use,
 *  at most every read_every_minutes. */
async function refreshReadings(s, st, now, waiting, off) {
  const every = (s.read_every_minutes || 30) * MIN;
  const inUse = (d) => s.drivers.includes(d) && !off.has(d) && !waiting(d) && usableAt(d, now, s);
  const agyAt = Math.max(0, ...lines(join(ROOT, 'tmp/fm/usage/agy-quota.tsv')).map((r) => Date.parse(r[0]) || 0));
  if ((inUse('agy') || inUse('agy-sonnet')) && now - agyAt >= every) {
    try { execFileSync(process.execPath, [join(ROOT, 'freemotion-night/agy-usage.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 180_000, windowsHide: true }); } catch { /* the next tick tries again */ }
  }
  for (const [d, folder] of Object.entries(s.accounts || {})) {
    if (!inUse(d) || ruleOf(s, d).kind === 'schedule') continue;   // the schedule reads its own
    const w = st.win[d];
    if (w && now - w.at < every) continue;
    if (st.noRead?.[d] && now - st.noRead[d] < every) continue;
    const r = await readClaude(folder);
    if (r) { st.win[d] = r; if (st.noRead) delete st.noRead[d]; } else st.noRead = { ...st.noRead, [d]: now };
  }
}

export async function tick() {
  const s = settings();
  const st = readJson(STATE, {});
  const save = () => { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(st, null, 2)); };
  if (!s.enabled) { liftAll(st); save(); return console.log('off (data/burn-settings.json "enabled": false)'); }
  const env = readJson(ENV_FILE, {});
  if (env.PATH) process.env.PATH = env.PATH;
  const now = Date.now();
  st.win = st.win || {};
  st.active = st.active || {};
  const off = new Set(s.off || []);
  for (const d of Object.keys(st.paused || {})) if (st.why?.[d] === OFF_WHY && !off.has(d)) resume(st, d, 'you turned it back on');
  const waiting = (d) => s.not_before?.[d] && now < Date.parse(s.not_before[d]);
  await refreshReadings(s, st, now, waiting, off);

  // A driver's windows for its rule: codex from its session logs, agy from its readings, a Claude account
  // from the readings above.
  const limitsOf = (d) => (d === 'codex' ? readCodex() : d.startsWith('agy') ? readAgy(d) : st.win[d] || null);

  for (const d of s.drivers) {
    if (off.has(d) || waiting(d)) continue;
    const rule = ruleOf(s, d);
    if (rule.kind === 'full') {
      // A pause from a rule it no longer has is lifted; run.sh's own limit marks stay.
      if (st.paused?.[d]) resume(st, d, 'full allowance');
      else if (st.why?.[d] !== 'full allowance') st.why = { ...st.why, [d]: 'full allowance' };
    } else if (rule.kind === 'schedule') {
      // An account the user works on: on schedule only, and nothing after its until.
      if (rule.until && now >= Date.parse(rule.until)) { pause(st, d, now + FOREVER, `its time with the timer ended (${rule.until}); it is yours again`); st.active[d] = false; continue; }
      const w = st.win[d];
      const stale = !w || now >= w.fiveReset || st.active[d] || (st.until?.[d] && now >= st.until[d] - MIN) || now - w.at > 60 * MIN;
      if (stale) st.win[d] = (await readClaude(s.accounts[d])) || w;
      let r = decide({ now: Date.now(), win: st.win[d], s, active: st.active[d] });
      if (r.read && st.win[d]?.at < now - MIN) { st.win[d] = (await readClaude(s.accounts[d])) || st.win[d]; r = decide({ now: Date.now(), win: st.win[d], s, active: st.active[d] }); }
      st.until = { ...st.until, [d]: r.until || null };
      st.active[d] = r.allow;
      if (r.allow) resume(st, d, r.why); else pause(st, d, r.until || now + 10 * MIN, r.why);
    } else if (rule.kind === 'monthly') {
      // Monthly credits, spread over the month (looked up once an hour).
      if (!st.month?.[d] || now - st.month[d].at > 60 * MIN) st.month = { ...st.month, [d]: readCopilot() || st.month?.[d] };
      const m = st.month?.[d];
      if (!m) { pause(st, d, now + 60 * MIN, 'its monthly credits could not be read (gh auth login?)'); continue; }
      const r = monthlyGate({ now, used: m.used, entitlement: m.entitlement, resetMs: m.resetMs, perJob: rule.credits_per_job });
      if (r.allow) resume(st, d, r.why); else pause(st, d, r.until, r.why);
    } else {
      const limits = limitsOf(d);
      const r = rule.kind === 'burn' ? burnGate({ now, limits, rule }) : reserveGate({ now, limits, reserve: rule });
      if (r.allow) resume(st, d, r.why); else pause(st, d, r.until, r.why);
    }
  }

  // Left alone until a date.
  for (const [d, from] of Object.entries(s.not_before || {})) {
    if (!s.drivers.includes(d) || off.has(d)) continue;
    const ms = Date.parse(from);
    if (now < ms) pause(st, d, ms, `left alone until ${when(ms)}`);
    else if (st.paused?.[d] === Math.ceil(ms / 1000)) resume(st, d, `its date (${when(ms)}) came`);
  }

  // Turned off by the user: out, whatever the rules above said.
  for (const d of off) if (s.drivers.includes(d)) pause(st, d, now + FOREVER, OFF_WHY);

  // A round whenever none is going.
  const sched = startRound.sched = await import('./scheduled.mjs');
  const running = sched.nightState() === 'Running';
  if (running) {
    if (readJson(NIGHT_START, {}).by !== 'burn') say('a run started by hand is going: no round from the timer');
    return save();
  }
  if (st.lastRound && now - Date.parse(st.lastRound) < s.min_round_gap_minutes * MIN) {
    say(`the last round started ${Math.round((now - Date.parse(st.lastRound)) / MIN)} min ago and is over already: next one after ${s.min_round_gap_minutes} min`);
    return save();
  }
  startRound(s, st, env, 'burn', s.round_jobs);
  save();
}

/** One round in the night task, with the timer's drivers and accounts. by: 'burn' | 'dashboard'. */
function startRound(s, st, env, by, jobs) {
  const { drivers, second, docsWriters } = roundPlan(s, Date.now(), weekResets(s));
  const nightEnv = {
    PATH: env.PATH || process.env.PATH,
    CLAUDE_CONFIG_DIR: accountDir(s.accounts.sonnet),
    CLAUDE1_DIR: accountDir(second),
    DRIVER_ORDER: drivers.join(' '),
    ROUND_JOBS: String(jobs),
    NO_SCAN: '1',
    MAX_ROUNDS: '1',
    SONNET_MAX_PER_WINDOW: '100000',
    ...(docsWriters ? { DOCS_WRITERS: docsWriters.join(' ') } : {}),
  };
  rmSync(join(ROOT, 'tmp/fm/night/stop'), { force: true });   // left from a round that is over
  const r = startRound.sched.startNightTask({ env: nightEnv, mail: s.mail, by });
  if (r.ok) { st.lastRound = r.at; say(`round started${by === 'burn' ? '' : ' by hand'}: ${jobs} jobs, drivers ${drivers.join(' ')}`); } else say(`could not start a round: ${r.error}`);
  return r;
}

function status() {
  const s = settings();
  const st = readJson(STATE, {});
  console.log(`auto-apply ${s.enabled ? 'on' : 'off'}: rounds of ${s.round_jobs} jobs; work ${s.work.from}-${s.work.to} (days ${s.work.days.join(',')}), buffer ${s.buffer}%`);
  console.log(`drivers, in today's order: ${roundPlan(s, Date.now(), weekResets(s)).drivers.join(' ')}`);
  for (const d of s.drivers) console.log(`  ${d}: rule ${JSON.stringify(ruleOf(s, d))}`);
  for (const [d, v] of Object.entries(s.not_before || {})) console.log(`  ${d}: left alone until ${v}`);
  for (const d of s.drivers) if (st.why?.[d]) console.log(`  ${d}: ${st.paused?.[d] ? 'paused' : 'may apply'}, ${st.why[d]}`);
  if (st.lastRound) console.log(`last round started ${new Date(st.lastRound).toLocaleString('sv-SE').slice(0, 16)}`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'tick') await tick();
  else if (cmd === 'on' || cmd === 'off') {
    const s = readJson(SETTINGS, {});
    writeFileSync(SETTINGS, JSON.stringify({ ...s, enabled: cmd === 'on' }, null, 2) + '\n');
    if (cmd === 'off') { const st = readJson(STATE, {}); liftAll(st); writeFileSync(STATE, JSON.stringify(st, null, 2)); }
    console.log(`auto-apply ${cmd}`);
  } else if (cmd === 'status') status();
  else if (cmd === 'round') {
    // A round now, by hand (the dashboard's "Start a round"): the timer's drivers, refused while one runs.
    const s = settings(), st = readJson(STATE, {}), env = readJson(ENV_FILE, {});
    if (env.PATH) process.env.PATH = env.PATH;
    const i = process.argv.indexOf('--jobs'), jobs = i > 0 ? Number(process.argv[i + 1]) : s.round_jobs;
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 200) { console.error('--jobs must be a whole number from 1 to 200'); process.exit(1); }
    startRound.sched = await import('./scheduled.mjs');
    if (startRound.sched.nightState() === 'Running') { console.error('a round is already running'); process.exit(2); }
    const r = startRound(s, st, env, 'dashboard', jobs);
    writeFileSync(STATE, JSON.stringify(st, null, 2));
    if (!r.ok) { console.error(r.error); process.exit(1); }
  } else if (cmd === 'driver') {
    // Turn a driver off (paused until turned on) or on again (the other rules decide at the next tick).
    const [d, how] = process.argv.slice(3);
    const raw = readJson(SETTINGS, {}), s = settings();
    if (!s.drivers.includes(d) || !['on', 'off'].includes(how)) { console.error(`Usage: node freemotion-night/burn.mjs driver <${s.drivers.join('|')}> on|off`); process.exit(1); }
    const off = new Set(raw.off || []);
    if (how === 'off') off.add(d); else off.delete(d);
    writeFileSync(SETTINGS, JSON.stringify({ ...raw, off: [...off] }, null, 2) + '\n');
    const st = readJson(STATE, {});
    if (how === 'off') pause(st, d, Date.now() + FOREVER, OFF_WHY);
    else if (st.why?.[d] === OFF_WHY) resume(st, d, 'you turned it back on');
    writeFileSync(STATE, JSON.stringify(st, null, 2));
  }
  else if (cmd === 'migrate') {
    const raw = readJson(SETTINGS, {});
    writeFileSync(SETTINGS, JSON.stringify(migrate({ ...raw, drivers: raw.drivers || DEFAULTS.drivers }), null, 2) + '\n');
    console.log('rules written to data/burn-settings.json');
  }
  else if (cmd === 'install') {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(ENV_FILE, JSON.stringify({ PATH: process.env.PATH }, null, 2));
    if (!existsSync(SETTINGS)) writeFileSync(SETTINGS, JSON.stringify(DEFAULTS, null, 2) + '\n');
    const sched = await import('./scheduled.mjs');
    sched.install({ only: 'burn' });
  } else {
    console.log('Usage: node freemotion-night/burn.mjs tick|on|off|status|install|migrate|round [--jobs N]|driver <id> on|off');
    if (cmd && cmd !== '--help' && cmd !== '-h') process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
