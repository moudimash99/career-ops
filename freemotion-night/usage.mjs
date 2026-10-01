// node freemotion-night/usage.mjs [run-id] — per-job token use for an overnight run (agy, agy-sonnet, sonnet1, sonnet;
// codex/copilot jobs are listed without tokens: see codex-usage.mjs / copilot-usage.mjs).
// node freemotion-night/usage.mjs --drivers — every run: per driver, jobs and sent, and how many jobs each
// driver did between its limit hits (tmp/fm/usage/limit-hits.tsv, written by run.sh).
// Defaults to the run id in tmp/fm/night/run-id (the last sheets make-jobs.mjs wrote).
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const DRIVERS = process.argv.includes('--drivers');
const RUN = DRIVERS ? null : process.argv[2] ?? readFileSync(`${ROOT}/tmp/fm/night/run-id`, 'utf8').trim();
const runsPath = `${ROOT}/tmp/fm/usage/night-runs.tsv`;
const runs = existsSync(runsPath) ? readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
const ledger = readFileSync(`${ROOT}/data/freemotion-submissions.tsv`, 'utf8').split('\n').map((l) => l.split('\t')).filter((c) => c[7] === RUN);
const k = (x) => (x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(x));
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const tot = { usd: 0, sent: 0, jobs: 0 };
if (DRIVERS) { driverReport(); process.exit(0); }
console.log('job   driver  result             fresh in / cached in / out');
for (const [n, , , d] of runs) {
  const brief = `${ROOT}/tmp/fm/night/job-${n}.md`;
  const url = existsSync(brief) ? (readFileSync(brief, 'utf8').match(/^   (https?:\/\/\S+)/m) ?? [])[1] : null;
  const res = ledger.filter((c) => c[1] === url).at(-1)?.[5] ?? '-';
  const j = read(`${ROOT}/tmp/fm/usage/${d}-${n}.json`);
  let fin = 0, cached = 0, out = 0;
  if (j && d.startsWith('agy')) { fin = j.usage?.input_tokens ?? 0; cached = j.usage?.cache_read_tokens ?? 0; out = j.usage?.output_tokens ?? 0; }
  if (j && d.startsWith('sonnet')) { const u = j.usage ?? {}; fin = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); cached = u.cache_read_input_tokens ?? 0; out = u.output_tokens ?? 0; tot.usd += j.total_cost_usd ?? 0; }
  tot[d] = (tot[d] ?? 0) + fin + cached + out; tot.jobs++; if (res === 'submitted') tot.sent++;
  console.log(`${n}  ${d.padEnd(10)}  ${res.padEnd(17)}  ${k(fin)} / ${k(cached)} / ${k(out)}`);
}
const byDriver = Object.entries(tot).filter(([x]) => !['usd', 'sent', 'jobs'].includes(x)).map(([x, v]) => `${x} ${k(v)}`).join(' · ');
console.log(`TOTAL ${tot.jobs} runs, ${tot.sent} sent · ${byDriver} (Claude ~$${tot.usd.toFixed(2)} list price)`);

function driverReport() {
  // Latest outcome per posting URL, across every run.
  const all = readFileSync(`${ROOT}/data/freemotion-submissions.tsv`, 'utf8').split('\n').map((l) => l.split('\t'));
  const outcome = new Map();
  for (const c of all) if (c[1] && c[5] && c[5] !== 'in-progress') outcome.set(`${c[1]}|${c[7]}`, c[5]);
  const hitsPath = `${ROOT}/tmp/fm/usage/limit-hits.tsv`;
  const hits = existsSync(hitsPath) ? readFileSync(hitsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
  const stats = {};
  for (const [n, start, , d] of runs) {
    const s = (stats[d] ??= { jobs: 0, sent: 0, starts: [] });
    s.jobs++; s.starts.push(start);
    const brief = `${ROOT}/tmp/fm/night/job-${n}.md`;
    const text = existsSync(brief) ? readFileSync(brief, 'utf8') : '';
    const url = (text.match(/^   (https?:\/\/\S+)/m) ?? [])[1];
    const run = (text.match(/--run-id (fm-[\w-]+)/) ?? [])[1];
    if (outcome.get(`${url}|${run}`) === 'submitted') s.sent++;
  }
  console.log('driver      jobs  sent  jobs between limit hits (hit time UTC)');
  for (const [d, s] of Object.entries(stats)) {
    const mine = hits.filter((h) => h[0] === d).map((h) => h[1]).sort();
    let prev = '';
    const per = mine.map((t) => { const c = s.starts.filter((x) => x > prev && x <= t).length; prev = t; return `${c} (${t.slice(5, 16)})`; });
    const since = s.starts.filter((x) => x > prev).length;
    console.log(`${d.padEnd(10)}  ${String(s.jobs).padStart(4)}  ${String(s.sent).padStart(4)}  ${per.join(', ') || '-'}${mine.length ? ` · ${since} since the last hit` : ''}`);
  }
}
