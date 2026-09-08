#!/usr/bin/env node

/**
 * freemotion-log.mjs — the append-only record of what Free Motion said on the
 * candidate's behalf.
 *
 * At tens of applications per hour, this file is the ONLY way the user learns
 * what was written into forms under their name. A run that submitted nothing
 * and says nothing happened is indistinguishable from one that silently
 * failed; a run that answered forty screening questions and recorded none of
 * them is worse, because it looks fine. So every filled field gets one line,
 * whichever tier produced it, with the SOURCE that produced it
 * (`profile` / `fallback` / `entailed` / `inferred`) — the accountability
 * mechanism the requirements brief asks for.
 *
 * `inferred` additionally carries agy's own one-line reasoning, because that
 * is the only source where no rule or file can be pointed at afterwards: it is
 * the model choosing the most probable answer for this candidate, and the
 * reasoning is the entire audit trail for that choice.
 *
 * JSONL, not JSON. A crashed run must leave a readable log: appending a line
 * needs no read-modify-write and no closing bracket, so the file is valid
 * after every single write. {@link readRunLog} tolerates a torn final line for
 * the same reason — a post-hoc audit of a crash is exactly when the log
 * matters most, and that is exactly when the last line is half-written.
 *
 * NOT LOCKED, on purpose. One `agy` process owns one `runId`; concurrent runs
 * use distinct `runId`s and therefore distinct files, so there is no
 * cross-writer contention to guard against. Adding a lock here would buy
 * nothing and cost a lock acquisition per field on the hottest path in the
 * system.
 *
 * Sized as one non-functional requirement among several (§4.8): an append and
 * a read-back, no query layer, no index, no review tooling. Searching it is
 * grep's job.
 *
 * Usage:
 *   node lib/freemotion-log.mjs append --run-id ID --event answer \
 *        [--ref e42] [--question "..."] [--value "..."] [--source inferred] \
 *        [--reasoning "..."] [--url <u>] [--detail "..."] [--root <path>]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import { flagValue, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** Directory holding per-run logs, relative to the data root. */
export const RUN_LOG_RELATIVE_DIR = 'data/freemotion-runs';

/**
 * Where an answer came from.
 *
 * The four are ordered by how much of the answer the candidate actually
 * authored, most to least — which is also the order the resolver tries them
 * in (§1.3). `inferred` is last because it is the only one nobody wrote down
 * in advance.
 */
export const ANSWER_SOURCES = ['profile', 'fallback', 'entailed', 'inferred'];

/**
 * One logged event.
 *
 * @typedef {Object} LogEntry
 * @property {string} ts - ISO 8601, added by {@link appendLogEntry}.
 * @property {string} event - `'answer'` | `'submitted'` | `'outcome'`, or any
 *   free-form label. Not a closed set: the log records, it does not police.
 * @property {string} [ref] - MCP element ref the value went into.
 * @property {string} [question] - The question as the form asked it.
 * @property {string} [value] - The answer as written into the form.
 * @property {'profile'|'fallback'|'entailed'|'inferred'} [source]
 * @property {string} [reasoning] - Required when `source === 'inferred'`.
 * @property {string} [url]
 * @property {string} [detail]
 */

/**
 * Absolute path of one run's log.
 *
 * The `runId` is used as a filename, so anything that could escape the
 * directory (a separator, a parent reference, a drive letter) is folded to
 * `-`. A caller-supplied id reaching the filesystem verbatim is how an audit
 * log ends up written outside `data/`.
 *
 * @param {string} runId
 * @param {{root?: string}} [options]
 * @returns {string}
 */
export function runLogPath(runId, { root } = {}) {
  const safe = String(runId ?? '').replace(/[^A-Za-z0-9._-]/g, '-') || 'unknown-run';
  const base = root ?? getCareerOpsRoot();
  const dir = isAbsolute(RUN_LOG_RELATIVE_DIR) ? RUN_LOG_RELATIVE_DIR : join(base, RUN_LOG_RELATIVE_DIR);
  return join(dir, `${safe}.jsonl`);
}

