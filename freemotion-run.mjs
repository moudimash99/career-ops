#!/usr/bin/env node

/**
 * freemotion-run.mjs — resolve one work order, and claim it before anything
 * touches a browser.
 *
 * This is the front door of a Free Motion run (§4.9). It answers one question —
 * "which posting am I applying to, with what, and am I allowed to?" — and hands
 * `agy` a work order. It does not open a browser, fill anything, or submit:
 * every module in this design is browser-agnostic by construction (§1.5), and
 * `agy` owns the only MCP session.
 *
 * ── THE CLAIM IS THE POINT ────────────────────────────────────────────────
 * The one thing this file must never do is hand back a work order for a
 * posting that is already submitted or already being worked. A duplicate
 * application is the single most visible failure this system can produce to an
 * employer, and it cannot be walked back. So the claim happens HERE, before the
 * browser opens, inside `claimSubmission`'s lock — not at submit time, when
 * two concurrent runs have already both filled the form.
 *
 * Order matters within that: the blacklist gate runs BEFORE the claim, so a
 * company the user refuses to apply to never gets a row in the ledger. A claim
 * is a promise to attempt; a refused posting was never attempted.
 *
 * ── FAILURE IS A RESULT, NOT AN EXCEPTION ─────────────────────────────────
 * Every "cannot proceed" is `{ok: false, reason}` with an exit code `agy` can
 * branch on: 2 means "expected, move to the next posting" (already submitted,
 * in progress, blacklisted, nothing eligible, unkeyable URL), 1 means "you
 * asked for something that does not exist" or an unexpected crash. §1.1's rule,
 * applied to the resolution step: a run that stops is fine, a run that stops
 * silently is not.
 *
 * Usage:
 *   node freemotion-run.mjs --report N [--run-id ID]
 *   node freemotion-run.mjs --url <url> --company <c> --role <r> [--run-id ID]
 *   node freemotion-run.mjs --next [--min-score X] [--run-id ID]
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';

import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { readEngineConfig } from './lib/freemotion-engine-config.mjs';
import { claimSubmission } from './lib/freemotion-submissions.mjs';
import { assignArm } from './lib/cv-experiment.mjs';
import { assignLetterArm } from './lib/letter-experiment.mjs';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { parsePdfIndex } from './find.mjs';
import { loadBlacklist } from './scan.mjs';
import { matchBlacklist } from './lib/company-cap.mjs';

/** Repo root — this file lives at the top level. */
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Reasons `agy` should treat as "nothing wrong, take the next posting".
 * Everything else is a usage error or a bug, and exits 1.
 */
export const EXPECTED_REFUSALS = [
  'already-submitted',
  'in-progress',
  'unkeyable',
  'no-eligible-row',
  'blacklisted',
];

/** The tracker status a row must carry to be picked up by `--next`. */
const NEXT_ELIGIBLE_STATUS = 'Evaluated';

/**
 * Absolute path for a possibly-relative path under the data root.
 *
 * @param {string} path
 * @param {string} root
 * @returns {string}
 */
function under(root, path) {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Read the tracker into rows, carrying the `URL` cell that `parseTrackerRow`
 * does not return (it maps a fixed field set; `url` is an optional column, see
 * AGENTS.md "Optional posting URL").
 *
 * @param {string} trackerPath
 * @returns {{rows: object[]}}
 */
function readTrackerRows(trackerPath) {
  if (!existsSync(trackerPath)) return { rows: [] };
  const lines = readFileSync(trackerPath, 'utf-8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    if (colmap.url != null) {
      const parts = line.split('|').map((s) => s.trim());
      row.url = parts[colmap.url] ?? '';
    }
    rows.push(row);
  }
  return { rows };
}

/**
 * Locate `reports/{N}-*.md`, accepting padded and unpadded prefixes (`064-`,
 * `64-`, `01-`) — the same rule `jd-capture.mjs` applies to `jds/`, and for the
 * same reason: both spellings exist in real directories, and comparing the
 * parsed integer keeps report 64 from picking up report 640's file.
 *
 * @param {string} reportsDir
 * @param {number} reportNum
 * @returns {string|null} Absolute path, or null.
 */
