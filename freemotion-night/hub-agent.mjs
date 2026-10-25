#!/usr/bin/env node
/**
 * freemotion-night/hub-agent.mjs — this machine's side of the Free Motion dashboard (freemotion-hub/).
 *
 *   node freemotion-night/hub-agent.mjs            run: sync every 3 s, carry out the dashboard's commands
 *   node freemotion-night/hub-agent.mjs --once     one sync, print what was sent, exit
 *   node freemotion-night/hub-agent.mjs --dry-run  read the records and print counts; send nothing
 *
 * It only ever connects OUT to the hub (HUB_URL, over Tailscale); nothing connects to this machine.
 * Each sync sends the records that changed since the last one (hub-records.mjs; the first sync sends
 * them all) and gets back the commands waiting for this machine. Commands run one at a time; each
 * reports back running → done | failed, with what happened. The PC stays in charge: a command is a
 * request to the scripts that already exist (burn.mjs, the stop file, blacklist.md), never a second
 * way of deciding anything.
 *
 * Settings (.env): HUB_URL (e.g. http://100.111.127.103:8791), HUB_MACHINE (this machine's name, e.g.
 * pc), HUB_KEY (its secret, also in the hub's AGENT_KEYS). Log: tmp/fm/hub/agent.log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { hostname } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { collect, collectFast, SCHEMA } from './hub-records.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NIGHT = join(ROOT, 'tmp/fm/night');
const LOGDIR = join(ROOT, 'tmp/fm/hub');
const VERSION = '1.0.0';
const EVERY = 3000;          // a sync every 3 s
const FULL_EVERY = 5;        // every 5th sync re-reads every file (the others: live job, drivers, rounds)

// ── settings ─────────────────────────────────────────────────────────────
function env() {
  const out = { ...process.env };
  try {
    for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*(HUB_[A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m && !process.env[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return out;
}
const E = env();
const HUB = (E.HUB_URL || '').replace(/\/+$/, '');
const MACHINE = E.HUB_MACHINE || hostname().toLowerCase();
const KEY = E.HUB_KEY || '';
const say = (line) => {
  const l = `${new Date().toISOString()} ${line}`;
  try { mkdirSync(LOGDIR, { recursive: true }); appendFileSync(join(LOGDIR, 'agent.log'), l + '\n'); } catch { /* best effort */ }
  console.log(l);
};

// ── what changed ─────────────────────────────────────────────────────────
const sent = new Map();   // "t|k" → hash of the data last sent
const hashOf = (d) => createHash('sha1').update(JSON.stringify(d)).digest('base64');
function changes(records, full) {
  const up = [], seen = new Set();
  for (const r of records) {
    const id = r.t + '|' + r.k, h = hashOf(r.d);
    seen.add(id);
    if (sent.get(id) !== h) up.push({ ...r, h });
  }
  // Records gone from the files (a resolved inbox line rewritten, a pool that changed): deleted at the hub.
  // Only on a full read, and only for tables that read had in full.
  const del = [];
  if (full) for (const id of sent.keys()) if (!seen.has(id)) del.push(id);
  return { up, del };
}

