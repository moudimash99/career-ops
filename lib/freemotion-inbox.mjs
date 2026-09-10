#!/usr/bin/env node

/**
 * freemotion-inbox.mjs — the inbox seam that turns
 * `account-verification-pending` from a terminal outcome into a resumable one
 * (Phase 9 of docs/freemotion-implementation-plan.md, the descope named in
 * §1.2).
 *
 * WHAT THIS IS. A registration wall ends a Free Motion run: the account is
 * created, the credentials are saved, and the posting is parked because
 * somebody has to open an email and click a link. This module reads that
 * email and hands the orchestrator ONE link to click. Like every other
 * `lib/freemotion-*.mjs` file it opens no browser and clicks nothing itself —
 * it is a pure data transform that prints JSON, and `agy` does the navigating
 * with its own MCP session (§1.5).
 *
 * THE EMAIL IS UNTRUSTED EXTERNAL CONTENT (AGENTS.md → "Untrusted External
 * Content"), and that is not a formality here — it is the entire security
 * design of this file. Everywhere else in career-ops an untrusted string is
 * read for *content*; here it would be read for *an action*: navigate to this
 * address. An inbox is the one input channel any stranger can write to, so
 * "the newest mail says click here" is a one-hop path from a spam message to
 * the orchestrator driving a real browser, carrying a real session, to an
 * attacker's page. Three rules keep that closed, and none of them may be
 * relaxed for convenience:
 *
 *   1. **Recency + addressee.** Only mail delivered inside the verification
 *      window (default 30 minutes) and addressed to the candidate's own
 *      address is considered at all. A registration that happened minutes ago
 *      is the only thing this module is ever resuming.
 *   2. **Same-site or nothing, automatically.** A link is auto-clickable only
 *      when its registrable site equals the registrable site of the domain
 *      the account was created on. A link anywhere else is reported to the
 *      user with its host spelled out and is NOT returned as clickable —
 *      opt in per-run with `--trust-cross-site` (or
 *      `freemotion.email_verification.trust_cross_site: true`) when you have
 *      looked at it yourself. This is generic, not a vendor table: no ATS
 *      name appears anywhere in this file (Requirement 1).
 *   3. **Nothing in the email chooses.** Ranking is done by this code against
 *      a fixed token list, over URLs only. Prose in the body — including
 *      prose addressed to "the AI" — is never read as an instruction, and an
 *      anchor text saying "click here to verify" can raise a link's score but
 *      can never make a cross-site link same-site.
 *
 * TWO SOURCES, ONE DECISION PATH. `--from-file` parses an email the user
 * pasted or exported (the `paste-reply.mjs` shape: a `Subject:`/`From:`/`To:`
 * header block, then the body), and Gmail is read over the API using the same
 * `GMAIL_*` credentials the bundled gmail plugin already documents. Both
 * normalize to the same `{from, to, subject, body, dateMs}` record and go
 * through the identical classifier, so the offline path is not a lesser one:
 * a user with no OAuth set up gets the same guard rails, and the tests cover
 * the security rules without a network.
 *
 * WHY THE GMAIL CALLS ARE NOT IMPORTED FROM `plugins/gmail/`. That plugin is
 * a bundled reference seed, explicitly frozen to security and compat fixes
 * and designed to be superseded by a user's own package. Importing it from
 * `lib/` would make a replaceable optional plugin a hard dependency of the
 * core applier and freeze its internals as an API. The ~30 lines of token
 * refresh and base64url body decoding are re-stated here instead, deliberately.
 *
 * Usage:
 *   node lib/freemotion-inbox.mjs pending [--root <path>]
 *   node lib/freemotion-inbox.mjs check --domain <hostname> [--email <e>]
 *        [--window-minutes N] [--max N] [--trust-cross-site] [--root <path>]
 *   node lib/freemotion-inbox.mjs check --domain <hostname> --from-file <path>
 *
 * Exit codes (`check`):
 *   0  a link is ready to click — `{"status":"ready","link":...}`
 *   2  expected "nothing to click yet" — no-message / no-link / cross-site-only
 *   1  usage error or an unexpected failure
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import * as yaml from 'js-yaml';

import { flagValue, hasFlag, safeIntFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { readCurrentState } from './freemotion-submissions.mjs';

/** Raised for a caller error this module can name precisely. */
export class FreemotionInboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreemotionInboxError';
  }
}

