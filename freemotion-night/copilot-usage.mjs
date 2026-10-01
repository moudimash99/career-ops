#!/usr/bin/env node
/**
 * freemotion-night/copilot-usage.mjs — the GitHub Copilot monthly allowance and what
 * each night job cost, so a run can be sized before it hits the limit.
 *
 *   monthly   `gh api copilot_internal/user` (the endpoint the Copilot apps read):
 *             quota_snapshots.premium_interactions = AI credits, entitlement / used /
 *             remaining, and quota_reset_date. Needs `gh auth login`.
 *   per job   tmp/fm/usage/copilot-<N>.json, the `session.usage_checkpoint` event:
 *             totalNanoAiu / 1e9 = AI credits the job used, plus the model(s) `auto` chose.
 *
 * 2026-09-30: 200 credits a month on this plan, ~11-12 per job, so ~17 jobs a month.
 *
 * Usage: node freemotion-night/copilot-usage.mjs [--jobs 20]
 * Read only.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SHOW = Number(argv[argv.indexOf('--jobs') + 1]) || 20;

// Per job: credits and models from each Copilot log, newest last.
const dir = join(ROOT, 'tmp/fm/usage');
const jobs = existsSync(dir) ? readdirSync(dir).filter((f) => /^copilot-\d+\.json$/.test(f))
  .map((f) => ({ n: Number(f.match(/\d+/)[0]), path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => a.mtime - b.mtime) : [];
const perJob = [];
for (const j of jobs) {
  let nano = 0; const models = new Set();
  for (const line of readFileSync(j.path, 'utf8').split('\n')) {
    if (line.includes('"session.usage_checkpoint"')) { try { nano = JSON.parse(line).data.totalNanoAiu || nano; } catch { /* torn */ } }
    const m = line.match(/"model":"([^"]+)"/); if (m) models.add(m[1]);
  }
  if (nano) perJob.push({ n: j.n, credits: nano / 1e9, models: [...models].join(', '), at: new Date(j.mtime) });
}

let q = null;
try {
  const j = JSON.parse(execFileSync('gh', ['api', 'copilot_internal/user'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  q = { plan: j.copilot_plan, reset: j.quota_reset_date, p: j.quota_snapshots?.premium_interactions };
} catch { /* gh missing or not logged in */ }

console.log('Copilot monthly allowance');
if (q?.p) {
  console.log(`  plan ${q.plan}: ${q.p.credits_used} of ${q.p.entitlement} AI credits used, ${q.p.quota_remaining} left (${q.p.percent_remaining}%), resets ${q.reset}`);
} else console.log('  unavailable (needs the GitHub CLI logged in: gh auth login)');

if (perJob.length) {
  const recent = perJob.slice(-SHOW);
  console.log(`\nLast ${recent.length} Copilot job(s): credits used, model chosen by auto`);
  for (const j of recent) console.log(`  ${String(j.n).padEnd(5)} ${j.credits.toFixed(1).padStart(5)}  ${j.models}`);
  const avg = recent.reduce((a, j) => a + j.credits, 0) / recent.length;
  console.log(`\n  average: ${avg.toFixed(1)} credits per job`);
  if (q?.p) console.log(`  → about ${Math.floor(q.p.quota_remaining / avg)} more job(s) this month; a full month (${q.p.entitlement}) is about ${Math.floor(q.p.entitlement / avg)} jobs`);
}
