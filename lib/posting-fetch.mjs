// @ts-check
/**
 * lib/posting-fetch.mjs — the text of one posting, without a browser, for
 * boards whose search results carry no description (or carried none before
 * the scanner saved texts, 2026-09-26). The night list fetches the text of
 * every job that passed the go / no-go gate (freemotion-night/fetch-texts.mjs),
 * for the years check and the model.
 *
 *   HelloWork, WTJ, Free-Work, jobposting.pro
 *                   the posting page's schema.org JobPosting block (JSON-LD),
 *                   which job sites publish for search engines; 1.5 s apart
 *                   (WTJ 3 s)
 *   LinkedIn        the guest endpoint liveness-api.mjs already uses
 *                   (jobs-guest/jobs/api/jobPosting/{id}), 3.5 s apart
 *   France Travail  the detail page's itemprop="description" block; 1.5 s apart
 *   Greenhouse, Lever, Ashby, Workday
 *                   their public API (browser-extract.mjs fetchJdViaKnownApi)
 *
 * Pages are asked for with a browser's User-Agent: WTJ answered 403 to the
 * old "career-ops night list" one, so every WTJ fetch failed without a word
 * until 2026-09-28. APEC is not here: its pages sit behind a bot wall and its
 * search results carry only an excerpt, so freemotion-night/apec-route.mjs
 * saves the full text from inside a Camoufox page.
 *
 * Only these hosts, over https: the URLs come from scraped data. Returns null
 * when the page has no readable text; the caller then scores the title.
 */

import { htmlToText } from '../providers/_html-to-text.mjs';
import { JD_TEXT_API_ATS, resolveAtsApi, throttleProviderRequest } from '../liveness-api.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../user-agent.mjs';
import { ENV_URL as WTTJ_ENV_URL, INDEX as WTTJ_INDEX, parseEnvPayload, wttjHitText } from '../providers/wttj.mjs';

const PAGE_THROTTLE_MS = 1_500;
// WTJ served a page without its JSON-LD to about half the fetches at 1.5 s
// (2026-09-28); the same pages read fine when asked again later.
const WTTJ_THROTTLE_MS = 3_000;
const TIMEOUT_MS = 15_000;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const https = (u) => /^https:/.test(u);
export const isHellowork = (u) => /(^|\.)hellowork\.com$/.test(hostOf(u)) && https(u);
export const isLinkedin = (u) => /(^|\.)linkedin\.com$/.test(hostOf(u)) && https(u);
export const isWttj = (u) => hostOf(u) === 'www.welcometothejungle.com' && https(u);

/** Hosts whose posting page carries a JSON-LD JobPosting. */
const JSON_LD_SITES = [
  ['hellowork', (h) => /(^|\.)hellowork\.com$/.test(h)],
  ['wttj', (h) => h === 'www.welcometothejungle.com'],
  ['free-work', (h) => h === 'www.free-work.com'],
  ['jobposting.pro', (h) => h === 'www.jobposting.pro'],
];

/**
 * Which site's reader handles this URL, or null when we do not fetch it.
 * @param {string} url
 * @returns {string|null}
 */
export function textSiteOf(url) {
  if (!https(url)) return null;
  const h = hostOf(url);
  if (isLinkedin(url)) return 'linkedin';
  for (const [site, test] of JSON_LD_SITES) if (test(h)) return site;
  if (h === 'candidat.francetravail.fr' && /\/offres\/recherche\/detail\//.test(url)) return 'francetravail';
  const api = resolveAtsApi(url);
  if (api && JD_TEXT_API_ATS.has(api.ats)) return api.ats;
  return null;
}

/** A posting whose text the night list can fetch itself. */
export const needsTextFetch = (u) => textSiteOf(u) !== null;

/**
 * The description of the first schema.org JobPosting in a page's JSON-LD, as text.
 * HelloWork writes the type with the "+" escaped (`ld&#x2B;json`, 2026-09-30).
 */
export function jobPostingText(html) {
  const blocks = String(html || '').matchAll(/<script[^>]*type=["']application\/ld(?:\+|&#x2B;|&#43;|&plus;)json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of blocks) {
    let data;
    try { data = JSON.parse(body.trim()); } catch { continue; }
    const items = [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.['@graph']) ? data['@graph'] : [])];
    for (const it of items) {
      const type = it?.['@type'];
      if ((type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) && typeof it.description === 'string') {
        const text = htmlToText(it.description);
        if (text) return text;
      }
    }
  }
  return null;
}

/** The posting text in a LinkedIn guest-endpoint page (the description block). */
export function linkedinPostingText(html) {
  const s = String(html || '');
  const at = s.search(/class="[^"]*\bdescription__text\b/);
  if (at < 0) return null;
  const start = Math.max(0, s.lastIndexOf('<', at));
  const end = s.indexOf('</section>', at);
  const text = htmlToText(s.slice(start, end > at ? end : at + 20_000));
  return text || null;
}

/** The posting text in a France Travail detail page (the itemprop="description" block). */
export function francetravailPostingText(html) {
  const s = String(html || '');
  const at = s.search(/itemprop="description"/);
  if (at < 0) return null;
  const start = Math.max(0, s.lastIndexOf('<', at));
  const end = s.indexOf('</div>', at);
  const text = htmlToText(s.slice(start, end > at ? end : at + 20_000));
  return text || null;
}