// ── commands ─────────────────────────────────────────────────────────────
const run = (cmd, args, { timeout = 120000 } = {}) => new Promise((res) => {
  execFile(cmd, args, { cwd: ROOT, timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    res({ ok: !err, code: err?.code ?? 0, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
  });
});
const node = (script, args, o) => run(process.execPath, [join(ROOT, script), ...args], o);
const lastLine = (s) => (s || '').split(/\r?\n/).filter(Boolean).pop() || '';
const currentLive = () => latest.find((r) => r.t === 'live')?.d || {};

function blacklistEdit(company, add, reason) {
  const p = join(ROOT, 'data/blacklist.md');
  const text = readFileSync(p, 'utf8');
  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const lines = text.split('\n');
  const isRow = (l) => { const m = /^\|\s*([^|]+?)\s*\|\s*\d{4}-\d\d-\d\d\s*\|/.exec(l); return m && fold(m[1]) === fold(company); };
  if (add) {
    if (lines.some(isRow)) return { ok: true, message: `${company} was already on the blacklist` };
    const clean = (s) => String(s).replace(/[|\r\n]/g, ' ').trim();
    const row = `| ${clean(company)} | ${new Date().toISOString().slice(0, 10)} | scan+apply | ${clean(reason || 'Added from the dashboard')} |`;
    let last = -1; lines.forEach((l, i) => { if (/^\|.*\|\s*$/.test(l)) last = i; });
    if (last < 0) return { ok: false, message: 'blacklist.md has no table to add to' };
    lines.splice(last + 1, 0, row);
  } else {
    const n = lines.length, kept = lines.filter((l) => !isRow(l));
    if (kept.length === n) return { ok: true, message: `${company} was not on the blacklist` };
    lines.length = 0; lines.push(...kept);
  }
  writeFileSync(p, lines.join('\n'));
  return { ok: true, message: add ? `${company} is on the blacklist` : `${company} is off the blacklist` };
}

function skipEdit(urls, add) {
  const p = join(NIGHT, 'skip');
  const have = new Set(existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  for (const u of urls) { if (!/^https?:\/\/\S+$/.test(u)) continue; if (add) have.add(u); else have.delete(u); }
  writeFileSync(p, [...have].join('\n') + (have.size ? '\n' : ''));
  return have.size;
}

// The files a drawer may open, all inside this project.
function fileFor(kind, num) {
  const n = String(num);
  if (!/^\d+$/.test(n)) return null;
  const docs = (() => { try { return JSON.parse(readFileSync(join(NIGHT, `docs-${n}.json`), 'utf8')); } catch { return null; } })();
  if (kind === 'cv') return docs?.cv?.path || null;
  if (kind === 'letter') return docs?.letter?.path || null;
  if (kind === 'report') return join(NIGHT, `report-${n}.md`);
  if (kind === 'actions') return join(NIGHT, `actions-${n}.log`);
  if (kind === 'shot') {
    const re = new RegExp(`^(?:hw-${n}-[\\w-]+|screenshot-${n}(?:-[\\w-]+)?|${n}-[\\w-]+|job-${n}-[\\w-]+|confirmation-${n}|pre-submit-${n}|shot-${n}(?:-\\w)?)\\.png$`);
    const shots = readdirSync(NIGHT).filter((f) => re.test(f)).map((f) => join(NIGHT, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return shots[0] || null;
  }
  return null;
}
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

async function stopNow() {
  const L = currentLive();
  writeFileSync(join(NIGHT, 'stop'), '');
  writeFileSync(join(NIGHT, 'stop-night'), '');
  if (L.state !== 'running' || !L.job) return { ok: true, message: 'No job was in hand; the round stops before the next one' };
  // The job is recorded as stopped first, so run.sh does not close it as a crash afterwards.
  const runId = (() => { try { return readFileSync(join(NIGHT, 'run-id'), 'utf8').trim(); } catch { return ''; } })();
  await node('lib/freemotion-submissions.mjs', ['finalize', '--url', L.url, '--outcome', 'errored', '--run-id', runId, '--notes', 'stopped by you from the dashboard; nothing sent after that point']);
  // Then its processes: the driver (its prompt names the sheet) or HelloWork's script.
  const ps = `$me=$PID; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.Name -ne 'powershell.exe' -and ($_.CommandLine -like '*job-${L.job}.md*' -or $_.CommandLine -like '*hellowork.mjs ${L.job}*') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $_.Name }`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 60000 });
  const killed = r.out.split(/\r?\n/).filter(Boolean);
  return { ok: true, message: `Job ${L.job} stopped (${killed.length ? killed.join(', ') + ' ended' : 'no process was left'}); the round ends` };
}

const scanState = { child: null };
function scan(report) {
  if (scanState.child) return { ok: false, message: 'A scan is already running' };
  return new Promise((res) => {
    const steps = [['scan.mjs', []], ['freemotion-night/make-pool.mjs', []]];
    let i = 0, last = '';
    const next = () => {
      if (i >= steps.length) { scanState.child = null; return res({ ok: true, message: last || 'Scan finished' }); }
      const [script, args] = steps[i++];
      report(i === 1 ? 'Reading the sources' : 'Building the pool: rules, posting texts, fit scores');
      const c = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, windowsHide: true });
      scanState.child = c;
      const onData = (b) => { const l = lastLine(String(b)); if (l) { last = l.slice(0, 200); report(last); } };
      c.stdout.on('data', onData); c.stderr.on('data', onData);
      c.on('close', (code) => { if (code) { scanState.child = null; res({ ok: false, message: `${script} stopped (exit ${code}): ${last}` }); } else next(); });
    };
    next();
  });
}

const DRIVER_ID = /^[a-z0-9-]{2,20}$/;
// HUB_DRY=1 (tests): every command answers "done" without touching anything; only reading a file is real.
const DRY = E.HUB_DRY === '1';
async function execute(c, report) {
  const a = c.args || {};
  if (DRY && c.action !== 'read') { await new Promise((z) => setTimeout(z, 600)); return { ok: true, message: `Dry run: ${c.action} not carried out` }; }
  switch (c.action) {
    case 'burn': {
      const r = await node('freemotion-night/burn.mjs', [a.on ? 'on' : 'off']);
      return r.ok ? { ok: true, message: a.on ? 'Burn timer on' : 'Burn timer off' } : { ok: false, message: r.err || r.out };
    }
    case 'stop-after-job': {
      for (const f of ['stop', 'stop-night']) { const p = join(NIGHT, f); if (a.on) writeFileSync(p, ''); else rmSync(p, { force: true }); }
      return { ok: true, message: a.on ? 'The round stops when the job in hand ends' : 'The round goes on' };
    }
    case 'stop-now': return stopNow();
    case 'start-round': {
      const jobs = Number(a.jobs);
      if (!Number.isInteger(jobs) || jobs < 1 || jobs > 200) return { ok: false, message: 'Jobs must be a whole number from 1 to 200' };
      for (const f of ['stop', 'stop-night']) rmSync(join(NIGHT, f), { force: true });
      const r = await node('freemotion-night/burn.mjs', ['round', '--jobs', String(jobs)], { timeout: 180000 });
      return r.ok ? { ok: true, message: `Round of ${jobs} started` } : { ok: false, message: lastLine(r.err) || lastLine(r.out) || 'could not start a round' };
    }
    case 'driver': {
      if (!DRIVER_ID.test(a.id || '')) return { ok: false, message: 'Unknown driver' };
      const r = await node('freemotion-night/burn.mjs', ['driver', a.id, a.on ? 'on' : 'off']);
      return r.ok ? { ok: true, message: a.on ? `${a.id} may take jobs again` : `${a.id} takes no new jobs` } : { ok: false, message: r.err || r.out };
    }
    case 'settings': {
      // Only these keys, checked here again: the page checks them too, but the PC decides.
      const p = join(ROOT, 'data/burn-settings.json'), s = JSON.parse(readFileSync(p, 'utf8'));
      const ch = [];
      if (a.round_jobs != null) { const n = Number(a.round_jobs); if (!Number.isInteger(n) || n < 1 || n > 200) return { ok: false, message: 'Jobs per round: 1 to 200' }; s.round_jobs = n; ch.push(`jobs per round ${n}`); }
      if (a.work) {
        const { days, from, to } = a.work, t = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || !t.test(from) || !t.test(to) || from >= to) return { ok: false, message: 'Working hours are not valid' };
        s.work = { days: [...new Set(days)].sort(), from, to }; ch.push(`working hours ${from}–${to}`);
      }
      if (a.reserve) {
        if (!DRIVER_ID.test(a.reserve.id || '')) return { ok: false, message: 'Unknown driver' };
        const w = Number(a.reserve.week), f = Number(a.reserve.five_hour);
        if (![w, f].every((x) => Number.isInteger(x) && x >= 0 && x <= 90)) return { ok: false, message: 'Reserves: 0 to 90%' };
        s.reserve = { ...s.reserve, [a.reserve.id]: { ...(s.reserve?.[a.reserve.id] || {}), week: w, five_hour: f } };
        ch.push(`${a.reserve.id} keeps ${w}% of its week and ${f}% of its 5 hours`);
      }
      if (!ch.length) return { ok: true, message: 'Nothing changed' };
      writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
      return { ok: true, message: 'Saved: ' + ch.join(', ') };
    }
    case 'blacklist': {
      const co = String(a.company || '').trim();
      if (!co || co.length > 120) return { ok: false, message: 'Company name missing' };
      const r = blacklistEdit(co, !!a.add, a.reason);
      // Its postings in the round in hand are passed over too (run.sh's skip file).
      if (r.ok && Array.isArray(a.urls) && a.urls.length) skipEdit(a.urls, !!a.add);
      return r;
    }
    case 'skip': {
      const n = skipEdit(Array.isArray(a.urls) ? a.urls : [], !!a.on);
      return { ok: true, message: a.on ? 'Taken out of the round' : 'Back in the round', data: { skipped: n } };
    }
    case 'alert': {
      // An agent-inbox line ticked off ([x]) or opened again ([ ]), found by its exact text.
      const p = join(ROOT, 'data/agent-inbox.md');
      const text = readFileSync(p, 'utf8'), body = String(a.line || '').replace(/^- \[.\] /, '');
      if (!body) return { ok: false, message: 'That alert is not from the agent inbox' };
      const lines = text.split('\n');
      const i = lines.findIndex((l) => l.replace(/\r$/, '').replace(/^- \[.\] /, '') === body);
      if (i < 0) return { ok: false, message: 'The inbox line changed since; reload the page' };
      lines[i] = lines[i].replace(/^- \[.\] /, a.resolve ? '- [x] ' : '- [ ] ');
      writeFileSync(p, lines.join('\n'));
      return { ok: true, message: a.resolve ? 'Ticked off in the agent inbox' : 'Open again in the agent inbox' };
    }
    case 'scan': return scan(report);
    case 'read': {
      const f = fileFor(a.kind, a.num);
      if (!f || !existsSync(f)) return { ok: false, message: 'That file is not there (any more)' };
      const full = resolve(f);
      if (!full.startsWith(resolve(ROOT) + sep)) return { ok: false, message: 'Outside the project' };
      const st = statSync(full);
      if (st.size > 6 << 20) return { ok: false, message: 'Too big to show here' };
      const ext = full.slice(full.lastIndexOf('.')).toLowerCase();
      return { ok: true, message: 'ok', data: { name: full.split(sep).pop(), type: TYPES[ext] || 'application/octet-stream', b64: readFileSync(full).toString('base64'), at: st.mtimeMs } };
    }
    default: return { ok: false, message: `This agent does not know "${c.action}" (version ${VERSION})` };
  }
}

