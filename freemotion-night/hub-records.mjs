/**
 * freemotion-night/hub-records.mjs — this machine's Free Motion files as plain records for the hub
 * (freemotion-hub/, the dashboard on the laptop). Read only: nothing here writes a file.
 *
 * Every record is { t: table, k: key, d: data }. The hub keeps them per machine, so the same keys on
 * two machines never collide. Tables (schema v1):
 *   job      one per finished job: company, role, site, driver, times, result, documents
 *   round    one per "===== round" in full-night.log, plus the round running now
 *   driver   one per driver in burn-settings.json: windows, reserve, pause, why
 *   alert    open and done items of data/agent-inbox.md, and the burn timer's repeated warnings
 *   scan     one per row of data/scan-runs.tsv
 *   pool     the ranked pool (pool.json) and this round's list (list.json), one record each
 *   reply    tracker status changes from data/status-log.tsv, tied to a job by its URL
 *   reaction one per employer reaction in data/reactions.tsv (inbox-replies.py): its level, who, what they said
 *   live     the job in hand: its phase and its last actions (agy's actions-<N>.log)
 *   setting  burn-settings.json and the blacklist, one record each
 *   event    what the logs said: notes, round starts and ends, burn timer lines
 *
 * Files are re-read only when their size or mtime changed (`cached`), and full-night.log (7 MB and
 * growing) only from where the last read stopped.
 */
import { existsSync, openSync, readFileSync, readSync, readdirSync, closeSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

import { REACTIONS, parseReactions } from '../lib/reactions.mjs';

export const SCHEMA = 1;
const NIGHT = 'tmp/fm/night';

// ── small helpers ────────────────────────────────────────────────────────
const memo = new Map();
/** fn(text) re-run only when the file changed; missing file → fallback. `tag` tells two readers of one file apart. */
function cached(root, rel, fn, fallback, tag = '') {
  const p = join(root, rel);
  const key = p + '#' + tag;
  let st;
  try { st = statSync(p); } catch { return fallback; }
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = memo.get(key);
  if (hit && hit.sig === sig) return hit.value;
  let value;
  try { value = fn(readFileSync(p, 'utf8'), st); } catch { value = fallback; }
  memo.set(key, { sig, value });
  return value;
}
const rows = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
const ms = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// ── sites ────────────────────────────────────────────────────────────────
const SITES = [
  [/hellowork\.com/, 'hellowork', 'HelloWork'], [/welcometothejungle\.com/, 'wttj', 'Welcome to the Jungle'],
  [/free-work\.com/, 'freework', 'Free-Work'], [/myworkdayjobs\.com|workday/, 'workday', 'Workday'],
  [/greenhouse\.io/, 'greenhouse', 'Greenhouse'], [/smartrecruiters\.com/, 'smartrecruiters', 'SmartRecruiters'],
  [/apec\.fr/, 'apec', 'APEC'], [/lever\.co/, 'lever', 'Lever'], [/ashbyhq\.com/, 'ashby', 'Ashby'],
  [/successfactors|sapsf/, 'successfactors', 'SuccessFactors'], [/teamtailor\.com/, 'teamtailor', 'Teamtailor'],
  [/taleo\.net/, 'taleo', 'Taleo'], [/icims\.com/, 'icims', 'iCIMS'], [/workable\.com/, 'workable', 'Workable'],
  [/recruitee\.com/, 'recruitee', 'Recruitee'], [/jobteaser\.com/, 'jobteaser', 'JobTeaser'],
  [/linkedin\.com/, 'linkedin', 'LinkedIn'], [/indeed\./, 'indeed', 'Indeed'], [/jobs\.personio/, 'personio', 'Personio'],
  [/francetravail|pole-emploi/, 'francetravail', 'France Travail'], [/cadremploi\.fr/, 'cadremploi', 'Cadremploi'],
];
export function siteOf(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { id: 'other', name: 'Other' }; }
  for (const [re, id, name] of SITES) if (re.test(host)) return { id, name };
  const parts = host.replace(/^www\./, '').split('.');
  const base = parts.slice(-2).join('.');
  return { id: base, name: base };
}