/**
 * Fetch one posting's text and say why when there is none.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, throttle?: (id: string, ms: number) => Promise<unknown>, atsFetch?: (url: string) => Promise<{ text?: string }|null> }} [opts]
 * @returns {Promise<{ site: string|null, text: string|null, why?: string }>}
 */
export async function tryFetchPostingText(url, { fetchImpl = fetch, throttle = throttleProviderRequest, atsFetch } = {}) {
  const site = textSiteOf(url);
  if (!site) return { site, text: null, why: 'not a site we read' };
  if (JD_TEXT_API_ATS.has(site)) {
    const get = atsFetch || (async (u) => (await import('../browser-extract.mjs')).fetchJdViaKnownApi(u));
    const r = await get(url);
    return r?.text ? { site, text: r.text } : { site, text: null, why: 'API gave no text' };
  }
  if (site === 'wttj') return wttjText(url, { fetchImpl, throttle });
  let read = jobPostingText;
  let target = url;
  if (site === 'linkedin') {
    const api = resolveAtsApi(url);
    if (!api || api.ats !== 'linkedin') return { site, text: null, why: 'no LinkedIn job id' };
    await throttle('linkedin', api.throttleMs || 3_500);
    target = api.apiUrl;
    read = linkedinPostingText;
  } else {
    await throttle(site, PAGE_THROTTLE_MS);
    if (site === 'francetravail') read = francetravailPostingText;
  }
  return { site, ...(await readPage(target, read, fetchImpl)) };
}

/** GET one page and read its text; a bot challenge (AWS WAF answers 202) is named. */
async function readPage(target, read, fetchImpl) {
  const res = await fetchImpl(target, {
    headers: { accept: 'text/html', 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8', 'user-agent': BROWSER_LIKE_USER_AGENT },
    redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 202 || res.headers?.get?.('x-amzn-waf-action')) return { text: null, why: 'bot challenge' };
  if (!res.ok) return { text: null, why: `http ${res.status}` };
  const text = read(await res.text());
  return text ? { text } : { text: null, why: 'no text on the page' };
}

// ── WTJ ────────────────────────────────────────────────────────────────
// The page has the full posting, but WTJ's bot wall (AWS WAF) challenges an
// address after ~130 page fetches (2026-09-28), curl included. Once it does,
// the rest of the run reads WTJ's search index instead (summary, key missions,
// profile: shorter, never challenged), the same one providers/wttj.mjs scans.
let wttjPagesBlocked = false;
/** @type {{ appId: string, apiKey: string } | null} */
let wttjEnv = null;
/** Forget the WTJ state (tests). */
export function resetWttj() { wttjPagesBlocked = false; wttjEnv = null; }

async function wttjText(url, { fetchImpl, throttle }) {
  if (!wttjPagesBlocked) {
    await throttle('wttj', WTTJ_THROTTLE_MS);
    const page = await readPage(url, jobPostingText, fetchImpl);
    if (page.text) return { site: 'wttj', text: page.text };
    if (page.why === 'bot challenge' || /^http (403|429)$/.test(page.why || '')) wttjPagesBlocked = true;
    else return { site: 'wttj', ...page };
  }
  return { site: 'wttj', ...(await wttjIndexText(url, { fetchImpl, throttle })) };
}

/** One WTJ posting's text from the search index, found by company + slug. */
export async function wttjIndexText(url, { fetchImpl = fetch, throttle = throttleProviderRequest } = {}) {
  const m = new URL(url).pathname.match(/\/companies\/([a-z0-9_-]+)\/jobs\/([a-z0-9_-]+)/i);
  if (!m) return { text: null, why: 'not a WTJ job link' };
  const [, org, slug] = m;
  if (!wttjEnv) {
    const r = await fetchImpl(WTTJ_ENV_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { text: null, why: `index key http ${r.status}` };
    wttjEnv = parseEnvPayload(await r.text());
  }
  await throttle('wttj-index', 300);
  const params = new URLSearchParams({
    query: slug.split('_')[0].replace(/-/g, ' '),
    filters: `organization.slug:"${org}"`,
    hitsPerPage: '50',
    attributesToRetrieve: 'slug,organization.slug,summary,key_missions,profile',
  });
  const r = await fetchImpl(`https://${wttjEnv.appId}-dsn.algolia.net/1/indexes/${WTTJ_INDEX}/query`, {
    method: 'POST',
    headers: { 'x-algolia-application-id': wttjEnv.appId, 'x-algolia-api-key': wttjEnv.apiKey, referer: 'https://www.welcometothejungle.com/', 'content-type': 'application/json' },
    body: JSON.stringify({ params: params.toString() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) return { text: null, why: `index http ${r.status}` };
  const hits = JSON.parse(await r.text())?.hits || [];
  const hit = hits.find((h) => h?.slug === slug && h?.organization?.slug === org);
  if (!hit) return { text: null, why: 'not in the WTJ index (closed?)' };
  const text = wttjHitText(hit);
  return text ? { text } : { text: null, why: 'index has no text' };
}

/**
 * @param {string} url - a posting URL on one of the sites above
 * @param {Parameters<typeof tryFetchPostingText>[1]} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchPostingText(url, opts) {
  return (await tryFetchPostingText(url, opts)).text;
}
