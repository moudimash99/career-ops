// tests/providers/hellowork.test.mjs — HelloWork, French general job board.
//
// Offline: provider.fetch() is driven with a stub ctx. Pinned here: the card
// parser on the real markup shape (entities included), the age and salary
// readers (a monthly salary read as yearly would mislead the salary filter),
// redirect: 'error' on every request, the page cap and the probe path.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — hellowork');

const card = (id, title, { company = 'ACME', place = 'Toulouse - 31', contract = 'CDI', salary = '', age = 'il y a 3 jours' } = {}) => `
<li data-cy="serpCard" class="x"><a href="/fr-fr/emplois/${id}.html">
<p class="typo-l inline md:typo-xl">${title}</p><p class="typo-s inline">${company}</p></a>
<div data-cy="localisationCard" > ${place} </div><div data-cy="contractCard" > ${contract} </div>
${salary ? `<div class="typo-s-bold w-fit border-0">${salary}</div>` : ''}<div>${age}</div></li>`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/hellowork.mjs')).href);
  const provider = mod.default;
  const { parseHelloworkPage, parseHelloworkAgeDays, parseHelloworkSalary } = mod;

  // ---- contract ----------------------------------------------------------
  if (provider?.id === 'hellowork' && typeof provider.fetch === 'function') pass('id is "hellowork" and fetch() exists');
  else fail('hellowork provider contract');
  if (provider.detect({ provider: 'hellowork' })?.url && provider.detect({ provider: 'apec' }) === null && provider.detect({}) === null) {
    pass('detect() claims only provider: hellowork');
  } else fail('detect() should claim exactly the hellowork entries');

  // ---- age ---------------------------------------------------------------
  const ages = ['il y a 14 heures', 'il y a 3 jours', 'il y a 2 semaines', 'il y a 1 mois', "aujourd'hui", 'hier', 'nothing'].map(parseHelloworkAgeDays);
  if (JSON.stringify(ages) === JSON.stringify([0, 3, 14, 30, 0, 1, null])) pass('parseHelloworkAgeDays() reads hours, days, weeks, months, today, yesterday');
  else fail(`ages = ${JSON.stringify(ages)}`);

  // ---- salary ------------------------------------------------------------
  const yearly = parseHelloworkSalary('40 000 - 48 000 € / an');
  if (yearly?.min === 40000 && yearly?.max === 48000 && yearly?.currency === 'EUR') pass('parseHelloworkSalary() reads a yearly range with narrow no-break spaces');
  else fail(`yearly = ${JSON.stringify(yearly)}`);
  const notYearly = ['2 500 € / mois', '15 € / heure', 'Selon profil', '', null].map(parseHelloworkSalary);
  if (notYearly.every((v) => v === null)) pass('parseHelloworkSalary() ignores monthly, hourly and prose');
  else fail(`non-yearly parsed as ${JSON.stringify(notYearly)}`);

  // ---- page parsing ------------------------------------------------------
  const now = Date.parse('2026-09-24T12:00:00Z');
  const page = parseHelloworkPage(card('111', 'DevOps &amp; SRE H/F', { salary: '45&#x202F;000 - 50&#x202F;000 &#x20AC; / an' }) + card('222', ''), now);
  if (page.length === 1 && page[0].id === '111' && page[0].title === 'DevOps & SRE H/F') pass('parseHelloworkPage() decodes entities and drops a titleless card');
  else fail(`page = ${JSON.stringify(page)}`);
  if (page[0]?.postedAt === now - 3 * 86_400_000) pass('parseHelloworkPage() turns "il y a 3 jours" into postedAt');
  else fail(`postedAt = ${page[0]?.postedAt}`);
  if (parseHelloworkSalary(page[0]?.salaryText)?.min === 45000) pass('the decoded salary line reads as 45000 (entities before parsing)');
  else fail(`salaryText = ${JSON.stringify(page[0]?.salaryText)}`);

  // ---- fetch() -----------------------------------------------------------
  let noQueries = null;
  try { await provider.fetch({ name: 'HW' }, { fetchText: async () => '' }); } catch (e) { noQueries = e; }
  if (noQueries && /configure explicit searches/i.test(noQueries.message)) pass('fetch() refuses to scan without configured queries');
  else fail(`missing queries should throw, got ${noQueries?.message}`);

  const sent = [];
  const pages = {
    1: card('1', 'DevOps H/F') + card('2', 'SRE H/F', { contract: 'CDD' }),
    2: card('1', 'DevOps H/F') + card('3', 'Cloud H/F', { salary: '2 500 € / mois' }),
    3: '',
  };
  const ctx = {
    sleep: async () => {},
    fetchText: async (url, opts) => {
      sent.push({ url, opts });
      return pages[new URL(url).searchParams.get('p')] ?? '';
    },
  };
  const jobs = await provider.fetch({ name: 'HW', hellowork: { queries: ['devops'], locations: ['Toulouse'], max_pages: 5 } }, ctx);
  if (jobs.length === 2 && jobs.every((j) => j.url.startsWith('https://www.hellowork.com/fr-fr/emplois/'))) pass('fetch() de-duplicates across pages and drops a non-CDI card');
  else fail(`jobs = ${JSON.stringify(jobs.map((j) => j.url))}`);
  if (jobs.find((j) => j.title === 'Cloud H/F') && !('salary' in jobs.find((j) => j.title === 'Cloud H/F'))) pass('fetch() leaves out a monthly salary');
  else fail('monthly salary must not become salary');
  if (sent.length === 3 && sent.every((r) => r.opts?.redirect === 'error')) pass('fetch() stops at the empty page and passes redirect: "error" on every request');
  else fail(`requests = ${sent.length}, redirects = ${JSON.stringify(sent.map((r) => r.opts?.redirect))}`);
  const q = new URL(sent[0].url).searchParams;
  if (q.get('k') === 'devops' && q.get('l') === 'Toulouse' && q.get('c') === 'CDI') pass('fetch() sends query, place and contract');
  else fail(`params = ${sent[0].url}`);

  // Age: results come by relevance, so old cards are skipped one by one, not by stopping.
  const aged = await provider.fetch({ name: 'HW', hellowork: { queries: ['x'], max_age_days: 14, max_pages: 1 } }, {
    sleep: async () => {},
    fetchText: async () => card('50', 'Old', { age: 'il y a 1 mois' }) + card('51', 'Fresh', { age: 'il y a 2 jours' }) + card('52', 'Undated', { age: '' }),
  });
  if (aged.map((j) => j.title).join() === 'Fresh,Undated') pass('max_age_days skips older cards and keeps undated ones');
  else fail(`aged = ${JSON.stringify(aged.map((j) => j.title))}`);

  // Page cap: the provider's own max_pages stops the walk even when every page is full.
  let capped = 0;
  await provider.fetch({ name: 'HW', hellowork: { queries: ['x'], max_pages: 2 } }, {
    sleep: async () => {},
    fetchText: async (url) => { capped++; return card(String(capped), `Job ${capped}`); },
  });
  if (capped === 2) pass('fetch() honours max_pages');
  else fail(`max_pages 2 made ${capped} requests`);

  // Probe: one request, and a rejection propagates unwrapped.
  let probeCalls = 0;
  await provider.fetch({ name: 'HW', hellowork: { queries: ['a', 'b'], locations: ['X', 'Y'] } }, {
    maxPages: 1,
    sleep: async () => {},
    fetchText: async () => { probeCalls++; return card('9', 'Job'); },
  });
  if (probeCalls === 1) pass('probe (ctx.maxPages: 1) makes exactly one request');
  else fail(`probe made ${probeCalls} requests`);
  class Budget extends Error {}
  let probeErr = null;
  try {
    await provider.fetch({ name: 'HW', hellowork: { queries: ['a'] } }, { maxPages: 1, sleep: async () => {}, fetchText: async () => { throw new Budget('budget'); } });
  } catch (e) { probeErr = e; }
  if (probeErr instanceof Budget) pass('probe propagates a fetch rejection unwrapped');
  else fail('probe must not swallow or rewrap a fetch rejection');
} catch (err) {
  fail(`hellowork provider suite crashed: ${err.message}`);
}