// ── results ──────────────────────────────────────────────────────────────
// The tracker's outcomes, folded into the dashboard's six results. The note decides between a closed
// posting, a job the user stopped, a posting that turned out not to fit, and a plain failure.
export function resultOf(outcome, note = '') {
  const n = note.toLowerCase();
  if (outcome === 'submitted') return 'sent';
  if (outcome === 'already-applied') return 'duplicate';
  if (outcome === 'captcha' || outcome === 'blocked-waf') return 'blocked';
  if (/stopped by (the user|the person|you)|watch window/.test(n)) return 'stopped';
  if (/closed|expir|plus disponible|n'est plus|no longer|removed|404|not found at employer/.test(n)) return 'closed';
  if (/^posting (is|only|requires)|internship|\bstage\b|not france|not a fit/.test(n)) return 'unfit';
  return 'failed';
}
// Rows that only hand a job on (a limit, a network retry) are not its result: a later row is.
const HANDOVER = /handing to|retrying|limit hit mid-run|usage limit mid-job|ran out of quota/i;

// ── job sheets: number → posting ─────────────────────────────────────────
const sheetMemo = new Map();
function sheet(root, num) {
  const j = join(root, NIGHT, `job-${num}.json`);
  const m = join(root, NIGHT, `job-${num}.md`);
  let st; try { st = statSync(existsSync(j) ? j : m); } catch { return null; }
  const hit = sheetMemo.get(num);
  if (hit && hit.mt === st.mtimeMs) return hit.v;
  let v = null;
  const js = existsSync(j) ? readJson(j) : null;
  if (js) v = { url: js.url, run: js.run, company: js.co, role: js.title, at: st.mtimeMs };
  else {
    try {
      const t = readFileSync(m, 'utf8').slice(0, 6000);
      const run = (t.match(/\(run ([^,)]+), job number \d+\)/) || [])[1] || '';
      const url = (t.match(/^ {3}(https?:\/\/\S+)/m) || [])[1] || '';
      const head = (t.match(/^\*\*(.+?)\*\*,\s*([^\n]*?)number \d+/m) || []);
      v = { url, run, company: '', role: head[1] || '', at: st.mtimeMs };
    } catch { v = null; }
  }
  sheetMemo.set(num, { mt: st.mtimeMs, v });
  return v;
}
function sheetNums(root) {
  let names = [];
  try { names = readdirSync(join(root, NIGHT)); } catch { return []; }
  const nums = new Set();
  for (const f of names) { const m = /^job-(\d+)\.(json|md)$/.exec(f); if (m && +m[1] < 9000) nums.add(+m[1]); }
  return [...nums].sort((a, b) => a - b);
}

// ── lookups by URL ───────────────────────────────────────────────────────
function fits(root) {
  return cached(root, 'data/llm-scores.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t).slice(1)) if (c[1] && c[4] !== '') out.set(c[1], +c[4]);
    return out;
  }, new Map());
}
function places(root) {
  return cached(root, 'data/scan-history.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t).slice(1)) if (c[0] && c[6]) out.set(c[0], c[6]);
    return out;
  }, new Map());
}
// One row per finished attempt: num → { start, end, driver }; the last attempt wins.
function attempts(root) {
  return cached(root, 'tmp/fm/usage/night-runs.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t)) if (c.length >= 4) out.set(+c[0], { start: ms(c[1]), end: ms(c[2]), driver: c[3] });
    return out;
  }, new Map());
}
function hwScript(root) {
  return cached(root, 'data/hellowork-script.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t).slice(1)) if (c[0]) out.set(+c[0], { start: ms(c[1]), secs: +c[2] || 0, result: c[5] || '' });
    return out;
  }, new Map());
}
// Every submissions row, grouped by "url|run".
function ledger(root) {
  return cached(root, 'data/freemotion-submissions.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t).slice(1)) {
      if (c.length < 8 || c[5] === 'rehearsal') continue;
      const k = c[1] + '|' + c[7];
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ outcome: c[5], at: ms(c[6]), note: c[8] || '', company: c[2], role: c[3] });
    }
    for (const list of out.values()) list.sort((a, b) => a.at - b.at);
    return out;
  }, new Map());
}
function docs(root, num) {
  const d = readJson(join(root, NIGHT, `docs-${num}.json`));
  if (!d) return { cv: { arm: 'generic', writer: null }, letter: { arm: 'none', writer: null, words: 0 }, known: false };
  const cvArm = d.cv?.arm || (d.cv?.tailored ? 'loose' : 'generic');
  const lArm = d.letter?.arm || (d.letter?.path ? 'full' : 'none');
  return {
    cv: { arm: cvArm, writer: d.cv?.tailored ? d.cv?.writer || null : null, fallback: !!d.cv?.fallback },
    letter: { arm: lArm, writer: lArm === 'none' ? null : d.letter?.writer || null, words: d.letter?.words || 0 },
    lang: d.lang || null, known: true,
  };
}