/**
 * Append one entry to a run's log, creating the directory if needed.
 *
 * `ts` is stamped here rather than accepted from the caller, so the log's
 * ordering reflects when things happened rather than what a caller claimed.
 *
 * @param {string} runId
 * @param {LogEntry} entry - `ts` is ignored if supplied.
 * @param {{root?: string}} [options]
 * @returns {string} The path written to, so a caller can report it.
 */
export function appendLogEntry(runId, entry, { root } = {}) {
  const path = runLogPath(runId, { root });
  mkdirSync(join(path, '..'), { recursive: true });
  // A caller-supplied `ts` is DISCARDED, not merged: spreading `entry` over the
  // stamp would let a caller date its own entries, and the ordering of this log
  // is the only evidence of what happened before what. Destructured out first
  // so the stamp still sorts to the front of each line for a human reading it.
  const { ts: _callerSupplied, ...rest } = entry ?? {};
  const record = { ts: new Date().toISOString(), ...rest };
  // A newline inside a value would split one entry into two lines, the second
  // of which is not JSON — turning a logged answer into a parse warning.
  // JSON.stringify escapes them, so this is safe by construction; the
  // assertion is that nothing else writes to this file.
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  return path;
}

/**
 * Read a run's log back.
 *
 * A malformed line — the torn last write of a killed process — is collected
 * into `warnings` rather than thrown on. Throwing would make the log
 * unreadable in precisely the case it was written for.
 *
 * @param {string} runId
 * @param {{root?: string}} [options]
 * @returns {{entries: LogEntry[], warnings: string[]}} A missing log is
 *   `{entries: [], warnings: []}`, not an error.
 */
export function readRunLog(runId, { root } = {}) {
  const path = runLogPath(runId, { root });
  if (!existsSync(path)) return { entries: [], warnings: [] };

  const entries = [];
  const warnings = [];
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    return { entries: [], warnings: [`unreadable log ${path}: ${err.message}`] };
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    try {
      entries.push(JSON.parse(line));
    } catch {
      warnings.push(`line ${idx + 1}: unparseable JSON (${line.length} chars)`);
    }
  });
  return { entries, warnings };
}

const USAGE = `Usage:
  node lib/freemotion-log.mjs append --run-id ID --event <event> [options]

Options:
  --ref <ref>          MCP element ref the value went into
  --question "<text>"  the question as the form asked it
  --value "<text>"     the answer written into the form
  --source <s>         one of: ${ANSWER_SOURCES.join(', ')}
  --reasoning "<text>" required when --source inferred
  --url <url>          posting URL
  --detail "<text>"    free-form note
  --root <path>        data root override (tests)`;

const VALUE_FLAGS = ['--run-id', '--event', '--ref', '--question', '--value', '--source', '--reasoning', '--url', '--detail', '--root'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

/**
 * CLI entry: `append`.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const flags = command ? argv.slice(1) : argv;
  validateFlags(flags, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  if (command !== 'append') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const runId = flagValue(flags, '--run-id');
  const event = flagValue(flags, '--event');
  if (!runId || !event) {
    console.error('append requires --run-id and --event');
    process.exitCode = 1;
    return;
  }

  const source = flagValue(flags, '--source');
  const reasoning = flagValue(flags, '--reasoning');
  // The one validated rule. An `inferred` answer with no reasoning is a value
  // written under the candidate's name that nothing on disk explains — the
  // exact gap this log exists to close, so it is refused rather than logged
  // incomplete.
  if (source === 'inferred' && !reasoning) {
    console.error('--source inferred requires --reasoning');
    process.exitCode = 1;
    return;
  }
  if (source !== undefined && !ANSWER_SOURCES.includes(source)) {
    console.error(`unknown --source "${source}" — valid: ${ANSWER_SOURCES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const entry = { event };
  for (const [flag, key] of [['--ref', 'ref'], ['--question', 'question'], ['--value', 'value'],
    ['--source', 'source'], ['--reasoning', 'reasoning'], ['--url', 'url'], ['--detail', 'detail']]) {
    const v = flagValue(flags, flag);
    if (v !== undefined) entry[key] = v;
  }

  const path = appendLogEntry(runId, entry, { root: flagValue(flags, '--root') });
  console.log(JSON.stringify({ ok: true, path }, null, 2));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
