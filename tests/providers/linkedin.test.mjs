// tests/providers/linkedin.test.mjs — LinkedIn public guest search (discovery only).
//
// Offline: provider.fetch() is driven with a stub ctx. Pinned here: `start`
// advances by the number of cards actually received (pages hold 10, and
// stepping by 25 skipped 15 of every 25 postings), entities are decoded, a
// failure mid-walk keeps what was found, and the probe path.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — linkedin');

const card = (id, title, company = 'ACME', place = 'Toulouse, Occitanie, France', date = '2026-09-22') => `<li>
<div class="base-card" data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">${title}</h3>
<a class="hidden-nested-link" href="#">${company}</a><span class="job-search-card__location">${place}</span>
<time class="job-search-card__listdate" datetime="${date}">x</time></div></li>`;
const pageOf = (from, n) => Array.from({ length: n }, (_, i) => card(String(from + i), `Job ${from + i}`)).join('');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/linkedin.mjs')).href);
  const provider = mod.default;
  const { parseLinkedinPage } = mod;

  if (provider?.id === 'linkedin' && typeof provider.fetch === 'function') pass('id is "linkedin" and fetch() exists');
  else fail('linkedin provider contract');
  if (provider.detect({ provider: 'linkedin' })?.url && provider.detect({ provider: 'wttj' }) === null) pass('detect() claims only provider: linkedin');
  else fail('detect() should claim exactly the linkedin entries');

  const parsed = parseLinkedinPage(card('42', 'Ing&#xE9;nieur DevOps &amp; SRE', 'Caf&#233; SA') + card('', 'No id') + card('43', ''));
  if (parsed.length === 1 && parsed[0].title === 'Ingénieur DevOps & SRE' && parsed[0].company === 'Café SA') pass('parseLinkedinPage() decodes entities and drops cards without id or title');
  else fail(`parsed = ${JSON.stringify(parsed)}`);
  if (parsed[0]?.url === 'https://www.linkedin.com/jobs/view/42' && parsed[0]?.postedAt === Date.parse('2026-09-22')) pass('parseLinkedinPage() builds the public job URL and reads the date');
  else fail(`url/date = ${parsed[0]?.url} ${parsed[0]?.postedAt}`);

  let noQueries = null;
  try { await provider.fetch({ name: 'LI' }, { fetchText: async () => '' }); } catch (e) { noQueries = e; }
  if (noQueries && /configure explicit searches/i.test(noQueries.message)) pass('fetch() refuses to scan without configured queries');
  else fail(`missing queries should throw, got ${noQueries?.message}`);

  // Pages of 10, then 7, then empty: offsets must be 0, 10, 17.
  const starts = [];
  const sent = [];
  const jobs = await provider.fetch({ name: 'LI', linkedin: { queries: ['devops'], locations: ['Toulouse, Occitanie, France'], max_age_days: 14 } }, {
    sleep: async () => {},
    fetchText: async (url, opts) => {
      sent.push(opts);
      const start = Number(new URL(url).searchParams.get('start'));
      starts.push(start);
      if (start === 0) return pageOf(0, 10);
      if (start === 10) return pageOf(10, 7);
      return '';
    },
  });
  if (JSON.stringify(starts) === JSON.stringify([0, 10, 17])) pass('`start` advances by the cards received (0, 10, 17)');
  else fail(`starts = ${JSON.stringify(starts)}`);
  if (jobs.length === 17) pass('fetch() collects every card across pages');
  else fail(`jobs = ${jobs.length}`);
  if (sent.every((o) => o?.redirect === 'error')) pass('fetch() passes redirect: "error" on every request');
  else fail('redirect must be "error"');

  // A failure mid-walk keeps what was already read.
  let n = 0;
  const partial = await provider.fetch({ name: 'LI', linkedin: { queries: ['devops'] } }, {
    sleep: async () => {},
    fetchText: async () => { n++; if (n === 1) return pageOf(0, 10); throw Object.assign(new Error('HTTP 400'), { status: 400 }); },
  });
  if (partial.length === 10) pass('a failed page keeps the pages already read');
  else fail(`partial = ${partial.length}`);

  let probeCalls = 0;
  await provider.fetch({ name: 'LI', linkedin: { queries: ['a', 'b'], locations: ['X', 'Y'] } }, { maxPages: 1, sleep: async () => {}, fetchText: async () => { probeCalls++; return pageOf(0, 10); } });
  if (probeCalls === 1) pass('probe (ctx.maxPages: 1) makes exactly one request');
  else fail(`probe made ${probeCalls} requests`);
  class Budget extends Error {}
  let probeErr = null;
  try { await provider.fetch({ name: 'LI', linkedin: { queries: ['a'] } }, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw new Budget('b'); } }); } catch (e) { probeErr = e; }
  if (probeErr instanceof Budget) pass('probe propagates a fetch rejection unwrapped');
  else fail('probe must not swallow or rewrap a fetch rejection');
} catch (err) {
  fail(`linkedin provider suite crashed: ${err.message}`);
}
