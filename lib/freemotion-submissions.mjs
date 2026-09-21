#!/usr/bin/env node

/**
 * freemotion-submissions.mjs — the durable, URL-keyed record of what Free
 * Motion has already applied to. Requirement 8: never submit twice for the
 * same posting.
 *
 * WHY A LEDGER AND NOT A TABLE. Rows are appended, never edited: a claim and
 * its later resolution are two separate rows sharing a `url_key`, and readers
 * fold to the LAST row per key. Same contract as `data/status-log.tsv`. An
 * in-place table would need a read-modify-write per event, which is the
 * operation that loses data when a run is killed mid-write — and this file is
 * the only thing standing between a restarted run and a second application to
 * an employer who already has one.
 *
 * WHY THE CLAIM IS THE GATE, NOT THE FINALIZE. `claimSubmission` runs BEFORE
 * any browser interaction and does read-decide-append inside ONE lock
 * acquisition. Checking a ledger and then appending to it as two separate
 * locked steps leaves exactly the window Requirement 8 exists to close: two
 * workers both read "not present", both conclude they may proceed, and the
 * employer gets two applications. `finalizeSubmission` afterwards only records
 * history and deliberately re-checks nothing.
 *
 * WHY ONLY `submitted` BLOCKS FOREVER. A posting that ended in
 * `validation-failed`, `captcha`, `blocked-waf`, `errored`, or
 * `account-verification-pending` was never sent to the employer, so a later
 * run SHOULD retry it — the whole point of recording six distinct outcomes
 * (§1.1) rather than a boolean. Only `submitted` is permanent. And an
 * `in-progress` row blocks only until it goes stale
 * ({@link IN_PROGRESS_STALE_MS}), because a run killed by Ctrl-C leaves its
 * claim behind and a claim nothing can ever release is a posting nothing can
 * ever apply to.
 *
 * NO KEY IS NOT A KEY. `normalizeUrl` returns `''` for anything that is not a
 * usable http(s) posting URL. Such a row is never written: a ledger keyed on
 * the empty string would collapse every unkeyable posting into one entry and
 * report the second one as a duplicate of the first. The claim is refused
 * with `reason: 'unkeyable'` instead, which the caller reports rather than
 * silently treating as "already done".
 *
 * Reuses `normalizeUrl` (url-key.mjs) and `withPipelineLock`
 * (pipeline-lock.mjs) rather than restating either. `followup-seed.mjs`
 * hand-rolled the lock protocol a second time; this is deliberately not the
 * third copy.
 *
 * Usage:
 *   node lib/freemotion-submissions.mjs claim --url <u> --run-id <id> \
 *        --company <c> --role <r> [--report N] [--log <path>]
 *   node lib/freemotion-submissions.mjs finalize --url <u> --outcome <o> \
 *        --run-id <id> [--report N] [--notes "..."] [--log <path>]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';

import { flagValue, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import normalizeUrl from '../url-key.mjs';

/** Path of the ledger relative to the data root. */
export const SUBMISSIONS_LOG_RELATIVE_PATH = 'data/freemotion-submissions.tsv';

/**
 * Every outcome a posting attempt can end in (§1.1). `in-progress` is the
 * claim itself; the other six are terminal for that attempt.
 *
 * A closed set on purpose: an unrecognized outcome written by a future caller
 * would fold into the ledger as a state no reader knows how to interpret, and
 * the one reader that matters decides whether to re-apply to an employer.
 */