/**
 * Defaults for the three tunables.
 *
 * `windowMinutes` is 30 rather than a day because the only thing this module
 * resumes is a registration the same operator performed minutes ago; a wide
 * window buys nothing and widens the target for rule 1 above.
 */
export const INBOX_DEFAULTS = {
  windowMinutes: 30,
  maxMessages: 20,
  trustCrossSite: false,
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Second-level registry labels that are NOT the registrable site on their own.
 *
 * Deliberately a short heuristic and not the Public Suffix List: pulling the
 * PSL in would add a dependency and a staleness problem to a check whose only
 * failure mode here is being too STRICT. {@link siteOf} keeps three labels
 * whenever it is unsure, and an over-long site string can only ever demote a
 * link from same-site to cross-site — which reports it to the user instead of
 * clicking it. The unsafe direction is unreachable by construction.
 */
const SECOND_LEVEL_REGISTRIES = new Set([
  'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'mil', 'or', 'ne', 'gouv',
]);

/**
 * URL substrings that disqualify a link outright.
 *
 * A verification mail carries a footer, and every footer link is a live URL
 * on the sender's own domain — so same-site alone does not make a link the
 * right one. Clicking "unsubscribe" while resuming a registration would
 * silently cost the candidate the rest of that employer's mail.
 */
const DENY_TOKENS = [
  'unsubscribe', 'optout', 'opt-out', 'opt_out', 'desabonn', 'abmelden',
  'privacy', 'confidentialite', 'datenschutz', 'terms', 'cgu', 'legal',
  'cookie', 'preferences', 'manage-subscription', 'report-abuse', 'spam',
];

/**
 * Substrings that mark a link as the verification link.
 *
 * Multilingual because the candidate applies across markets and an ATS sends
 * in the tenant's locale; French and German first after English because that
 * is where this build is aimed. Matched case-insensitively against the URL,
 * and separately against the anchor text (worth less — see {@link scoreLink}).
 */
const VERIFY_TOKENS = [
  'verify', 'verification', 'verif', 'confirm', 'confirmation', 'activate',
  'activation', 'validate', 'validation', 'authenticate', 'email-confirm',
  'confirmer', 'verifier', 'valider', 'activer', 'bestatig', 'bestätig',
  'aktivier', 'confirmar', 'verificar', 'activar', 'conferma', 'verifica',
];

/** Query parameters that carry a one-time credential, a weak positive signal. */
const TOKEN_PARAMS = ['token', 'code', 'key', 'confirmation_token', 'verification_code', 'otp', 'nonce', 't'];

/**
 * The registrable site of a hostname — the unit "same site" is measured in.
 *
 * @param {string} hostname - e.g. `"careers.eu.example.co.uk"`.
 * @returns {string} e.g. `"example.co.uk"`. Empty string for input that is not
 *   a dotted hostname (an IP literal, `localhost`, garbage) — and an empty
 *   site never equals another empty site in {@link classifyLink}, so
 *   unparseable hosts fail closed rather than all matching each other.
 */
export function siteOf(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (host === '' || /^[\d.]+$/.test(host) || host.includes(':')) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const secondLast = labels.at(-2);
  // Keep three labels whenever the second-to-last looks like a registry label
  // rather than a name — see SECOND_LEVEL_REGISTRIES on why erring long is the
  // safe direction.
  const keep = labels.length > 2 && (SECOND_LEVEL_REGISTRIES.has(secondLast) || secondLast.length <= 2) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Undo the entity encoding an HTML mail part applies to `&` in query strings. */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * Every http(s) URL in an email body, with the anchor text that pointed at it.
 *
 * Handles both parts of a normal multipart mail: `href="..."` attributes from
 * the HTML alternative, and bare URLs from the text one. The same link
 * appearing in both is collapsed, keeping whichever occurrence carried anchor
 * text, so a body's own duplication does not double-rank it.
 *
 * @param {string} body
 * @returns {{url: string, text: string}[]} In first-seen order.
 */
export function extractLinks(body) {
  const source = decodeEntities(String(body ?? ''));
  /** @type {Map<string, {url: string, text: string}>} */
  const found = new Map();

  const add = (rawUrl, text) => {
    // Trailing punctuation is sentence punctuation, not part of the URL.
    const url = String(rawUrl).trim().replace(/[).,;:'"\]>]+$/, '');
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const prior = found.get(url);
    if (prior) {
      if (!prior.text && text) prior.text = String(text).trim();
      return;
    }
    found.set(url, { url, text: String(text ?? '').trim() });
  };

  const anchorRe = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(anchorRe)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    const text = match[4].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    add(href, text);
  }

  // Strip tags before the bare-URL sweep so an href already captured above is
  // not re-added with a different trailing-character trim.
  const plain = source.replace(/<[^>]*>/g, ' ');
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"')]+/gi)) add(match[0], '');

  return [...found.values()];
}

/**
 * Rank one link's likelihood of being THE verification link.
 *
 * Anchor text scores less than the URL itself for a reason worth stating: the
 * URL is written by the sending system, the anchor text is free prose that
 * anything in the body can imitate. Score only ever orders same-site
 * candidates against each other — it can never promote a cross-site link,
 * which is decided by host alone in {@link classifyLink}.
 *
 * @param {{url: string, text: string}} link
 * @returns {number} Negative when disqualified.
 */
export function scoreLink(link) {
  const url = String(link?.url ?? '').toLowerCase();
  const text = String(link?.text ?? '').toLowerCase();
  if (DENY_TOKENS.some((token) => url.includes(token))) return -1;

  let score = 0;
  if (VERIFY_TOKENS.some((token) => url.includes(token))) score += 3;
  if (VERIFY_TOKENS.some((token) => text.includes(token))) score += 2;
  try {
    const { searchParams } = new URL(link.url);
    if (TOKEN_PARAMS.some((param) => (searchParams.get(param) ?? '').length >= 8)) score += 1;
  } catch { /* unparseable → no query-string bonus */ }
  return score;
}

/**
 * Decide one link against the domain the account was created on.
 *
 * @param {{url: string, text: string}} link
 * @param {string} accountDomain - Hostname the registration happened on.
 * @returns {{url: string, text: string, host: string, site: string,
 *   trust: 'same-site'|'cross-site', score: number, disqualified: boolean}}
 */
export function classifyLink(link, accountDomain) {
  const accountSite = siteOf(accountDomain);
  let host = '';
  try {
    host = new URL(link.url).hostname;
  } catch { /* unparseable → empty host → cross-site */ }
  const site = siteOf(host);
  const score = scoreLink(link);
  return {
    url: link.url,
    text: link.text,
    host,
    site,
    // An empty accountSite or site must never match: both mean "could not be
    // parsed", and two unknowns are not the same site.
    trust: site !== '' && accountSite !== '' && site === accountSite ? 'same-site' : 'cross-site',
    score,
    disqualified: score < 0,
  };
}

/** Lowercased list of every address in a comma-separated header value. */
function addressesIn(headerValue_) {
  return String(headerValue_ ?? '')
    .toLowerCase()
    .match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
}

/**
 * Is this message in scope for the registration we are resuming?
 *
 * Rule 1 of the header, implemented literally. Both halves are cheap and both
 * are load-bearing: recency alone would accept anything that happened to
 * arrive during the window, and addressee alone would accept a month-old mail.
 *
 * @param {{from?: string, to?: string, cc?: string, subject?: string, body?: string, dateMs?: number}} message
 * @param {{candidateEmail?: string, now?: number, windowMs?: number}} [options]
 * @returns {{inScope: boolean, reason: string}} `reason` is machine-readable
 *   and reported as-is, because "why did it find nothing" is the only hard
 *   question this tool ever gets asked.
 */
export function messageInScope(message, { candidateEmail, now = Date.now(), windowMs } = {}) {
  const limit = Number.isFinite(windowMs) ? windowMs : INBOX_DEFAULTS.windowMinutes * 60_000;
  const dateMs = Number(message?.dateMs);
  if (!Number.isFinite(dateMs)) return { inScope: false, reason: 'undated' };
  if (now - dateMs > limit) return { inScope: false, reason: 'outside-window' };
  // A clock-skewed future timestamp is suspicious, not fatal; allow a minute.
  if (dateMs - now > 60_000) return { inScope: false, reason: 'future-dated' };

  if (candidateEmail) {
    const wanted = String(candidateEmail).toLowerCase().trim();
    const recipients = [...addressesIn(message?.to), ...addressesIn(message?.cc)];
    if (!recipients.includes(wanted)) return { inScope: false, reason: 'not-addressed-to-candidate' };
  }
  return { inScope: true, reason: 'in-scope' };
}

/**
 * The whole decision, over however many messages the caller supplies.
 *
 * @param {Array<{from?: string, to?: string, cc?: string, subject?: string, body?: string, dateMs?: number}>} messages
 * @param {{accountDomain: string, candidateEmail?: string, now?: number,
 *   windowMs?: number, trustCrossSite?: boolean}} options
 * @returns {{status: 'ready'|'no-message'|'no-link'|'cross-site-only',
 *   link: string|null, trust: string|null, candidates: object[],
 *   considered: number, skipped: {reason: string, subject: string}[]}}
 *   `candidates` is every surviving link, best first, each with its host
 *   spelled out — a `cross-site-only` result is meant to be read by a human
 *   who then decides, so it must show what it refused to click.
 */
export function resolveVerificationLink(messages, options) {
  const { accountDomain, candidateEmail, now = Date.now(), windowMs, trustCrossSite = false } = options ?? {};
  if (!accountDomain) throw new FreemotionInboxError('accountDomain is required');

  /** @type {object[]} */
  const candidates = [];
  /** @type {{reason: string, subject: string}[]} */
  const skipped = [];
  let considered = 0;

  for (const message of messages ?? []) {
    const scope = messageInScope(message, { candidateEmail, now, windowMs });
    if (!scope.inScope) {
      skipped.push({ reason: scope.reason, subject: String(message?.subject ?? '').slice(0, 120) });
      continue;
    }
    considered += 1;
    for (const link of extractLinks(message?.body)) {
      const classified = classifyLink(link, accountDomain);
      if (classified.disqualified) continue;
      candidates.push({ ...classified, subject: String(message?.subject ?? '').slice(0, 120) });
    }
  }

  // Same-site first, then score, then earlier-seen. Sorting trust ahead of
  // score is the point: a perfectly-worded cross-site link never outranks a
  // plain same-site one.
  const rank = (candidate) => (candidate.trust === 'same-site' ? 1000 : 0) + candidate.score;
  candidates.sort((a, b) => rank(b) - rank(a));

  if (considered === 0) return { status: 'no-message', link: null, trust: null, candidates, considered, skipped };
  if (candidates.length === 0) return { status: 'no-link', link: null, trust: null, candidates, considered, skipped };

  const best = candidates[0];
  const clickable = best.trust === 'same-site' || trustCrossSite === true;
  if (!clickable) return { status: 'cross-site-only', link: null, trust: null, candidates, considered, skipped };
  return { status: 'ready', link: best.url, trust: best.trust, candidates, considered, skipped };
}

/**
 * Parse an email the user pasted or exported into the internal record.
 *
 * The accepted shape is `paste-reply.mjs`'s, so a user who already knows how
 * to feed this system an email by hand does not learn a second format: header
 * lines (`Subject:`, `From:`, `To:`, `Date:`) in any order, a blank line, then
 * the body. A file with no header block at all is still usable — it becomes a
 * body dated `now`, which is the honest reading of "here is the mail I am
 * looking at right now".
 *
 * @param {string} text
 * @param {{now?: number}} [options]
 * @returns {{from: string, to: string, cc: string, subject: string, body: string, dateMs: number}}
 */
export function parsePastedEmail(text, { now = Date.now() } = {}) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const headers = { from: '', to: '', cc: '', subject: '', date: '' };
  const lines = source.split('\n');

  let index = 0;
  let sawHeader = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      if (sawHeader) index += 1;
      break;
    }
    const match = /^(from|to|cc|subject|date)\s*:\s*(.*)$/i.exec(line);
    if (!match) break;
    headers[match[1].toLowerCase()] = match[2].trim();
    sawHeader = true;
  }

  const body = sawHeader ? lines.slice(index).join('\n') : source;
  const parsedDate = headers.date ? Date.parse(headers.date) : NaN;
  return {
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    body,
    // No parseable Date: header means the user is looking at this mail now.
    dateMs: Number.isFinite(parsedDate) ? parsedDate : now,
  };
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * Re-stated rather than imported from `plugins/gmail/` — see the file header.
 *
 * @param {{clientId: string, clientSecret: string, refreshToken: string}} credentials
 * @param {typeof fetch} [fetchFn] - Injection point; every test uses it.
 * @returns {Promise<string>}
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new FreemotionInboxError(`Gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new FreemotionInboxError('Gmail token refresh returned no access_token');
  return data.access_token;
}

/** base64url payload → text, walking every MIME part. */
function decodeBody(payload) {
  if (!payload) return '';
  let body = '';
  if (payload.body?.data) {
    body += Buffer.from(String(payload.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
  }
  for (const part of payload.parts ?? []) body += decodeBody(part);
  return body;
}

function headerOf(payload, name) {
  const wanted = name.toLowerCase();
  for (const header of payload?.headers ?? []) {
    if (String(header?.name ?? '').toLowerCase() === wanted) return String(header?.value ?? '');
  }
  return '';
}

/**
 * Read recent Gmail messages and normalize them to the internal record.
 *
 * The Gmail query is built here, not accepted from the caller, so the recency
 * bound of rule 1 cannot be widened by a config value: `newer_than` is derived
 * from the same window the classifier then re-checks locally. Server filtering
 * is an optimization; {@link messageInScope} is the enforcement.
 *
 * @param {{accessToken: string, windowMinutes?: number, max?: number}} options
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<Array<{from: string, to: string, cc: string, subject: string, body: string, dateMs: number}>>}
 */
export async function fetchGmailMessages(options, fetchFn = globalThis.fetch) {
  const { accessToken } = options ?? {};
  if (!accessToken) throw new FreemotionInboxError('accessToken is required');
  const windowMinutes = Number(options.windowMinutes) > 0 ? Number(options.windowMinutes) : INBOX_DEFAULTS.windowMinutes;
  const max = Number(options.max) > 0 ? Number(options.max) : INBOX_DEFAULTS.maxMessages;

  const hours = Math.max(1, Math.ceil(windowMinutes / 60));
  const query = `newer_than:${hours}h`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  const listRes = await fetchFn(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`, { headers });
  if (!listRes.ok) {
    throw new FreemotionInboxError(`Gmail list failed: ${listRes.status} ${(await listRes.text()).slice(0, 200)}`);
  }
  const list = await listRes.json();

  const messages = [];
  // Messages the API listed but would not hand over. Skipping one unreadable
  // message must not sink the batch — but skipping SILENTLY turns a systematic
  // failure into a quiet lie. Gmail rate-limits per minute, so a large window
  // hits 403 partway and the caller receives a truncated set with no way to
  // tell it apart from "that is all there was". That is exactly how a sweep of
  // this mailbox came back with 118 of 200 messages and got read as evidence
  // that the applications had produced almost no replies.
  const dropped = [];
  for (const stub of list.messages ?? []) {
    const res = await fetchFn(`${GMAIL_API}/messages/${stub.id}?format=full`, { headers });
    if (!res.ok) { dropped.push({ id: stub.id, status: res.status }); continue; }
    const full = await res.json();
    const dateHeader = Date.parse(headerOf(full.payload, 'Date'));
    messages.push({
      from: headerOf(full.payload, 'From'),
      to: headerOf(full.payload, 'To'),
      cc: headerOf(full.payload, 'Cc'),
      subject: headerOf(full.payload, 'Subject'),
      body: decodeBody(full.payload),
      dateMs: Number.isFinite(dateHeader) ? dateHeader : Number(full.internalDate) || NaN,
    });
  }

  // A partial batch is reported, never returned as if it were whole. The
  // verification flow this module was built for reads a handful of recent
  // messages and will essentially never trip this; anything sweeping a wide
  // window will, and it must find out from the data rather than from a wrong
  // conclusion drawn later.
  if (dropped.length) {
    const throttled = dropped.filter((d) => d.status === 429 || d.status === 403).length;
    messages.incomplete = {
      listed: (list.messages ?? []).length,
      returned: messages.length,
      dropped: dropped.length,
      throttled,
      hint: throttled
        ? 'Gmail rate-limited this batch. Lower --max or narrow the window, then retry.'
        : 'Some listed messages could not be fetched.',
    };
  }
  return messages;
}

