// lib/doc-writers.mjs — who writes a CV payload or a letter from one pasted context.
//
// cv-write.mjs and letter-write.mjs build ONE context and hand it to a writer that answers with JSON.
// The writer was always agy; in a night run agy is often out of quota for hours while the applying goes
// on with codex or the second Claude account, and every job in that stretch would fall back to the
// generic CV and no letter. So a night run tries the writers in order until one answers:
//   agy       reads context.md in a fresh temp folder (cv-write.mjs's writeWithAgy)
//   codex     gets the context on standard input (codex exec -), no file access needed
//   sonnet1   claude -p --model sonnet on the second Claude account, context on standard input
//   copilot   copilot -p, reads context.md in a fresh temp folder (its prompt cannot come from a pipe)
//   gemini-web, chatgpt-web  the Gemini and ChatGPT websites on the user's own accounts (#59), through
//             lib/web-llm.py: context on standard input, the answer on standard output. They run first (ChatGPT, then Gemini),
//             so the drivers' allowances go to the applying. A site at its limit is marked out for
//             WEB_OUT_HOURS; a signed-out site for a day, with a note in data/agent-inbox.md to sign in again.
// A writer that run.sh has marked out (tmp/fm/night/out/<name> holds the time it comes back) is skipped.

import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AGY_PROMPT, extractJson, writeWithAgy } from '../cv-write.mjs';

// ChatGPT first for all writing (user, 2026-10-15), the Gemini website next (#59), then codex, whichever
// driver runs the job (user, 2026-10-13).
export const WRITER_ORDER = ['chatgpt-web', 'gemini-web', 'codex', 'agy', 'sonnet1', 'copilot'];
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const STDIN_PROMPT = 'Everything below is the task. Reply with the JSON only: no prose, no code fences. Use no tool; read and write no file.\n\n';
const TIMEOUT_MS = 10 * 60_000;

/** End a process and everything it started: on Windows killing the shell leaves its children running. */
function killTree(p) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { windowsHide: true });
    else p.kill('SIGKILL');
  } catch { /* already gone */ }
}

