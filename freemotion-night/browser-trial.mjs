#!/usr/bin/env node
// freemotion-night/browser-trial.mjs — how fast and how steady is Camoufox, hidden vs visible?
//
// Starts the same Playwright MCP server the drivers use (command, pinned version and
// --config from .mcp.json), but on a temporary copy of the config with only "headless"
// changed (lib/freemotion-browser-mode.mjs) and its own empty browser profile, so it
// never touches the shared config or a session that is running. Then it does what an
// agent does, over the MCP protocol, and times each call:
//   - launch: the server answers, then the first page load (which starts the browser)
//   - a local test page (no network): clicks, typing with slowly: true, a screenshot
//   - a few application sites: load the page, read it, look for a bot wall. It only
//     opens pages; it fills and sends nothing.
// Rows go to tmp/fm/browser-trial.tsv (date, mode, step, ms, ok, note); a summary is printed.
//
//   node freemotion-night/browser-trial.mjs                    # hidden, then visible
//   node freemotion-night/browser-trial.mjs --mode headful     # one mode only
//   --clicks 5   --no-sites   --sites <url,url>   --timeout 180 (seconds per call)

import { spawn, execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { flagValue, hasFlag, safeIntFlag, validateFlags } from '../lib/cli-flags.mjs';
import { withHeadless } from '../lib/freemotion-browser-mode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tmp/fm/browser-trial.tsv');

// Public search pages of sites Free Motion applies through. Opened, read, closed.
const DEFAULT_SITES = [
  'https://www.hellowork.com/fr-fr/emploi/recherche.html?k=data+engineer&l=Toulouse',
  'https://www.welcometothejungle.com/fr/jobs?query=data%20engineer',
  'https://www.free-work.com/fr/tech-it/jobs?query=data%20engineer',
  'https://candidat.francetravail.fr/offres/recherche?motsCles=data+engineer',
  'https://www.apec.fr/candidat/recherche-emploi.html/emploi?motsCles=data%20engineer',
];
const BOT_WALL = /captcha|just a moment|verify you are human|attention required|access denied|are you a robot|vérifi\w* que vous|datadome/i;

const USAGE = `Usage: node freemotion-night/browser-trial.mjs [--mode headless|headful|both] [--clicks N]
       [--sites url,url | --no-sites] [--timeout seconds]`;
