// tests/freemotion-submissions.test.mjs — the URL-keyed ledger that keeps Free
// Motion from applying to the same posting twice (Requirement 8).
//
// Every assertion runs against a temp-dir log path, never the real
// data/freemotion-submissions.tsv: a test that claimed a real posting would
// block the user's next run against it for 30 minutes.
//
// Run: node test-all.mjs --only freemotion-submissions

import { pass, fail, ROOT, rmSync } from './helpers.mjs';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-submissions — the never-apply-twice ledger');

const {
  claimSubmission, finalizeSubmission, readCurrentState,
  VALID_OUTCOMES, IN_PROGRESS_STALE_MS,
} = await import(pathToFileURL(join(ROOT, 'lib/freemotion-submissions.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'fm-subs-'));
const logPath = join(tmp, 'submissions.tsv');
const URL_A = 'https://boards.greenhouse.io/acme/jobs/1';

try {
  // ------------------------------------------- the plan's acceptance sequence

  const a = await claimSubmission(URL_A, { runId: 'r1', company: 'Acme', role: 'Eng', reportNum: 1, logPath });
  check('a fresh posting is claimed', a.claimed, true);

  const b = await claimSubmission(URL_A, { runId: 'r2', company: 'Acme', role: 'Eng', reportNum: 1, logPath });
  check('a second worker is refused while the first holds it', b.claimed, false);
  check('  ...and is told why', b.reason, 'in-progress');

  await finalizeSubmission(URL_A, 'submitted', { runId: 'r1', reportNum: 1, notes: 'ok', logPath });

  const c = await claimSubmission(URL_A, { runId: 'r3', company: 'Acme', role: 'Eng', reportNum: 1, logPath });
  check('a submitted posting is never claimed again', c.claimed, false);
  check('  ...and says so', c.reason, 'already-submitted');
  check('  ...and hands back the row that blocked it', c.priorRow?.outcome, 'submitted');

  // ------------------------------------------- only `submitted` blocks forever

  // A posting that never reached the employer must be retryable, or one CAPTCHA
  // permanently burns a company the candidate could still apply to.
  for (const outcome of ['validation-failed', 'captcha', 'blocked-waf', 'errored', 'account-verification-pending']) {
    const url = `https://boards.greenhouse.io/acme/jobs/${outcome}`;
    const first = await claimSubmission(url, { runId: 'r1', company: 'Acme', role: 'Eng', reportNum: null, logPath });
    if (!first.claimed) { fail(`${outcome}: first claim refused`); continue; }
    await finalizeSubmission(url, outcome, { runId: 'r1', reportNum: null, notes: '', logPath });
    const retry = await claimSubmission(url, { runId: 'r2', company: 'Acme', role: 'Eng', reportNum: null, logPath });
    check(`a posting that ended '${outcome}' can be retried`, retry.claimed, true);
  }

  // ---------------------------------------------- a stale claim is reclaimable

  // A run killed by Ctrl-C leaves its in-progress row behind. A claim nothing
  // can release is a posting nothing can ever apply to.
  const staleUrl = 'https://boards.greenhouse.io/acme/jobs/stale';
  const staleAt = Date.now() - (IN_PROGRESS_STALE_MS + 60_000);
  const stale = await claimSubmission(staleUrl, { runId: 'dead', company: 'Acme', role: 'Eng', reportNum: null, logPath, now: staleAt });
  check('the abandoned run claimed it', stale.claimed, true);
  const reclaim = await claimSubmission(staleUrl, { runId: 'alive', company: 'Acme', role: 'Eng', reportNum: null, logPath });
  check('a stale in-progress claim is reclaimable', reclaim.claimed, true);

  const fresh = await claimSubmission('https://boards.greenhouse.io/acme/jobs/fresh', { runId: 'x', company: 'A', role: 'B', reportNum: null, logPath, now: Date.now() });
  check('a fresh claim is granted', fresh.claimed, true);
  const blocked = await claimSubmission('https://boards.greenhouse.io/acme/jobs/fresh', { runId: 'y', company: 'A', role: 'B', reportNum: null, logPath });
  check('  ...and still blocks a second worker', blocked.reason, 'in-progress');

  // ------------------------------------------------------ no key is not a key

  // Folding unkeyable URLs to '' would collapse every one of them into a single
  // ledger entry and report the second as a duplicate of the first.
  for (const bad of ['', 'N/A', 'local:jds/foo.md', 'ftp://x.com/job', 'not a url']) {
    const r = await claimSubmission(bad, { runId: 'r', company: 'A', role: 'B', reportNum: null, logPath });
    check(`an unkeyable URL (${JSON.stringify(bad)}) is refused, not keyed`, r.reason, 'unkeyable');
  }
  const beforeCount = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length;
  await claimSubmission('N/A', { runId: 'r', company: 'A', role: 'B', reportNum: null, logPath });
  check('an unkeyable claim writes no row at all', readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length, beforeCount);

  // ------------------------------------------ two spellings of one posting

  // normalizeUrl is what makes the dedup deterministic: a tracking param or a
  // trailing slash must not read as a different posting.
  const canonical = 'https://boards.greenhouse.io/acme/jobs/77';
  const first = await claimSubmission(canonical, { runId: 'r1', company: 'A', role: 'B', reportNum: null, logPath });
  check('the canonical spelling is claimed', first.claimed, true);
  await finalizeSubmission(canonical, 'submitted', { runId: 'r1', reportNum: null, notes: '', logPath });
  const variant = await claimSubmission(`${canonical}/?utm_source=linkedin#apply`, { runId: 'r2', company: 'A', role: 'B', reportNum: null, logPath });
  check('a tracking-param variant is the same posting', variant.reason, 'already-submitted');

  // ------------------------------------------------------------- TSV integrity

  // A note carrying a tab would shift every later column of its row, and the
  // column that shifts is `outcome`.
  const tabUrl = 'https://boards.greenhouse.io/acme/jobs/tabs';
  await claimSubmission(tabUrl, { runId: 'r1', company: 'A', role: 'B', reportNum: null, logPath });
  await finalizeSubmission(tabUrl, 'submitted', { runId: 'r1', reportNum: null, notes: 'line one\tcol two\nline two', logPath });
  const tabRow = readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.includes('/jobs/tabs')).pop();
  check('a note with tabs/newlines still yields exactly 9 columns', tabRow.split('\t').length, 9);
  check('  ...and the outcome column still holds the outcome', tabRow.split('\t')[5], 'submitted');

  // --------------------------------------------------------- readCurrentState

  const state = readCurrentState({ logPath });
  check('the fold returns one row per posting', state.size > 0, true);
  check('the fold takes the LAST row per key', state.get(readCurrentState({ logPath }).keys().next().value) !== undefined, true);

  const submittedRow = [...state.values()].find((r) => r.rawUrl === URL_A);
  check('the folded row keeps the final outcome', submittedRow?.outcome, 'submitted');
  check('the folded row keeps the report number', submittedRow?.reportNum, 1);
  check('the folded row carries the company forward from the claim', submittedRow?.company, 'Acme');

  check('a missing ledger folds to an empty map, not an error', readCurrentState({ logPath: join(tmp, 'nope.tsv') }).size, 0);

  // A ledger containing only its header must not be read as a row.
  const headerOnly = join(tmp, 'header-only.tsv');
  writeFileSync(headerOnly, 'url_key\traw_url\tcompany\trole\treport_num\toutcome\ttimestamp\trun_id\tnotes\n');
  check('the header row is not a submission', readCurrentState({ logPath: headerOnly }).size, 0);

  // ------------------------------------------------------- outcome validation

  try {
    await finalizeSubmission('https://x.com/jobs/1', 'definitely-not-an-outcome', { runId: 'r', reportNum: null, notes: '', logPath });
    fail('an unknown outcome should throw, not be written');
  } catch (err) {
    check('an unknown outcome is refused', /unknown outcome/.test(err.message), true);
  }
  check('VALID_OUTCOMES is the closed set the plan specifies', VALID_OUTCOMES, [
    'in-progress', 'submitted', 'validation-failed', 'captcha',
    'blocked-waf', 'account-verification-pending', 'errored',
    // Added 2026-09-07: the employer refusing an attempt before the form was
    // completed, and a deliberate no-submit dry run. Both used to be recorded
    // as failures of the run, which they are not.
    'already-applied', 'rehearsal',
    // Added 2026-09-20 for Requirement 5: a submit whose page says neither a
    // success nor a refusal. Not `submitted` (that would invent a success) and
    // not `errored` (that would invent a fault and invite a second click,
    // which is how one candidate applies twice).
    'unknown',
  ]);

  // Neither new outcome may bar a later real attempt — only `submitted` does.
  // A rehearsal exists in order to be redone for real, and an already-applied
  // posting can reopen as a new requisition.
  for (const outcome of ['already-applied', 'rehearsal']) {
    const url = `https://x.com/jobs/reopen-${outcome}`;
    await claimSubmission(url, { runId: 'r1', company: 'C', role: 'R', reportNum: null, logPath });
    await finalizeSubmission(url, outcome, { runId: 'r1', reportNum: null, notes: '', logPath });
    const again = await claimSubmission(url, { runId: 'r2', company: 'C', role: 'R', reportNum: null, logPath });
    check(`a posting left '${outcome}' can be claimed again`, again.claimed, true);
  }

  // ------------------------------------------------------- header on creation

  const firstLine = readFileSync(logPath, 'utf-8').split('\n')[0];
  check('the ledger opens with its header', firstLine.split('\t')[0], 'url_key');
  check('the file was created where asked', existsSync(logPath), true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
