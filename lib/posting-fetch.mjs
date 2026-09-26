// @ts-check
/**
 * lib/posting-fetch.mjs — the text of one HelloWork, WTJ or LinkedIn posting,
 * without a browser. Those boards send no description in their search
 * results, so the night list fetches the text of the few postings it is about
 * to score (freemotion-night/make-pool.mjs), for the years check and the model.
 *
 *   HelloWork, WTJ  the posting page's schema.org JobPosting block (JSON-LD),
 *                   which job sites publish for search engines; 1.5 s apart
 *   LinkedIn        the guest endpoint liveness-api.mjs already uses
 *                   (jobs-guest/jobs/api/jobPosting/{id}), 3.5 s apart
 *
 * Only these hosts, over https: the URLs come from scraped data. Returns null
 * when the page has no readable text; the caller then scores the title.
 */

import { htmlToText } from '../providers/_html-to-text.mjs';
import { resolveAtsApi, throttleProviderRequest } from '../liveness-api.mjs';

const PAGE_THROTTLE_MS = 1_500;
const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (career-ops night list)';

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
export const isHellowork = (u) => /(^|\.)hellowork\.com$/.test(hostOf(u)) && /^https:/.test(u);
export const isLinkedin = (u) => /(^|\.)linkedin\.com$/.test(hostOf(u)) && /^https:/.test(u);
export const isWttj = (u) => hostOf(u) === 'www.welcometothejungle.com' && /^https:/.test(u);
/** A posting whose text the night list fetches itself (its board's search results carry none). */
export const needsTextFetch = (u) => isHellowork(u) || isWttj(u) || isLinkedin(u);

/** The description of the first schema.org JobPosting in a page's JSON-LD, as text. */
export function jobPostingText(html) {
  const blocks = String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
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

/**
 * @param {string} url - a HelloWork, WTJ or LinkedIn posting URL
 * @param {{ fetchImpl?: typeof fetch, throttle?: (id: string, ms: number) => Promise<unknown> }} [opts]
 * @returns {Promise<string|null>}
 */
export async function fetchPostingText(url, { fetchImpl = fetch, throttle = throttleProviderRequest } = {}) {
  let target;
  let read;
  if (isLinkedin(url)) {
    const api = resolveAtsApi(url);
    if (!api || api.ats !== 'linkedin') return null;
    await throttle('linkedin', api.throttleMs || 3_500);
    target = api.apiUrl;
    read = linkedinPostingText;
  } else if (isHellowork(url) || isWttj(url)) {
    await throttle(isWttj(url) ? 'wttj' : 'hellowork', PAGE_THROTTLE_MS);
    target = url;
    read = jobPostingText;
  } else {
    return null;
  }
  const res = await fetchImpl(target, { headers: { accept: 'text/html', 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return null;
  return read(await res.text());
}