/** Run a command line with `input` on standard input; resolves {code, out, err}, code -2 after TIMEOUT_MS. */
export function pipe(cmdline, input, { cwd, env, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((res) => {
    // spawn's own `timeout` kills only the shell; a website call then held the pipes open for 6 hours
    // (2026-10-23) and the whole round waited. So: our own timer, the whole tree, and no wait for 'close'.
    const p = spawn(cmdline, { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); res(r); } };
    const timer = setTimeout(() => {
      killTree(p);
      done({ code: -2, out, err: `${err}\ntimed out after ${Math.round(timeoutMs / 60_000)} min` });
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => done({ code: -1, out, err: String(e.message) }));
    p.on('close', (code) => done({ code, out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** Token use summed over a `codex exec --json` event stream (turn.completed events). */
export function codexEventUsage(jsonl) {
  const u = { input_tokens: 0, output_tokens: 0 };
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.includes('"turn.completed"')) continue;
    try { const x = JSON.parse(line).usage ?? {}; u.input_tokens += x.input_tokens ?? 0; u.output_tokens += (x.output_tokens ?? 0) + (x.reasoning_output_tokens ?? 0); } catch { /* torn line */ }
  }
  return u;
}

async function writeWithCodex(context) {
  const work = mkdtempSync(join(tmpdir(), 'doc-write-'));
  const reply = join(work, 'reply.txt');
  const t0 = Date.now();
  // --json: the events on stdout carry each turn's token use (#7); the reply is still in -o.
  const r = await pipe(`codex exec --json --skip-git-repo-check -C "${work}" -o "${reply}" -`, STDIN_PROMPT + context, { cwd: work });
  if (!existsSync(reply)) throw new Error(`codex gave no reply (exit ${r.code}): ${(r.err || r.out).trim().slice(-300)}`);
  return { payload: extractJson(readFileSync(reply, 'utf8')), usage: codexEventUsage(r.out), seconds: Math.round((Date.now() - t0) / 1000) };
}

/** The second Claude account's folder, the one no watching session uses (same rule as run.sh). */
export function secondClaudeDir(env = process.env) {
  if (env.CLAUDE1_DIR) return env.CLAUDE1_DIR;
  const onAccount1 = /[/\\]\.claude-account1[/\\]?$/.test(env.CLAUDE_CONFIG_DIR || '');
  return join(homedir(), onAccount1 ? '.claude-account2' : '.claude-account1');
}

async function writeWithSonnet1(context) {
  const work = mkdtempSync(join(tmpdir(), 'doc-write-'));
  const t0 = Date.now();
  const r = await pipe('claude -p --model sonnet --output-format json', STDIN_PROMPT + context, { cwd: work, env: { CLAUDE_CONFIG_DIR: secondClaudeDir() } });
  let j;
  try { j = JSON.parse(r.out); } catch { throw new Error(`claude gave no JSON result (exit ${r.code}): ${(r.err || r.out).trim().slice(-300)}`); }
  if (j.is_error) throw new Error(`claude: ${String(j.result).slice(0, 300)}`);
  const u = j.usage || {};
  return { payload: extractJson(j.result), usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens }, seconds: Math.round((Date.now() - t0) / 1000) };
}

async function writeWithCopilot(context) {
  const work = mkdtempSync(join(tmpdir(), 'doc-write-'));
  writeFileSync(join(work, 'context.md'), context);
  const t0 = Date.now();
  // AGY_PROMPT holds no quote and no shell character, so it goes on the command line as it is.
  const r = await pipe(`copilot -p "${AGY_PROMPT}" --allow-all-tools --no-ask-user --no-color -s`, '', { cwd: work });
  let payload;
  try { payload = extractJson(r.out); } catch { throw new Error(`copilot gave no JSON (exit ${r.code}): ${(r.err || r.out).trim().slice(-300)}`); }
  return { payload, usage: {}, seconds: Math.round((Date.now() - t0) / 1000) };
}

// A website that does not answer in WEB_TIMEOUT_MS sits out an hour, so it does not cost every job the wait.
// One that fails ERRORS_IN_A_ROW times in a row for any other reason sits out an hour too.
const WEB_OUT_HOURS = { limit: 3, signedOut: 24, timeout: 1, errors: 1 };
const ERRORS_IN_A_ROW = 3;
const WEB_TIMEOUT_MS = 5 * 60_000;

/** Mark a writer out until `hours` from now, the way run.sh marks a driver out. */
export function markOut(name, hours, root = REPO, now = Date.now()) {
  const dir = join(root, 'tmp/fm/night/out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), String(Math.round(now / 1000 + hours * 3600)));
}

/** One open agent-inbox item per signed-out site. */
function askToSignIn(site, root = REPO) {
  const key = `web-llm: ${site} is signed out`;
  const path = join(root, 'data/agent-inbox.md');
  const open = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- [ ]')) : [];
  if (open.some((l) => l.includes(key))) return;
  spawnSync(process.execPath, [join(root, 'agent-inbox.mjs'), 'add', `${key}: run \`python lib/web-llm.py signin\`, sign in, close the window`], { cwd: root });
}

// Every website call, one line each, so "how often do we hit the limits" has an answer (user, 2026-10-23):
// data/web-llm-events.tsv, at · site · result (ok | limit | signed-out | error | no-json) · seconds · detail.
// A failure is also told the user by email, at most once per site every ALERT_HOURS (night-mail.py --alert):
// a later writer answering used to hide a dead site for days.
export const WEB_EVENTS = 'data/web-llm-events.tsv';
const WEB_EVENTS_HEADER = 'at\tsite\tresult\tseconds\tdetail\n';
export const ALERT_HOURS = 6;

/** Append one website call to data/web-llm-events.tsv. */
export function logWebEvent(root, site, result, seconds, detail = '') {
  try {
    const path = join(root, WEB_EVENTS);
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, WEB_EVENTS_HEADER);
    appendFileSync(path, [new Date().toISOString(), site, result, seconds, String(detail).replace(/\s+/g, ' ').slice(0, 300)].join('\t') + '\n');
  } catch { /* the log never stops a CV */ }
}

/** How many of this site's latest calls failed in a row (data/web-llm-events.tsv). */
export function failsInARow(root, site) {
  let lines = [];
  try { lines = readFileSync(join(root, WEB_EVENTS), 'utf8').trim().split(/\r?\n/).slice(-200); } catch { return 0; }
  let n = 0;
  for (const l of lines.reverse()) {
    const [, s, result] = l.split('\t');
    if (s !== site) continue;
    if (result === 'ok') break;
    n++;
  }
  return n;
}

/** Email the user through night-mail.py --alert, unless this site was already reported in the last ALERT_HOURS. */
export function alertOnce(root, site, subject, body, { send = mailAlert, now = Date.now() } = {}) {
  const stamp = join(root, 'tmp/fm/night/alerts', site);
  try { if (now - Number(readFileSync(stamp, 'utf8')) < ALERT_HOURS * 3600e3) return false; } catch { /* never reported */ }
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, String(now));
  send(root, subject, body);
  return true;
}

/** Hand the email to night-mail.py in the background: its retries must not hold up the job. */
function mailAlert(root, subject, body) {
  const script = join(root, 'freemotion-night/night-mail.py');
  if (!existsSync(script)) return;
  try {
    const p = spawn(process.env.PYTHON || 'python', [script, '--alert', subject], { cwd: root, detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.on('error', () => {});
    p.stdin.end(body);
    p.unref();
  } catch { /* no email is no reason to fail the CV */ }
}

const WHAT_TO_DO = {
  limit: `It is marked out for ${WEB_OUT_HOURS.limit} h; the next writer in line writes meanwhile.`,
  'signed-out': `Sign in again: python lib/web-llm.py signin (a window opens; sign in, close it). Marked out for ${WEB_OUT_HOURS.signedOut} h.`,
  timeout: `It gave no answer in ${WEB_TIMEOUT_MS / 60_000} min and was stopped; marked out for ${WEB_OUT_HOURS.timeout} h. Check it with: python lib/web-llm.py check`,
  error: `After ${ERRORS_IN_A_ROW} failures in a row it is marked out for ${WEB_OUT_HOURS.errors} h; before that it is asked again on the next job. Check it with: python lib/web-llm.py check`,
  'no-json': 'It answered twice with broken JSON. It is asked again on the next job.',
};

/** A writer for one website: exit 0 answered, 2 signed out, 3 limit reached (lib/web-llm.py). */
export function webWriter(site, { run = pipe, root = REPO, alert = alertOnce } = {}) {
  const name = `${site}-web`;
  const failed = (result, why, t0) => {
    const seconds = Math.round((Date.now() - t0) / 1000);
    logWebEvent(root, site, result, seconds, why);
    console.error(`web-llm: ${name} ${result} after ${seconds} s: ${why}`);
    alert(root, name, `FM: ${name} failed (${result})`,
      `The ${site} website did not write a CV or letter (${new Date().toString().slice(0, 21)}).\n\n` +
      `Result: ${result}, after ${seconds} s\nWhat it said: ${why}\n\n${WHAT_TO_DO[result]}\n\n` +
      `Every call is in ${WEB_EVENTS}. No other email about ${name} for ${ALERT_HOURS} h.`);
    return new Error(why);
  };
  return async (context) => {
    const t0 = Date.now();
    // A website now and then answers with broken JSON (quotes dropped): one more try before the next writer.
    for (let attempt = 1; ; attempt++) {
      const r = await run(`${process.env.PYTHON || 'python'} "${join(root, 'lib/web-llm.py')}" ask ${site}`, STDIN_PROMPT + context, { cwd: root, env: { PYTHONIOENCODING: 'utf-8' }, timeoutMs: WEB_TIMEOUT_MS });
      const why = (r.err || r.out).trim().split('\n').pop()?.slice(-300) || `exit ${r.code}`;
      if (r.code === -2) { markOut(name, WEB_OUT_HOURS.timeout, root); throw failed('timeout', why, t0); }
      if (r.code === 3) { markOut(name, WEB_OUT_HOURS.limit, root); throw failed('limit', why, t0); }
      if (r.code === 2) { markOut(name, WEB_OUT_HOURS.signedOut, root); askToSignIn(site, root); throw failed('signed-out', why, t0); }
      if (r.code !== 0) {
        const err = failed('error', why, t0);
        if (failsInARow(root, site) >= ERRORS_IN_A_ROW) markOut(name, WEB_OUT_HOURS.errors, root);
        throw err;
      }
      try {
        const payload = extractJson(r.out);
        logWebEvent(root, site, 'ok', Math.round((Date.now() - t0) / 1000), attempt > 1 ? 'second try' : '');
        return { payload, usage: {}, seconds: Math.round((Date.now() - t0) / 1000) };
      } catch {
        if (attempt >= 2) throw failed('no-json', `${name} gave no JSON: ${r.out.trim().slice(0, 200)}`, t0);
      }
    }
  };
}

export const WRITERS = {
  agy: writeWithAgy, codex: writeWithCodex, sonnet1: writeWithSonnet1, copilot: writeWithCopilot,
  'gemini-web': webWriter('gemini'), 'chatgpt-web': webWriter('chatgpt'),
};

/** Is this writer marked out by run.sh right now? */
export function isOut(name, root, now = Date.now()) {
  try { return Number(readFileSync(join(root, 'tmp/fm/night/out', name), 'utf8').trim()) * 1000 > now; } catch { return false; }
}

/**
 * A `write(context)` that tries each writer in turn and remembers who answered.
 * @param {{names: string[], writers?: object, skip?: (name: string) => boolean}} o
 * @returns {((context: string) => Promise<object>) & {used: string[], errors: string[]}}
 */
export function chainWriter({ names, writers = WRITERS, skip = () => false }) {
  const write = async (context) => {
    for (const name of names) {
      if (skip(name)) { write.errors.push(`${name}: out of quota`); continue; }
      try {
        const res = await writers[name](context);
        write.used.push(name);
        // Tokens per writer for the cost per sent application (#7): every count the writer reported.
        const n = Object.values(res?.usage || {}).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0);
        write.tokens[name] = (write.tokens[name] || 0) + n;
        return res;
      } catch (e) {
        write.errors.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    throw new Error(`no writer answered (${write.errors.slice(-names.length).join('; ')})`);
  };
  write.used = [];
  write.errors = [];
  write.tokens = {};
  return write;
}
