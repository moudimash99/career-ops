#!/usr/bin/env node
// @ts-check

/**
 * targets.mjs — the ONE place that says which jobs we look for.
 *
 * Reads config/targets.yml (override: CAREER_OPS_TARGETS) and hands the same
 * lists to every tool that used to keep its own copy:
 *
 *   scan.mjs, scan-ats-full.mjs   applyTargets(config): `title_filter` comes from
 *                                 the targets, and a job-board block without its
 *                                 own `queries:` searches with the targets' words
 *   freemotion-night/pool-rules   judgeTitle(): keep / drop / points / rank low
 *
 * Matching is title-keywords.mjs's, the scanner's own: one dialect, not two.
 * A keyword written with accents also matches the title typed without them.
 *
 *   node targets.mjs check    what portals.yml still says that the targets now own
 *
 * Without config/targets.yml every function here is a no-op and the scanner
 * behaves exactly as before.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

import { compileKeyword, compilePositiveKeyword } from './title-keywords.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export const TARGETS_PATH = process.env.CAREER_OPS_TARGETS || join(getCareerOpsRoot(), 'config/targets.yml');

/**
 * Job-board providers that take search words, and the portals.yml block each
 * one reads them from (`entry[block].queries`).
 */
export const QUERY_PROVIDERS = ['wttj', 'apec', 'hellowork', 'freework', 'francetravail', 'linkedin'];

const words = (v) => (Array.isArray(v) ? v : [])
  .filter((k) => typeof k === 'string')
  .map((k) => k.trim())
  .filter(Boolean);

const unaccent = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');

/**
 * Every keyword, plus its accent-free spelling when it has accents:
 * "ingénieur data" → ["ingénieur data", "ingenieur data"]. Order kept, no repeats.
 * @param {string[]} list
 * @returns {string[]}
 */