// ── jobs ─────────────────────────────────────────────────────────────────
const docMemo = new Map();
// agy's steps in a job: its "» NEXT:" lines in actions-<N>.log (agent-log.mjs writes one per step).
const stepMemo = new Map();
function steps(root, num) {
  const p = join(root, NIGHT, `actions-${num}.log`);
  let st; try { st = statSync(p); } catch { return null; }
  const hit = stepMemo.get(num);
  if (hit && hit.mt === st.mtimeMs) return hit.v;
  let v = null;
  try { v = (readFileSync(p, 'utf8').match(/» NEXT:/g) || []).length || null; } catch { v = null; }
  stepMemo.set(num, { mt: st.mtimeMs, v });
  return v;
}
function agyRows(root) {
  return cached(root, 'data/agy-jobs.tsv', (t) => {
    const out = new Map();
    for (const c of rows(t).slice(1)) {
      if (c.length < 8) continue;
      out.set(Number(c[0]), { driver: c[1], asked: c[2], model: c[3], tools: Number(c[6]) || 0, tool_fails: Number(c[7]) || 0 });
    }
    return out;
  }, new Map(), 'agy');
}
export function jobs(root) {
  const L = ledger(root), A = attempts(root), H = hwScript(root), F = fits(root), P = places(root);
  const G = agyRows(root);
  const out = [];
  for (const num of sheetNums(root)) {
    const s = sheet(root, num);
    if (!s || !s.url) continue;
    const list = L.get(s.url + '|' + s.run) || [];
    const finals = list.filter((r) => r.outcome !== 'in-progress' && !HANDOVER.test(r.note));
    const last = finals[finals.length - 1];
    if (!last) continue;   // not finished (the live job, or a sheet nobody ran)
    const first = list[0];
    const a = A.get(num), hw = H.get(num);
    const driver = a?.driver || (hw ? 'hellowork' : 'unknown');
    const start = a?.start || hw?.start || first?.at || last.at;
    const end = a?.end || (hw && !a ? hw.start + hw.secs * 1000 : null) || last.at;
    const result = resultOf(last.outcome, last.note);
    let dk = docMemo.get(num);
    if (!dk) { dk = docs(root, num); if (dk.known) docMemo.set(num, dk); }
    const site = siteOf(s.url);
    out.push({
      t: 'job', k: String(num), d: {
        id: num, run: s.run, company: last.company || first?.company || s.company || '', role: last.role || first?.role || s.role || '',
        place: P.get(s.url) || '', site: site.id, siteName: site.name, url: s.url, driver, start, end: Math.max(end, start),
        result, outcome: last.outcome, reason: result === 'sent' ? null : (last.note || null),
        fit: F.has(s.url) ? F.get(s.url) : null, cv: dk.cv, letter: dk.letter, lang: dk.lang || null,
        tries: list.filter((r) => r.outcome === 'in-progress').length || 1,
        steps: /^agy/.test(driver) ? steps(root, num) : null,
        // From data/agy-jobs.tsv (agy-jobs.mjs): the model it ran on, what run.sh asked for ('' = default, before the test), tool calls.
        agy: G.get(num)?.driver === driver ? { model: G.get(num).model, asked: G.get(num).asked, tools: G.get(num).tools, fails: G.get(num).tool_fails } : null,
      },
    });
  }
  return out;
}

// ── full-night.log: rounds and events ────────────────────────────────────
// Read once in full, then only what was appended. Only the marker lines matter; agy's action lines
// (most of the file) are skipped.
const logState = { off: 0, size: 0, carry: '', lines: [] };
const MARK = /^(#####|=====|job \d+|note:|allowance:|FULL NIGHT DONE|ALL DONE|  tonight's list:|docs for job \d+:)/;
function logLines(root) {
  const p = join(root, NIGHT, 'full-night.log');
  let st; try { st = statSync(p); } catch { return logState.lines; }
  if (st.size < logState.size) Object.assign(logState, { off: 0, carry: '', lines: [] });   // rotated
  if (st.size > logState.off) {
    const fd = openSync(p, 'r');
    try {
      const len = st.size - logState.off, buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, logState.off);
      const text = logState.carry + buf.toString('utf8');
      const parts = text.split(/\r?\n/);
      logState.carry = parts.pop();
      for (const l of parts) if (MARK.test(l)) logState.lines.push(l);
      logState.off = st.size;
    } finally { closeSync(fd); }
  }
  logState.size = st.size;
  return logState.lines;
}

const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
// "Sat 17:00" → the first such local moment at or after `after` (minus a minute).
function clockAfter(text, after) {
  const m = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d\d):(\d\d)/.exec(text);
  if (!m || !after) return null;
  for (let d = 0; d < 8; d++) {
    const t = new Date(after); t.setDate(t.getDate() + d); t.setHours(+m[2], +m[3], 0, 0);
    if (t.getDay() === DOW[m[1]] && t.getTime() >= after - 60000) return t.getTime();
  }
  return null;
}

function burnStarts(root) {
  return cached(root, 'tmp/fm/burn/burn.log', (t) => {
    const out = [];
    for (const l of t.split(/\r?\n/)) { const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) round started/.exec(l); if (m) out.push(new Date(m[1].replace(' ', 'T')).getTime()); }
    return out;
  }, [], 'starts');
}