// ── the scheduled tasks: their real next run (Windows keeps a fixed offset across clock changes) ──
let tasks = { t: 'setting', k: 'tasks', d: { at: 0, list: [] } };
async function readTasks() {
  const ps = "Get-ScheduledTask -TaskPath '\\career-ops\\' | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name = $_.TaskName; state = [string]$_.State; next = if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }; last = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToUniversalTime().ToString('o') } else { $null }; result = $i.LastTaskResult } } | ConvertTo-Json -Compress";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 60000 });
  if (!r.ok) return;
  try {
    const list = [].concat(JSON.parse(r.out || '[]')).map((x) => ({ name: x.name, state: x.state, next: x.next ? Date.parse(x.next) : null, last: x.last ? Date.parse(x.last) : null, result: x.result }));
    tasks = { t: 'setting', k: 'tasks', d: { at: Date.now(), list } };
  } catch { /* keep the last reading */ }
}

// ── the loop ─────────────────────────────────────────────────────────────
let latest = [];
async function post(path, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await fetch(HUB + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${KEY}`, 'x-machine': MACHINE },
    body: gzipSync(raw), signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const hello = () => ({ version: VERSION, schema: SCHEMA, host: hostname(), platform: process.platform, started: STARTED });
const STARTED = Date.now();
const queue = [];
let busy = false;
async function work() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const c = queue.shift();
    const report = (message) => { post('/agent/v1/result', { id: c.id, status: 'running', message }).catch(() => {}); };
    report('Started');
    let r;
    try { r = await execute(c, report); } catch (e) { r = { ok: false, message: e.message }; }
    say(`command ${c.id} ${c.action} ${JSON.stringify(c.args || {}).slice(0, 120)}: ${r.ok ? 'done' : 'failed'} — ${r.message}`);
    for (let k = 0; k < 5; k++) {
      try { await post('/agent/v1/result', { id: c.id, status: r.ok ? 'done' : 'failed', message: r.message, data: r.data || null }); break; } catch { await new Promise((z) => setTimeout(z, 3000)); }
    }
    tick.force = true;   // what the command changed shows at once
  }
  busy = false;
}

let n = 0, failing = 0;
async function tick() {
  const full = n % FULL_EVERY === 0 || tick.force;
  tick.force = false;
  if (Date.now() - tasks.d.at > 10 * 60000) await readTasks();
  const records = [...(full ? collect(ROOT) : collectFast(ROOT)), tasks];
  latest = records;
  const { up, del } = changes(records, full);
  const res = await post('/agent/v1/sync', { machine: MACHINE, hello: n % 20 === 0 ? hello() : undefined, full, upserts: up.map(({ h, ...r }) => r), deletes: del, at: Date.now() });
  for (const r of up) sent.set(r.t + '|' + r.k, r.h);
  for (const id of del) sent.delete(id);
  for (const c of res.commands || []) if (!queue.some((q) => q.id === c.id)) queue.push(c);
  work();
  n++;
  return { up: up.length, del: del.length, commands: (res.commands || []).length };
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    const all = collect(ROOT), by = {};
    for (const r of all) by[r.t] = (by[r.t] || 0) + 1;
    console.log(by, `${Math.round(JSON.stringify(all).length / 1024)} KB`);
    return;
  }
  if (!HUB || !KEY) { console.error('Set HUB_URL and HUB_KEY in .env (and HUB_MACHINE, else the host name is used)'); process.exit(1); }
  if (process.argv.includes('--once')) { console.log(await tick()); return; }
  say(`agent ${VERSION} for ${MACHINE} → ${HUB}`);
  for (;;) {
    const t0 = Date.now();
    try {
      const r = await tick();
      if (failing) say(`hub reachable again after ${failing} failed sync(s)`);
      failing = 0;
      if (r.up > 200) say(`sent ${r.up} records`);
    } catch (e) {
      if (failing++ % 20 === 0) say(`sync failed: ${e.message}`);
      sent.clear();   // send everything again once the hub answers: it may have lost what it had
    }
    const wait = failing ? Math.min(30000, EVERY * failing) : EVERY;
    await new Promise((z) => setTimeout(z, Math.max(200, wait - (Date.now() - t0))));
  }
}

main();
