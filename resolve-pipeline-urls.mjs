#!/usr/bin/env node
/**
 * resolve-pipeline-urls.mjs — rewrite branded career-page URLs to the ATS URL underneath.
 *
 * Most company career sites are a skin over Greenhouse, Lever or Ashby.
 * careers.datadoghq.com/detail/7194969/?gh_jid=7194969 IS a Greenhouse job — the
 * gh_jid is the Greenhouse job id and the page names the board token in its embed
 * (`for=datadog`). The appliers' parseUrl only recognises the vendor domains, so
 * these rows were being skipped as "not a greenhouse url" — 18 Datadog jobs among
 * them, plus MongoDB, Elastic, Cribl, Platform.sh and others.
 *
 * This rewrites data/pipeline.md in place so the existing adapters pick them up.
 * No applier changes needed.
 *
 * Dry run by default — data/pipeline.md is user layer.
 *
 *   node resolve-pipeline-urls.mjs           # report what it would rewrite
 *   node resolve-pipeline-urls.mjs --apply
 */

import fs from 'fs';

const PIPELINE = 'data/pipeline.md';
const KNOWN = /greenhouse\.io|ashbyhq\.com|lever\.co/;
const apply = process.argv.includes('--apply');

/** Vendor fingerprints, in the order they are worth trying. */
async function resolve(url) {
  let html;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { error: `http ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { error: e.message.split('\n')[0].slice(0, 60) };
  }

  // Greenhouse: the job id rides in the URL as gh_jid, the board token appears in
  // the embed as for={token}.
  const ghId = url.match(/[?&]gh_jid=(\d+)/)?.[1] ?? html.match(/gh_jid[=":\s]+(\d+)/)?.[1];
  const ghToken =
    html.match(/for=([a-zA-Z0-9_-]+)/)?.[1] ??
    html.match(/boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/)?.[1];
  if (ghId && ghToken && ghToken !== 'embed') {
    return { vendor: 'greenhouse', url: `https://boards.greenhouse.io/${ghToken}/jobs/${ghId}` };
  }

  const lever = html.match(/jobs\.lever\.co\/([a-zA-Z0-9_-]+)\/([0-9a-f-]{36})/i);
  if (lever) return { vendor: 'lever', url: `https://jobs.lever.co/${lever[1]}/${lever[2]}` };

  const ashby = html.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9_-]+)\/([0-9a-f-]{36})/i);
  if (ashby) return { vendor: 'ashby', url: `https://jobs.ashbyhq.com/${ashby[1]}/${ashby[2]}` };

  return { error: 'no known ATS fingerprint on the page' };
}

/** Confirm the rewritten URL actually resolves before trusting it. */
async function verify(hit) {
  if (hit.vendor !== 'greenhouse') return true;
  const m = hit.url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return false;
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`, {
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const text = fs.readFileSync(PIPELINE, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n');

  let inPending = false;
  const targets = [];
  lines.forEach((line, i) => {
    if (/^## /.test(line)) { inPending = /^## Pending/i.test(line); return; }
    if (!inPending) return;
    const m = line.match(/^- \[ \] (\S+)/);
    if (!m || KNOWN.test(m[1])) return;
    targets.push({ i, url: m[1], company: line.split('|')[1]?.trim() ?? '' });
  });

  console.log(`\n${targets.length} pending row(s) on unadapted hosts\n`);
  if (!targets.length) return;

  const rewrites = [];
  const failures = [];
  let n = 0;
  const queue = targets.slice();

  const worker = async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const hit = await resolve(t.url);
      if (hit.url && (await verify(hit))) {
        rewrites.push({ ...t, ...hit });
        console.log(`  ✓ ${t.company.padEnd(22)} -> ${hit.vendor}`);
      } else {
        failures.push({ ...t, error: hit.error ?? 'rewritten url did not resolve' });
      }
      if (++n % 10 === 0) process.stdout.write(`  ...${n}/${targets.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));

  const byVendor = {};
  for (const r of rewrites) byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
  console.log(`\n  resolved  ${rewrites.length}`);
  for (const [v, c] of Object.entries(byVendor)) console.log(`     ${String(c).padStart(3)}  ${v}`);
  console.log(`  unresolved ${failures.length}`);
  for (const f of failures.slice(0, 8)) console.log(`     ${f.company.padEnd(22)} ${f.error}`);
  if (failures.length > 8) console.log(`     ...and ${failures.length - 8} more`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.\n');
    return;
  }
  for (const r of rewrites) lines[r.i] = lines[r.i].replace(r.url, r.url);
  for (const r of rewrites) {
    lines[r.i] = lines[r.i].replace(/^- \[ \] \S+/, `- [ ] ${r.url}`);
  }
  fs.writeFileSync(PIPELINE, lines.join('\n'));
  console.log(`\nRewrote ${rewrites.length} URL(s) in ${PIPELINE}.\n`);
}

main().catch((e) => { console.error(`\nfatal: ${e.message}\n`); process.exit(1); });