/** Rounds and the night runs around them, from the log's marker lines. */
export function rounds(root, now = Date.now()) {
  const lines = logLines(root), burn = burnStarts(root);
  const out = [], events = [];
  let night = null, cur = null, seq = 0, nightSeq = 0;
  const close = (how, t) => { if (cur && !cur.end) { cur.end = t || cur.lastAt || cur.start; cur.ended = cur.ended || how; } };
  for (const l of lines) {
    if (l.startsWith('#####')) {
      close('interrupted');
      const m = /(\d{4}-\d\d-\d\d) (\d\d:\d\d)/.exec(l);
      const start = m ? new Date(`${m[1]}T${m[2]}`).getTime() : null;
      const byBurn = start != null && burn.some((b) => Math.abs(b - start) < 20 * 60000);
      night = { no: ++nightSeq, start, by: byBurn ? 'Burn timer' : 'You', done: false };
      cur = null;
      events.push({ t: start, actor: byBurn ? 'System' : 'You', text: byBurn ? 'The burn timer started a run' : 'A night run started' });
    } else if (l.startsWith('=====') && night) {
      close('finished');
      const start = clockAfter(l, night.start) || night.start;
      cur = { id: 'R-' + String(++seq).padStart(3, '0'), start, by: night.by, night: night.no, planned: 0, jobs: [], ended: null, end: null, last: /the last one/.test(l), lastAt: start, notes: [] };
      out.push(cur);
      events.push({ t: start, actor: 'System', text: 'Round ' + cur.id + ' started', run: cur.id });
    } else if (!cur) {
      continue;
    } else if (l.startsWith("  tonight's list:")) {
      const m = /list: (\d+) jobs/.exec(l); if (m) cur.planned = +m[1];
    } else if (/^job \d+/.test(l)) {
      const m = /^job (\d+)(?: \(([^)]+)\))?: (.*)$/.exec(l);
      if (m && !/skipped/.test(m[3])) cur.jobs.push(+m[1]);
    } else if (l.startsWith('note:')) {
      const text = l.slice(6).trim();
      if (/stop file found|stop-night file found/.test(text)) cur.ended = 'stopped';
      if (/no driver left|single-driver run, stopping|every driver is out/.test(text) && !cur.ended) cur.waitedForDrivers = true;
      if (/no driver left; stopping/.test(text)) cur.ended = 'nodriver';
      if (/pool is empty/.test(text)) cur.ended = 'empty';
      cur.notes.push(text);
      events.push({ t: cur.lastAt, actor: 'System', text: text.charAt(0).toUpperCase() + text.slice(1), run: cur.id });
    } else if (l.startsWith('ALL DONE')) {
      cur.applyDone = true;
    } else if (l.startsWith('FULL NIGHT DONE')) {
      const end = clockAfter(l, cur.start);
      close(cur.ended || 'finished', end);
      night.done = true;
      events.push({ t: end, actor: 'System', text: 'Round ' + cur.id + ' ended', run: cur.id });
    }
  }
  // Times between markers: each round's jobs carry their own end times (job records); the hub fills
  // a round's end from its last job when the log gives none.
  const running = !!(night && !night.done);
  if (running && cur && !cur.end) cur.ended = 'running';
  else close('interrupted');
  return { rounds: out, events, running, night };
}

// ── the job in hand ──────────────────────────────────────────────────────
const ACTION = /^(\d\d:\d\d:\d\d)\s{2}(\S+)\s+(.*)$/;
export function actions(root, num, day) {
  const p = join(root, NIGHT, `actions-${num}.log`);
  let text = ''; try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  let lastT = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = ACTION.exec(raw);
    if (m) {
      const [h, mi, s] = m[1].split(':').map(Number);
      const d = new Date(day); d.setHours(h, mi, s, 0);
      lastT = d.getTime();
      out.push({ t: lastT, kind: 'act', tool: m[2], text: m[3].trim() });
      continue;
    }
    const l = raw.trim();
    if (!l || lastT == null) continue;
    if (l.startsWith('» NEXT:')) {
      const [next, why] = l.slice(7).split(' — WHY:');
      out.push({ t: lastT, kind: 'next', text: next.trim(), why: (why || '').trim() });
    } else if (l.startsWith('→')) out.push({ t: lastT, kind: 'res', text: l.slice(1).trim().slice(0, 300) });
    else if (l.startsWith('✗')) out.push({ t: lastT, kind: 'bad', text: l.slice(1).trim().slice(0, 300) });
  }
  return out;
}

