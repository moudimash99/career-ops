#!/usr/bin/env node
// freemotion-night/browser-gate.mjs — the browser for a WATCHED run: every action that puts input into
// the page waits for the person's OK in the watch window (control.mjs).
//
// It is an MCP server that agy talks to in place of the Playwright one. It starts the real server exactly
// as `.mcp.json` describes it (same version, same Camoufox config) and passes everything through, except
// tool calls that type, click, choose, upload, open a page or run page code: those are held until the
// person decides. Calls that only read (snapshot, screenshot, the read-form/check helpers) pass at once.
// agy has no other way to the browser during a watched run, so this does not depend on agy obeying.
//
// Files (tmp/fm/gate/, cleared by control.mjs when a job starts):
//   pending.json    the action waiting for a decision {sig, tool, text, warn, args, at}
//   decision.json   the person's answer {sig, action: continue|skip|stop, text}
//   events.jsonl    every call, decision and result, for the window and the log
//   shot-<n>.png    every screenshot agy took;  view-<n>.png  the gate's own, for the person only
//
// ── WAITING ──────────────────────────────────────────────────────────────
// agy gives up on a browser call after 3 minutes ("MCP tool call … timed out after 3m0s", 2026-10-04).
// So a held call is answered "WAITING FOR THE PERSON, ask again" after GATE_WAIT_S seconds (default 150),
// and agy repeats it: the repeat takes the old one's place on screen, nothing else changes. Between
// answers agy is idle and uses no tokens.
// If agy asks for a DIFFERENT action instead, it has dropped the old one: the old one leaves the screen.
// A refusal message the person wrote for a dropped action is not lost: it answers agy's next action.
// Two actions sent at once (agy does that) are shown one after the other.
//
// ── A FRESH VIEW ON A BLOCK ──────────────────────────────────────────────
// When the form check reports empty required fields or errors, when an approved action fails, or when
// submit.js finds no button, the gate reads the page (browser_snapshot) and adds it to the answer agy
// gets: it then decides from the page as it is, not from an old read (a follow-up field that appeared
// after a choice was missed that way, 2026-10-04). agy gets no extra view otherwise.
//
// ── THE PERSON'S VIEW ────────────────────────────────────────────────────
// A screenshot when a new action is shown for approval, and after each approved action: view-<n>.png,
// "Page now" in the window. agy never sees these.
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, needsApproval } from './gate-describe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tmp', 'fm', 'gate');
const REPLY_MS = Number(process.env.GATE_WAIT_S || 150) * 1000;
mkdirSync(DIR, { recursive: true });
const PENDING = join(DIR, 'pending.json');
const DECISION = join(DIR, 'decision.json');
const log = (e) => { try { appendFileSync(join(DIR, 'events.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n'); } catch {} };

// The real server, as .mcp.json starts it.
const real = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')).mcpServers.playwright;
const child = spawn([real.command, ...real.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
process.stdin.on('end', () => child.kill());

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const toChild = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
const sigOf = (tool, args) => `${tool} ${JSON.stringify(args ?? {})}`;
const reply = (id, text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
const WAITING = 'WAITING FOR THE PERSON: this browser action has NOT been done yet; the person watching has not decided. Call the same tool again with exactly the same arguments to keep waiting. Do nothing else in the meantime.';

function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
}

// ── the gate's own calls to the real server (ids "gate-<n>") ─────────────
let ownId = 0;
const own = new Map();
function ask(name, args = {}) {
  const id = `gate-${++ownId}`;
  return new Promise((resolve) => {
    own.set(id, resolve);
    toChild({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    setTimeout(() => { if (own.delete(id)) resolve(null); }, 30000);
  });
}
let views = 0;
let lastView = 0;
async function viewForPerson() {
  if (Date.now() - lastView < 1500) return;
  lastView = Date.now();
  const r = await ask('browser_take_screenshot');
  const img = r?.result?.content?.find((c) => c.type === 'image' && c.data);
  if (!img) return;
  const file = `view-${++views}.png`;
  try { writeFileSync(join(DIR, file), Buffer.from(img.data, 'base64')); log({ kind: 'view', file }); } catch {}
}
const textOf = (msg) => (msg?.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// The last page snapshot seen: a click given only a reference ("e514") is shown with the element's name.
let lastSnapshot = '';
function named(args) {
  const ref = [args.ref, args.target].find((r) => /^e\d+$/.test(String(r ?? '')));
  if (!ref || (args.element && args.element !== ref)) return args;
  const line = lastSnapshot.split('\n').find((l) => l.includes(`[ref=${ref}]`));
  const m = line?.match(/-\s*([\w-]+)\s*(?:"([^"]*)")?/);
  return m ? { ...args, element: `${m[1]}${m[2] ? ` "${m[2]}"` : ''}` } : args;
}

// ── answers from the real server ─────────────────────────────────────────
// Calls forwarded for agy, by request id: what to log and whether a block deserves a fresh view.
const open = new Map();
let shots = 0;

lines(child.stdout, async (l) => {
  let msg;
  try { msg = JSON.parse(l); } catch { process.stdout.write(l + '\n'); return; }
  if (msg.id != null && own.has(msg.id)) {
    const done = own.get(msg.id);
    own.delete(msg.id);
    const t = textOf(msg);
    if (/\[ref=e\d+\]/.test(t)) lastSnapshot = t;
    done(msg);
    return;
  }
  const call = msg.id != null ? open.get(msg.id) : null;
  if (!call) { send(msg); return; }
  open.delete(msg.id);
  const content = msg.result?.content ?? [];
  for (const c of content) {
    if (c.type === 'image' && c.data) {
      const file = `shot-${++shots}.png`;
      try { writeFileSync(join(DIR, file), Buffer.from(c.data, 'base64')); log({ kind: 'shot', file, tool: call.tool }); } catch {}
    }
  }
  const text = textOf(msg);
  if (/\[ref=e\d+\]/.test(text)) lastSnapshot = text;
  const err = msg.error?.message || (msg.result?.isError || /^### Error/m.test(text) ? (text.match(/### Error\s*\n([\s\S]*?)(\n###|$)/)?.[1] ?? text) : '');
  const res = text.match(/### Result\s*\n([\s\S]*?)(\n###|$)/)?.[1] ?? '';
  const url = text.match(/- Page URL: (\S+)/)?.[1] ?? '';
  log({ kind: 'result', id: msg.id, tool: call.tool, ok: !err, text: (err || res).trim().slice(0, 400), url });

  const blocked = blockOf(call, err, res);
  if (blocked && msg.result) {
    const snap = await ask('browser_snapshot');
    const page = textOf(snap);
    if (page) {
      msg.result.content = [...content, { type: 'text', text: `### Page now (read by the browser gate because ${blocked}: decide from this, not from an earlier read)\n${page}` }];
      log({ kind: 'fresh', why: blocked });
    }
  }
  send(msg);
  if (call.approved) viewForPerson();
});

// Why this answer is a block worth a fresh look, or '' when it is not.
function blockOf(call, err, res) {
  if (err && call.approved) return 'the action failed';
  if (call.helper === 'check') {
    try {
      const r = JSON.parse(res);
      if (r.requiredEmpty > 0 || r.errors?.length) return 'the form check found empty required fields or errors';
    } catch {}
  }
  if (call.helper === 'submit') {
    try { if (!JSON.parse(res).clicked) return 'no send button was found on this page'; } catch {}
  }
  return '';
}
const helperOf = (tool, args) => (tool === 'browser_run_code_unsafe' && !args.code ? (String(args.filename ?? '').match(/(check|submit)\.js$/)?.[1] ?? '') : '');

// ── requests from agy ────────────────────────────────────────────────────
// Actions waiting for the person, oldest first; the first is on screen. msg is agy's live request for it
// (null once answered "WAITING" and not asked again yet).
const waiting = [];
let owed = '';   // a refusal message for an action agy dropped, owed to its next action

// One request at a time, in agy's order (a request may wait for the gate's own page read below).
let inbox = Promise.resolve();
lines(process.stdin, (l) => { inbox = inbox.then(() => handle(l)).catch(() => {}); });

async function handle(l) {
  let msg;
  try { msg = JSON.parse(l); } catch { child.stdin.write(l + '\n'); return; }
  if (msg.method === 'notifications/cancelled') {
    const w = waiting.find((x) => x.msg?.id === msg.params?.requestId);
    if (w) { clearTimeout(w.timer); w.msg = null; return; }
    toChild(msg);
    return;
  }
  if (msg.method !== 'tools/call') { toChild(msg); return; }
  const tool = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  // An element given only by its code ("e619") that the last page read does not hold (a list that
  // opened since): read the page for the person's sake, so the window shows its name. agy never sees it.
  const ref = [args.ref, args.target].find((r) => /^e\d+$/.test(String(r ?? '')));
  if (ref && (!args.element || args.element === ref) && needsApproval(tool, args) && !lastSnapshot.includes(`[ref=${ref}]`)) await ask('browser_snapshot');
  const { text, warn } = describe(tool, named(args));
  if (!needsApproval(tool, args)) {
    open.set(msg.id, { tool, helper: helperOf(tool, args) });
    log({ kind: 'call', id: msg.id, tool, text, gated: false });
    toChild(msg);
    return;
  }
  const sig = sigOf(tool, args);
  // A message the person wrote for an action agy has since dropped: it answers this action instead.
  if (owed) {
    reply(msg.id, `NOT DONE: ${owed} Follow their message, then go on.`);
    log({ kind: 'decision', id: msg.id, action: 'skip', text: `(for this action too) ${owed}` });
    owed = '';
    return;
  }
  let w = waiting.find((x) => x.sig === sig);
  if (w) { clearTimeout(w.timer); w.msg = msg; }
  else {
    // agy asked for something else: actions it stopped asking for leave the screen.
    for (let i = waiting.length - 1; i >= 0; i--) if (!waiting[i].msg) waiting.splice(i, 1);
    w = { sig, tool, args, text, warn, msg, at: new Date().toISOString() };
    waiting.push(w);
    log({ kind: 'call', id: msg.id, tool, text, warn, gated: true });
    viewForPerson();
  }
  w.timer = setTimeout(() => { if (w.msg) { reply(w.msg.id, WAITING); w.msg = null; } }, REPLY_MS);
  show();
}

function show() {
  const w = waiting[0];
  try {
    if (w) writeFileSync(PENDING, JSON.stringify({ sig: w.sig, tool: w.tool, text: w.text, warn: w.warn, args: w.args, at: w.at }));
    else unlinkSync(PENDING);
  } catch {}
}

// ── the person's decisions ───────────────────────────────────────────────
setInterval(() => {
  const w = waiting[0];
  if (!w) return;
  let d;
  try { d = JSON.parse(readFileSync(DECISION, 'utf8')); } catch { return; }
  try { unlinkSync(DECISION); } catch {}
  if (d.sig !== w.sig && d.action !== 'stop') return;
  if (d.action === 'continue' && !w.msg) {
    // Approved while agy was between asks: keep it on screen as approved, agy's repeat goes through at once.
    w.approved = true;
    log({ kind: 'decision', action: 'continue', text: '' });
    return;
  }
  waiting.shift();
  clearTimeout(w.timer);
  log({ kind: 'decision', id: w.msg?.id, action: d.action, text: d.text ?? '' });
  if (d.action === 'continue') { open.set(w.msg.id, { tool: w.tool, helper: helperOf(w.tool, w.args), approved: true }); toChild(w.msg); }
  else if (d.action === 'stop') { if (w.msg) reply(w.msg.id, 'STOPPED BY THE PERSON: do nothing more. Do not use the browser again. Write STOPPED and end.'); for (const x of waiting.splice(0)) if (x.msg) reply(x.msg.id, 'STOPPED BY THE PERSON.'); }
  else {
    const said = `the person did not allow "${w.text}".${d.text ? ` Their message: ${d.text}` : ''}`;
    if (w.msg) reply(w.msg.id, `NOT DONE: ${said} Follow their message, then go on.`);
    else owed = said;
  }
  show();
}, 300);

// An action approved between agy's asks goes through as soon as agy repeats it.
setInterval(() => {
  const w = waiting[0];
  if (!w?.approved || !w.msg) return;
  waiting.shift();
  clearTimeout(w.timer);
  open.set(w.msg.id, { tool: w.tool, helper: helperOf(w.tool, w.args), approved: true });
  toChild(w.msg);
  show();
}, 300);
