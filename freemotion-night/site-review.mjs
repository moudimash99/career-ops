#!/usr/bin/env node

/**
 * freemotion-night/site-review.mjs — the weekly site review. Zero tokens.
 *
 *   node freemotion-night/site-review.mjs [--days 7]
 *
 * Every night list sends agy to every application site except the ones on
 * data/site-blacklist.md. This report shows, per site, how agy's attempts
 * ended over the last --days days (from data/freemotion-submissions.tsv), so
 * the user can decide which sites to add to the blacklist. It only suggests;
 * it never edits the blacklist.
 *
 * A site is SUGGESTED when it has at least 2 failed attempts and no success in
 * the window. "Failed" = captcha, blocked-waf, validation-failed,
 * account-verification-pending, errored. A closed posting also lands in
 * `errored`, which is not the site's fault — the notes column is shown so the
 * reader can tell the two apart.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { readCurrentState } from '../lib/freemotion-submissions.mjs';
import { isBlockedSite, parseSiteBlacklist } from './make-pool.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAILED = new Set(['captcha', 'blocked-waf', 'validation-failed', 'account-verification-pending', 'errored']);

const siteOf = (u) => {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    // Group company tenants of one system under the system: thales.wd3.myworkdayjobs.com → myworkdayjobs.com
    const m = h.match(/(myworkdayjobs\.com|greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|icims\.com|teamtailor\.com|recruitee\.com|workable\.com|successfactors\.(?:com|eu)|taleo\.net|flatchr\.io)$/);
    return m ? m[1] : h;
  } catch {
    return '';
  }
};

/**
 * Per-site tally of attempts in the window. Pure; exported for tests.
 * @param {Iterable<{rawUrl: string, outcome: string, timestamp: string, notes: string}>} rows
 * @param {number} sinceMs
 */
export function tallySites(rows, sinceMs) {
  const sites = new Map();
  for (const r of rows) {
    if (!r || r.outcome === 'rehearsal' || r.outcome === 'in-progress') continue;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    const site = siteOf(r.rawUrl);
    if (!site) continue;
    const s = sites.get(site) || { site, sent: 0, failed: 0, outcomes: {}, notes: [], sampleUrl: r.rawUrl };
    if (r.outcome === 'submitted') s.sent++;
    else if (FAILED.has(r.outcome)) {
      s.failed++;
      if (r.notes && s.notes.length < 2) s.notes.push(r.notes.slice(0, 90));
    }
    s.outcomes[r.outcome] = (s.outcomes[r.outcome] || 0) + 1;
    sites.set(site, s);
  }
  return [...sites.values()].map((s) => ({ ...s, suggest: s.failed >= 2 && s.sent === 0 }))
    .sort((a, b) => (b.suggest - a.suggest) || (b.failed - a.failed) || (b.sent - a.sent));
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--days');
  const days = i >= 0 ? Number(argv[i + 1]) : 7;
  const blPath = join(ROOT, 'data/site-blacklist.md');
  const blocked = existsSync(blPath) ? parseSiteBlacklist(readFileSync(blPath, 'utf8')) : [];
  const rows = tallySites(readCurrentState().values(), Date.now() - days * 86_400_000);

  console.log(`Site review — agy's attempts over the last ${days} days (practice runs not counted)\n`);
  if (!rows.length) { console.log('No attempts in this window.'); return; }
  console.log('sent  failed  site                              outcomes');
  for (const s of rows) {
    const mark = isBlockedSite(`https://${s.site}/`, blocked) ? '  [already blacklisted]' : s.suggest ? '  <- suggested' : '';
    console.log(`${String(s.sent).padStart(4)}  ${String(s.failed).padStart(6)}  ${s.site.padEnd(33)} ${JSON.stringify(s.outcomes)}${mark}`);
    for (const n of s.notes) console.log(`${' '.repeat(14)}note: ${n}`);
  }
  const suggested = rows.filter((s) => s.suggest && !isBlockedSite(`https://${s.site}/`, blocked));
  if (suggested.length) {
    const today = new Date().toISOString().slice(0, 10);
    console.log('\nTo blacklist a suggested site, add its row to data/site-blacklist.md:');
    for (const s of suggested) console.log(`| ${s.site} | ${today} | ${s.failed} failed, 0 sent in ${days} days: <why> |`);
  }
}

if (isMainModule(import.meta.url)) main();
