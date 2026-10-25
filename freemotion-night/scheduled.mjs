#!/usr/bin/env node

/**
 * freemotion-night/scheduled.mjs — what Windows Task Scheduler runs (issue #22).
 *
 *   node freemotion-night/scheduled.mjs scan      "scan": scan.mjs, make-pool.mjs (posting texts and scores),
 *                                                 then the reply check (inbox-replies.py)
 *   node freemotion-night/scheduled.mjs loops     start the three scoring loops if they are not running
 *   node freemotion-night/scheduled.mjs weekly    the weekly lessons report (lessons.mjs weekly)
 *   node freemotion-night/scheduled.mjs start-night [--jobs 50] [--end 09:00] [--every 5] [--no-scan] [--no-mail]
 *                                                 [--mail-every 50] [--drivers "..."] [--rounds N]
 *                                                 start a full night run through the "FreeMotion night" task (#41);
 *                                                 --mail-every: a progress email every N jobs (night-mail.py --every)
 *   node freemotion-night/scheduled.mjs night     what that task runs: full-night.sh, then night-mail.py beside it
 *   node freemotion-night/scheduled.mjs burn      burn.mjs's tick: applications in what is left of a 5-hour window
 *   node freemotion-night/scheduled.mjs install   create the Windows tasks below (needs no admin rights); --only <job>
 *   node freemotion-night/scheduled.mjs uninstall remove them
 *   node freemotion-night/scheduled.mjs status    the tasks and their last result
 *
 * Tasks (folder \career-ops\ in Task Scheduler; a run missed while the PC was off starts when it is on):
 *   FreeMotion scan     every day 06:00
 *   FreeMotion loops    at log-on and every day 06:00 (a loop already running is left alone)
 *   FreeMotion weekly   Mondays 09:00
 *   FreeMotion night    no schedule: only `start-night` (or burn.mjs) starts it
 *   FreeMotion burn     every 10 minutes: burn.mjs (installed by `node freemotion-night/burn.mjs install`)
 *   FreeMotion agent    at log-on, and every 5 minutes if it is not running: hub-agent.mjs, this PC's side of
 *                       the dashboard (installed by `node freemotion-night/scheduled.mjs install --only agent`)
 * They run hidden (conhost --headless). "apply" is otherwise never scheduled: it spends the drivers'
 * allowances and sends real applications, so a person starts it. The one exception is burn.mjs, which the
 * user asked for (2026-10-19): it uses only what is left of one Claude account's 5-hour windows.
 *
 * The night task is there so that a night started from a Claude Code session no longer belongs to that
 * session: on 2026-10-10 Claude Code killed full-night.sh and the mailer when the PC ran low on memory
 * (#41). `start-night` writes the night's settings, with this shell's PATH and CLAUDE_CONFIG_DIR so the
 * drivers are the same as from the session, to tmp/fm/night/night-start.json, then starts that one task;
 * it never makes a new one. The log stays tmp/fm/night/full-night.log; stop it with tmp/fm/night/stop-night
 * as before. A job cut off by a kill keeps an in-progress claim that is reclaimed after 30 minutes
 * (lib/freemotion-submissions.mjs), so a later run tries it again.
 *
 * Each run writes tmp/fm/scheduled/<task>-<date>.log. Only what needs a person goes to
 * data/agent-inbox.md (printed after every run and every scan): a step that failed, a recruiter
 * who wants to talk, tracker changes proposed from replies, the weekly report. Each only once.
 */

import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tmp/fm/scheduled');
const SEEN = join(OUT, 'noted.txt');
const NODE = process.execPath;
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PYTHON = flag('--python', process.env.FM_PYTHON || 'python');
// Git's bash, never WSL's C:\Windows\System32\bash.exe, which cannot run this repo's scripts (see record.mjs).
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = flag('--bash', process.env.FM_BASH || (existsSync(GIT_BASH) ? GIT_BASH : 'bash'));
const NIGHT_START = join(ROOT, 'tmp/fm/night/night-start.json');
const NIGHT_LOG = join(ROOT, 'tmp/fm/night/full-night.log');
// What start-night hands to the night task: full-night.sh's settings, and what the drivers need.
export const NIGHT_ENV = ['PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE1_DIR', 'DRIVER_ORDER', 'ROUND_JOBS', 'EVERY_HOURS', 'END_AT', 'NO_SCAN', 'MAX_ROUNDS', 'SONNET_MAX_PER_WINDOW', 'HEADFUL'];
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 16);
const today = () => new Date().toLocaleDateString('sv-SE');

