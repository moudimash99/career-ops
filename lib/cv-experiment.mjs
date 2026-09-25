#!/usr/bin/env node

/**
 * cv-experiment.mjs — which CV went out with each Free Motion application,
 * and which kind gets callbacks.
 *
 * Three arms, drawn per posting:
 *   generic 15%  — the fixed generic CV (config/apply-answers.yml → resume)
 *   loose   50%  — tailored, same build rules, low fact-checking
 *   strict  35%  — tailored, same build rules, full fact gate
 * Weights can be overridden in config/profile.yml → cv_experiment.weights.
 *
 * The ledger (data/cv-experiment.tsv) is append-only, keyed by the normalized
 * posting URL, same shape as data/freemotion-submissions.tsv:
 *   assigned — the draw. A posting keeps its first draw forever, so a retried
 *              run can't re-roll until it gets the arm it "likes".
 *   sent     — the application was actually submitted. ONLY sent postings are
 *              counted: a draw that never reached an employer measures nothing.
 *   fallback — the tailored build failed and the generic CV went out instead.
 *              Reported as its own group, never mixed into loose or strict.
 *
 * Usage:
 *   node lib/cv-experiment.mjs assign --url <u> --company <c> --role <r> [--report N] [--force-arm <arm>]
 *   node lib/cv-experiment.mjs sent --url <u> --pdf <path>
 *   node lib/cv-experiment.mjs fallback --url <u> --reason "<why>"
 *   node lib/cv-experiment.mjs report [--summary]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import * as yaml from 'js-yaml';

import { flagValue, hasFlag } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import normalizeUrl from '../url-key.mjs';
import { parseTrackerRows } from '../find.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';
import { roleFuzzyMatch } from '../role-matcher.mjs';

export const LEDGER_RELATIVE_PATH = 'data/cv-experiment.tsv';
export const ARMS = ['generic', 'loose', 'strict'];
export const DEFAULT_WEIGHTS = { generic: 15, loose: 50, strict: 35 };
const HEADER = ['url_key', 'url', 'report', 'company', 'role', 'event', 'arm', 'timestamp', 'detail'];
const EVENTS = new Set(['assigned', 'sent', 'fallback']);

// Tracker states that mean the employer came back with interest.
const CALLBACK_STATES = new Set(['Responded', 'Interview', 'Offer', 'Hired']);
// Below this many sends an arm's rate is noise; the report says so.
export const MIN_SAMPLE = 30;

export function ledgerPath({ logPath, root } = {}) {
  const base = root ?? getCareerOpsRoot();
  if (logPath) return isAbsolute(logPath) ? logPath : join(base, logPath);
  return join(base, LEDGER_RELATIVE_PATH);
}

const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim());

/** Weights from profile.yml → cv_experiment.weights, falling back per arm. */
export function readWeights(root) {
  const path = join(root ?? getCareerOpsRoot(), 'config', 'profile.yml');
  let custom = {};
  try {
    if (existsSync(path)) custom = yaml.load(readFileSync(path, 'utf-8'))?.cv_experiment?.weights || {};
  } catch { /* a broken profile must not stop an application; use defaults */ }
  const out = {};
  for (const arm of ARMS) {
    const w = Number(custom[arm]);
    out[arm] = Number.isFinite(w) && w >= 0 ? w : DEFAULT_WEIGHTS[arm];
  }
  return out;
}

/** Weighted draw. `rng` returns [0, 1). */
export function drawArm(weights = DEFAULT_WEIGHTS, rng = Math.random) {
  const total = ARMS.reduce((s, a) => s + (weights[a] || 0), 0);
  if (total <= 0) throw new Error('cv_experiment weights sum to zero');
  let x = rng() * total;
  for (const arm of ARMS) {
    x -= weights[arm] || 0;
    if (x < 0) return arm;
  }
  return ARMS[ARMS.length - 1];
}

/** All ledger rows, in file order. */
export function readLedger(opts = {}) {
  const path = ledgerPath(opts);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (p[0] === HEADER[0] || p.length < 7) continue;
    const [urlKey, url, report, company, role, event, arm, timestamp, ...rest] = p;
    if (!EVENTS.has(event)) continue;
    rows.push({ urlKey, url, report: report === '-' ? null : report, company, role, event, arm, timestamp, detail: rest.join(' ') });
  }
  return rows;
}

/**
 * Fold the ledger to one record per posting.
 * @returns {Map<string, {urlKey, url, report, company, role, arm, sent: boolean, fallback: boolean, pdf: string}>}
 */
export function foldLedger(rows) {
  const state = new Map();
  for (const r of rows) {
    let s = state.get(r.urlKey);
    if (r.event === 'assigned') {
      if (s) continue; // first draw wins
      s = { urlKey: r.urlKey, url: r.url, report: r.report, company: r.company, role: r.role, arm: r.arm, sent: false, fallback: false, pdf: '' };
      state.set(r.urlKey, s);
    } else if (s) {
      if (r.event === 'sent') { s.sent = true; s.pdf = r.detail; }
      if (r.event === 'fallback') s.fallback = true;
    }
  }
  return state;
}

function appendRow(path, row) {
  const fresh = !existsSync(path);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const line = [row.urlKey, row.url, row.report ?? '-', row.company, row.role, row.event, row.arm, new Date().toISOString(), row.detail]
    .map(cell).join('\t');
  appendFileSync(path, `${fresh ? `${HEADER.join('\t')}\n` : ''}${line}\n`, 'utf-8');
}

/**
 * Draw (or recall) the arm for a posting.
 * @returns {Promise<{arm: string, urlKey: string, fresh: boolean}>}
 */