function resolveAgainst(path, root) {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Read `config/profile.yml → freemotion.email_verification`, plus the
 * candidate address the registration used.
 *
 * A missing block yields {@link INBOX_DEFAULTS} — `check` has to work on a
 * checkout where nobody wrote a `freemotion:` block, the same contract
 * `readEngineConfig` holds to.
 *
 * @param {string} [profilePath]
 * @returns {{windowMinutes: number, maxMessages: number, trustCrossSite: boolean, candidateEmail: string}}
 */
export function readInboxConfig(profilePath = 'config/profile.yml') {
  const path = resolveAgainst(String(profilePath), getCareerOpsRoot());
  const config = { ...INBOX_DEFAULTS, candidateEmail: '' };
  if (!existsSync(path)) return config;

  let parsed;
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new FreemotionInboxError(`could not parse ${path}: ${err.message}`);
  }

  config.candidateEmail = String(parsed?.candidate?.email ?? '').trim();
  const block = parsed?.freemotion?.email_verification;
  if (!block || typeof block !== 'object') return config;

  if (Number(block.window_minutes) > 0) config.windowMinutes = Number(block.window_minutes);
  if (Number(block.max_messages) > 0) config.maxMessages = Number(block.max_messages);
  if (block.trust_cross_site !== undefined && block.trust_cross_site !== null) {
    config.trustCrossSite = String(block.trust_cross_site).trim().toLowerCase() === 'true';
  }
  return config;
}

