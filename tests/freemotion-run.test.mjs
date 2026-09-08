// tests/freemotion-run.test.mjs — the front door: resolve one posting, claim it.
//
// The assertion that matters most is the second call. Resolving the SAME row
// twice must not hand back two work orders: the claim happens here, before the
// browser opens, because at submit time two concurrent runs have already both
// filled the form. A duplicate application is the most visible failure this
// system can produce to an employer and it cannot be walked back.
//
// The second is ordering: the blacklist gate runs BEFORE the claim, so a
// company the user refuses to apply to never gets a row in the ledger. A claim
// is a promise to attempt; a refused posting was never attempted.
//
// Run: node test-all.mjs --only freemotion-run

import { pass, fail, run, rmSync, NODE, ROOT } from './helpers.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-run — work-order resolution and claim');

const { resolveWorkOrder, EXPECTED_REFUSALS } =
  await import(pathToFileURL(join(ROOT, 'freemotion-run.mjs')).href);
const { readCurrentState } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-submissions.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

// ── Fixture root ──────────────────────────────────────────────────────────
const ACME_URL = 'https://boards.greenhouse.io/acme/jobs/1111';
const BEST_URL = 'https://jobs.lever.co/best/2222';
const BLOCKED_URL = 'https://careers.badco.com/jobs/3333';

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'fm-run-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-08-01 | Acme | Staff Engineer | 4.2/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-08-01.md) | — | ${ACME_URL} |
| 2 | 2026-08-02 | Best Co | Platform Lead | 4.7/5 | Evaluated | ✅ | [2](../reports/002-best-co-2026-08-02.md) | — | ${BEST_URL} |
| 3 | 2026-08-03 | BadCo | Backend | 4.9/5 | Evaluated | ✅ | [3](../reports/003-badco-2026-08-03.md) | — | ${BLOCKED_URL} |
| 4 | 2026-08-04 | Slow Co | Analyst | 3.1/5 | Evaluated | ✅ | — | — | https://slow.example/jobs/4 |
| 5 | 2026-08-05 | Sent Co | SRE | 4.8/5 | Applied | ✅ | — | already gone | https://sent.example/jobs/5 |
| 6 | 2026-08-06 | NoPdf Co | Data | 4.6/5 | Evaluated | ❌ | — | no CV yet | https://nopdf.example/jobs/6 |
| 7 | 2026-08-07 | Backfill Co | Ops | N/A | Evaluated | ✅ | — | backfilled, never evaluated | https://backfill.example/jobs/7 |
`);
  // Padded report filename resolved from an unpadded tracker number.
  writeFileSync(join(root, 'reports', '001-acme-2026-08-01.md'),
    '# Acme — Staff Engineer\n\n**Score:** 4.2/5\n**URL:** https://reports-say-this.example/acme\n');
  writeFileSync(join(root, 'reports', '002-best-co-2026-08-02.md'), '# Best Co\n');
  writeFileSync(join(root, 'reports', '003-badco-2026-08-03.md'), '# BadCo\n');
  return root;
};

const roots = [];
const freshRoot = () => { const r = makeRoot(); roots.push(r); return r; };

// ── 1. A clean row resolves, and claims itself ────────────────────────────
let root = freshRoot();
let result = await resolveWorkOrder({ report: 1, root, runId: 'fm-test-1' });
check('--report 1 resolves to a work order', result.ok, true);
check('  ...with the row\'s URL', result.workOrder.url, ACME_URL);
check('  ...its company and role', [result.workOrder.company, result.workOrder.role],
  ['Acme', 'Staff Engineer']);
check('  ...and the report file, found by unpadded number',
  result.workOrder.reportPath.endsWith('001-acme-2026-08-01.md'), true);
check('  ...carrying the engine config, so agy never re-reads profile.yml',
  result.workOrder.engineConfig.browser, 'chromium');
check('  ...and no PDF or draft answers in a fixture with neither',
  [result.workOrder.pdfPath, result.workOrder.draftAnswers], [null, null]);

// ── 2. The same row, immediately again: refused, not re-issued ────────────
const second = await resolveWorkOrder({ report: 1, root, runId: 'fm-test-2' });
check('the same row a second time is refused', [second.ok, second.reason], [false, 'in-progress']);
check('  ...and the ledger holds exactly one claim for it',
  readCurrentState({ root }).size, 1);

// ── 3. The blacklist gate runs BEFORE the claim ───────────────────────────
root = freshRoot();
writeFileSync(join(root, 'data', 'blacklist.md'), `| Company | Since | Scope | Reason |
|---|---|---|---|
| BadCo | 2026-01-01 | all | unpaid trial period |
`);
result = await resolveWorkOrder({ report: 3, root, runId: 'fm-test-3' });
check('a blacklisted company is refused', [result.ok, result.reason], [false, 'blacklisted']);
check('  ...with the user\'s own reason', result.detail, 'unpaid trial period');
check('  ...and NOTHING was written to the ledger', readCurrentState({ root }).size, 0);
check('  ...matching is punctuation/case-insensitive like every other tracker writer',
  (await resolveWorkOrder({ url: BLOCKED_URL, company: 'badco.', role: 'Backend', root })).reason,
  'blacklisted');

// ── 4. --next takes the highest score, skipping what it may not touch ─────
root = freshRoot();
writeFileSync(join(root, 'data', 'blacklist.md'), `| Company | Since | Scope | Reason |
|---|---|---|---|
| BadCo | 2026-01-01 | all | unpaid trial period |
`);
result = await resolveWorkOrder({ next: true, root, runId: 'fm-next-1' });
check('--next skips the blacklisted 4.9 and takes the 4.7',
  [result.ok, result.workOrder.company, result.workOrder.url], [true, 'Best Co', BEST_URL]);
check('  ...and the blacklisted row still has no ledger entry',
  [...readCurrentState({ root }).values()].map((r) => r.company), ['Best Co']);

result = await resolveWorkOrder({ next: true, root, runId: 'fm-next-2' });
check('--next again moves down to the next unclaimed row',
  [result.ok, result.workOrder.company], [true, 'Acme']);

result = await resolveWorkOrder({ next: true, minScore: 4.5, root, runId: 'fm-next-3' });
check('--min-score excludes everything left', [result.ok, result.reason], [false, 'no-eligible-row']);
check('  ...and says how many rows it considered', /score>=4.5/.test(result.detail), true);

// The three rows --next must never pick up, each for its own reason.
root = freshRoot();
const picked = [];
for (let i = 0; i < 5; i++) {
  const r = await resolveWorkOrder({ next: true, root, runId: `fm-drain-${i}` });
  if (!r.ok) break;
  picked.push(r.workOrder.company);
}
check('--next drains only the eligible rows, best score first',
  picked, ['BadCo', 'Best Co', 'Acme', 'Slow Co']);
check('  ...never an already-Applied row, a row with no PDF, or an unscored backfill',
  picked.some((c) => ['Sent Co', 'NoPdf Co', 'Backfill Co'].includes(c)), false);

// ── 5. Ad-hoc --url: no report, same claim discipline ──────────────────────
root = freshRoot();
result = await resolveWorkOrder({
  url: 'https://elsewhere.example/jobs/9', company: 'Elsewhere', role: 'Engineer', root, runId: 'fm-adhoc',
});
check('--url resolves with no report, PDF or draft answers',
  [result.ok, result.workOrder.reportNum, result.workOrder.reportPath, result.workOrder.pdfPath],
  [true, null, null, null]);
check('  ...and is claimed like any other posting',
  [...readCurrentState({ root }).values()].map((r) => r.outcome), ['in-progress']);

check('a URL that cannot be keyed is refused rather than attempted',
  (await resolveWorkOrder({ url: 'not a url', company: 'X', role: 'Y', root })).reason, 'unkeyable');

// ── 6. Not found, and the URL fallback through the report header ──────────
root = freshRoot();
result = await resolveWorkOrder({ report: 99, root });
check('an unknown --report is not-found, not a silent no-op',
  [result.ok, result.reason], [false, 'not-found']);
check('  ...and names the tracker it looked in', /applications\.md/.test(result.detail), true);

// A row predating the optional URL column still resolves, through its report.
root = freshRoot();
const noUrlTracker = readFileSync(join(root, 'data', 'applications.md'), 'utf-8')
  .replace(` ${ACME_URL} |`, ' — |');
writeFileSync(join(root, 'data', 'applications.md'), noUrlTracker);
result = await resolveWorkOrder({ report: 1, root, runId: 'fm-fallback' });
check('a row with no URL cell falls back to the report\'s **URL:** header',
  [result.ok, result.workOrder.url], [true, 'https://reports-say-this.example/acme']);

// ── 7. CLI exit codes are the branch agy takes ────────────────────────────
root = freshRoot();
const cli = (args) => run(NODE, ['freemotion-run.mjs', '--root', root, ...args]);

const ok = JSON.parse(cli(['--report', '1', '--run-id', 'fm-cli-1']));
check('CLI --report prints a work order and exits 0', [ok.ok, ok.workOrder.company], [true, 'Acme']);
check('  ...a repeat exits non-zero rather than issuing a second order',
  cli(['--report', '1', '--run-id', 'fm-cli-2']), null);
check('  ...neither --report nor --url nor --next is a usage error', cli([]), null);
check('  ...and so are two modes at once', cli(['--next', '--report', '1']), null);
check('  ...and a non-numeric --report', cli(['--report', 'acme']), null);

check('the expected-refusal set is the one agy branches on',
  EXPECTED_REFUSALS.slice().sort(),
  ['already-submitted', 'blacklisted', 'in-progress', 'no-eligible-row', 'unkeyable']);

for (const r of roots) rmSync(r, { recursive: true, force: true });
