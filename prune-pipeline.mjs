#!/usr/bin/env node
/**
 * prune-pipeline.mjs — retro-apply portals.yml filters to an existing data/pipeline.md.
 *
 * Why this exists: portals.yml shipped with every filter block commented out, so
 * scan.mjs ran with `buildLocationFilter(undefined)` — which returns `() => true` —
 * and 5195 pending rows accumulated across every country. Enabling the filters
 * only affects FUTURE scans; the backlog stays as it is. This applies the same
 * filters to the rows already on disk.
 *
 * It reuses scan.mjs's own filter and blacklist code rather than reimplementing
 * the matching rules, so a row pruned here is exactly a row the scanner would not
 * have added.
 *
 * Nothing is deleted. data/pipeline.md is user layer: rejected rows move to
 * data/pipeline-archive.md with the reason, and rows whose location string cannot
 * be judged ("2 Locations") move to a "Needs review" section rather than being
 * silently dropped.
 *
 * Usage:
 *   node prune-pipeline.mjs            # dry run — prints the buckets, writes nothing
 *   node prune-pipeline.mjs --apply    # rewrite pipeline.md + archive
 */

import fs from 'fs';
import * as yaml from 'js-yaml';
import { buildLocationFilter, loadBlacklist, locationHintFromUrl } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';

const PIPELINE = 'data/pipeline.md';
const ARCHIVE = 'data/pipeline-archive.md';

// A location the provider reports as a bare count tells us nothing about which
// country any of those places is in, so it can be neither kept nor rejected.
const OPAQUE_LOCATION_RE = /^\d+\s+locations?$/i;

const apply = process.argv.includes('--apply');

/** `- [ ] {url} | {company} | {title} | {location} | posted: {date}` */
function parseRow(line) {
  const m = line.match(/^- \[ \] (\S+)(.*)$/);
  if (!m) return null;
  const parts = m[2].split('|').map((s) => s.trim()).filter(Boolean);
  return {
    line,
    url: m[1],
    company: parts[0] || '',
    title: parts[1] || '',
    location: parts[2] || '',
  };
}

function main() {
  if (!fs.existsSync(PIPELINE)) throw new Error(`${PIPELINE} not found`);
  const config = yaml.load(fs.readFileSync('portals.yml', 'utf8'));
  if (!config.location_filter) {
    throw new Error('portals.yml has no active location_filter — configure it before pruning');
  }
  const passesLocation = buildLocationFilter(config.location_filter);
  const blacklist = loadBlacklist();

  const text = fs.readFileSync(PIPELINE, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n');

  // Everything before "## Pending" is the header; everything from "## Processed"
  // (or whatever heading follows) onward is preserved untouched.
  //
  // "## Needs review" is deliberately read back IN as input, not treated as
  // tail: a re-run after widening the filters must be able to promote a row out
  // of review, which makes the script idempotent and re-runnable.
  const pendingIdx = lines.findIndex((l) => /^## Pending/i.test(l));
  if (pendingIdx === -1) throw new Error(`${PIPELINE}: no "## Pending" section`);
  let tailIdx = lines.findIndex((l, i) => i > pendingIdx && /^## /.test(l) && !/^## Needs review/i.test(l));
  if (tailIdx === -1) tailIdx = lines.length;

  const head = lines.slice(0, pendingIdx + 1);
  const body = lines.slice(pendingIdx + 1, tailIdx);
  const tail = lines.slice(tailIdx);

  const keep = [];
  const review = [];
  const archived = [];
  const other = []; // non-row lines inside Pending (blank lines, stray notes)

  for (const line of body) {
    if (/^## Needs review/i.test(line) || /^<!-- Location reported as a bare count/.test(line)) continue;
    const row = parseRow(line);
    if (!row) {
      if (line.trim()) other.push(line);
      continue;
    }
    const key = normalizeCompany(row.company);
    if (key && blacklist.has(key)) {
      archived.push({ row, reason: `blacklist: ${blacklist.get(key).company}` });
      continue;
    }
    if (OPAQUE_LOCATION_RE.test(row.location)) {
      // "2 Locations" says nothing, but many ATS URLs carry the city in the path
      // (.../job/Orsay-Essonne-France/...). Judge on that when it exists; only a
      // row with neither a usable location nor a usable URL goes to review.
      //
      // The title is deliberately withheld from passesLocation here and below:
      // scan.mjs:356 titleSignalsRemote is a last-resort widener that rescues any
      // row whose title says "Remote", which for a France-only search means a
      // "Sr. Manager - Remote" in California comes back as a keep.
      const hint = locationHintFromUrl(row.url);
      if (!hint) { review.push(row); continue; }
      if (passesLocation('', row.url)) keep.push(row);
      else archived.push({ row, reason: `location (from url): ${hint}` });
      continue;
    }
    if (!passesLocation(row.location, row.url)) {
      archived.push({ row, reason: `location: ${row.location || '(empty)'}` });
    } else {
      keep.push(row);
    }
  }

  console.log(`\n${PIPELINE}: ${keep.length + review.length + archived.length} pending rows\n`);
  console.log(`  keep          ${String(keep.length).padStart(5)}   pass the France filter`);
  console.log(`  needs review  ${String(review.length).padStart(5)}   opaque location ("2 Locations")`);
  console.log(`  archived      ${String(archived.length).padStart(5)}   -> ${ARCHIVE}`);

  const byReason = {};
  for (const a of archived) {
    const k = a.reason.startsWith('blacklist') ? a.reason : 'location';
    byReason[k] = (byReason[k] || 0) + 1;
  }
  console.log('\n  archive reasons:');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(5)}  ${k}`);
  }

  const kept = {};
  for (const r of keep) kept[r.company] = (kept[r.company] || 0) + 1;
  console.log('\n  kept, by company:');
  for (const [k, v] of Object.entries(kept).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${String(v).padStart(5)}  ${k}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply once the buckets look right.\n');
    return;
  }

  const out = [
    ...head,
    '',
    ...keep.map((r) => r.line),
    ...(other.length ? ['', ...other] : []),
    '',
    '## Needs review',
    '',
    '<!-- Location reported as a bare count by the ATS; decide by hand, then move up to Pending. -->',
    '',
    ...review.map((r) => r.line),
    '',
    ...tail,
  ];
  fs.writeFileSync(PIPELINE, out.join('\n'));

  const stamp = new Date().toISOString().slice(0, 10);
  const archiveLines = [
    ...(fs.existsSync(ARCHIVE) ? [fs.readFileSync(ARCHIVE, 'utf8').replace(/\s+$/, ''), ''] : ['# Pipeline Archive', '', 'Rows removed from `data/pipeline.md` by `prune-pipeline.mjs`. Nothing here is deleted — move a row back to Pending to reconsider it.', '']),
    `## Pruned ${stamp}`,
    '',
    ...archived.map((a) => `${a.row.line}  <!-- ${a.reason} -->`),
    '',
  ];
  fs.writeFileSync(ARCHIVE, archiveLines.join('\n'));

  console.log(`\nWrote ${PIPELINE} (${keep.length} pending, ${review.length} needs review)`);
  console.log(`Wrote ${ARCHIVE} (+${archived.length} rows)\n`);
}

main();
