#!/usr/bin/env node

/**
 * company-cap.mjs — refuse to send the Nth application to the same employer.
 *
 * WHY THIS EXISTS. The tracker reached 984 sent applications, and 977 of them
 * went to four companies: 410 to one, 361 to another, 145 and 61 to the last
 * two. Nothing in the pipeline noticed. The blacklist can only express "never,
 * at all", so the only way to stop the 411th was to ban the company outright —
 * which is the wrong instrument for "I have already asked them plenty".
 *
 * Worse, one of those tenants dedupes by candidate email across requisitions
 * (see `docs/freemotion-ats-findings.md`), so applications 2 through 410 there
 * short-circuited before a human ever saw them. Volume against one employer is
 * not persistence; past a point it is an address getting filtered.
 *
 * So: a cap, counted from the tracker itself, checked before a submit. The
 * blacklist stays what it is — a permanent no. This is a ceiling.
 *
 * NOT A SCORER AND NOT A SCAN FILTER. It answers exactly one question, at the
 * last possible moment: may I submit this one? Evaluating and tracking a role
 * at a capped company is still fine and still useful; only the send is refused.
 *
 * Usage:
 *   node lib/company-cap.mjs --check "Davidson"        # exit 0 = may submit
 *   node lib/company-cap.mjs --report                  # every company vs cap
 *   node lib/company-cap.mjs --report --json
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';

/**
 * Applications-per-employer ceiling.
 *
 * Set to 20 by the user on 2026-09-10. Deliberately a plain number rather than
 * a formula: the point is that SOMEBODY chose it, and that the 411th
 * application cannot happen by accident.
 */
export const DEFAULT_CAP = 20;

/**
 * Corporate suffixes that name the same employer.
 *
 * The cap keys on a normalized company name, and a normalized name keeps
 * every word — so "Thales" is capped while "Thales Group" sails through with
 * a count of zero. That is not hypothetical: the tracker already carries
 * "Capgemini Engineering" as a row separate from its 361 "Capgemini" ones.
 * An employer that has had 410 applications has had them whichever way the
 * posting spelled the name.
 *
 * Stripped from the END only. A leading word is part of the name ("Groupe
 * SII" is the company), while a trailing one is nearly always a legal form or
 * a division label.
 */
const CORPORATE_SUFFIX = /(?:\s+(?:group|groupe|engineering|technologies|technology|consulting|services|solutions|systems|systemes|france|international|sa|sas|sarl|sasu|inc|llc|ltd|limited|gmbh|bv|nv|plc|corp|corporation|co|company|holding|holdings))+$/i;

/**
 * The key an employer is counted under.
 *
 * @param {string} name
 * @returns {string}
 */
export function capKey(name) {
  // Deliberately NOT tracker-utils' normalizeCompany, which strips whitespace
  // and returns one run-on token ("airbusdefenceandspace"). That is right for
  // exact row matching and useless here: this key has to keep its word
  // boundaries so a division name can be recognised as the parent employer.
  const words = (s) => String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // fold accents: Systèmes -> systemes
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const full = words(name);
  if (!full) return '';
  const trimmed = words(full.replace(CORPORATE_SUFFIX, ''));
  // Never collapse to nothing: a company literally called "Group" keeps its
  // own key rather than merging with every other row.
  return trimmed || full;
}
/** Tracker states that mean an application actually went out. */
const SENT_STATES = /^(applied|responded|interview|offer|hired|rejected)$/i;

/**
 * Count applications already sent, per normalized company.
 *
 * Counts SENT states only. A row sitting at `Evaluated` or `SKIP` never
 * reached the employer, so counting it would refuse a send on the strength of
 * research nobody acted on.
 *
 * @param {string} trackerText - Raw applications.md content.
 * @returns {Map<string, {company: string, sent: number}>}
 */