export function live(root, R, now = Date.now()) {
  if (!R.running) return { t: 'live', k: 'current', d: { state: 'idle' } };
  const cur = R.rounds[R.rounds.length - 1];
  const RUN = (() => { try { return readFileSync(join(root, NIGHT, 'run-id'), 'utf8').trim(); } catch { return ''; } })();
  if (!cur || cur.end) return { t: 'live', k: 'current', d: { state: 'between', round: cur?.id || null, night: R.night?.start || null } };
  // This round's sheets: written by make-jobs.mjs at its start.
  const mine = sheetNums(root).filter((n) => { const s = sheet(root, n); return s && s.run === RUN && s.at >= cur.start - 60000; });
  const done = new Set(cur.jobs);
  const L = ledger(root);
  const left = mine.filter((n) => !done.has(n));
  const num = left[0];
  const F = fits(root), P = places(root);
  const item = (n) => { const x = sheet(root, n), st = siteOf(x.url); return { num: n, url: x.url, company: x.company, role: x.role, site: st.id, siteName: st.name, fit: F.get(x.url) ?? null, place: P.get(x.url) || '' }; };
  const base = { state: 'running', round: cur.id, planned: cur.planned || mine.length, done: cur.jobs.length, queue: left.slice(1).map(item) };
  if (num == null) return { t: 'live', k: 'current', d: { ...base, state: 'choosing' } };
  const s = sheet(root, num), site = siteOf(s.url);
  const rowsFor = L.get(s.url + '|' + s.run) || [];
  const A = attempts(root);
  const prevEnd = Math.max(cur.start, ...[...done].map((n) => A.get(n)?.end || 0));
  const docsAt = (() => { try { const st = statSync(join(root, NIGHT, `docs-${num}.json`)); return st.mtimeMs >= prevEnd ? st.mtimeMs : null; } catch { return null; } })();
  const acts = actions(root, num, now).filter((a) => a.t >= prevEnd - 60000);
  const recorded = rowsFor.some((r) => r.outcome !== 'in-progress' && !HANDOVER.test(r.note) && r.at >= prevEnd);
  const claim = rowsFor.filter((r) => r.outcome === 'in-progress' && r.at >= prevEnd).pop();
  const isHw = site.id === 'hellowork';
  const phases = [
    { k: 'docs', label: 'Documents', at: prevEnd },
    ...(isHw ? [{ k: 'script', label: 'HelloWork form', at: docsAt }] : []),
    { k: 'agent', label: 'Agent', at: acts[0]?.t || (claim && (!isHw || claim.at > (docsAt || 0) + 30000) ? claim.at : null) },
    { k: 'record', label: 'Recorded', at: recorded ? rowsFor[rowsFor.length - 1].at : null },
  ];
  let phase = 0;
  phases.forEach((p, i) => { if (p.at) phase = i; });
  if (docsAt && phase === 0) phase = 1;
  const dk = docs(root, num);
  let driver = null, dAt = 0;
  for (const d of ['agy', 'agy-sonnet', 'codex', 'copilot', 'sonnet', 'sonnet1']) {
    for (const ext of ['json', 'err']) {
      try { const t = statSync(join(root, 'tmp/fm/usage', `${d}-${num}.${ext}`)).birthtimeMs; if (t >= prevEnd - 60000 && t > dAt) { driver = d; dAt = t; } } catch { /* not this one */ }
    }
  }
  if (!driver && isHw && phase === 1) driver = 'hellowork';
  return {
    t: 'live', k: 'current', d: {
      ...base, job: num, run: s.run, company: rowsFor[0]?.company || s.company, role: rowsFor[0]?.role || s.role, url: s.url,
      site: site.id, siteName: site.name, place: places(root).get(s.url) || '', fit: fits(root).get(s.url) ?? null,
      start: prevEnd, phase, phases, driver, cv: dk.known ? dk.cv : null, letter: dk.known ? dk.letter : null,
      log: acts.slice(-150), hasLog: acts.length > 0,
    },
  };
}

// ── drivers ──────────────────────────────────────────────────────────────
const SERVICE = {
  agy: 'Antigravity · Gemini models', 'agy-sonnet': 'Antigravity · Claude models', codex: 'Codex',
  copilot: 'GitHub Copilot', sonnet: 'Claude · account 2', sonnet1: 'Claude · account 1 (yours)',
};
function claudeWindows(root) {
  return cached(root, 'tmp/fm/usage/claude-windows.tsv', (t) => {
    const out = {};
    for (const c of rows(t)) if (c.length >= 6) out[c[1]] = { at: ms(c[0]), five: +c[2], week: +c[3], fiveReset: +c[4] * 1000, weekReset: +c[5] * 1000 };
    return out;
  }, {});
}
function agyQuota(root) {
  return cached(root, 'tmp/fm/usage/agy-quota.tsv', (t) => {
    const out = {};
    for (const c of rows(t)) if (c.length >= 4 && /Models|models/.test(c[1])) out[c[1] + '|' + c[2]] = { at: ms(c[0]), left: c[3] === '' ? null : +c[3], reset: ms(c[4]) };
    return out;
  }, {});
}
// Codex's windows from its newest session log (`rate_limits`: primary = 5 hours, secondary = week).
let codexMemo = { at: 0, v: null };
function codexWindows(now) {
  if (now - codexMemo.at < 5 * 60000) return codexMemo.v;
  codexMemo.at = now;
  try {
    const base = join(homedir(), '.codex', 'sessions');
    const newest = (dir, depth) => {
      const names = readdirSync(dir).sort().reverse();
      for (const n of names) {
        const p = join(dir, n);
        if (depth === 0) { if (n.endsWith('.jsonl')) return p; continue; }
        const f = newest(p, depth - 1); if (f) return f;
      }
      return null;
    };
    const f = newest(base, 3);
    if (!f) return null;
    const text = readFileSync(f, 'utf8');
    const i = text.lastIndexOf('"rate_limits"');
    if (i < 0) return null;
    const line = text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i) < 0 ? undefined : text.indexOf('\n', i));
    const rl = JSON.parse(line)?.payload?.rate_limits || JSON.parse(line)?.rate_limits;
    const at = statSync(f).mtimeMs;
    const w = (x) => x ? { used: x.used_percent, reset: x.resets_at ? x.resets_at * 1000 : at + (x.resets_in_seconds || 0) * 1000 } : null;
    codexMemo.v = { at, five: w(rl.primary), week: w(rl.secondary) };
  } catch { codexMemo.v = null; }
  return codexMemo.v;
}