/**
 * Every posting parked on a verification wall, newest first.
 *
 * This is the half of Phase 9 that makes the outcome *resumable* rather than
 * merely detectable: the ledger already records the state, and until now
 * nothing read it back. Read-only — resuming a row is a `check` plus a click,
 * and the row is re-finalized through the normal `finalizeSubmission` path.
 *
 * @param {{logPath?: string, root?: string}} [options]
 * @returns {Array<{urlKey: string, rawUrl: string, company: string, role: string,
 *   reportNum: number|null, timestamp: string, runId: string, notes: string, domain: string}>}
 */
export function listPendingVerifications({ logPath, root } = {}) {
  const rows = [];
  for (const row of readCurrentState({ logPath, root }).values()) {
    if (row.outcome !== 'account-verification-pending') continue;
    let domain = '';
    try {
      domain = new URL(row.rawUrl).hostname;
    } catch { /* an unparseable stored URL still lists, just without a domain */ }
    rows.push({ ...row, domain });
  }
  rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return rows;
}

const USAGE = `Usage:
  node lib/freemotion-inbox.mjs pending [--root <path>]
  node lib/freemotion-inbox.mjs check --domain <hostname> [--email <e>]
       [--window-minutes N] [--max N] [--trust-cross-site] [--root <path>]
  node lib/freemotion-inbox.mjs check --domain <hostname> --from-file <path>

Reads the verification mail for an account Free Motion created and prints the
ONE link to click as JSON. Opens nothing, clicks nothing, submits nothing.

Gmail needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN in the
environment (the same three the bundled gmail plugin documents). With
--from-file no credentials are needed at all.

Exit codes:
  0  a link is ready to click
  2  expected — no message yet, no link in it, or the only link is cross-site
  1  usage error or an unexpected failure`;