export async function assignArm(url, { report = null, company = '', role = '', forceArm = null, rng, root, logPath } = {}) {
  const urlKey = normalizeUrl(url);
  if (!urlKey) throw new Error(`unkeyable URL: ${url}`);
  if (forceArm && !ARMS.includes(forceArm)) throw new Error(`unknown arm "${forceArm}" (${ARMS.join(', ')})`);
  const path = ledgerPath({ root, logPath });
  return withPipelineLock(path, async () => {
    const prior = foldLedger(readLedger({ logPath: path })).get(urlKey);
    if (prior && !forceArm) return { arm: prior.arm, urlKey, fresh: false };
    const arm = forceArm || drawArm(readWeights(root), rng);
    // A forced arm is a dry-run tool: it is recorded (so the run is traceable)
    // but only a later `sent` row would make it count.
    appendRow(path, { urlKey, url, report, company, role, event: 'assigned', arm, detail: forceArm ? 'forced' : '' });
    return { arm, urlKey, fresh: true };
  });
}

async function appendEvent(url, event, detail, { root, logPath } = {}) {
  const urlKey = normalizeUrl(url);
  if (!urlKey) throw new Error(`unkeyable URL: ${url}`);
  const path = ledgerPath({ root, logPath });
  return withPipelineLock(path, async () => {
    const prior = foldLedger(readLedger({ logPath: path })).get(urlKey);
    if (!prior) throw new Error(`no arm assigned for ${url}; run "assign" first`);
    appendRow(path, { ...prior, urlKey, url, event, arm: prior.arm, detail });
    return { arm: prior.arm, urlKey };
  });
}

export const markSent = (url, pdf, opts) => appendEvent(url, 'sent', pdf || '', opts);
export const markFallback = (url, reason, opts) => appendEvent(url, 'fallback', reason || '', opts);

/** Tracker status for a posting: by report number first, then fuzzy company + role. */
function statusFor(record, trackerRows) {
  const norm = (n) => String(n ?? '').replace(/^0+(?=\d)/, '');
  if (record.report) {
    const hit = trackerRows.find(r => r.reportNum && norm(r.reportNum) === norm(record.report));
    if (hit) return hit.status;
  }
  const company = normalizeCompany(record.company);
  const hit = trackerRows.find(r => normalizeCompany(r.company) === company && roleFuzzyMatch(r.role, record.role));
  return hit ? hit.status : null;
}

/**
 * Per-group outcome table over SENT postings only.
 * Groups: generic, loose, strict, fallback.
 */
export function buildReport(state, trackerRows) {
  const groups = {};
  for (const g of [...ARMS, 'fallback']) {
    groups[g] = { sent: 0, callbacks: 0, rejected: 0, pending: 0, unmatched: 0, byStatus: {} };
  }
  for (const rec of state.values()) {
    if (!rec.sent) continue;
    const g = groups[rec.fallback ? 'fallback' : rec.arm];
    if (!g) continue;
    g.sent++;
    const status = statusFor(rec, trackerRows);
    if (!status) { g.unmatched++; continue; }
    g.byStatus[status] = (g.byStatus[status] || 0) + 1;
    if (CALLBACK_STATES.has(status)) g.callbacks++;
    else if (status === 'Rejected') g.rejected++;
    else g.pending++;
  }
  for (const g of Object.values(groups)) {
    g.callbackRate = g.sent ? Math.round((g.callbacks / g.sent) * 1000) / 10 : null;
    g.enoughData = g.sent >= MIN_SAMPLE;
  }
  return groups;
}

function loadTrackerRows(root) {
  const path = resolveTrackerPath(root);
  return path && existsSync(path) ? parseTrackerRows(readFileSync(path, 'utf-8')) : [];
}

function printSummary(groups) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('arm', 10)}${pad('sent', 6)}${pad('callback', 10)}${pad('rate', 8)}${pad('rejected', 10)}${pad('pending', 9)}note`);
  for (const [name, g] of Object.entries(groups)) {
    const rate = g.callbackRate === null ? '-' : `${g.callbackRate}%`;
    const note = g.sent === 0 ? '' : g.enoughData ? '' : `too few sends to read (<${MIN_SAMPLE})`;
    console.log(`${pad(name, 10)}${pad(g.sent, 6)}${pad(g.callbacks, 10)}${pad(rate, 8)}${pad(g.rejected, 10)}${pad(g.pending, 9)}${note}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const url = flagValue(args, '--url');
  const usage = 'Usage: node lib/cv-experiment.mjs assign|sent|fallback|report  (see file header)';
  try {
    if (cmd === 'assign') {
      if (!url) throw new Error('--url is required');
      const r = await assignArm(url, {
        report: flagValue(args, '--report') || null,
        company: flagValue(args, '--company') || '',
        role: flagValue(args, '--role') || '',
        forceArm: flagValue(args, '--force-arm') || null,
      });
      console.log(JSON.stringify(r));
    } else if (cmd === 'sent') {
      if (!url) throw new Error('--url is required');
      console.log(JSON.stringify(await markSent(url, flagValue(args, '--pdf'))));
    } else if (cmd === 'fallback') {
      if (!url) throw new Error('--url is required');
      console.log(JSON.stringify(await markFallback(url, flagValue(args, '--reason'))));
    } else if (cmd === 'report') {
      const root = getCareerOpsRoot();
      const groups = buildReport(foldLedger(readLedger({ root })), loadTrackerRows(root));
      if (hasFlag(args, '--summary')) printSummary(groups);
      else console.log(JSON.stringify(groups, null, 2));
    } else {
      console.error(usage);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