// APEC route lookups at the daily scan (issue #25). Since APEC's bot check (2026-10-01) about 32 lookups a
// day get through before its CAPTCHA (33 on 10-06, 32 on 10-07; 50 hit it on 10-07). 25 stays under that.
export const APEC_MAX = 25;

// The scoring loops, as in freemotion-night/README.md "Scoring all day".
export const LOOPS = [
  { name: '', args: ['--models', 'gemini-3.5-flash-lite,gemini-3.1-flash-lite'] },
  { name: 'flash', args: ['--name', 'flash', '--models', 'gemini-3.8-flash,gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash', '--from-middle', '--no-gate', '--rpm', '5', '--rpm-max', '8'] },
  { name: 'gemma', args: ['--name', 'gemma', '--model', 'gemma-4-31b-it', '--oldest-first', '--no-gate', '--text-only', '--parallel', '2', '--busy-rest', '3', '--rpm', '6', '--rpm-max', '10'] },
];

/** One line in the agent inbox, unless the same `key` was noted before. */
export function note(text, key = text, { inbox = join(ROOT, 'data/agent-inbox.md'), seen = SEEN } = {}) {
  const k = createHash('sha1').update(key).digest('hex').slice(0, 12);
  const done = existsSync(seen) ? readFileSync(seen, 'utf8').split(/\r?\n/) : [];
  if (done.includes(k)) return false;
  mkdirSync(dirname(seen), { recursive: true });
  appendFileSync(seen, `${k}\n`);
  appendFileSync(inbox, `- [ ] ${stamp()} — ${text}\n`);
  return true;
}

