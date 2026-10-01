// @ts-check
/**
 * freemotion-night/fetch-texts.mjs — the posting text of every job that
 * passed the go / no-go gate, before the full score (make-pool.mjs).
 *
 * Until 2026-09-28 the text was fetched only for the jobs about to be scored
 * that night, and WTJ refused every fetch (403 on our User-Agent) without a
 * word: 65% of the English jobs in the pool had no text, so the model scored
 * them on title, company and place. Now every passed job without a stored text
 * gets one fetch, the text is kept (lib/posting-text.mjs), and a job whose
 * text could not be had is remembered as a miss and asked again only after
 * MISS_RETRY_DAYS, so a night never repeats the same work. No model is called.
 *
 * A network error or a 429 / 5xx is not the posting's fault: it is not kept
 * as a miss, so the next run asks again; 10 network errors in a row stop the
 * run as offline (2026-09-28: the machine lost its connection mid-backfill and
 * ~890 postings were wrongly parked for 3 days).
 *
 * Problems are raised, not just logged: a site that gives nothing back (10+
 * tries, under 20% text) or jobs left over when the time budget ran out each
 * add one item to data/agent-inbox.md, which the next session reads first.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { tryFetchPostingText, textSiteOf } from '../lib/posting-fetch.mjs';
import { loadMisses, loadPostingTexts, saveMisses, savePostingTexts } from '../lib/posting-text.mjs';

const SAVE_EVERY = 25;
/** Network errors in a row that mean the machine is offline (not a site problem). */
export const OFFLINE_AFTER = 10;
/** Not the posting's fault: asked again next run, never remembered as a miss. */
export const isTransient = (why) => /^network:|^http (429|5\d\d)$|^bot challenge$/.test(why || '');
/** A site is broken when it gave text to fewer than this share of 10+ tries. */
export const ALARM_MIN_TRIES = 10;
export const ALARM_MAX_SHARE = 0.2;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return '?'; } };

/**
 * Fetch and store the text of every job without one.
 * @param {Array<{ url: string }>} jobs - best first: the time budget cuts the tail
 * @param {{ root: string, today: string, now?: () => number, maxMinutes?: number,
 *   fetchOne?: typeof tryFetchPostingText, log?: (m: string) => void }} opts
 */
export async function fetchMissingTexts(jobs, { root, today, now = Date.now, maxMinutes = 120, fetchOne = tryFetchPostingText, log = () => {} }) {
  const urls = [...new Set(jobs.map((j) => j.url))];
  const had = loadPostingTexts(root, urls);
  const misses = loadMisses(root, { now: now() });
  /** @type {Record<string, number>} */
  const unreadable = {};
  const todo = [];
  let recentMiss = 0;
  for (const url of urls) {
    if (had.has(url)) continue;
    if (!textSiteOf(url)) { const h = hostOf(url); unreadable[h] = (unreadable[h] || 0) + 1; continue; }
    if (misses.has(url)) { recentMiss++; continue; }
    todo.push(url);
  }

  /** @type {Record<string, { tried: number, got: number, why: Record<string, number> }>} */
  const bySite = {};
  /** @type {Map<string, string>} */
  const got = new Map();
  let texts = [], missed = [];
  const flush = () => {
    if (texts.length) savePostingTexts(root, texts, today);
    if (missed.length) saveMisses(root, missed, { now: now() });
    texts = []; missed = [];
  };
  const deadline = now() + maxMinutes * 60_000;
  let done = 0;
  let netInARow = 0;
  let offline = false;
  for (const url of todo) {
    if (now() > deadline) break;
    if (netInARow >= OFFLINE_AFTER) { offline = true; break; }
    let r;
    try { r = await fetchOne(url); } catch (err) { r = { site: textSiteOf(url), text: null, why: `network: ${String(err?.message || err).slice(0, 60)}` }; }
    const s = (bySite[r.site || '?'] ??= { tried: 0, got: 0, why: {} });
    s.tried++;
    if (r.text) { s.got++; got.set(url, r.text); texts.push({ url, text: r.text }); }
    else {
      const why = r.why || 'no text';
      s.why[why] = (s.why[why] || 0) + 1;
      if (!isTransient(why)) missed.push({ url, why });
    }
    netInARow = /^network:/.test(r.why || '') ? netInARow + 1 : 0;
    done++;
    if (done % SAVE_EVERY === 0) { flush(); log(`fetch-texts: ${done}/${todo.length} (${got.size} with text)`); }
  }
  flush();
  if (offline) log(`fetch-texts: ${OFFLINE_AFTER} network errors in a row, stopping (offline?); ${todo.length - done} left for the next run`);
  return { total: urls.length, had: had.size, got, bySite, left: todo.length - done, offline, recentMiss, unreadable };
}

/**
 * Sites that gave text to almost none of their tries.
 * @param {Record<string, { tried: number, got: number, why: Record<string, number> }>} bySite
 * @returns {string[]}
 */
export function textAlarms(bySite) {
  return Object.entries(bySite)
    .filter(([, s]) => s.tried >= ALARM_MIN_TRIES && s.got / s.tried < ALARM_MAX_SHARE)
    .map(([site, s]) => `${site}: text for ${s.got} of ${s.tried} (${Object.entries(s.why).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} x${n}`).join(', ')})`);
}

/** One summary line for make-pool's report. */
export function textLine(r) {
  const sites = Object.entries(r.bySite).map(([k, s]) => `${k} ${s.got}/${s.tried}`).join(', ');
  const withText = r.had + r.got.size;
  const pct = r.total ? Math.round((100 * withText) / r.total) : 100;
  const top = Object.entries(r.unreadable).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, n]) => `${h} ${n}`).join(', ');
  return `  text: ${withText} of ${r.total} passed jobs have it (${pct}%) | fetched now: ${sites || 'none needed'}`
    + `${r.left ? ` | ${r.left} left for the next run (${r.offline ? 'network down' : 'time budget'})` : ''}${r.recentMiss ? ` | ${r.recentMiss} failed recently, retried after 3 days` : ''}`
    + `${top ? ` | no reader for: ${top}` : ''}`;
}

/**
 * Put each problem in data/agent-inbox.md once (skipped while an open item
 * for it is still there).
 * @param {string} root
 * @param {string[]} problems - each starts with a stable key before the first ':'
 * @param {{ inboxCli?: string }} [opts]
 */
export function raiseInInbox(root, problems, { inboxCli = join(root, 'agent-inbox.mjs') } = {}) {
  const path = join(root, 'data/agent-inbox.md');
  const open = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- [ ]')) : [];
  const raised = [];
  for (const p of problems) {
    const key = `posting text — ${p.split(':')[0]}`;
    if (open.some((l) => l.includes(key))) continue;
    const r = spawnSync(process.execPath, [inboxCli, 'add', `${key}: ${p.slice(p.indexOf(':') + 1).trim()}`], { cwd: root, encoding: 'utf8' });
    if (r.status === 0) raised.push(key);
  }
  return raised;
}

/** Everything make-pool needs to raise after a text run. */
export function textProblems(r) {
  const out = textAlarms(r.bySite).map((a) => `${a} — the site may be blocking us; check lib/posting-fetch.mjs, then run node freemotion-night/make-pool.mjs --no-llm --texts-only`);
  if (r.left) out.push(`backlog: ${r.left} passed jobs still have no text (${r.offline ? 'the network went down mid-run' : "the night's time budget ran out"}); run node freemotion-night/make-pool.mjs --no-llm --texts-only`);
  return out;
}
