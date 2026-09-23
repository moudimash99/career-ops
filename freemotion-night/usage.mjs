// node freemotion-night/usage.mjs [run-id] — per-job token use for an overnight run (agy or Sonnet driver).
// Defaults to the run id in tmp/fm/night/run-id (the last sheets make-jobs.mjs wrote).
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const RUN = process.argv[2] ?? readFileSync(`${ROOT}/tmp/fm/night/run-id`, 'utf8').trim();
const runsPath = `${ROOT}/tmp/fm/usage/night-runs.tsv`;
const runs = existsSync(runsPath) ? readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
const ledger = readFileSync(`${ROOT}/data/freemotion-submissions.tsv`, 'utf8').split('\n').map((l) => l.split('\t')).filter((c) => c[7] === RUN);
const k = (x) => (x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(x));
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const tot = { agy: 0, sonnet: 0, usd: 0, sent: 0, jobs: 0 };
console.log('job   driver  result             fresh in / cached in / out');
for (const [n, , , d] of runs) {
  const brief = `${ROOT}/tmp/fm/night/job-${n}.md`;
  const url = existsSync(brief) ? (readFileSync(brief, 'utf8').match(/^   (https?:\/\/\S+)/m) ?? [])[1] : null;
  const res = ledger.filter((c) => c[1] === url).at(-1)?.[5] ?? '-';
  const j = read(`${ROOT}/tmp/fm/usage/${d}-${n}.json`);
  let fin = 0, cached = 0, out = 0;
  if (j && d === 'agy') { fin = j.usage?.input_tokens ?? 0; cached = j.usage?.cache_read_tokens ?? 0; out = j.usage?.output_tokens ?? 0; }
  if (j && d === 'sonnet') { const u = j.usage ?? {}; fin = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); cached = u.cache_read_input_tokens ?? 0; out = u.output_tokens ?? 0; tot.usd += j.total_cost_usd ?? 0; }
  tot[d] += fin + cached + out; tot.jobs++; if (res === 'submitted') tot.sent++;
  console.log(`${n}  ${d.padEnd(6)}  ${res.padEnd(17)}  ${k(fin)} / ${k(cached)} / ${k(out)}`);
}
console.log(`TOTAL ${tot.jobs} runs, ${tot.sent} sent · agy ${k(tot.agy)} · sonnet ${k(tot.sonnet)} (~$${tot.usd.toFixed(2)} list price)`);