/** What the reply check printed that needs a person: recruiters who want to talk, and the status changes it made. */
export function replyNotes(output) {
  const out = [];
  const talk = output.split(/A RECRUITER WANTS TO TALK[^\n]*\n/)[1];
  if (talk) for (const line of talk.split(/\r?\n/)) {
    if (!/^\s{3}\d{4}-\d{2}-\d{2}\s/.test(line)) break;
    out.push({ text: `Recruiter wrote and wants to talk (answer by hand): ${line.trim()}`, key: `talk ${line.trim()}` });
  }
  const m = output.match(/STATUS CHANGES MADE \((\d+)\)[^\n]*\n((?:\s*#\d+.*\n?)*)/);
  if (m && Number(m[1]) > 0) {
    const lines = m[2].trim().split(/\r?\n/).map((l) => l.trim());
    out.push({ text: `${m[1]} tracker change(s) made from employers' replies (data/reactions.tsv, data/status-log.tsv)`, key: `changes ${lines.join('|')}` });
  }
  return out;
}

function step(log, label, cmd, cmdArgs) {
  appendFileSync(log, `\n=== ${stamp()} ${label}: ${cmd} ${cmdArgs.join(' ')}\n`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  appendFileSync(log, `${r.stdout || ''}${r.stderr || ''}\n=== exit ${r.status}${r.error ? ` (${r.error.message})` : ''}\n`);
  if (r.status !== 0) note(`Scheduled ${label} failed (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): see tmp/fm/scheduled/${log.split(/[\\/]/).pop()}`, `fail ${label} ${today()}`);
  return r;
}

function startLoops(log) {
  for (const l of LOOPS) {
    const st = spawnSync(NODE, ['freemotion-night/score-loop.mjs', ...(l.name ? ['--name', l.name] : []), '--status'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (/^running/m.test(st.stdout || '')) { appendFileSync(log, `${stamp()} loop ${l.name || 'main'}: already running\n`); continue; }
    const child = spawn(NODE, ['freemotion-night/score-loop.mjs', ...l.args], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    appendFileSync(log, `${stamp()} loop ${l.name || 'main'}: started (pid ${child.pid})\n`);
  }
}

// ── Windows tasks ───────────────────────────────────────────────────────
const TASKS = [
  { name: 'FreeMotion scan', job: 'scan', triggers: ['New-ScheduledTaskTrigger -Daily -At 06:00'] },
  { name: 'FreeMotion loops', job: 'loops', triggers: ['New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME', 'New-ScheduledTaskTrigger -Daily -At 06:00'] },
  { name: 'FreeMotion weekly', job: 'weekly', triggers: ['New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 09:00'] },
  // No trigger: only start-night starts it. A night whose last round starts after 09:00 can pass 14 hours.
  { name: 'FreeMotion night', job: 'night', triggers: [], hours: 30 },
  // Only with --only burn (burn.mjs install): it starts applications by itself.
  { name: 'FreeMotion burn', job: 'burn', triggers: ['New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10)'], hours: 1, optIn: true },
  // The dashboard's agent runs for good: no time limit, and the 5-minute trigger starts it again if it ended.
  { name: 'FreeMotion agent', job: 'agent', triggers: ['New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME', 'New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)'], hours: 0, optIn: true },
];
const NIGHT_TASK = TASKS.find((t) => t.job === 'night').name;
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });

export function install({ only } = {}) {
  const python = spawnSync(PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();
  if (!python) { console.error(`no python found (${PYTHON}); pass --python <path>`); process.exit(1); }
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  for (const t of TASKS.filter((x) => (only ? x.job === only : !x.optIn))) {
    const argument = `--headless "${NODE}" "${join(ROOT, 'freemotion-night/scheduled.mjs')}" ${t.job} --python "${python}" --bash "${BASH}"`;
    const script = 'try { ' + [
      `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${q(argument)} -WorkingDirectory ${q(ROOT)}`,
      `$t = @(${t.triggers.map((x) => `(${x})`).join(', ')})`,
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours ${t.hours ?? 8}) -MultipleInstances IgnoreNew`,
      `Register-ScheduledTask -TaskPath '\\career-ops\\' -TaskName ${q(t.name)} -Action $a ${t.triggers.length ? '-Trigger $t ' : ''}-Settings $s -Force -ErrorAction Stop | Out-Null`,
      `'ok'`,
    ].join('; ') + ` } catch { 'ERROR: ' + $_.Exception.Message }`;
    const r = ps(script);
    console.log(`${t.name}: ${(r.stdout || '').trim() === 'ok' ? 'installed' : `FAILED ${(r.stderr || r.stdout).trim().slice(0, 300)}`}`);
  }
}

// ── The full night run, outside the session (#41) ─────────────────────────
/** full-night.sh's environment from start-night's options and the calling shell's environment. */
export function nightEnv(argv, env = process.env) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? '' : undefined; };
  const out = {};
  for (const k of NIGHT_ENV) if (env[k]) out[k] = env[k];
  const set = { '--jobs': 'ROUND_JOBS', '--end': 'END_AT', '--every': 'EVERY_HOURS', '--drivers': 'DRIVER_ORDER', '--rounds': 'MAX_ROUNDS' };
  for (const [f, k] of Object.entries(set)) {
    const v = opt(f);
    if (v === undefined) continue;
    if (!v || v.startsWith('--')) throw new Error(`${f} needs a value`);
    out[k] = v;
  }
  if (out.MAX_ROUNDS && !/^[1-9]\d*$/.test(out.MAX_ROUNDS)) throw new Error(`--rounds must be a number, not ${out.MAX_ROUNDS}`);
  if (out.ROUND_JOBS && !/^\d+$/.test(out.ROUND_JOBS)) throw new Error(`--jobs must be a number, not ${out.ROUND_JOBS}`);
  if (out.EVERY_HOURS && !/^\d+$/.test(out.EVERY_HOURS)) throw new Error(`--every must be whole hours, not ${out.EVERY_HOURS}`);
  if (out.END_AT && !/^\d{1,2}:\d{2}$/.test(out.END_AT)) throw new Error(`--end must look like 09:00, not ${out.END_AT}`);
  if (argv.includes('--no-scan')) out.NO_SCAN = '1';
  return out;
}

export function nightState() {
  const r = ps(`$t = Get-ScheduledTask -TaskPath '\\career-ops\\' -TaskName '${NIGHT_TASK}' -ErrorAction SilentlyContinue; if ($t) { $t.State } else { 'missing' }`);
  return (r.stdout || '').trim() || 'missing';
}

/** Write the night's settings and start the night task; {ok, at} or {ok: false, error}. `by` marks who started it. */
export function startNightTask({ env, mail = true, mailEvery, by }) {
  const state = nightState();
  if (state === 'missing') return { ok: false, error: `The "${NIGHT_TASK}" task is not installed: run node freemotion-night/scheduled.mjs install` };
  if (state === 'Running') return { ok: false, error: `A night is already running (task "${NIGHT_TASK}"). Log: tmp/fm/night/full-night.log. To end it after the round in hand: touch tmp/fm/night/stop-night` };
  mkdirSync(dirname(NIGHT_START), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(NIGHT_START, JSON.stringify({ at, mail, mailEvery, ...(by ? { by } : {}), env }, null, 2));
  const r = ps(`Start-ScheduledTask -TaskPath '\\career-ops\\' -TaskName '${NIGHT_TASK}' -ErrorAction Stop; 'ok'`);
  if ((r.stdout || '').trim() !== 'ok') return { ok: false, error: `could not start the task: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
  return { ok: true, at };
}

function startNight() {
  let env;
  try { env = nightEnv(args.slice(1)); } catch (e) { console.error(e.message); process.exit(1); }
  const mi = args.indexOf('--mail-every');
  const mailEvery = mi >= 0 ? args[mi + 1] : undefined;
  if (mailEvery !== undefined && !/^\d+$/.test(mailEvery)) { console.error(`--mail-every must be a number, not ${mailEvery}`); process.exit(1); }
  const r = startNightTask({ env, mail: !args.includes('--no-mail'), mailEvery });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`Night started in the "${NIGHT_TASK}" task, outside this session: ${env.ROUND_JOBS || 50} jobs a round, every ${env.EVERY_HOURS || 5} h, last round from ${env.END_AT || '09:00'}${env.NO_SCAN ? ', no scan' : ''}${args.includes('--no-mail') ? ', no emails' : `, an email every ${mailEvery || 50} jobs and after each round`}.`);
  console.log('Log: tmp/fm/night/full-night.log · task log: tmp/fm/scheduled/night-<date>.log · stop after the round in hand: touch tmp/fm/night/stop-night');
}

async function runNight(log) {
  let start = { mail: true, env: {} };
  try { start = JSON.parse(readFileSync(NIGHT_START, 'utf8')); } catch { appendFileSync(log, `${stamp()} no ${NIGHT_START}: defaults\n`); }
  const env = { ...process.env, ...start.env, PYTHONIOENCODING: 'utf-8' };
  const size = existsSync(NIGHT_LOG) ? readFileSync(NIGHT_LOG).length : 0;
  appendFileSync(log, `\n##### ${stamp()} night: ${BASH} freemotion-night/full-night.sh ${JSON.stringify({ ...start.env, PATH: undefined })}\n`);
  const night = spawn(BASH, ['freemotion-night/full-night.sh'], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  const done = new Promise((res) => { night.on('exit', (code) => res(code)); night.on('error', (e) => { appendFileSync(log, `${stamp()} night did not start: ${e.message}\n`); res(-1); }); });
  let mailer = null;
  if (start.mail !== false) {
    // night-mail.py starts at the log's last "##### full night run" line, so it waits for this night's.
    for (let i = 0; i < 120 && !mailer; i++) {
      const fresh = existsSync(NIGHT_LOG) && readFileSync(NIGHT_LOG).subarray(size).includes('##### full night run');
      if (fresh) mailer = spawn(PYTHON, ['-u', 'freemotion-night/night-mail.py', ...(start.mailEvery ? ['--every', String(start.mailEvery)] : [])], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      else if (night.exitCode !== null) break;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    if (mailer) {
      mailer.stdout.on('data', (d) => appendFileSync(log, d));
      mailer.stderr.on('data', (d) => appendFileSync(log, d));
      appendFileSync(log, `${stamp()} mailer started (pid ${mailer.pid})\n`);
    } else appendFileSync(log, `${stamp()} no new night in the log after 2 minutes: no mailer\n`);
  }
  const code = await done;
  appendFileSync(log, `${stamp()} full-night.sh ended (exit ${code})\n`);
  if (code !== 0) note(`The full night run ended with exit ${code}: see tmp/fm/night/full-night.log`, `night fail ${today()}`);
  if (mailer && mailer.exitCode === null) {
    // It exits on "FULL NIGHT DONE"; give it time for that email, then stop it.
    let timer;
    await Promise.race([new Promise((r) => mailer.on('exit', r)), new Promise((r) => { timer = setTimeout(r, 5 * 60_000); })]);
    clearTimeout(timer);
    if (mailer.exitCode === null) mailer.kill();
  }
}

async function main() {
  const cmd = args[0];
  mkdirSync(OUT, { recursive: true });
  const log = join(OUT, `${cmd}-${today()}.log`);
  if (cmd === 'scan') {
    appendFileSync(log, `\n##### ${stamp()} scheduled scan\n`);
    step(log, 'scan', NODE, ['scan.mjs']);
    // APEC rate test (#25): the first APEC contact of the day asks up to APEC_MAX route lookups. A second
    // batch the same day hit the CAPTCHA after one request (2026-10-06), so the test runs here, at 06:00.
    const pool = step(log, 'make-pool', NODE, ['freemotion-night/make-pool.mjs', '--apec-max', String(APEC_MAX)]);
    if (/CAPTCHA/i.test(`${pool.stdout}${pool.stderr}`)) note(`APEC showed its CAPTCHA during the 06:00 scan at --apec-max ${APEC_MAX} (#25): lower APEC_MAX in freemotion-night/scheduled.mjs.`, `apec captcha ${today()}`);
    // The reply check records what employers did and moves the tracker itself, without asking (user, 2026-10-08, 2026-10-25).
    const r = step(log, 'reply check', PYTHON, ['freemotion-night/inbox-replies.py']);
    for (const n of replyNotes(r.stdout || '')) note(n.text, n.key);
  } else if (cmd === 'loops') {
    startLoops(log);
  } else if (cmd === 'weekly') {
    const r = step(log, 'weekly lessons', NODE, ['freemotion-night/lessons.mjs', 'weekly']);
    const file = (r.stdout || '').match(/data\/lessons-weekly\/\S+\.md/);
    if (file) note(`Weekly lessons report ready: ${file[0]}. Say "weekly review" to go through it.`, `weekly ${file[0]}`);
  } else if (cmd === 'start-night') {
    startNight();
  } else if (cmd === 'night') {
    await runNight(log);
  } else if (cmd === 'burn') {
    await (await import('./burn.mjs')).tick();
  } else if (cmd === 'agent') {
    await import('./hub-agent.mjs');   // runs until the task is stopped
  } else if (cmd === 'install') {
    install({ only: flag('--only') });
  } else if (cmd === 'uninstall') {
    for (const t of TASKS) { const r = ps(`Unregister-ScheduledTask -TaskPath '\\career-ops\\' -TaskName '${t.name}' -Confirm:$false; 'ok'`); console.log(`${t.name}: ${(r.stdout || '').trim() === 'ok' ? 'removed' : (r.stderr || '').trim().slice(0, 200)}`); }
  } else if (cmd === 'status') {
    const r = ps(`Get-ScheduledTask -TaskPath '\\career-ops\\' | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; '{0,-20} {1,-8} last {2} (result {3}) next {4}' -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime }`);
    console.log((r.stdout || r.stderr || '').trim() || 'no tasks');
  } else {
    console.error('Usage: node freemotion-night/scheduled.mjs scan|loops|weekly|start-night|night|burn|agent|install|uninstall|status [--python <path>] [--bash <path>]');
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
