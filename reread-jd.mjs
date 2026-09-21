#!/usr/bin/env node

/**
 * reread-jd.mjs — pull up job descriptions for roles already applied to.
 *
 * WHY THIS EXISTS. After a batch run the only record of what was applied to is
 * a tracker row and a URL. Rereading one means finding the row, copying the
 * link, and opening it — and a posting that has been filled or expired simply
 * will not be there any more. This makes the common case one command, and
 * prefers an archived local copy when one exists.
 *
 * Resolution order for each pick:
 *   1. jds/ — a local capture, via jd-capture.mjs (survives the posting dying)
 *   2. Welcome to the Jungle — full text from its public API, no key needed
 *   3. the URL itself, printed for the browser
 *
 * Usage:
 *   node reread-jd.mjs                      # 3 random, from the whole tracker
 *   node reread-jd.mjs --count 5            # pick 5
 *   node reread-jd.mjs --since 1179         # only rows numbered >= 1179
 *   node reread-jd.mjs --report 1184        # one specific row
 *   node reread-jd.mjs --company napta      # rows whose company matches
 *   node reread-jd.mjs --full               # whole description, not a preview
 *   node reread-jd.mjs --open               # also open each in the browser
 *   node reread-jd.mjs --list               # just the table, no fetching
 *
 * Read-only: it never writes to the tracker or the pipeline.
 */

import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';

const KNOWN_FLAGS = [
  '--count', '--since', '--report', '--company', '--full', '--open', '--list', '--json',
  '--help', '-h',
];
const VALUE_FLAGS = ['--count', '--since', '--report', '--company'];

const WTTJ_API = 'https://api.welcometothejungle.com/api/v1/organizations';
const PREVIEW_CHARS = 1200;

/**
 * Parse the tracker into rows that are actually rereadable: applied, with a URL.
 *
 * Exported for tests.
 *
 * @param {string} markdown
 * @returns {Array<{num:number,date:string,company:string,role:string,status:string,url:string}>}
 */
export function parseAppliedRows(markdown) {
  const out = [];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the empty string before the leading pipe.
    const num = Number(cells[1]);
    if (!Number.isInteger(num) || num <= 0) continue;
    const url = cells[10] || '';
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      num,
      date: cells[2] || '',
      company: cells[3] || '',
      role: cells[4] || '',
      status: cells[6] || '',
      url,
    });
  }
  return out;
}

/**
 * Fisher-Yates, then take n. Using a real shuffle rather than sorting on
 * Math.random() so every subset is equally likely.
 *
 * Exported for tests.
 *
 * @template T
 * @param {T[]} items
 * @param {number} n
 * @returns {T[]}
 */
export function pickRandom(items, n) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}

/** Split a WTTJ posting URL into its organization and job slugs. */
export function parseWttjUrl(url) {
  const m = /welcometothejungle\.com\/[a-z-]+\/companies\/([a-z0-9_-]+)\/jobs\/([a-z0-9_-]+)/i.exec(
    String(url ?? ''),
  );
  return m ? { org: m[1], slug: m[2] } : null;
}

/** Strip tags and collapse whitespace, the way the scan providers do. */
export function htmlToPlain(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Look for a local capture via jd-capture.mjs; never throws. */
function localCapture(num) {
  try {
    const out = execFileSync(process.execPath, ['jd-capture.mjs', '--report', String(num), '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(out);
    const path = parsed?.path || parsed?.file || null;
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Fetch the full WTTJ description; returns null when unavailable. */
async function fetchWttj(url) {
  const parts = parseWttjUrl(url);
  if (!parts) return null;
  try {
    const res = await fetch(`${WTTJ_API}/${parts.org}/jobs/${parts.slug}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const job = (await res.json())?.job;
    if (!job) return null;
    const body = [job.description, job.profile, job.recruitment_process]
      .map(htmlToPlain)
      .filter(Boolean)
      .join('\n\n');
    return body || null;
  } catch {
    return null;
  }
}

function openInBrowser(url) {
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

async function main(argv) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
    return 0;
  }
  validateFlags(argv, KNOWN_FLAGS, VALUE_FLAGS, 'reread-jd.mjs');

  const trackerPath = resolveTrackerPath(getCareerOpsRoot());
  if (!existsSync(trackerPath)) {
    console.error(`reread-jd: no tracker at ${trackerPath}`);
    return 1;
  }

  let rows = parseAppliedRows(readFileSync(trackerPath, 'utf8'));

  const report = flagValue(argv, '--report');
  const since = flagValue(argv, '--since');
  const company = flagValue(argv, '--company');

  if (report) {
    rows = rows.filter((r) => r.num === Number(report));
  } else {
    // Default to things actually sent — rereading a row you never applied to
    // is a different question.
    rows = rows.filter((r) => r.status === 'Applied');
    if (since) rows = rows.filter((r) => r.num >= Number(since));
    if (company) {
      const needle = company.toLowerCase();
      rows = rows.filter((r) => r.company.toLowerCase().includes(needle));
    }
  }

  if (rows.length === 0) {
    console.error('reread-jd: nothing matched. Try --since, --company, or drop the filters.');
    return 2;
  }

  const count = report ? rows.length : Math.max(1, Number(flagValue(argv, '--count') ?? 3));
  const picks = report || company ? rows.slice(0, count) : pickRandom(rows, count);

  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ pool: rows.length, picks }, null, 2));
    return 0;
  }

  console.log(`\n${picks.length} of ${rows.length} applied postings\n`);

  for (const r of picks) {
    console.log('─'.repeat(72));
    console.log(`#${r.num}  ${r.company} — ${r.role}`);
    console.log(`applied ${r.date}   ${r.url}`);

    if (hasFlag(argv, '--open')) {
      console.log(openInBrowser(r.url) ? '  → opened in browser' : '  → could not open a browser');
    }
    if (hasFlag(argv, '--list')) {
      console.log('');
      continue;
    }

    const capture = localCapture(r.num);
    if (capture) {
      console.log(`  archived copy: ${capture}`);
    }

    const text = await fetchWttj(r.url);
    if (text) {
      const full = hasFlag(argv, '--full');
      console.log('');
      console.log(full ? text : text.slice(0, PREVIEW_CHARS) + (text.length > PREVIEW_CHARS ? ' […]' : ''));
    } else if (!capture) {
      console.log('  (no local capture and not a WTTJ posting — open the URL above)');
    }
    console.log('');
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`reread-jd: ${err.message}`);
      process.exit(1);
    });
}