function findReportPath(reportsDir, reportNum) {
  if (!Number.isInteger(reportNum) || reportNum <= 0 || !existsSync(reportsDir)) return null;
  let entries;
  try { entries = readdirSync(reportsDir); } catch { return null; }
  const match = entries
    .filter((name) => name.endsWith('.md'))
    .find((name) => {
      const prefix = /^(\d+)-/.exec(name);
      return prefix ? Number(prefix[1]) === reportNum : false;
    });
  return match ? join(reportsDir, match) : null;
}

/**
 * The `**URL:**` line every report header carries (AGENTS.md, "Pipeline
 * Integrity" rule 3).
 *
 * Used as a fallback when the tracker row has no `URL` cell: the column is
 * optional and was added late, so rows predating it still resolve through
 * their report rather than being unreachable to this runner.
 *
 * @param {string|null} reportPath
 * @returns {string}
 */
function urlFromReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return '';
  const match = /^\s*\*\*URL:\*\*\s*(\S+)/m.exec(readFileSync(reportPath, 'utf-8'));
  const url = match ? match[1].trim() : '';
  return /^https?:\/\//i.test(url) ? url : '';
}

/**
 * Numeric value of a tracker score cell (`4.5/5` → 4.5).
 *
 * The sentinels (`N/A`, `—`, `-`) are NOT zero: a row with no evaluation has no
 * score to compare against `--min-score`, so it is not a `--next` candidate at
 * all. Reading them as 0 would make them eligible for every `--min-score 0`
 * run, which is every run that does not pass the flag.
 *
 * @param {string} cell
 * @returns {number|null}
 */