export function withAccentFree(list) {
  const out = [];
  for (const k of list) {
    for (const v of [k, unaccent(k)]) if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Read config/targets.yml. `null` when the file does not exist; throws on a
 * file that exists but cannot be used (a broken targets file must stop a scan,
 * not quietly let every title through).
 * @param {string} [path]
 */
export function loadTargets(path = TARGETS_PATH) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
  return compileTargets(raw, path);
}

/**
 * Validate and compile the parsed YAML.
 * @param {any} raw
 * @param {string} [where] - for error messages
 */
export function compileTargets(raw, where = 'targets') {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: expected a mapping with \`tiers:\``);
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) throw new Error(`${where}: \`tiers:\` must be a non-empty list`);

  const tiers = raw.tiers.map((t, i) => {
    if (!t || typeof t !== 'object' || typeof t.points !== 'number') throw new Error(`${where}: tier ${i + 1} needs a numeric \`points:\``);
    if (!t.groups || typeof t.groups !== 'object') throw new Error(`${where}: tier ${i + 1} needs \`groups:\``);
    const groups = Object.entries(t.groups).map(([name, g]) => {
      const match = words(g?.match);
      if (match.length === 0) throw new Error(`${where}: group "${name}" has no \`match:\` words`);
      const all = withAccentFree(match);
      const tests = all.map((k) => compilePositiveKeyword(k.toLowerCase()));
      return { name, search: words(g?.search), match, all, test: (lower) => tests.some((m) => m(lower)) };
    });
    return { points: t.points, groups };
  });

  const drop = Object.entries(raw.drop && typeof raw.drop === 'object' ? raw.drop : {}).map(([name, list]) => {
    const all = withAccentFree(words(list));
    const tests = all.map((k) => compileKeyword(k.toLowerCase()));
    return { name, all, test: (lower) => tests.some((m) => m(lower)) };
  });

  const rankLowAll = withAccentFree(words(raw.rank_low));
  const rankLowTests = rankLowAll.map((k) => compileKeyword(k.toLowerCase()));

  // A rescue word beats every drop list: "Presales Engineer" carries "sales".
  const rescueAll = withAccentFree(words(raw.rescue));
  const rescueTests = rescueAll.map((k) => compileKeyword(k.toLowerCase()));
  const isRescued = (lower) => rescueTests.some((m) => m(lower));
  // Other fields: drop a title only when none of our role words is in it.
  const nonFitAll = withAccentFree(words(raw.non_fit));
  const nonFitTests = nonFitAll.map((k) => compileKeyword(k.toLowerCase()));
  const isNonFit = (lower) => nonFitTests.some((m) => m(lower));

  const groups = tiers.flatMap((t) => t.groups);
  const hasGroup = (lower) => groups.some((g) => g.test(lower));
  /** The drop list's name (or 'non_fit'), or null when the title is kept. */
  const dropReason = (lower) => {
    if (isRescued(lower)) return null;
    const hit = drop.find((d) => d.test(lower));
    if (hit) return hit.name;
    return isNonFit(lower) && !hasGroup(lower) ? 'non_fit' : null;
  };

  let tooManyYears = null;
  if (raw.too_many_years != null) {
    if (typeof raw.too_many_years !== 'number' || !(raw.too_many_years > 0)) {
      throw new Error(`${where}: \`too_many_years:\` must be a positive number`);
    }
    tooManyYears = raw.too_many_years;
  }
  if (raw.candidate != null && (typeof raw.candidate !== 'object' || Array.isArray(raw.candidate))) {
    throw new Error(`${where}: \`candidate:\` must be a mapping`);
  }
  const candidate = raw.candidate ?? null;

  const searchWords = [];
  for (const g of groups) for (const q of g.search) if (!searchWords.includes(q)) searchWords.push(q);

  return {
    tiers,
    groups,
    drop,
    rescue: rescueAll,
    nonFit: nonFitAll,
    searchWords,
    tooManyYears,
    candidate,
    /**
     * The scanner's title filter as keyword lists: any group's (or rescue)
     * words in, any drop word out. `non_fit` needs no entry: with a match word
     * required, a non-fit title is only ever kept when it has a role word too,
     * which is exactly the non_fit rule. A plain list cannot say "unless a
     * rescue word is there too", so a reader that can take a function should
     * use keepTitle() / dropFilter() instead.
     */
    titleFilter: {
      positive: [...groups.flatMap((g) => g.all), ...rescueAll],
      negative: drop.flatMap((d) => d.all),
    },
    /**
     * Drop and non-fit words only: true when the title is kept. For job
     * boards, which already searched with our words.
     * @param {string} title
     */
    dropFilter(title) {
      return dropReason(String(title ?? '').toLowerCase()) === null;
    },
    /**
     * The full filter: a group's word or a rescue word, and no drop word
     * (rescue words beat drop words).
     * @param {string} title
     */
    keepTitle(title) {
      const lower = String(title ?? '').toLowerCase();
      if (dropReason(lower) !== null) return false;
      return isRescued(lower) || hasGroup(lower);
    },
    /**
     * One title against the targets.
     * @param {string} title
     * @returns {{ dropped: string|null, groups: string[], points: number, rankLow: boolean, rescued: boolean, unsure: boolean }}
     *   `dropped` is the drop list's name (or 'non_fit'), or null; `groups` in
     *   file order; `unsure` = a non-fit word next to a role word, for the
     *   model to decide.
     */
    judgeTitle(title) {
      const lower = String(title ?? '').toLowerCase();
      const matched = [];
      let points = 0;
      for (const t of tiers) {
        const hits = t.groups.filter((g) => g.test(lower));
        if (hits.length) points += t.points; // once per tier, however many of its groups match
        matched.push(...hits.map((g) => g.name));
      }
      const dropped = dropReason(lower);
      const rescued = isRescued(lower);
      return {
        dropped,
        groups: matched,
        points,
        rankLow: rankLowTests.some((m) => m(lower)),
        rescued,
        unsure: dropped === null && !rescued && matched.length > 0 && isNonFit(lower),
      };
    },
  };
}

/**
 * Put the targets into a parsed portals.yml, in place.
 *   - `title_filter.positive` / `.negative` are replaced by the targets' lists
 *     (the rest of title_filter, and title_filter_full, are left alone);
 *   - every job-board entry whose provider takes search words and whose block
 *     has no `queries:` of its own gets the targets' search words. WTJ is only
 *     filled when its block has no `filters:` either, since filters alone are
 *     a complete WTJ search.
 * @param {any} config - parsed portals.yml
 * @param {ReturnType<typeof compileTargets>|null} targets
 * @returns {string[]} one line per change, for the scan log
 */