export const VALID_OUTCOMES = [
  'in-progress',
  'submitted',
  'validation-failed',
  'captcha',
  'blocked-waf',
  'account-verification-pending',
  'errored',
  // Added 2026-09-07 after a live run had to record two things the original
  // seven could not say honestly, and both landed in buckets that mean
  // "something went wrong" when nothing did:
  //
  //   already-applied — the EMPLOYER refused the attempt before the form was
  //     ever completed. One tenant dedupes by candidate email across
  //     requisitions and jumps straight to its thank-you page with
  //     `status=alreadyApplied` and no application id. The run worked
  //     perfectly; there is simply nothing to submit. Recorded as `errored`
  //     this looks like a bug to fix, and it is not.
  //
  //   rehearsal — a deliberate no-submit dry run: the form was filled to the
  //     end and stopped on purpose. Recorded as `validation-failed` (the
  //     previous convention) it inflates the failure rate with runs that
  //     succeeded at exactly what they set out to do.
  //
  // Neither bars a later real attempt — see TERMINAL_SUCCESS, which stays
  // `submitted` alone. A rehearsal is meant to be re-attempted for real, and
  // an already-applied posting may open a second requisition later.
  'already-applied',
  'rehearsal',
  // Added 2026-09-20 for Requirement 5. A submit whose page says NEITHER a
  // success phrase nor a refusal has an honest answer, and it is not one of
  // the others: the click landed, nothing is known to be broken, and whether
  // the employer has it is genuinely undetermined until the inbox is checked.
  // Recording it as `submitted` invents a success; recording it as `errored`
  // invents a fault and invites a re-attempt, which is how one candidate
  // applies twice. It is deliberately NOT terminal, so a later run may resolve
  // it — but the run that produced it must never click Submit again.
  'unknown',
];

/** Outcomes that permanently bar a re-attempt. */
const TERMINAL_SUCCESS = 'submitted';

/**
 * How long an `in-progress` claim is honoured before another run may take the
 * posting.
 *
 * 30 minutes is far longer than any single posting should take (the whole
 * throughput target is tens per hour) and short enough that a crashed run does
 * not strand a posting for the rest of the day.
 */
export const IN_PROGRESS_STALE_MS = 30 * 60_000;

const HEADER = ['url_key', 'raw_url', 'company', 'role', 'report_num', 'outcome', 'timestamp', 'run_id', 'notes'];

/**
 * One folded row: the current state of one posting.
 *
 * @typedef {Object} SubmissionRow
 * @property {string} urlKey
 * @property {string} rawUrl
 * @property {string} company
 * @property {string} role
 * @property {number|null} reportNum - `null` for an ad-hoc `--url` run.
 * @property {string} outcome - One of {@link VALID_OUTCOMES}.
 * @property {string} timestamp - ISO 8601.
 * @property {string} runId
 * @property {string} notes
 */

/**
 * Absolute path of the ledger.
 *
 * @param {{logPath?: string, root?: string}} [options] - `logPath` wins and is
 *   resolved against `root` when relative, so a test can hand in a temp path
 *   and never touch the real `data/`.
 * @returns {string}
 */
export function submissionsLogPath({ logPath, root } = {}) {
  const base = root ?? getCareerOpsRoot();
  if (logPath) return isAbsolute(logPath) ? logPath : join(base, logPath);
  return join(base, SUBMISSIONS_LOG_RELATIVE_PATH);
}

/**
 * Flatten a value into one TSV cell.
 *
 * Tabs and newlines are the column and row separators, so a note containing
 * either would silently shift every later column of that row — and the column
 * that shifts is `outcome`. Collapsing whitespace is lossy for the notes
 * field and exactly right for every other one.
 *
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Read the ledger and fold it to one current row per `url_key`.
 *
 * Unlocked, and deliberately so: this is the same read-then-locked-write shape
 * `merge-tracker.mjs` uses. The authoritative decision happens inside
 * {@link claimSubmission}'s lock, so a stale read here can only ever cost a
 * caller an extra lock acquisition, never a duplicate application.
 *
 * A missing file is an empty ledger, not an error — the first run of a fresh
 * checkout must not have to create it first.
 *
 * @param {{logPath?: string, root?: string}} [options]
 * @returns {Map<string, SubmissionRow>} Keyed by `url_key`, last row winning.
 */
