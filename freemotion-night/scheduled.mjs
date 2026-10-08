#!/usr/bin/env node

/**
 * freemotion-night/scheduled.mjs — what Windows Task Scheduler runs (issue #22).
 *
 *   node freemotion-night/scheduled.mjs scan      "scan": scan.mjs, make-pool.mjs (posting texts and scores),
 *                                                 then the reply check (inbox-replies.py)
 *   node freemotion-night/scheduled.mjs loops     start the three scoring loops if they are not running
 *   node freemotion-night/scheduled.mjs weekly    the weekly lessons report (lessons.mjs weekly)
 *   node freemotion-night/scheduled.mjs install   create the Windows tasks below (needs no admin rights)
 *   node freemotion-night/scheduled.mjs uninstall remove them
 *   node freemotion-night/scheduled.mjs status    the tasks and their last result
 *
 * Tasks (folder \career-ops\ in Task Scheduler; a run missed while the PC was off starts when it is on):
 *   FreeMotion scan     every day 06:00
 *   FreeMotion loops    at log-on and every day 06:00 (a loop already running is left alone)
 *   FreeMotion weekly   Mondays 09:00
 * They run hidden (conhost --headless). "apply" is never scheduled: it spends the drivers' allowances
 * and sends real applications, so a person starts it.
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

/** What the reply check printed that needs a person: recruiters who want to talk, proposed changes. */
export function replyNotes(output) {
  const out = [];
  const talk = output.split(/A RECRUITER WANTS TO TALK[^\n]*\n/)[1];
  if (talk) for (const line of talk.split(/\r?\n/)) {
    if (!/^\s{3}\d{4}-\d{2}-\d{2}\s/.test(line)) break;
    out.push({ text: `Recruiter wrote and wants to talk (answer by hand): ${line.trim()}`, key: `talk ${line.trim()}` });
  }
  const m = output.match(/PROPOSED CHANGES \((\d+)\)[^\n]*\n((?:\s*\d+\s+#.*\n?)*)/);
  if (m && Number(m[1]) > 0) {
    const lines = m[2].trim().split(/\r?\n/).map((l) => l.trim());
    out.push({ text: `${m[1]} tracker change(s) applied from employers' replies (rejections found in email; see data/status-log.tsv)`, key: `changes ${lines.join('|')}` });
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
];
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });

function install() {
  const python = spawnSync(PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout?.trim();
  if (!python) { console.error(`no python found (${PYTHON}); pass --python <path>`); process.exit(1); }
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  for (const t of TASKS) {
    const argument = `--headless "${NODE}" "${join(ROOT, 'freemotion-night/scheduled.mjs')}" ${t.job} --python "${python}"`;
    const script = 'try { ' + [
      `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${q(argument)} -WorkingDirectory ${q(ROOT)}`,
      `$t = @(${t.triggers.map((x) => `(${x})`).join(', ')})`,
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8) -MultipleInstances IgnoreNew`,
      `Register-ScheduledTask -TaskPath '\\career-ops\\' -TaskName ${q(t.name)} -Action $a -Trigger $t -Settings $s -Force -ErrorAction Stop | Out-Null`,
      `'ok'`,
    ].join('; ') + ` } catch { 'ERROR: ' + $_.Exception.Message }`;
    const r = ps(script);
    console.log(`${t.name}: ${(r.stdout || '').trim() === 'ok' ? 'installed' : `FAILED ${(r.stderr || r.stdout).trim().slice(0, 300)}`}`);
  }
}

function main() {
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
    const r = step(log, 'reply check', PYTHON, ['freemotion-night/inbox-replies.py']);
    // Rejections found in email go into the tracker without asking (user, 2026-10-08).
    if (/PROPOSED CHANGES \([1-9]/.test(r.stdout || '')) step(log, 'apply replies', PYTHON, ['freemotion-night/inbox-replies.py', '--apply', 'all']);
    for (const n of replyNotes(r.stdout || '')) note(n.text, n.key);
  } else if (cmd === 'loops') {
    startLoops(log);
  } else if (cmd === 'weekly') {
    const r = step(log, 'weekly lessons', NODE, ['freemotion-night/lessons.mjs', 'weekly']);
    const file = (r.stdout || '').match(/data\/lessons-weekly\/\S+\.md/);
    if (file) note(`Weekly lessons report ready: ${file[0]}. Say "weekly review" to go through it.`, `weekly ${file[0]}`);
  } else if (cmd === 'install') {
    install();
  } else if (cmd === 'uninstall') {
    for (const t of TASKS) { const r = ps(`Unregister-ScheduledTask -TaskPath '\\career-ops\\' -TaskName '${t.name}' -Confirm:$false; 'ok'`); console.log(`${t.name}: ${(r.stdout || '').trim() === 'ok' ? 'removed' : (r.stderr || '').trim().slice(0, 200)}`); }
  } else if (cmd === 'status') {
    const r = ps(`Get-ScheduledTask -TaskPath '\\career-ops\\' | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; '{0,-20} {1,-8} last {2} (result {3}) next {4}' -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime }`);
    console.log((r.stdout || r.stderr || '').trim() || 'no tasks');
  } else {
    console.error('Usage: node freemotion-night/scheduled.mjs scan|loops|weekly|install|uninstall|status [--python <path>]');
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