/** Each driver's week reset from the readings, as burn.mjs's weekResets reads them. */
function weekResets(root, s) {
  const out = {}, cw = claudeWindows(root), aq = agyQuota(root);
  for (const [d, folder] of Object.entries(s.accounts || {})) if (cw[folder]?.weekReset) out[d] = cw[folder].weekReset;
  if (aq['Gemini Models|week']?.reset) out.agy = aq['Gemini Models|week'].reset;
  if (aq['Claude and GPT models|week']?.reset) out['agy-sonnet'] = aq['Claude and GPT models|week'].reset;
  return out;
}
export function driverOrder(s, resets, now = Date.now()) {
  const expired = (d) => s.scheduled?.[d]?.until && now >= Date.parse(s.scheduled[d].until);
  const last = s.last_resort || [];
  const firsts = (s.drivers || []).filter((d) => !expired(d) && !last.includes(d)).map((d, i) => ({ d, i, r: resets[d] ?? Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.d);
  return { order: firsts.concat((s.drivers || []).filter((d) => last.includes(d))), expired: (s.drivers || []).filter(expired) };
}

export function drivers(root, now = Date.now()) {
  const s = readJson(join(root, 'data/burn-settings.json')) || {};
  const st = readJson(join(root, 'tmp/fm/burn/state.json')) || {};
  const cw = claudeWindows(root), aq = agyQuota(root), cx = codexWindows(now);
  const out = [];
  const list = s.drivers || [];
  const win = (used, reset, len, at) => (used == null || !Number.isFinite(used) ? null : { used: Math.max(0, Math.min(100, used)), reset, len, at });
  const plan = driverOrder(s, weekResets(root, s), now);
  list.forEach((id, i) => {
    let five = null, week = null, month = null;
    if (id === 'agy' || id === 'agy-sonnet') {
      const g = id === 'agy' ? 'Gemini Models' : 'Claude and GPT models';
      const f = aq[g + '|5h'], w = aq[g + '|week'];
      if (f && f.left != null) five = win(100 - f.left, f.reset, 5 * 3600e3, f.at);
      if (w && w.left != null) week = win(100 - w.left, w.reset, 7 * 86400e3, w.at);
    } else if (id === 'sonnet' || id === 'sonnet1') {
      const acct = s.accounts?.[id];
      const r = st.win?.[id] || (acct && cw[acct] ? { at: cw[acct].at, fivePct: cw[acct].five, fiveReset: cw[acct].fiveReset, weekPct: cw[acct].week, weekReset: cw[acct].weekReset } : null);
      if (r) { five = win(r.fivePct, r.fiveReset, 5 * 3600e3, r.at); week = win(r.weekPct, r.weekReset, 7 * 86400e3, r.at); }
    } else if (id === 'codex' && cx) {
      five = win(cx.five?.used, cx.five?.reset, 5 * 3600e3, cx.at); week = win(cx.week?.used, cx.week?.reset, 7 * 86400e3, cx.at);
    } else if (id === 'copilot' && st.month?.copilot) {
      const m = st.month.copilot;
      const start = new Date(m.resetMs); start.setMonth(start.getMonth() - 1);
      month = win(100 * m.used / (m.entitlement || 1), m.resetMs, m.resetMs - start.getTime(), m.at);
      if (month) month.detail = `${Math.round(m.used)} of ${m.entitlement} credits`;
    }
    let outUntil = null;
    try { const e = +readFileSync(join(root, NIGHT, 'out', id), 'utf8').trim(); if (e * 1000 > now) outUntil = e * 1000; } catch { /* none */ }
    const rsv = s.reserve?.[id] || {};
    out.push({
      t: 'driver', k: id, d: {
        id, service: SERVICE[id] || id, priority: plan.order.includes(id) ? plan.order.indexOf(id) + 1 : null, listed: i + 1,
        expired: plan.expired.includes(id), off: (s.off || []).includes(id), account: s.accounts?.[id] || null,
        windows: { five, week, month }, reserve: { five: rsv.five_hour || 0, week: rsv.week || 0, month: 0 },
        lastHours: rsv.last_hours || null,
        from: s.not_before?.[id] ? ms(s.not_before[id]) : null, until: s.scheduled?.[id]?.until ? ms(s.scheduled[id].until) : null,
        scheduled: !!s.scheduled?.[id], workHours: !!s.scheduled?.[id], monthly: (s.monthly || []).includes(id),
        lastResort: (s.last_resort || []).includes(id), writes: id === 'codex',
        paused: st.paused?.[id] ? st.paused[id] * 1000 : null, why: st.why?.[id] || null, outUntil,
        noRead: st.noRead?.[id] || null,
      },
    });
  });
  return out;
}

// ── settings ─────────────────────────────────────────────────────────────
export function blacklist(root) {
  return cached(root, 'data/blacklist.md', (t) => {
    const out = [];
    for (const l of t.split(/\r?\n/)) {
      const m = /^\|\s*([^|]+?)\s*\|\s*(\d{4}-\d\d-\d\d)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(l);
      if (m && m[1] !== 'Company') out.push({ company: m[1], since: m[2], scope: m[3], reason: m[4] });
    }
    return out;
  }, []);
}
export function settings(root) {
  const s = readJson(join(root, 'data/burn-settings.json')) || {};
  return [
    { t: 'setting', k: 'burn', d: s },
    { t: 'setting', k: 'blacklist', d: { list: blacklist(root) } },
  ];
}

// ── alerts ───────────────────────────────────────────────────────────────
function sevOf(text) {
  if (/signed out|disabled|failed to start|not sent|could not|refused|broke|error/i.test(text)) return 'warning';
  return 'info';
}
export function alerts(root, now = Date.now()) {
  const out = [];
  const inbox = cached(root, 'data/agent-inbox.md', (t) => {
    const list = [];
    for (const l of t.split(/\r?\n/)) {
      const m = /^- \[([ xX!])\] (?:(\d{4}-\d\d-\d\d)(?: (\d\d:\d\d))?\s*[—-]+\s*)?(.*)$/.exec(l);
      if (!m) continue;
      const body = m[4].trim();
      const at = m[2] ? new Date(`${m[2]}T${m[3] || '00:00'}`).getTime() : null;
      const cut = body.search(/ — |: /);
      const title = (cut > 8 && cut < 110 ? body.slice(0, cut) : body.slice(0, 100)).replace(/\*\*/g, '');
      list.push({ id: 'IN-' + hash(l.replace(/^- \[.\] /, '')), state: m[1] === ' ' || m[1] === '!' ? 'open' : 'resolved', sev: m[1] === '!' ? 'critical' : sevOf(body),
        title, detail: body.replace(/\*\*/g, '').slice(0, 900), first: at, last: at, count: 1, source: 'Agent inbox', line: l });
    }
    return list;
  }, []);
  for (const a of inbox) out.push({ t: 'alert', k: a.id, d: a });
  // The burn timer's repeated warnings: one alert per distinct message, counted.
  const burnWarn = cached(root, 'tmp/fm/burn/burn.log', (t) => {
    const g = new Map();
    for (const l of t.split(/\r?\n/)) {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d) (could not .*|.*(?:failed|error).*)$/i.exec(l);
      if (!m) continue;
      const at = new Date(m[1].replace(' ', 'T')).getTime();
      const k = m[2].slice(0, 160);
      const x = g.get(k) || { first: at, last: at, count: 0, text: m[2] };
      x.last = at; x.count++; g.set(k, x);
    }
    return [...g.values()];
  }, [], 'warnings');
  for (const w of burnWarn) {
    const stale = now - w.last > 3 * 3600e3;
    const acct = /could not read (\S+?):/.exec(w.text);
    out.push({ t: 'alert', k: 'BU-' + hash(w.text.slice(0, 160)), d: {
      id: 'BU-' + hash(w.text.slice(0, 160)), state: stale ? 'resolved' : 'open', sev: /disabled|signed out/i.test(w.text) ? 'critical' : 'warning',
      title: acct ? `The burn timer cannot read ${acct[1]}` : w.text.slice(0, 90), detail: w.text, first: w.first, last: w.last, count: w.count,
      source: 'Burn timer', auto: true, resolvedAt: stale ? w.last : null,
    } });
  }
  return out;
}

// ── scans ────────────────────────────────────────────────────────────────
export function scans(root) {
  return cached(root, 'data/scan-runs.tsv', (t) => {
    const r = rows(t); const h = r[0] || [];
    return r.slice(1).map((c) => {
      const o = {}; h.forEach((k, i) => { o[k] = /^\d+$/.test(c[i] || '') ? +c[i] : c[i]; });
      const at = ms(o.timestamp);
      return { t: 'scan', k: String(at), d: { at, ...o } };
    }).filter((x) => x.d.at);
  }, []);
}
export function pool(root) {
  const read = (rel) => cached(root, rel, (t) => JSON.parse(t), []);
  const P = places(root);
  const norm = (x, i) => { const s = siteOf(x.url); return { key: x.url, rank: i + 1, company: x.co, role: x.title, url: x.url, site: s.id, siteName: s.name, fit: x.fit ?? null, tier: x.tier || null, place: P.get(x.url) || (x.toulouse ? 'Toulouse' : x.paris ? 'Paris' : ''), route: x.route || null, english: !!x.english }; };
  let poolAt = null, listAt = null;
  try { poolAt = statSync(join(root, NIGHT, 'pool.json')).mtimeMs; } catch { /* none */ }
  try { listAt = statSync(join(root, NIGHT, 'list.json')).mtimeMs; } catch { /* none */ }
  return [
    { t: 'pool', k: 'pool', d: { at: poolAt, items: read(`${NIGHT}/pool.json`).slice(0, 400).map(norm), total: read(`${NIGHT}/pool.json`).length } },
    { t: 'pool', k: 'list', d: { at: listAt, items: read(`${NIGHT}/list.json`).map(norm) } },
  ];
}

// ── replies: the tracker's status changes ────────────────────────────────
/** Tracker row number → { url, company, role, status }. */
function trackerIndex(root) {
  return cached(root, 'data/applications.md', (t) => {
    const m = new Map();
    for (const l of t.split(/\r?\n/)) {
      const c = l.split('|').map((x) => x.trim());
      if (!/^\d+$/.test(c[1] || '')) continue;
      const url = (/\((https?:\/\/[^)]+)\)/.exec(c[10] || '') || [])[1] || (/(https?:\/\/\S+)/.exec(c[10] || '') || [])[1] || '';
      m.set(+c[1], { url, company: c[3], role: c[4], status: c[6] });
    }
    return m;
  }, new Map());
}
export function replies(root) {
  const urls = trackerIndex(root);
  return cached(root, 'data/status-log.tsv', (t) => {
    const out = [];
    rows(t).forEach((c, i) => {
      if (c.length < 4 || !/^\d+$/.test(c[0])) return;
      const row = urls.get(+c[0]);
      out.push({ t: 'reply', k: `${c[0]}|${c[1]}|${c[3]}|${i}`, d: { tracker: +c[0], date: c[1], from: c[2], to: c[3], source: c[4] || '', note: c[5] || '', url: row?.url || '', company: row?.company || '', role: row?.role || '' } });
    });
    return out;
  }, []);
}