export function readCurrentState({ logPath, root } = {}) {
  const path = submissionsLogPath({ logPath, root });
  const state = new Map();
  if (!existsSync(path)) return state;

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    // Unreadable is not the same as empty, but there is nothing better to
    // return, and the caller's claim will still be gated by the lock below.
    return state;
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    // The header, and any row too short to carry an outcome, tell us nothing.
    if (parts[0] === HEADER[0] || parts.length < HEADER.length) continue;
    const [urlKey, rawUrl, company, role, reportNum, outcome, timestamp, runId, ...rest] = parts;
    if (!urlKey) continue;
    state.set(urlKey, {
      urlKey,
      rawUrl,
      company,
      role,
      reportNum: /^\d+$/.test(reportNum) ? Number(reportNum) : null,
      outcome,
      timestamp,
      runId,
      notes: rest.join(' '),
    });
  }
  return state;
}

/**
 * Append one row, creating the file (and `data/`) with its header if absent.
 *
 * Always called from inside the lock.
 *
 * @param {string} path - Absolute ledger path.
 * @param {SubmissionRow} row
 * @returns {void}
 */
function appendRow(path, row) {
  const fresh = !existsSync(path);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const line = [
    row.urlKey, row.rawUrl, row.company, row.role,
    row.reportNum === null || row.reportNum === undefined ? '-' : row.reportNum,
    row.outcome, row.timestamp, row.runId, row.notes,
  ].map(cell).join('\t');
  appendFileSync(path, `${fresh ? `${HEADER.join('\t')}\n` : ''}${line}\n`, 'utf-8');
}

/**
 * Claim a posting for this run, or explain why it may not be attempted.
 *
 * MUST be called before any browser interaction with the posting. Read,
 * decide and append all happen inside one lock acquisition — see the header
 * note on why splitting them reintroduces the duplicate-application race.
 *
 * @param {string} url - Raw posting URL.
 * @param {{runId: string, company: string, role: string, reportNum: number|null,
 *          logPath?: string, root?: string, now?: number}} meta - `now` is an
 *   injection point for the staleness test; production never passes it.
 * @returns {Promise<{claimed: true, urlKey: string}
 *   | {claimed: false, reason: 'already-submitted'|'in-progress'|'unkeyable', priorRow?: SubmissionRow}>}
 */
export async function claimSubmission(url, meta) {
  const { runId, company, role, reportNum, logPath, root, now } = meta ?? {};
  const urlKey = normalizeUrl(url);
  if (urlKey === '') return { claimed: false, reason: 'unkeyable' };

  const path = submissionsLogPath({ logPath, root });
  const at = now ?? Date.now();

  return withPipelineLock(path, async () => {
    const prior = readCurrentState({ logPath: path }).get(urlKey);

    if (prior && prior.outcome === TERMINAL_SUCCESS) {
      return { claimed: false, reason: 'already-submitted', priorRow: prior };
    }
    if (prior && prior.outcome === 'in-progress') {
      // A claim whose owning process died must eventually be reclaimable, or
      // one Ctrl-C strands the posting permanently.
      const startedAt = Date.parse(prior.timestamp);
      const fresh = Number.isFinite(startedAt) && at - startedAt < IN_PROGRESS_STALE_MS;
      if (fresh) return { claimed: false, reason: 'in-progress', priorRow: prior };
    }

    appendRow(path, {
      urlKey,
      rawUrl: url,
      company: company ?? '',
      role: role ?? '',
      reportNum: reportNum ?? null,
      outcome: 'in-progress',
      timestamp: new Date(at).toISOString(),
      runId: runId ?? '',
      notes: prior ? `reclaimed after ${prior.outcome}` : '',
    });
    return { claimed: true, urlKey };
  });
}

