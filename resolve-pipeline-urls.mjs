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
import { chromium } from 'playwright';

const PIPELINE = 'data/pipeline.md';
const KNOWN = /greenhouse\.io|ashbyhq\.com|lever\.co/;
const apply = process.argv.includes('--apply');

// Aggregator pages (Welcome to the Jungle above all) render their apply link in
// JS, so a plain fetch sees an empty shell. Those need a browser.
const JS_RENDERED = /welcometothejungle\.com/;

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

/**
 * Confirm the rewritten URL actually serves an application form.
 *
 * Checking the API alone is not enough: Datadog's board answers
 * boards-api.greenhouse.io fine, but boards.greenhouse.io/datadog/jobs/{id}
 * 302s straight back to careers.datadoghq.com, which has no Greenhouse form on
 * it. That produced 19 rewrites that all failed later with NO_FORM.
 */
async function verify(hit) {
  if (hit.vendor !== 'greenhouse') return true;
  const m = hit.url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return false;
  try {
    const api = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!api.ok) return false;
    // The board must actually host the form, not bounce back to the brand site.
    const page = await fetch(hit.url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return page.ok && /greenhouse\.io/.test(new URL(page.url).hostname);
  } catch {
    return false;
  }
}

/**
 * Follow an aggregator listing to whatever ATS its Apply button points at.
 * Returns the outbound host as the vendor when it is one we do not adapt, so the
 * report shows what is actually out there rather than just "unresolved".
 */
async function resolveInBrowser(url, ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    const href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(
        (a) => /apply|postuler/i.test(a.textContent || '') && a.href && !/welcometothejungle/.test(a.href)
      );
      return a ? a.href : null;
    });
    if (!href) return { error: 'applies natively on the aggregator (needs an account, sends no CV)' };
    const host = new URL(href).hostname.replace(/^www\./, '');
    if (/lever\.co/.test(host)) {
      const m = href.match(/lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
      return m ? { vendor: 'lever', url: `https://jobs.lever.co/${m[1]}/${m[2]}` } : { error: 'lever link not parseable' };
    }
    if (/greenhouse\.io/.test(host)) {
      const m = href.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
      return m ? { vendor: 'greenhouse', url: `https://boards.greenhouse.io/${m[1]}/jobs/${m[2]}` } : { error: 'greenhouse link not parseable' };
    }
    if (/ashbyhq\.com/.test(host)) {
      const m = href.match(/ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
      return m ? { vendor: 'ashby', url: `https://jobs.ashbyhq.com/${m[1]}/${m[2]}` } : { error: 'ashby link not parseable' };
    }
    return { error: `no adapter for ${host}` };
  } catch (e) {
    return { error: e.message.split(/\n/)[0].slice(0, 50) };
  } finally {
    await page.close().catch(() => {});
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

  const needsBrowser = targets.some((t) => JS_RENDERED.test(t.url));
  const browser = needsBrowser ? await chromium.launch({ headless: true }) : null;
  const ctx = browser ? await browser.newContext() : null;

  const rewrites = [];
  const failures = [];
  let n = 0;
  const queue = targets.slice();

  const worker = async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      const hit = JS_RENDERED.test(t.url) ? await resolveInBrowser(t.url, ctx) : await resolve(t.url);
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
  if (browser) await browser.close();

  const byVendor = {};
  for (const r of rewrites) byVendor[r.vendor] = (byVendor[r.vendor] || 0) + 1;
  console.log(`\n  resolved  ${rewrites.length}`);
  for (const [v, c] of Object.entries(byVendor)) console.log(`     ${String(c).padStart(3)}  ${v}`);
  console.log(`  unresolved ${failures.length}`);
  const reasons = {};
  for (const f of failures) reasons[f.error] = (reasons[f.error] || 0) + 1;
  for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`     ${String(c).padStart(3)}  ${r}`);
  }

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