function parseScore(cell) {
  const match = /^\**\s*(\d+(?:\.\d+)?)\s*\/\s*5\s*\**$/.exec(String(cell ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * The tailored CV for a report, from `data/pdf-index.tsv` (written by
 * `generate-pdf.mjs`, which is the only thing that knows the mapping — the
 * tracker's PDF column is a ✅/❌, not a path).
 *
 * @param {string} root
 * @param {number|null} reportNum
 * @returns {string|null} Absolute path, or null when nothing is indexed.
 */
function resolvePdfPath(root, reportNum) {
  if (reportNum === null || reportNum === undefined) return null;
  const indexPath = under(root, 'data/pdf-index.tsv');
  if (!existsSync(indexPath)) return null;
  let index;
  try { index = parsePdfIndex(readFileSync(indexPath, 'utf-8')); } catch { return null; }
  const key = String(reportNum).replace(/^0+(?=\d)/, '');
  const recorded = index.get(key);
  if (!recorded) return null;
  const absolute = under(root, recorded);
  return existsSync(absolute) ? absolute : null;
}

/**
 * Absolute path of the generic CV (config/apply-answers.yml → resume), or null
 * when it is unset or missing on disk.
 *
 * @param {string} root
 * @returns {string|null}
 */
function readGenericCvPath(root) {
  try {
    const answers = yaml.load(readFileSync(under(root, 'config/apply-answers.yml'), 'utf-8')) || {};
    const rel = String(answers.resume ?? '').trim();
    if (!rel) return null;
    const absolute = under(root, rel);
    return existsSync(absolute) ? absolute : null;
  } catch {
    return null;
  }
}

/**
 * The evaluation's `## H) Draft Application Answers` block, if it wrote one.
 *
 * An optimization, never a requirement: any failure here (no report, no block,
 * a parse error, a non-zero exit) yields null and the run continues. The answer
 * resolver reaches the same answers from `config/` on its own — draft answers
 * only save it the work.
 *
 * @param {string|null} reportPath
 * @returns {object|null}
 */
function readDraftAnswers(reportPath) {
  if (!reportPath) return null;
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'application-answers.mjs'), '--report', reportPath, '--read-draft'],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve one posting into a work order, claiming it in the submissions ledger.
 *
 * @param {{report?: number, url?: string, company?: string, role?: string,
 *          next?: boolean, minScore?: number, runId?: string, root?: string,
 *          forceArm?: 'generic'|'loose'|'strict', forceLetterArm?: 'none'|'short'|'full'}} args
 * @returns {Promise<
 *   { ok: true, workOrder: { runId: string, url: string, company: string, role: string,
 *       reportNum: number|null, reportPath: string|null, cvArm: 'generic'|'loose'|'strict',
 *       genericCvPath: string|null, pdfPath: string|null,
 *       draftAnswers: object|null, engineConfig: object } }
 *   | { ok: false, reason: 'blacklisted'|'already-submitted'|'in-progress'|'unkeyable'
 *                        |'no-eligible-row'|'not-found', detail?: string }>}
 */
export async function resolveWorkOrder(args = {}) {
  const root = args.root ?? getCareerOpsRoot();
  const runId = args.runId || `fm-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Computed BEFORE any claim: readEngineConfig throws on a bad config, and a
  // throw after claiming would strand an `in-progress` row for 30 minutes.
  const engineConfig = readEngineConfig(under(root, 'config/profile.yml'));
  const blacklist = loadBlacklist(under(root, 'data/blacklist.md'));
  const reportsDir = under(root, 'reports');

  const isBlacklisted = (company) => matchBlacklist(blacklist, String(company ?? ''));

  /** Everything a claim needs, plus what the work order will carry. */
  const describe = (candidate) => {
    const reportPath = candidate.reportNum === null
      ? null
      : findReportPath(reportsDir, candidate.reportNum);
    return { ...candidate, reportPath };
  };

  // CV experiment (lib/cv-experiment.mjs): drawn only here, AFTER the claim,
  // so a skipped posting never draws an arm. `generic` uploads the fixed CV
  // right away; `loose`/`strict` leave pdfPath null — the mode tailors and
  // renders a fresh one-page CV for this posting before the upload step.
  const finish = async (candidate) => {
    const genericCvPath = readGenericCvPath(root);
    let cvArm = 'generic';
    let cvArmError = null;
    try {
      ({ arm: cvArm } = await assignArm(candidate.url, {
        report: candidate.reportNum,
        company: candidate.company,
        role: candidate.role,
        forceArm: args.forceArm || null,
        root,
      }));
    } catch (err) {
      // Never let the experiment stop an application: send the generic CV.
      cvArmError = err.message;
    }
    // Letter experiment (lib/letter-experiment.mjs): none / short / full.
    // Same rule: a failed draw must not stop the application; it means a
    // short letter.
    let letterArm = 'short';
    try {
      ({ arm: letterArm } = await assignLetterArm(candidate.url, {
        report: candidate.reportNum,
        company: candidate.company,
        role: candidate.role,
        forceArm: args.forceLetterArm || null,
        root,
      }));
    } catch { /* keep 'short' */ }
    return {
      ok: true,
      workOrder: {
        runId,
        url: candidate.url,
        company: candidate.company,
        role: candidate.role,
        reportNum: candidate.reportNum,
        reportPath: candidate.reportPath,
        cvArm,
        ...(cvArmError ? { cvArmError } : {}),
        letterArm,
        genericCvPath,
        pdfPath: cvArm === 'generic' ? genericCvPath : null,
        draftAnswers: readDraftAnswers(candidate.reportPath),
        engineConfig,
      },
    };
  };

  const claim = async (candidate) => claimSubmission(candidate.url, {
    runId,
    company: candidate.company,
    role: candidate.role,
    reportNum: candidate.reportNum,
    root,
  });

  // ── --next: the highest-scoring untouched row ───────────────────────────
  if (args.next) {
    const minScore = Number.isFinite(args.minScore) ? args.minScore : 0;
    const { rows } = readTrackerRows(resolveTrackerPath(root));

    const candidates = rows
      .map((row) => {
        const score = parseScore(row.score);
        const reportNum = /^\d+$/.test(String(row.num)) ? Number(row.num) : null;
        const reportPath = reportNum === null ? null : findReportPath(reportsDir, reportNum);
        const url = /^https?:\/\//i.test(String(row.url ?? '').trim())
          ? String(row.url).trim()
          : urlFromReport(reportPath);
        return { row, score, reportNum, reportPath, url, company: row.company, role: row.role };
      })
      // No PDF requirement: the CV experiment builds (or picks) the CV at
      // apply time, so a row without a pre-rendered PDF is just as eligible.
      .filter((c) => c.row.status === NEXT_ELIGIBLE_STATUS
        && c.url !== ''
        && c.score !== null
        && c.score >= minScore)
      .sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      // Skipped, not refused: one blacklisted row must not hide the eligible
      // row behind it, and it must never reach the ledger.
      if (isBlacklisted(candidate.company)) continue;
      const claimed = await claim(candidate);
      if (claimed.claimed) return await finish(candidate);
    }
    return {
      ok: false,
      reason: 'no-eligible-row',
      detail: `${candidates.length} row(s) matched status=${NEXT_ELIGIBLE_STATUS}, score>=${minScore}; all were blacklisted, claimed or already submitted`,
    };
  }

  // ── --report N: one tracked row ─────────────────────────────────────────
  let candidate;
  if (args.report !== undefined && args.report !== null) {
    const reportNum = Number(args.report);
    const trackerPath = resolveTrackerPath(root);
    const { rows } = readTrackerRows(trackerPath);
    const row = rows.find((r) => r.num === reportNum);
    if (!row) {
      return { ok: false, reason: 'not-found', detail: `no tracker row #${reportNum} in ${trackerPath}` };
    }
    const reportPath = findReportPath(reportsDir, reportNum);
    const url = /^https?:\/\//i.test(String(row.url ?? '').trim())
      ? String(row.url).trim()
      : urlFromReport(reportPath);
    if (url === '') {
      return {
        ok: false,
        reason: 'not-found',
        detail: `tracker row #${reportNum} has no URL cell and its report carries no **URL:** header`,
      };
    }
    candidate = { url, company: row.company, role: row.role, reportNum, reportPath };
  } else if (args.url) {
    // Ad-hoc: nothing was evaluated, so there is no report, no tailored PDF and
    // no draft answers. The rest of the loop is identical.
    candidate = describe({
      url: String(args.url).trim(),
      company: String(args.company ?? '').trim(),
      role: String(args.role ?? '').trim(),
      reportNum: null,
    });
  } else {
    return { ok: false, reason: 'not-found', detail: 'pass one of --report N, --url <url>, or --next' };
  }

  const listed = isBlacklisted(candidate.company);
  if (listed) {
    return {
      ok: false,
      reason: 'blacklisted',
      detail: listed.reason || `${listed.company} is on data/blacklist.md`,
    };
  }

  const claimed = await claim(candidate);
  if (!claimed.claimed) return { ok: false, reason: claimed.reason };

  return await finish(candidate);
}

const USAGE = `Usage:
  node freemotion-run.mjs --report N [--run-id ID]
  node freemotion-run.mjs --url <url> --company <c> --role <r> [--run-id ID]
  node freemotion-run.mjs --next [--min-score X] [--run-id ID]

  --force-arm generic|loose|strict   dry runs only: pin the CV experiment arm
  --force-letter-arm none|short|full dry runs only: pin the letter experiment arm

Resolves ONE posting into a work order and claims it in
data/freemotion-submissions.tsv before any browser opens. Prints the result as
JSON. Opens nothing, fills nothing, submits nothing.

Exit codes:
  0  a work order was claimed
  2  expected refusal — ${EXPECTED_REFUSALS.join(', ')} — take the next posting
  1  usage error, an unknown --report N, or an unexpected failure`;

const VALUE_FLAGS = ['--report', '--url', '--company', '--role', '--min-score', '--run-id', '--root', '--force-arm', '--force-letter-arm'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--next', '--help', '-h'];

/**
 * CLI entry.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const reportRaw = flagValue(argv, '--report');
  const url = flagValue(argv, '--url');
  const next = hasFlag(argv, '--next');

  const modes = [reportRaw !== undefined, url !== undefined, next].filter(Boolean).length;
  if (modes !== 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (reportRaw !== undefined && !/^\d+$/.test(reportRaw)) {
    console.error(`Error: --report takes a tracker row number, got "${reportRaw}"`);
    process.exitCode = 1;
    return;
  }

  const minScoreRaw = flagValue(argv, '--min-score');
  const result = await resolveWorkOrder({
    ...(reportRaw !== undefined ? { report: Number(reportRaw) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(next ? { next: true } : {}),
    company: flagValue(argv, '--company'),
    role: flagValue(argv, '--role'),
    ...(minScoreRaw !== undefined ? { minScore: Number(minScoreRaw) } : {}),
    runId: flagValue(argv, '--run-id'),
    root: flagValue(argv, '--root'),
    forceArm: flagValue(argv, '--force-arm'),
    forceLetterArm: flagValue(argv, '--force-letter-arm'),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.ok) return;
  process.exitCode = EXPECTED_REFUSALS.includes(result.reason) ? 2 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
