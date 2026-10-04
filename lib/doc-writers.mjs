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
// A writer that run.sh has marked out (tmp/fm/night/out/<name> holds the time it comes back) is skipped.

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { AGY_PROMPT, extractJson, writeWithAgy } from '../cv-write.mjs';

export const WRITER_ORDER = ['agy', 'codex', 'sonnet1', 'copilot'];
const STDIN_PROMPT = 'Everything below is the task. Reply with the JSON only: no prose, no code fences. Use no tool; read and write no file.\n\n';
const TIMEOUT_MS = 10 * 60_000;

/** Run a command line with `input` on standard input; resolves {code, out, err}. */
function pipe(cmdline, input, { cwd, env } = {}) {
  return new Promise((res) => {
    const p = spawn(cmdline, { cwd, env: { ...process.env, ...env }, shell: true, timeout: TIMEOUT_MS });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => res({ code: -1, out, err: String(e.message) }));
    p.on('close', (code) => res({ code, out, err }));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

async function writeWithCodex(context) {
  const work = mkdtempSync(join(tmpdir(), 'doc-write-'));
  const reply = join(work, 'reply.txt');
  const t0 = Date.now();
  const r = await pipe(`codex exec --skip-git-repo-check -C "${work}" -o "${reply}" -`, STDIN_PROMPT + context, { cwd: work });
  if (!existsSync(reply)) throw new Error(`codex gave no reply (exit ${r.code}): ${(r.err || r.out).trim().slice(-300)}`);
  return { payload: extractJson(readFileSync(reply, 'utf8')), usage: {}, seconds: Math.round((Date.now() - t0) / 1000) };
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

export const WRITERS = { agy: writeWithAgy, codex: writeWithCodex, sonnet1: writeWithSonnet1, copilot: writeWithCopilot };

/** Is this writer marked out by run.sh right now? */
export function isOut(name, root, now = Date.now()) {
  try { return Number(readFileSync(join(root, 'tmp/fm/night/out', name), 'utf8').trim()) * 1000 > now; } catch { return false; }
}

/**
 * The order to try: `first` (the driver about to run the job) leads when it is a writer.
 * @param {{first?: string, order?: string[]}} [o]
 */
export function writerOrder({ first, order = WRITER_ORDER } = {}) {
  const lead = first === 'agy-sonnet' ? 'agy' : first;
  return order.includes(lead) ? [lead, ...order.filter((n) => n !== lead)] : [...order];
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
        return res;
      } catch (e) {
        write.errors.push(`${name}: ${String(e.message).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    throw new Error(`no writer answered (${write.errors.slice(-names.length).join('; ')})`);
  };
  write.used = [];
  write.errors = [];
  return write;
}