async function main(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const args = command ? argv.slice(1) : argv;

  validateFlags(
    args,
    ['--domain', '--email', '--window-minutes', '--max', '--trust-cross-site', '--from-file', '--root', '--help', '-h'],
    USAGE,
    { valueFlags: ['--domain', '--email', '--window-minutes', '--max', '--from-file', '--root'] },
  );

  const root = flagValue(args, '--root');

  if (command === 'pending') {
    const pending = listPendingVerifications({ root });
    console.log(JSON.stringify({ pending, count: pending.length }, null, 2));
    return 0;
  }

  if (command !== 'check') {
    console.error(USAGE);
    return 1;
  }

  const domain = flagValue(args, '--domain');
  if (!domain) {
    console.error('--domain is required (the hostname the account was created on)\n');
    console.error(USAGE);
    return 1;
  }

  const config = readInboxConfig();
  const windowMinutes = safeIntFlag(flagValue(args, '--window-minutes'), config.windowMinutes);
  const max = safeIntFlag(flagValue(args, '--max'), config.maxMessages);
  const candidateEmail = flagValue(args, '--email') ?? config.candidateEmail;
  const trustCrossSite = hasFlag(args, '--trust-cross-site') || config.trustCrossSite;

  const fromFile = flagValue(args, '--from-file');
  let messages;
  let source;
  if (fromFile) {
    source = 'file';
    const path = resolveAgainst(fromFile, root ?? getCareerOpsRoot());
    if (!existsSync(path)) {
      console.error(`no such file: ${path}`);
      return 1;
    }
    messages = [parsePastedEmail(readFileSync(path, 'utf-8'))];
  } else {
    source = 'gmail';
    const {
      GMAIL_CLIENT_ID: clientId,
      GMAIL_CLIENT_SECRET: clientSecret,
      GMAIL_REFRESH_TOKEN: refreshToken,
    } = process.env;
    if (!clientId || !clientSecret || !refreshToken) {
      console.error(
        'missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.\n'
        + 'Set them (see plugins/gmail/skill.md) or pass --from-file with the email pasted into it.',
      );
      return 1;
    }
    const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
    messages = await fetchGmailMessages({ accessToken, windowMinutes, max });
  }

  const result = resolveVerificationLink(messages, {
    accountDomain: domain,
    candidateEmail,
    windowMs: windowMinutes * 60_000,
    trustCrossSite,
  });

  console.log(JSON.stringify({ ...result, domain, source, windowMinutes, trustCrossSite }, null, 2));
  return result.status === 'ready' ? 0 : 2;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err instanceof FreemotionInboxError ? err.message : String(err?.stack ?? err));
      process.exitCode = 1;
    });
}
