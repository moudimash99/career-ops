#!/usr/bin/env node

/**
 * site-links.mjs — one tracked link to the personal site per application, and
 * who opened it.
 *
 * The site (machaka.net, repo moudimash99/Personal-Website) serves
 * /r/<code>: it logs the open, sets a cookie that logs the pages read after
 * it, and redirects home. POST /api/links registers a code with who it was
 * for; GET /api/links returns opens, visitors and pages per code.
 *
 * Codes are random and say nothing: `k3m9xq`, never `airbus-k3m9xq`. A
 * readable code tells the recruiter the link is tracked. Who a code belongs
 * to lives only here (data/site-links.tsv) and in the site's registry.
 *
 * A link is only handed out once the site has accepted its registration. Until
 * the tracking build is deployed, /r/<code> is a 404 there, so every caller
 * gets the plain site URL instead and nothing is recorded.
 *
 * Ledger (data/site-links.tsv), append-only:
 *   created — the code was registered for this application (key = posting URL,
 *             else report number). One code per application, reused forever.
 *   used    — the code went into a cv / letter / form.
 *
 * Config (.env or environment): SITE_URL (https://machaka.net) and
 * SITE_ADMIN_KEY (the site's ADMIN_KEY). Without the key nothing is tracked.
 *
 * Usage:
 *   node lib/site-links.mjs link --url <posting> [--report N] [--company C] [--role R] [--used cv|letter|form]
 *   node lib/site-links.mjs clicks [--summary] [--all]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import * as yaml from 'js-yaml';

import { flagValue, hasFlag } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { withPipelineLock } from '../pipeline-lock.mjs';
import normalizeUrl from '../url-key.mjs';
import { loadTrackerRows, statusFor } from './cv-experiment.mjs';

export const LEDGER_RELATIVE_PATH = 'data/site-links.tsv';
const HEADER = ['code', 'key', 'url', 'report', 'company', 'role', 'event', 'timestamp', 'detail'];
const EVENTS = new Set(['created', 'used']);
export const USES = ['cv', 'letter', 'form'];
// Same alphabet as the site's own generator: no 0/o, 1/l/i.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 6;
const TIMEOUT_MS = 8000;

const CODE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * process.env over the .env file(s). The repo's .env is only read when working on
 * the real data root: a test run on a temp root must never register codes on the live site.
 */
export async function readEnv(root) {
  const real = getCareerOpsRoot();
  const files = root && resolve(root) !== resolve(real) ? [join(root, '.env')] : [join(real, '.env'), join(CODE_ROOT, '.env')];
  let fromFiles = {};
  try {
    const { parse } = await import('dotenv');
    for (const f of [...files].reverse()) if (existsSync(f)) fromFiles = { ...fromFiles, ...parse(readFileSync(f)) };
  } catch { /* dotenv optional */ }
  return { ...fromFiles, ...process.env };
}

const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ').trim());
const norm = (n) => String(n ?? '').replace(/^0+(?=\d)/, '');

export function ledgerPath({ logPath, root } = {}) {
  const base = root ?? getCareerOpsRoot();
  if (logPath) return isAbsolute(logPath) ? logPath : join(base, logPath);
  return join(base, LEDGER_RELATIVE_PATH);
}

/** The plain site URL from profile.yml, for when SITE_URL is not set. */
function profileSiteUrl(root) {
  try {
    const p = yaml.load(readFileSync(join(root ?? getCareerOpsRoot(), 'config', 'profile.yml'), 'utf-8'));
    return p?.candidate?.portfolio_url || null;
  } catch { return null; }
}