export function applyTargets(config, targets) {
  if (!targets || !config || typeof config !== 'object') return [];
  const notes = [];
  const old = config.title_filter && typeof config.title_filter === 'object' ? config.title_filter : {};
  if (words(old.positive).length || words(old.negative).length) {
    notes.push('title_filter.positive/negative in portals.yml are ignored: config/targets.yml sets them');
  }
  config.title_filter = { ...old, ...targets.titleFilter };

  if (targets.searchWords.length === 0) return notes;
  const entries = [config.job_boards, config.tracked_companies].filter(Array.isArray).flat();
  for (const entry of entries) {
    const block = entry && QUERY_PROVIDERS.includes(entry.provider) ? entry.provider : null;
    if (!block) continue;
    const cfg = entry[block] && typeof entry[block] === 'object' ? entry[block] : {};
    if (words(cfg.queries).length) continue; // its own list wins
    if (block === 'wttj' && cfg.filters) continue;
    entry[block] = { ...cfg, queries: [...targets.searchWords] };
    notes.push(`${entry.name || block}: searching with ${targets.searchWords.length} word${targets.searchWords.length === 1 ? '' : 's'} from config/targets.yml`);
  }
  return notes;
}

// ── CLI: `check` ─────────────────────────────────────────────────────────

function check() {
  const targets = loadTargets();
  if (!targets) {
    console.log(`No ${TARGETS_PATH}: the scanner uses portals.yml as before.`);
    return 0;
  }
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  console.log(`${TARGETS_PATH}: ${n(targets.groups.length, 'group')}, ${n(targets.titleFilter.positive.length, 'match word')}, ${n(targets.titleFilter.negative.length, 'drop word')}, ${n(targets.nonFit.length, 'non-fit word')}, ${n(targets.rescue.length, 'rescue word')}, ${n(targets.searchWords.length, 'search word')}`);
  console.log(targets.tooManyYears ? `Postings asking ${targets.tooManyYears}+ years are not saved.` : 'No years limit (too_many_years is not set).');
  const unset = Object.entries(targets.candidate || {}).filter(([, v]) => v == null).map(([k]) => k);
  if (!targets.candidate) console.log('No candidate: block, so the night list\'s model has nothing to score against.');
  else if (unset.length) console.log(`candidate: still to fill in: ${unset.join(', ')}`);

  let portals = null;
  const portalsPath = process.env.CAREER_OPS_PORTALS || join(getCareerOpsRoot(), 'portals.yml');
  if (existsSync(portalsPath)) portals = yaml.load(readFileSync(portalsPath, 'utf8'));
  if (!portals || typeof portals !== 'object') {
    console.log(`No ${portalsPath} to compare with.`);
    return 0;
  }

  let leftovers = 0;
  const tf = portals.title_filter || {};
  for (const side of ['positive', 'negative']) {
    const list = words(tf[side]);
    if (!list.length) continue;
    leftovers++;
    console.log(`\nportals.yml title_filter.${side} (${list.length} words) is ignored now. Words the targets do not cover:`);
    // A word "is covered" when the targets would treat it, read as a title, the same way.
    const uncovered = list.filter((w) => {
      const j = targets.judgeTitle(w.replace(/^(word|stem):/, ''));
      return side === 'positive' ? j.groups.length === 0 : j.dropped === null;
    });
    console.log(uncovered.length ? uncovered.map((w) => `  - ${w}`).join('\n') : '  (none)');
  }

  const entries = [portals.job_boards, portals.tracked_companies].filter(Array.isArray).flat();
  for (const entry of entries) {
    const block = entry && QUERY_PROVIDERS.includes(entry.provider) ? entry.provider : null;
    const queries = block ? words(entry[block]?.queries) : [];
    if (!queries.length) continue;
    leftovers++;
    console.log(`\n${entry.name || block} (${block}.queries, used instead of the targets' search words):`);
    for (const q of queries) {
      const g = targets.judgeTitle(q).groups[0];
      console.log(`  - ${q.padEnd(34)} ${g ? `→ group ${g}` : '→ no group (titles it finds still have to match a group)'}${targets.searchWords.includes(q) ? '' : '   [not in targets]'}`);
    }
  }
  console.log(leftovers ? '\nMove what is still needed into config/targets.yml, then delete it from portals.yml.' : '\nportals.yml holds no role lists: config/targets.yml is the only one.');
  return 0;
}

if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd !== 'check') {
    console.error('Usage: node targets.mjs check');
    process.exitCode = 1;
  } else {
    try { process.exitCode = check(); } catch (err) { console.error(err.message); process.exitCode = 1; }
  }
}
