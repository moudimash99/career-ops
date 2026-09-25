// tests/cv-experiment.test.mjs — the 15/50/35 CV experiment ledger and its
// hook into Free Motion work orders.
//
// What must hold for the results to mean anything:
//   - a posting keeps its first arm (a retry can't re-roll),
//   - only SENT postings are counted,
//   - a failed tailored build that fell back to the generic CV is its own group,
//   - a skipped posting (blacklisted) never draws an arm.
//
// Run: node test-all.mjs --only cv-experiment

import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ncv-experiment — arm draw, ledger, report, Free Motion hook');

const exp = await import(pathToFileURL(join(ROOT, 'lib/cv-experiment.mjs')).href);
const { resolveWorkOrder } = await import(pathToFileURL(join(ROOT, 'freemotion-run.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

// Deterministic PRNG (mulberry32) so the weight test never flakes.
const seeded = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── 1. Weights ────────────────────────────────────────────────────────────
{
  const rng = seeded(42);
  const counts = { generic: 0, loose: 0, strict: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) counts[exp.drawArm(exp.DEFAULT_WEIGHTS, rng)]++;
  const pct = (a) => (counts[a] / N) * 100;
  const near = (a, target) => Math.abs(pct(a) - target) < 1.5;
  if (near('generic', 15) && near('loose', 50) && near('strict', 35)) {
    pass(`draws land near 15/50/35 (${pct('generic').toFixed(1)}/${pct('loose').toFixed(1)}/${pct('strict').toFixed(1)})`);
  } else {
    fail(`draws off target: ${JSON.stringify(counts)}`);
  }
  check('a zero-weight arm is never drawn',
    Array.from({ length: 500 }, () => exp.drawArm({ generic: 0, loose: 1, strict: 0 }, rng)).every(a => a === 'loose'), true);
}

// ── 2. Ledger: stable arm, sent-only counting, fallback group ───────────────
const roots = [];
const makeRoot = (tracker = '') => {
  const root = mkdtempSync(join(tmpdir(), 'cv-exp-'));
  roots.push(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'reports'), { recursive: true });
  if (tracker) writeFileSync(join(root, 'data', 'applications.md'), tracker);
  return root;
};

{
  const root = makeRoot();
  const url = 'https://jobs.example.com/role/1?utm_source=x';
  const first = await exp.assignArm(url, { company: 'Acme', role: 'SRE', root, rng: () => 0.9 });
  check('first draw is fresh', first.fresh, true);
  check('rng 0.9 draws strict (last 35%)', first.arm, 'strict');
  const again = await exp.assignArm('https://jobs.example.com/role/1', { company: 'Acme', role: 'SRE', root, rng: () => 0.0 });
  check('same posting (tracking params stripped) keeps its arm', [again.arm, again.fresh], ['strict', false]);

  let threw = false;
  try { await exp.markSent('https://jobs.example.com/never-assigned', 'x.pdf', { root }); } catch { threw = true; }
  check('sent without an assignment is refused', threw, true);

  const forced = await exp.assignArm('https://jobs.example.com/role/2', { root, forceArm: 'generic' });
  check('--force-arm pins the arm', forced.arm, 'generic');
}

{
  const tracker = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 10 | 2026-09-01 | Acme | Data Engineer | 4.0/5 | Interview | ✅ | [10](../reports/010-acme-2026-09-01.md) | — |
| 11 | 2026-09-01 | Globex | Cloud Engineer | 4.0/5 | Rejected | ✅ | [11](../reports/011-globex-2026-09-01.md) | — |
| 12 | 2026-09-01 | Initech | SRE | 4.0/5 | Applied | ✅ | — | — |
`;
  const root = makeRoot(tracker);
  const a = 'https://a.example/1', b = 'https://b.example/2', c = 'https://c.example/3', d = 'https://d.example/4';
  await exp.assignArm(a, { report: '10', company: 'Acme', role: 'Data Engineer', root, forceArm: 'loose' });
  await exp.assignArm(b, { report: '11', company: 'Globex', role: 'Cloud Engineer', root, forceArm: 'strict' });
  await exp.assignArm(c, { company: 'Initech', role: 'SRE', root, forceArm: 'loose' });
  await exp.assignArm(d, { company: 'Nobody', role: 'X', root, forceArm: 'generic' });
  await exp.markSent(a, 'a.pdf', { root });
  await exp.markSent(b, 'b.pdf', { root });
  await exp.markFallback(c, 'rendercv missing', { root });
  await exp.markSent(c, 'generic.pdf', { root });
  // d is assigned but never sent: must not count anywhere.

  const trackerRows = (await import(pathToFileURL(join(ROOT, 'find.mjs')).href))
    .parseTrackerRows(tracker);
  const groups = exp.buildReport(exp.foldLedger(exp.readLedger({ root })), trackerRows);
  check('loose: 1 sent, 1 callback (Interview, matched by report #)', [groups.loose.sent, groups.loose.callbacks], [1, 1]);
  check('strict: 1 sent, 1 rejected', [groups.strict.sent, groups.strict.rejected], [1, 1]);
  check('fallback kept apart from loose, matched by company + role', [groups.fallback.sent, groups.fallback.pending], [1, 1]);
  check('assigned-but-never-sent counts nowhere', groups.generic.sent, 0);
  check('callback rate is a percentage', groups.loose.callbackRate, 100);
  check('small samples are flagged', groups.loose.enoughData, false);
}

// ── 3. Free Motion hook ─────────────────────────────────────────────────────
{
  const URL_OK = 'https://boards.greenhouse.io/acme/jobs/1111';
  const URL_BLOCKED = 'https://careers.badco.com/jobs/3333';
  const root = makeRoot(`# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-08-01 | Acme | Staff Engineer | 4.2/5 | Evaluated | ✅ | — | — | ${URL_OK} |
| 3 | 2026-08-03 | BadCo | Backend | 4.9/5 | Evaluated | ✅ | — | — | ${URL_BLOCKED} |
`);
  mkdirSync(join(root, 'documents'), { recursive: true });
  writeFileSync(join(root, 'documents', 'generic.pdf'), '%PDF-1.4 fixture');
  writeFileSync(join(root, 'config', 'apply-answers.yml'), 'resume: "documents/generic.pdf"\n');
  writeFileSync(join(root, 'data', 'blacklist.md'), '| Company | Reason |\n|---|---|\n| BadCo | test |\n');

  const generic = await resolveWorkOrder({ report: 1, root, runId: 'fm-exp-1', forceArm: 'generic' });
  check('work order carries cvArm', generic.workOrder?.cvArm, 'generic');
  check('generic arm uploads the generic CV', generic.workOrder?.pdfPath?.endsWith('generic.pdf'), true);

  const root2 = makeRoot(`# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
| 1 | 2026-08-01 | Acme | Staff Engineer | 4.2/5 | Evaluated | ✅ | — | — | ${URL_OK} |
`);
  const loose = await resolveWorkOrder({ report: 1, root: root2, runId: 'fm-exp-2', forceArm: 'loose' });
  check('tailored arm leaves pdfPath null for the mode to build', [loose.workOrder?.cvArm, loose.workOrder?.pdfPath], ['loose', null]);
  check('work order carries a letter arm too', ['none', 'short', 'full'].includes(loose.workOrder?.letterArm), true);

  const blocked = await resolveWorkOrder({ report: 3, root, runId: 'fm-exp-3' });
  check('a blacklisted posting is refused', blocked.reason, 'blacklisted');
  const drawn = exp.foldLedger(exp.readLedger({ root }));
  check('...and draws no arm', [...drawn.values()].some(r => r.company === 'BadCo'), false);
}

for (const r of roots) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