/** `machaka.net` from `https://www.machaka.net/`. */
export function displayOf(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch { return String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

/** {base, key, display} — base is the plain site URL; key is null when tracking is off. */
export function siteConfig({ env = process.env, root } = {}) {
  const raw = (env.SITE_URL || profileSiteUrl(root) || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return { base, key: (env.SITE_ADMIN_KEY || '').trim() || null, display: displayOf(base) };
}

export function newCode(taken = new Set(), rng = randomBytes) {
  for (;;) {
    const code = Array.from(rng(CODE_LENGTH), (b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!taken.has(code)) return code;
  }
}

/** The code inside a tracked link (`…/r/k3m9xq` → `k3m9xq`), else null. */
export function codeOf(link) {
  const m = /\/r\/([a-z0-9-]{3,40})\/?(?:[?#].*)?$/i.exec(String(link || ''));
  return m ? m[1].toLowerCase() : null;
}

export function readLedger(opts = {}) {
  const path = ledgerPath(opts);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (p[0] === HEADER[0] || p.length < 8) continue;
    const [code, key, url, report, company, role, event, timestamp, ...rest] = p;
    if (!EVENTS.has(event)) continue;
    rows.push({ code, key, url, report: report === '-' ? null : report, company, role, event, timestamp, detail: rest.join(' ') });
  }
  return rows;
}

/** One record per code: {code, key, url, report, company, role, created, used: string[]}. */
export function foldLedger(rows) {
  const byCode = new Map();
  for (const r of rows) {
    let s = byCode.get(r.code);
    if (r.event === 'created') {
      if (s) continue;
      s = { code: r.code, key: r.key, url: r.url, report: r.report, company: r.company, role: r.role, created: r.timestamp, used: [] };
      byCode.set(r.code, s);
    } else if (s && r.event === 'used' && r.detail && !s.used.includes(r.detail)) {
      s.used.push(r.detail);
    }
  }
  return byCode;
}

function appendRow(path, row) {
  const fresh = !existsSync(path);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const line = [row.code, row.key, row.url, row.report ?? '-', row.company, row.role, row.event, new Date().toISOString(), row.detail]
    .map(cell).join('\t');
  appendFileSync(path, `${fresh ? `${HEADER.join('\t')}\n` : ''}${line}\n`, 'utf-8');
}

/** The application's key: its posting URL, else its report number. */
export function keyFor({ url, report }) {
  const u = url ? normalizeUrl(url) : null;
  if (u) return u;
  if (report !== null && report !== undefined && String(report).trim()) return `report:${norm(report)}`;
  return null;
}

function findExisting(state, { key, report }) {
  for (const rec of state.values()) if (rec.key === key) return rec;
  if (report !== null && report !== undefined && String(report).trim()) {
    for (const rec of state.values()) if (rec.report && norm(rec.report) === norm(report)) return rec;
  }
  return null;
}

/**
 * Register a code on the site. 'ok' | 'taken' (the code exists there already) | 'down' (not deployed,
 * unreachable, refused).
 */
export async function registerCode(site, { code, company, role, report, url }, fetchImpl = fetch) {
  const who = [company, role].filter(Boolean).join(' — ') || (report ? `report ${report}` : 'application');
  const note = [report ? `career-ops #${report}` : null, url || null].filter(Boolean).join(' · ');
  try {
    const res = await fetchImpl(`${site.base}/api/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${site.key}` },
      body: JSON.stringify({ code, recipient: who, company: company || undefined, note: note || undefined, target: '/' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 201) return 'ok';
    if (res.status === 409) return 'taken';
    return 'down';
  } catch {
    return 'down';
  }
}

/**
 * The site link for one application. Reuses the application's code; creates and registers one
 * otherwise. Falls back to the plain site URL whenever tracking is unavailable — never throws for that.
 *
 * @returns {Promise<{url: string, display: string, tracked: boolean, code?: string, fresh?: boolean, reason?: string} | null>}
 *   null only when no site is configured at all.
 */
export async function getSiteLink({ url, report = null, company = '', role = '', used = null, root, logPath, env, fetchImpl = fetch } = {}) {
  if (!env) env = await readEnv(root);
  const site = siteConfig({ env, root });
  if (!site) return null;
  const plain = (reason) => ({ url: site.base, display: site.display, tracked: false, reason });
  if (!site.key) return plain('SITE_ADMIN_KEY not set');
  const key = keyFor({ url, report });
  if (!key) return plain('no posting URL or report number');
  if (used && !USES.includes(used)) throw new Error(`--used must be one of ${USES.join(', ')}`);

  const path = ledgerPath({ root, logPath });
  return withPipelineLock(path, async () => {
    const state = foldLedger(readLedger({ logPath: path }));
    let rec = findExisting(state, { key, report });
    let fresh = false;
    if (!rec) {
      const taken = new Set(state.keys());
      for (let attempt = 0; attempt < 3 && !rec; attempt++) {
        const code = newCode(taken);
        const r = await registerCode(site, { code, company, role, report, url }, fetchImpl);
        if (r === 'down') return plain('site did not accept the registration (tracking build not deployed, or unreachable)');
        if (r === 'taken') { taken.add(code); continue; }
        rec = { code, key, url: url || '', report, company, role, used: [] };
        appendRow(path, { ...rec, event: 'created', detail: '' });
        fresh = true;
      }
      if (!rec) return plain('could not find a free code');
    }
    if (used && !rec.used.includes(used)) appendRow(path, { ...rec, event: 'used', detail: used });
    return { url: `${site.base}/r/${rec.code}`, display: site.display, tracked: true, code: rec.code, fresh };
  });
}

/** Record that a tracked link went into a cv / letter / form. No-op for a plain link or an unknown code. */
export async function markUsed(link, used, { root, logPath } = {}) {
  const code = codeOf(link);
  if (!code || !USES.includes(used)) return false;
  const path = ledgerPath({ root, logPath });
  return withPipelineLock(path, async () => {
    const rec = foldLedger(readLedger({ logPath: path })).get(code);
    if (!rec) return false;
    if (!rec.used.includes(used)) appendRow(path, { ...rec, event: 'used', detail: used });
    return true;
  });
}

/** True when `value` is the bare site address (any scheme, www, trailing slash). */
export function isPlainSiteUrl(value, display) {
  if (!display) return false;
  const v = String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  return v === display.toLowerCase();
}

/** Form answers with the bare site URL swapped for the tracked link. Returns [answers, swapped count]. */
export function withSiteLink(answers, link) {
  const display = displayOf(link);
  let swapped = 0;
  const out = answers.map((a) => {
    if (a && typeof a.value === 'string' && isPlainSiteUrl(a.value, display) && a.value.trim() !== link) {
      swapped++;
      return { ...a, value: link };
    }
    return a;
  });
  return [out, swapped];
}

/** Text with every bare mention of the site replaced by the tracked link. */
export function replaceSiteMentions(text, link) {
  const display = displayOf(link);
  if (!display || !codeOf(link)) return text;
  const host = display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:https?://)?(?:www\\.)?${host}(?![\\w/.-]*\\w)/?`, 'gi');
  return String(text).replace(re, link);
}

// ── clicks ─────────────────────────────────────────────────────────────

/** GET /api/links joined with the ledger and the tracker. */
export async function collectClicks({ root, logPath, env, fetchImpl = fetch } = {}) {
  if (!env) env = await readEnv(root);
  const site = siteConfig({ env, root });
  if (!site?.key) throw new Error('SITE_ADMIN_KEY is not set (.env)');
  const res = await fetchImpl(`${site.base}/api/links`, {
    headers: { authorization: `Bearer ${site.key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  });
  if (!res.ok) throw new Error(`${site.base}/api/links answered ${res.status}${res.status === 404 ? ' (tracking build not deployed yet?)' : ''}`);
  const remote = new Map((await res.json()).map((r) => [String(r.code).toLowerCase(), r]));
  const trackerRows = loadTrackerRows(root);
  const out = [];
  for (const rec of foldLedger(readLedger({ root, logPath })).values()) {
    const s = remote.get(rec.code)?.stats || {};
    out.push({
      code: rec.code, report: rec.report, company: rec.company, role: rec.role, url: rec.url, used: rec.used, created: rec.created,
      status: statusFor(rec, trackerRows),
      opens: s.opens || 0, botOpens: s.botOpens || 0, visitors: s.visitors || 0, pageViews: s.pageViews || 0,
      firstOpen: s.firstOpen || null, lastSeen: s.lastSeen || null, pages: s.pages || [], devices: s.devices || [],
    });
  }
  return out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(b.created).localeCompare(String(a.created)));
}

export function printClicks(rows, { all = false } = {}) {
  const opened = rows.filter((r) => r.opens > 0 || r.pageViews > 0);
  const shown = all ? rows : opened;
  console.log(`${rows.length} tracked application(s), ${opened.length} opened by a person.`);
  for (const r of shown) {
    const who = `${r.report ? `#${r.report} ` : ''}${r.company || '?'} — ${r.role || '?'}`;
    const when = r.lastSeen ? r.lastSeen.slice(0, 16).replace('T', ' ') : 'never';
    const pages = r.pages.slice(0, 4).map(([p, n]) => `${p}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    console.log(`\n${who}  [${r.status || 'not in tracker'}]`);
    console.log(`  ${r.code} · in ${r.used.join('+') || '—'} · ${r.opens} open(s)${r.botOpens ? ` (+${r.botOpens} bot)` : ''}, ${r.visitors} person(s), ${r.pageViews} page view(s) · last ${when}`);
    if (pages) console.log(`  read: ${pages}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const usage = 'Usage: node lib/site-links.mjs link --url <u> [--report N] [--company C] [--role R] [--used cv|letter|form]\n       node lib/site-links.mjs clicks [--summary] [--all]';
  try {
    if (cmd === 'link') {
      const r = await getSiteLink({
        url: flagValue(args, '--url') || null,
        report: flagValue(args, '--report') || null,
        company: flagValue(args, '--company') || '',
        role: flagValue(args, '--role') || '',
        used: flagValue(args, '--used') || null,
      });
      if (!r) throw new Error('no site configured (SITE_URL in .env, or candidate.portfolio_url in config/profile.yml)');
      console.log(JSON.stringify(r));
    } else if (cmd === 'clicks') {
      const rows = await collectClicks({ root: getCareerOpsRoot() });
      if (hasFlag(args, '--summary')) printClicks(rows, { all: hasFlag(args, '--all') });
      else console.log(JSON.stringify(rows, null, 2));
    } else {
      console.error(usage);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