const VALUE_FLAGS = ['--mode', '--clicks', '--sites', '--timeout'];
const argv = process.argv.slice(2);
validateFlags(argv, [...VALUE_FLAGS, '--no-sites', '--help', '-h'], USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
const MODE = flagValue(argv, '--mode') ?? 'both';
if (!['headless', 'headful', 'both'].includes(MODE)) { console.error(USAGE); process.exit(1); }
const CLICKS = safeIntFlag(flagValue(argv, '--clicks'), 5);
const TIMEOUT_MS = safeIntFlag(flagValue(argv, '--timeout'), 180) * 1000;
const SITES = hasFlag(argv, '--no-sites') ? [] : (flagValue(argv, '--sites')?.split(',').filter(Boolean) ?? DEFAULT_SITES);

/** The playwright entry of .mcp.json: command, and args with the --config path pulled out. */
function productionServer() {
  const server = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf-8'))?.mcpServers?.playwright;
  const args = server?.args ?? [];
  const at = args.indexOf('--config');
  if (!server?.command || at === -1 || !args[at + 1]) {
    throw new Error('.mcp.json has no playwright server with --config; nothing to copy the trial from');
  }
  return { command: server.command, args: args.filter((_, i) => i !== at && i !== at + 1), configPath: args[at + 1] };
}

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Free Motion browser trial</title></head>
<body><h1>Browser trial</h1>
<form onsubmit="return false">
  <label>Name <input id="name" name="name"></label>
  <label>Motivation <textarea id="why" name="why"></textarea></label>
  <button type="button" id="count" onclick="this.dataset.n=(+this.dataset.n||0)+1;document.getElementById('out').textContent='clicked '+this.dataset.n">Count</button>
  <p id="out">clicked 0</p>
</form></body></html>`;

function serveTestPage() {
  const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(TEST_PAGE); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * A newline-delimited JSON-RPC client over the server's stdio. `cwd` is where the
 * server writes its snapshots and screenshots (.playwright-mcp/), kept out of the repo.
 */
function startMcp(command, args, cwd) {
  const win = process.platform === 'win32';
  // npx is a .cmd on Windows, which Node only starts through a shell.
  const child = spawn(win ? `${command} ${args.map((a) => `"${a}"`).join(' ')}` : command, win ? [] : args,
    { shell: win, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} timed out after ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
    waiting.set(id, (msg) => { clearTimeout(timer); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const stop = () => {
    try { child.stdin.end(); } catch { /* already closed */ }
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') {
      // The shell, npx, node and Camoufox are a tree; end all of it.
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    } else child.kill();
  };
  return { request, notify: (method, params) => send({ jsonrpc: '2.0', method, params }), stop, stderr: () => stderr };
}

const textOf = (result) => (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const refOf = (text, pattern) => text.split('\n').find((l) => pattern.test(l))?.match(/\[ref=([^\]]+)\]/)?.[1] ?? null;

/**
 * The page snapshot of a tool reply: inline, or (this MCP version) a file the reply
 * links to as "- [Snapshot](.playwright-mcp/page-....yml)", relative to the server's cwd.
 */
function snapshotOf(text, cwd) {
  const file = text.match(/\[Snapshot\]\(([^)]+\.yml)\)/)?.[1];
  if (!file) return text;
  try { return readFileSync(join(cwd, file), 'utf-8'); } catch { return text; }
}

async function trial(mode, server, testUrl) {
  const rows = [];
  const record = (step, ms, ok, note = '') => {
    rows.push({ step, ms, ok, note });
    console.log(`  ${mode.padEnd(8)} ${step.padEnd(26)} ${String(ms).padStart(7)} ms  ${ok ? 'ok' : 'FAIL'}${note ? `  ${note}` : ''}`);
  };
  const work = mkdtempSync(join(tmpdir(), 'fm-browser-trial-'));
  const configPath = join(work, 'config.json');
  writeFileSync(configPath, withHeadless(readFileSync(server.configPath, 'utf-8'), mode === 'headless', server.configPath));
  const mcp = startMcp(server.command, [...server.args, '--config', configPath, '--user-data-dir', join(work, 'profile')], work);
  const timed = async (step, fn) => {
    const t0 = performance.now();
    try {
      const value = await fn();
      const isError = value?.isError === true;
      return { value, ms: Math.round(performance.now() - t0), ok: !isError, note: isError ? textOf(value).split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ').slice(0, 160) : '' };
    } catch (err) {
      return { value: null, ms: Math.round(performance.now() - t0), ok: false, note: err.message.slice(0, 120) };
    }
  };
  const call = (name, args) => mcp.request('tools/call', { name, arguments: args });

  try {
    let r = await timed('server start', () => mcp.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fm-browser-trial', version: '1' },
    }));
    record('server start', r.ms, r.ok, r.note);
    if (!r.ok) return rows;
    mcp.notify('notifications/initialized', {});

    r = await timed('launch + first page', () => call('browser_navigate', { url: testUrl }));
    record('launch + first page', r.ms, r.ok, r.note);
    if (!r.ok) return rows;
    let page = snapshotOf(textOf(r.value), work);
    const button = refOf(page, /button "Count"/);
    const name = refOf(page, /textbox "Name"/);

    for (let i = 1; i <= CLICKS && button; i++) {
      r = await timed(`click ${i}`, () => call('browser_click', { element: 'Count button', target: button }));
      const counted = snapshotOf(textOf(r.value), work).includes(`clicked ${i}`);
      record(`click ${i}`, r.ms, r.ok && counted, r.ok && !counted ? 'page did not register the click' : r.note);
    }
    if (!button) record('click', 0, false, 'no Count button in the snapshot');
    if (name) {
      r = await timed('type 20 chars, slowly', () => call('browser_type', { element: 'Name field', target: name, text: 'Free Motion trial 01', slowly: true }));
      record('type 20 chars, slowly', r.ms, r.ok, r.note);
    }
    r = await timed('screenshot', () => call('browser_take_screenshot', { type: 'png' }));
    record('screenshot', r.ms, r.ok, r.note);

    for (const url of SITES) {
      const host = new URL(url).hostname.replace(/^www\./, '');
      r = await timed(`open ${host}`, () => call('browser_navigate', { url }));
      if (!r.ok && /NS_BINDING_ABORTED/.test(r.note)) {
        // The page before it rewrote its own URL as we left (free-work does), which
        // cancels the new load. Not the window's doing: once more, after a pause.
        record(`open ${host}`, r.ms, false, 'load cancelled by the page before it; once more');
        await new Promise((ok) => setTimeout(ok, 2000));
        r = await timed(`open ${host} (again)`, () => call('browser_navigate', { url }));
      }
      const reply = textOf(r.value);
      page = snapshotOf(reply, work);
      const wall = page.match(BOT_WALL)?.[0];
      const title = reply.match(/Page Title: (.*)/)?.[1]?.slice(0, 60) ?? '';
      record(`open ${host}`, r.ms, r.ok && !wall, wall ? `bot wall? "${wall}" | ${title}` : (r.note || title));
      // A failed load is often a page that reloads itself (NS_BINDING_ABORTED): look
      // again a few seconds later and record where the browser ended up.
      if (!r.ok) await new Promise((ok) => setTimeout(ok, 5000));
      r = await timed(`read ${host}`, () => call('browser_snapshot', {}));
      const after = textOf(r.value);
      const landed = after.match(/Page URL: (.*)/)?.[1] ?? '';
      const afterWall = snapshotOf(after, work).match(BOT_WALL)?.[0];
      record(`read ${host}`, r.ms, r.ok && !afterWall, r.note
        || `${snapshotOf(after, work).length} chars${afterWall ? `, bot wall? "${afterWall}"` : ''}${landed.includes(host) ? '' : `, on ${landed.slice(0, 80)}`}`);
    }
    r = await timed('close', () => call('browser_close', {}));
    record('close', r.ms, r.ok, r.note);
  } finally {
    mcp.stop();
    if (rows.some((x) => !x.ok) && mcp.stderr().trim()) console.log(`  server said: ${mcp.stderr().trim().split('\n').slice(-3).join(' | ')}`);
    // Camoufox can keep the profile locked for a moment after the tree is killed.
    for (let i = 0; i < 5; i++) {
      try { rmSync(work, { recursive: true, force: true }); break; } catch { await new Promise((ok) => setTimeout(ok, 1000)); }
    }
  }
  return rows;
}

const server = productionServer();
if (!existsSync(server.configPath)) { console.error(`${server.configPath} (from .mcp.json) not found`); process.exit(1); }
const http = await serveTestPage();
const testUrl = `http://127.0.0.1:${http.address().port}/`;
const date = new Date().toISOString();
mkdirSync(dirname(OUT), { recursive: true });
if (!existsSync(OUT)) writeFileSync(OUT, 'date\tmode\tstep\tms\tok\tnote\n');

const all = {};
for (const mode of MODE === 'both' ? ['headless', 'headful'] : [MODE]) {
  console.log(`\n${mode === 'headful' ? 'Visible' : 'Hidden'} window (${mode}):`);
  all[mode] = await trial(mode, server, testUrl);
  for (const r of all[mode]) {
    appendFileSync(OUT, `${date}\t${mode}\t${r.step}\t${r.ms}\t${r.ok ? 'ok' : 'fail'}\t${r.note.replace(/[\t\n]/g, ' ')}\n`);
  }
}
http.close();

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
console.log('\nSummary (median ms):');
for (const [mode, rows] of Object.entries(all)) {
  const by = (re) => median(rows.filter((r) => re.test(r.step) && r.ok).map((r) => r.ms));
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`  ${mode.padEnd(8)} launch+page ${by(/^launch/) ?? '-'} · click ${by(/^click/) ?? '-'} · type ${by(/^type/) ?? '-'} · site open ${by(/^open/) ?? '-'} · ${failed} failed of ${rows.length}`);
}
console.log(`\nRows appended to ${OUT}`);
