#!/usr/bin/env node

/**
 * freemotion-route.mjs — decide whether a posting is worth opening, before a
 * single model call is spent on it.
 *
 * WHY THIS EXISTS (Requirement 13). Everything downstream costs money and
 * time: a browser launch, five or six controller turns, a CV upload. Some
 * postings were never applyable — the employer is blacklisted, we already
 * submitted there, the platform demands a CAPTCHA the project will not solve.
 * Finding that out on turn four is the expensive way to find it out.
 *
 * THE BIAS IS TOWARDS INCLUDING, and that is the whole design. A false
 * positive costs one wasted run. A false negative silently drops a job the
 * user could have got, and nobody ever learns it happened. So this skips ONLY
 * on a definite signal, and anything uncertain goes through.
 *
 * NO EMPLOYER NAMES ARE HARDCODED HERE. The blacklist and the applied history
 * are passed in by the caller, from the user's own files.
 */

/**
 * Platforms whose application flow is gated behind a CAPTCHA the project's
 * policy refuses to solve. Matched on the HOST, because that is a property of
 * the platform rather than of any employer using it.
 */
export const CAPTCHA_HOSTS = [/(^|\.)lever\.co$/i];

/** Normalise a company name the way the tracker's dedup does. */
const key = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The comparable form of a URL: no tracking parameters, no fragment. */
export function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|mc_|ref$|source$)/i.test(p)) u.searchParams.delete(p);
    }
    u.host = u.host.toLowerCase();
    return u.toString().replace(/\/$/, '');
  } catch {
    return String(url ?? '').trim();
  }
}

/**
 * Should this posting be opened?
 *
 * @param {string} url
 * @param {{company?: string, blacklist?: string[], submittedUrls?: string[],
 *          manualSignInHosts?: string[]}} [context]
 * @returns {{open: boolean, reason: string, signal: string|null}}
 */
export function routeFor(url, context = {}) {
  const { company, blacklist = [], submittedUrls = [], manualSignInHosts = [] } = context;
  const clean = normalizeUrl(url);

  let host = '';
  try { host = new URL(clean).host; } catch { /* unparseable; see below */ }

  // An unparseable URL is not a reason to skip — it is a reason to look. The
  // browser resolves redirects this function cannot.
  if (!host) return { open: true, reason: 'could not read the host; opening rather than guessing', signal: null };

  if (submittedUrls.some((u) => normalizeUrl(u) === clean)) {
    return { open: false, reason: 'already submitted to this exact posting', signal: 'already-submitted' };
  }

  if (company && blacklist.some((b) => key(b) && key(company) === key(b))) {
    return { open: false, reason: `"${company}" is on the do-not-apply list`, signal: 'blacklisted' };
  }

  if (CAPTCHA_HOSTS.some((re) => re.test(host))) {
    return { open: false, reason: `${host} gates applications behind a CAPTCHA, which is never solved`, signal: 'captcha-platform' };
  }

  if (manualSignInHosts.some((h) => key(h) && host.toLowerCase().includes(String(h).toLowerCase()))) {
    return { open: false, reason: `${host} needs a sign-in done by hand, which is out of scope`, signal: 'manual-sign-in' };
  }

  return { open: true, reason: 'no definite reason to skip', signal: null };
}

/**
 * A company name matching the blacklist only LOOSELY — same first word, say.
 *
 * Reported rather than acted on, because "Thales" and "Thales Alenia Space"
 * may or may not be the same employer for this purpose, and silently skipping
 * on a guess is the expensive error this module exists to avoid.
 *
 * @returns {string[]} blacklist entries worth a human glance
 */
export function nearBlacklistMatches(company, blacklist = []) {
  const c = key(company);
  if (!c) return [];
  return blacklist.filter((b) => {
    const k = key(b);
    if (!k || k === c) return false;
    return c.startsWith(`${k} `) || k.startsWith(`${c} `);
  });
}
