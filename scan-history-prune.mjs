#!/usr/bin/env node
// @ts-check
/**
 * scan-history-prune.mjs — remove the rows of data/scan-history.tsv that the
 * scanner would not save today.
 *
 *   node scan-history-prune.mjs            what would go, by reason and source (writes nothing)
 *   node scan-history-prune.mjs --apply    back up, then remove them
 *
 * A row goes when the filter its own source runs today rejects it:
 *   blacklisted   data/blacklist.md
 *   title         job boards: drop / non-fit words (config/targets.yml);
 *                 company boards: the full filter; the full ATS sweep
 *                 (*-full rows): title_filter_full and its overrides
 *   location      portals.yml location_filter
 * Rows from other writers (their `portal` is not `<provider>-api`,
 * `<provider>-full` or `local-parser`) are never touched. The years filter
 * needs posting text, which the history does not keep, so it is not replayed.
 *
 * Why it is safe: a removed row is one the scanner would reject again if it
 * came back, so nothing reappears in pipeline.md. --apply first copies the
 * file to data/scan-history.backup-YYYY-MM-DD.tsv, then rewrites it under the
 * same lock the scanner uses.
 */

import { copyFileSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import * as yaml from 'js-yaml';

import {
  PORTALS_PATH, SCAN_HISTORY_PATH, buildLocationFilter, buildTitleFilterOverrides,
  buildTitleFilterWithOverrides, loadBlacklist, titleFilterFor,
} from './scan.mjs';
import { resolveTitleFilterConfig } from './scan-ats-full.mjs';
import { applyTargets, loadTargets } from './targets.mjs';
import { normalizeCompany, writeFileAtomic } from './tracker-utils.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

/**
 * Why a history row would not be saved today, or null to keep it.
 * @param {Record<string, string>} r - one row by header name
 * @param {{ keepTitle: Function, dropFilter: Function, fullFilter: Function, locationFilter: Function, blacklist: Map<string, unknown> }} f
 * @returns {string|null}
 */
export function pruneReason(r, f) {
  const portal = r.portal || '';
  const m = portal.match(/^([a-z0-9-]+?)-(api|full)$/);
  if (!m && portal !== 'local-parser') return null; // another writer's row: leave it
  if (f.blacklist.size && f.blacklist.get(normalizeCompany(r.company || ''))) return 'blacklisted';
  const title = r.title || '';
  const titleOk = m && m[2] === 'full'
    ? f.fullFilter(title, r.company || '')
    : titleFilterFor(m ? m[1] : 'local-parser', f.keepTitle, f.dropFilter)(title);
  if (!titleOk) return 'title';
  if (!f.locationFilter(r.location || '', r.url || '', title)) return 'location';
  return null;
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const targets = loadTargets();
  if (!targets) { console.error('scan-history-prune: config/targets.yml is missing; nothing to prune against.'); return 1; }
  if (!existsSync(SCAN_HISTORY_PATH)) { console.log(`No ${SCAN_HISTORY_PATH}.`); return 0; }
  const config = /** @type {any} */ (existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf8')) : {}) || {};
  applyTargets(config, targets);
  const filters = {
    keepTitle: targets.keepTitle,
    dropFilter: targets.dropFilter,
    fullFilter: buildTitleFilterWithOverrides(resolveTitleFilterConfig(config), buildTitleFilterOverrides(config.title_filter_overrides)),
    locationFilter: buildLocationFilter(config.location_filter),
    blacklist: loadBlacklist(),
  };

  const text = readFileSync(SCAN_HISTORY_PATH, 'utf8');
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = head.split('\t');
  const keep = [head];
  const byReason = {};
  const samples = {};
  for (const line of lines) {
    const r = Object.fromEntries(line.split('\t').map((v, i) => [cols[i], v]));
    const why = pruneReason(r, filters);
    if (!why) { keep.push(line); continue; }
    const k = `${why} · ${r.portal}`;
    byReason[k] = (byReason[k] || 0) + 1;
    (samples[why] ||= []).length < 8 && samples[why].push(`${r.company} | ${r.title} | ${r.location}`);
  }
  const removed = lines.length - (keep.length - 1);
  console.log(`${SCAN_HISTORY_PATH}: ${lines.length} rows, ${removed} would ${apply ? 'be removed' : 'go'}, ${keep.length - 1} stay.`);
  for (const [k, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  for (const [why, list] of Object.entries(samples)) console.log(`\n${why}, for example:\n${list.map((s) => `  - ${s}`).join('\n')}`);
  if (!apply) { console.log('\nNothing written. Run with --apply to remove them (a backup is made first).'); return 0; }
  if (!removed) return 0;

  const backup = join(dirname(SCAN_HISTORY_PATH), `scan-history.backup-${localToday()}.tsv`);
  await withPipelineLock(SCAN_HISTORY_PATH, () => {
    // Re-read under the lock: a scan may have appended since the count above.
    const now = readFileSync(SCAN_HISTORY_PATH, 'utf8');
    if (now !== text) throw new Error('scan-history.tsv changed while pruning; run it again');
    copyFileSync(SCAN_HISTORY_PATH, backup);
    writeFileAtomic(SCAN_HISTORY_PATH, `${keep.join('\n')}\n`);
  });
  console.log(`\nRemoved ${removed} rows. Backup: ${backup}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`scan-history-prune: ${err.message}`); process.exitCode = 1; });
}