/**
 * Record how a claimed posting ended.
 *
 * Does NOT re-check dedup: that already happened in {@link claimSubmission},
 * and a finalize that could refuse to write would lose the record of what the
 * run actually did — the outcome the audit trail is for.
 *
 * @param {string} url - Raw posting URL, the same one that was claimed.
 * @param {'submitted'|'validation-failed'|'captcha'|'blocked-waf'|'account-verification-pending'|'errored'} outcome
 * @param {{runId: string, reportNum?: number|null, notes?: string, company?: string,
 *          role?: string, logPath?: string, root?: string}} meta
 * @returns {Promise<void>}
 * @throws {Error} When `outcome` is not in {@link VALID_OUTCOMES}, or the URL
 *   is unkeyable — both are caller bugs, and a silently-dropped finalize would
 *   leave an `in-progress` row that later reads as a live claim.
 */
export async function finalizeSubmission(url, outcome, meta) {
  const { runId, reportNum, notes, company, role, logPath, root } = meta ?? {};
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`unknown outcome "${outcome}" — valid: ${VALID_OUTCOMES.join(', ')}`);
  }
  const urlKey = normalizeUrl(url);
  if (urlKey === '') throw new Error(`cannot finalize an unkeyable URL: ${url}`);

  const path = submissionsLogPath({ logPath, root });
  await withPipelineLock(path, async () => {
    const prior = readCurrentState({ logPath: path }).get(urlKey);
    appendRow(path, {
      urlKey,
      rawUrl: url,
      // Carry the claim's own company/role forward when the caller does not
      // repeat them, so a folded row is self-describing whichever event is last.
      company: company ?? prior?.company ?? '',
      role: role ?? prior?.role ?? '',
      reportNum: reportNum ?? prior?.reportNum ?? null,
      outcome,
      timestamp: new Date().toISOString(),
      runId: runId ?? '',
      notes: notes ?? '',
    });
  });
}

const USAGE = `Usage:
  node lib/freemotion-submissions.mjs claim --url <u> --run-id <id> --company <c> --role <r> [--report N] [--log <path>]
  node lib/freemotion-submissions.mjs finalize --url <u> --outcome <o> --run-id <id> [--report N] [--notes "..."] [--log <path>]

Outcomes: ${VALID_OUTCOMES.join(', ')}

Exit codes:
  0  claim granted / finalize written
  1  usage error
  3  claim refused (already-submitted, in-progress, unkeyable) — not an error;
     move to the next posting`;

const VALUE_FLAGS = ['--url', '--run-id', '--company', '--role', '--report', '--outcome', '--notes', '--log'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

/**
 * CLI entry: `claim` or `finalize`.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const flags = command ? argv.slice(1) : argv;
  validateFlags(flags, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const url = flagValue(flags, '--url');
  const runId = flagValue(flags, '--run-id') ?? '';
  const logPath = flagValue(flags, '--log');
  const rawReport = flagValue(flags, '--report');
  const reportNum = rawReport !== undefined && /^\d+$/.test(rawReport) ? Number(rawReport) : null;

  if (!command || !url) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (command === 'claim') {
    const result = await claimSubmission(url, {
      runId,
      company: flagValue(flags, '--company') ?? '',
      role: flagValue(flags, '--role') ?? '',
      reportNum,
      logPath,
    });
    console.log(JSON.stringify(result, null, 2));
    // A refused claim is an EXPECTED outcome, not a failure: agy reads exit 3
    // and moves to the next posting without treating the run as broken.
    if (!result.claimed) process.exitCode = 3;
    return;
  }

  if (command === 'finalize') {
    const outcome = flagValue(flags, '--outcome');
    if (!outcome) {
      console.error('finalize requires --outcome');
      process.exitCode = 1;
      return;
    }
    await finalizeSubmission(url, outcome, {
      runId,
      reportNum,
      notes: flagValue(flags, '--notes') ?? '',
      logPath,
    });
    console.log(JSON.stringify({ ok: true, url, outcome }, null, 2));
    return;
  }

  console.error(`unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
