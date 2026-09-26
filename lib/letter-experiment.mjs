#!/usr/bin/env node

/**
 * letter-experiment.mjs — which cover letter went with each application.
 *
 * The point is diversification, not statistics (callbacks are ~1 in 100): no
 * single letter prompt writes every application, so a bad one cannot sink
 * the whole search. Three arms, drawn per posting and kept forever, same
 * ledger logic as lib/cv-experiment.mjs:
 *   none   — optional letter fields stay empty (a required one gets `short`)
 *   short  — 3–5 sentences (letter-write.mjs --version short)
 *   full   — 3–4 paragraphs (letter-write.mjs --version full)
 * Weights: config/profile.yml → letter_experiment.weights (default 15/35/50).
 *
 * Usage:
 *   node lib/letter-experiment.mjs assign --url <u> --company <c> --role <r> [--report N] [--force-arm <arm>]
 *   node lib/letter-experiment.mjs sent --url <u> [--letter <path>]
 *   node lib/letter-experiment.mjs fallback --url <u> --reason "<why>"
 *   node lib/letter-experiment.mjs report [--summary]
 */

import { flagValue, hasFlag } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import {
  assignArm as assignGeneric, buildReport, foldLedger, loadTrackerRows, markFallback as fallbackGeneric,
  markSent as sentGeneric, printSummary, readLedger,
} from './cv-experiment.mjs';

export const LETTER_ARMS = ['none', 'short', 'full'];
export const LETTER_WEIGHTS = { none: 15, short: 35, full: 50 };
export const LETTER_SPEC = {
  arms: LETTER_ARMS,
  defaultWeights: LETTER_WEIGHTS,
  profileKey: 'letter_experiment',
  ledger: 'data/letter-experiment.tsv',
};

export const assignLetterArm = (url, opts = {}) => assignGeneric(url, { ...opts, spec: LETTER_SPEC });
export const markLetterSent = (url, letter, opts = {}) => sentGeneric(url, letter, { ...opts, spec: LETTER_SPEC });
export const markLetterFallback = (url, reason, opts = {}) => fallbackGeneric(url, reason, { ...opts, spec: LETTER_SPEC });
export function letterReport(root = getCareerOpsRoot()) {
  return buildReport(foldLedger(readLedger({ root, spec: LETTER_SPEC })), loadTrackerRows(root), LETTER_ARMS);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const url = flagValue(args, '--url');
  try {
    if (cmd === 'assign') {
      if (!url) throw new Error('--url is required');
      console.log(JSON.stringify(await assignLetterArm(url, {
        report: flagValue(args, '--report') || null,
        company: flagValue(args, '--company') || '',
        role: flagValue(args, '--role') || '',
        forceArm: flagValue(args, '--force-arm') || null,
      })));
    } else if (cmd === 'sent') {
      if (!url) throw new Error('--url is required');
      console.log(JSON.stringify(await markLetterSent(url, flagValue(args, '--letter'))));
    } else if (cmd === 'fallback') {
      if (!url) throw new Error('--url is required');
      console.log(JSON.stringify(await markLetterFallback(url, flagValue(args, '--reason'))));
    } else if (cmd === 'report') {
      const groups = letterReport();
      if (hasFlag(args, '--summary')) printSummary(groups);
      else console.log(JSON.stringify(groups, null, 2));
    } else {
      console.error('Usage: node lib/letter-experiment.mjs assign|sent|fallback|report  (see file header)');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
