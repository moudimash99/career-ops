// @ts-check
/**
 * lib/posting-text.mjs — a short, local cache of posting text for the night
 * list's model (freemotion-night/llm-score.mjs).
 *
 * Most boards send the posting text with their search results (France
 * Travail, APEC, Free-Work, the company ATS APIs), but scan-history.tsv keeps
 * titles only. The scanner saves the start of each new posting's text here,
 * and the night list reads it back by URL instead of downloading it again.
 * HelloWork, WTJ and LinkedIn send no description: the night list fetches
 * their text and saves it here too.
 *
 *   data/posting-text/YYYY-MM-DD.jsonl.gz   one {"url","text"} per line
 *
 * One file per day, each write appended as its own gzip member (gunzip reads
 * them as one stream). Files older than KEEP_DAYS are deleted on write: the
 * night list only looks back 14 days. Local only: data/* is not in git.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';

// The profile / requirements often come after the company blurb, so keep
// enough to reach them (the providers' own DESCRIPTION_CAP).
export const MAX_CHARS = 4000;
export const KEEP_DAYS = 16;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/;
const DAY_MS = 86_400_000;

/** @param {string} root */
export const postingTextDir = (root) => join(root, 'data/posting-text');

/** Collapse whitespace and cut to MAX_CHARS. */
export function clipText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/**
 * Append texts for the day's new postings; entries without text are skipped.
 * Deletes day files older than KEEP_DAYS.
 * @param {string} root
 * @param {Array<{ url: string, text?: string, description?: string }>} items
 * @param {string} date - YYYY-MM-DD
 * @returns {number} how many were saved
 */
export function savePostingTexts(root, items, date) {
  const lines = [];
  for (const it of items) {
    const text = clipText(it.text ?? it.description);
    if (it.url && text) lines.push(JSON.stringify({ url: it.url, text }));
  }
  const dir = postingTextDir(root);
  if (lines.length) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${date}.jsonl.gz`), gzipSync(`${lines.join('\n')}\n`));
  }
  prunePostingTexts(root, date);
  return lines.length;
}

/**
 * Delete day files more than KEEP_DAYS before `today`.
 * @param {string} root
 * @param {string} today - YYYY-MM-DD
 */
export function prunePostingTexts(root, today) {
  const dir = postingTextDir(root);
  if (!existsSync(dir)) return;
  const cutoff = Date.parse(today) - KEEP_DAYS * DAY_MS;
  for (const f of readdirSync(dir)) {
    const m = f.match(FILE_RE);
    if (m && Date.parse(m[1]) < cutoff) unlinkSync(join(dir, f));
  }
}

/**
 * Texts for the given URLs, newest file first (a later save wins).
 * @param {string} root
 * @param {Iterable<string>} urls
 * @returns {Map<string, string>}
 */
export function loadPostingTexts(root, urls) {
  const want = new Set(urls);
  const found = new Map();
  const dir = postingTextDir(root);
  if (!want.size || !existsSync(dir)) return found;
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().reverse();
  for (const f of files) {
    let body;
    try {
      body = gunzipSync(readFileSync(join(dir, f))).toString('utf8');
    } catch {
      continue; // a torn write loses that day's cache, never the night run
    }
    for (const line of body.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (want.has(row.url) && !found.has(row.url) && typeof row.text === 'string') found.set(row.url, row.text);
    }
    if (found.size === want.size) break;
  }
  return found;
}