// ── reactions: how far each application got ──────────────────────────────
export function reactions(root) {
  const T = trackerIndex(root);
  return cached(root, REACTIONS, parseReactions, []).map((r) => {
    const row = r.num != null ? T.get(r.num) : null;
    return { t: 'reaction', k: `${r.ref}|${r.num ?? ''}`, d: { num: r.num, date: r.date, level: r.level, company: row?.company || r.company, role: row?.role || r.role,
      url: row?.url || '', status: row?.status || '', source: r.source, who: r.who, summary: r.summary, evidence: r.evidence, replyNeeded: r.reply_needed, by: r.by } };
  });
}

// ── everything ───────────────────────────────────────────────────────────
export function flags(root) {
  const has = (f) => existsSync(join(root, NIGHT, f));
  let skip = [];
  try { skip = readFileSync(join(root, NIGHT, 'skip'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* none */ }
  let start = null;
  // Who started the run in hand, and with which drivers (not its PATH and account folders).
  const ns = readJson(join(root, NIGHT, 'night-start.json'));
  if (ns) start = { at: ms(ns.at), by: ns.by || 'hand', mail: !!ns.mail, drivers: (ns.env?.DRIVER_ORDER || '').split(' ').filter(Boolean), jobs: +ns.env?.ROUND_JOBS || null };
  return { t: 'setting', k: 'flags', d: { stop: has('stop'), stopNight: has('stop-night'), skip, nightStart: start } };
}

/** The tables that change while a job runs; read every sync (the rest every few). */
export function collectFast(root, now = Date.now()) {
  const R = rounds(root, now);
  return [
    ...R.rounds.slice(-3).map((r) => ({ t: 'round', k: r.id, d: { ...r, lastAt: undefined } })),
    live(root, R, now), ...drivers(root, now), ...settings(root), flags(root),
  ];
}

export function collect(root, now = Date.now()) {
  const R = rounds(root, now);
  const recs = [
    ...jobs(root),
    ...R.rounds.map((r) => ({ t: 'round', k: r.id, d: { ...r, lastAt: undefined } })),
    ...R.events.filter((e) => e.t).map((e) => ({ t: 'event', k: 'log-' + hash(`${e.t}|${e.text}|${e.run || ''}`), d: e })),
    live(root, R, now), flags(root),
    ...drivers(root, now),
    ...settings(root),
    ...alerts(root, now),
    ...scans(root),
    ...pool(root),
    ...replies(root),
    ...reactions(root),
  ];
  return recs;
}