export function countByCompany(trackerText) {
  const counts = new Map();
  for (const line of String(trackerText ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    // | # | Date | Company | Role | Score | Status | ...
    const num = cells[1] || '';
    const company = cells[3] || '';
    const status = cells[6] || '';
    if (!/^\d+$/.test(num)) continue;      // header, separator, or prose
    if (!company || !SENT_STATES.test(status)) continue;
    const key = capKey(company);
    if (!key) continue;
    const prev = counts.get(key);
    if (prev) prev.sent += 1;
    else counts.set(key, { company, sent: 1 });
  }
  return counts;
}

/**
 * Find the counted employer a name belongs to.
 *
 * Exact key first. Failing that, a LEADING-TOKEN match: "Airbus Defence and
 * Space" is Airbus, and Airbus has had 145 applications however the posting
 * spelled the division. Suffix stripping alone does not reach this, because
 * "Defence and Space" is a business unit rather than a legal form, and no list
 * of suffixes will ever contain every division name.
 *
 * Anchored at the start and on whole tokens, so it cannot fire on a coincidence:
 * "Airbush Systems" does not begin with the token "airbus", and a name that
 * merely mentions a big company later ("Consulting for Airbus") is not matched
 * either — being a supplier to an employer is not being that employer.
 *
 * @param {string} key - Already normalized via capKey.
 * @param {Map<string, {company: string, sent: number}>} counts
 * @returns {{key: string, company: string, sent: number}|null}
 */
export function resolveCountedKey(key, counts) {
  const exact = counts.get(key);
  if (exact) return { key, company: exact.company, sent: exact.sent };

  const tokens = key.split(' ').filter(Boolean);
  let best = null;
  for (const [candidateKey, entry] of counts) {
    const candidateTokens = candidateKey.split(' ').filter(Boolean);
    if (candidateTokens.length >= tokens.length) continue;
    const isPrefix = candidateTokens.every((t, i) => t === tokens[i]);
    if (!isPrefix) continue;
    // Longest matching prefix wins: given both "airbus" and "airbus defence",
    // the more specific one is the better answer.
    if (!best || candidateTokens.length > best.key.split(' ').length) {
      best = { key: candidateKey, company: entry.company, sent: entry.sent };
    }
  }
  return best;
}

/**
 * May another application go to this employer?
 *
 * @param {string} company - Company name as the posting gives it.
 * @param {Map<string, {company: string, sent: number}>} counts
 * @param {number} [cap]
 * @returns {{allowed: boolean, company: string, sent: number, cap: number, remaining: number, reason: string}}
 */
export function checkCompany(company, counts, cap = DEFAULT_CAP) {
  const key = capKey(company || '');
  const match = key ? resolveCountedKey(key, counts) : null;
  const sent = match ? match.sent : 0;
  const remaining = Math.max(0, cap - sent);
  const allowed = sent < cap;
  return {
    allowed,
    company: String(company ?? ''),
    matchedAs: match && match.key !== key ? match.company : undefined,
    sent,
    cap,
    remaining,
    reason: allowed
      ? `${sent} of ${cap} used`
      : `cap reached: ${sent} applications already sent to this employer (limit ${cap})`,
  };
}

/**
 * Every company at or near the cap, worst first.
 *
 * @param {Map<string, {company: string, sent: number}>} counts
 * @param {number} [cap]
 * @returns {{overCap: object[], nearCap: object[], total: number}}
 */
export function report(counts, cap = DEFAULT_CAP) {
  const rows = [...counts.values()].sort((a, b) => b.sent - a.sent);
  return {
    overCap: rows.filter((r) => r.sent >= cap),
    // Within five of the ceiling: worth seeing before a batch, not after.
    nearCap: rows.filter((r) => r.sent < cap && r.sent >= cap - 5),
    total: rows.reduce((n, r) => n + r.sent, 0),
  };
}

const USAGE = `Usage:
  node lib/company-cap.mjs --check "<company>" [--cap N] [--json]
  node lib/company-cap.mjs --report [--cap N] [--json]

Refuses the Nth application to the same employer. Counts SENT rows only
(Applied and beyond) from the tracker; Evaluated rows never reached anyone.

--check exits 0 when a submit is allowed and 3 when the cap is reached, so it
can gate a submit step directly.`;

function loadTracker() {
  const root = getCareerOpsRoot();
  const path = resolveTrackerPath(root);
  const resolved = isAbsolute(path) ? path : join(getCareerOpsRoot(), path);
  if (!existsSync(resolved)) return '';
  return readFileSync(resolved, 'utf-8');
}

function main(argv) {
  validateFlags(argv, ['--check', '--report', '--cap', '--json', '--help', '-h'], USAGE,
    { valueFlags: ['--check', '--cap'] });

  const cap = Number(flagValue(argv, '--cap') ?? DEFAULT_CAP);
  if (!Number.isFinite(cap) || cap < 1) { console.error('--cap must be a positive number'); return 2; }
  const counts = countByCompany(loadTracker());
  const json = hasFlag(argv, '--json');

  const company = flagValue(argv, '--check');
  if (company) {
    const verdict = checkCompany(company, counts, cap);
    if (json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(`${verdict.allowed ? 'ALLOWED' : 'BLOCKED'}  ${verdict.company}: ${verdict.reason}`);
    return verdict.allowed ? 0 : 3;
  }

  if (hasFlag(argv, '--report')) {
    const r = report(counts, cap);
    if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    console.log(`cap ${cap} per employer · ${r.total} applications sent in total\n`);
    if (r.overCap.length) {
      console.log('AT OR OVER THE CAP — no further sends:');
      for (const x of r.overCap) console.log(`  ${String(x.sent).padStart(4)}  ${x.company}`);
    }
    if (r.nearCap.length) {
      console.log('\nwithin five of the cap:');
      for (const x of r.nearCap) console.log(`  ${String(x.sent).padStart(4)}  ${x.company}`);
    }
    if (!r.overCap.length && !r.nearCap.length) console.log('nothing near the cap.');
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
}
