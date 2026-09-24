// tests/providers/freework.test.mjs — Free-Work, French tech/IT board.
//
// Offline: provider.fetch() is driven with a stub ctx. Pinned here: the
// employer link wins over the Free-Work page only for "apply on the employer's
// site" postings and only when it is https; the age cut-off stops paging; a
// changed payload shape throws instead of returning an empty board.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — freework');

const DAY = 86_400_000;
const posting = (id, over = {}) => ({
  id,
  title: `Job ${id}`,
  slug: `job-${id}`,
  job: { slug: 'ingenieur-devops-cloud' },
  company: { name: 'ACME' },
  location: { label: 'Toulouse, Occitanie', countryCode: 'FR' },
  publishedAt: new Date(Date.now() - DAY).toISOString(),
  applicationType: 'turnover',
  applicationUrl: null,
  ...over,
});

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/freework.mjs')).href);
  const provider = mod.default;
  const { normalizeFreeworkPosting } = mod;

  if (provider?.id === 'freework' && typeof provider.fetch === 'function') pass('id is "freework" and fetch() exists');
  else fail('freework provider contract');
  if (provider.detect({ provider: 'freework' })?.url && provider.detect({ provider: 'hellowork' }) === null) pass('detect() claims only provider: freework');
  else fail('detect() should claim exactly the freework entries');

  // ---- normalisation -----------------------------------------------------
  const onSite = normalizeFreeworkPosting(posting(1));
  if (onSite?.url === 'https://www.free-work.com/fr/tech-it/ingenieur-devops-cloud/job-mission/job-1') pass('an apply-on-Free-Work posting keeps its free-work.com page');
  else fail(`url = ${onSite?.url}`);
  const external = normalizeFreeworkPosting(posting(2, { applicationType: 'url', applicationUrl: 'https://careers.acme.test/jobs/2' }));
  if (external?.url === 'https://careers.acme.test/jobs/2') pass('an apply-on-employer-site posting uses the employer link');
  else fail(`external url = ${external?.url}`);
  const insecure = normalizeFreeworkPosting(posting(3, { applicationType: 'url', applicationUrl: 'http://careers.acme.test/jobs/3' }));
  if (insecure?.url.startsWith('https://www.free-work.com/')) pass('a non-https employer link falls back to the Free-Work page');
  else fail(`insecure url = ${insecure?.url}`);
  const paid = normalizeFreeworkPosting(posting(4, { minAnnualSalary: 45000, maxAnnualSalary: 55000, company: 'Plain Co', description: '<p>Hello <b>world</b></p>' }));
  if (paid?.salary?.min === 45000 && paid?.salary?.max === 55000 && paid?.company === 'Plain Co' && /Hello\s+world/.test(paid?.description || '')) {
    pass('salary, string company and description (HTML to text) are mapped');
  } else fail(`paid = ${JSON.stringify(paid)}`);
  if (normalizeFreeworkPosting(posting(5, { title: '' })) === null && normalizeFreeworkPosting(null) === null) pass('drops a titleless posting and a non-object');
  else fail('titleless / non-object must drop');

  // ---- fetch() -----------------------------------------------------------
  let noQueries = null;
  try { await provider.fetch({ name: 'FW' }, { fetchJson: async () => ({}) }); } catch (e) { noQueries = e; }
  if (noQueries && /configure explicit searches/i.test(noQueries.message)) pass('fetch() refuses to scan without configured queries');
  else fail(`missing queries should throw, got ${noQueries?.message}`);

  const sent = [];
  const full = Array.from({ length: 50 }, (_, i) => posting(100 + i));
  const old = Array.from({ length: 50 }, (_, i) => posting(200 + i, { publishedAt: new Date(Date.now() - 30 * DAY).toISOString() }));
  const ctx = {
    sleep: async () => {},
    fetchJson: async (url, opts) => {
      sent.push({ url, opts });
      const page = new URL(url).searchParams.get('page');
      return { 'hydra:member': page === '1' ? [...full.slice(0, 49), posting(999, { location: { label: 'Genève', countryCode: 'CH' } })] : old };
    },
  };
  const jobs = await provider.fetch({ name: 'FW', freework: { queries: ['devops'], max_age_days: 14, max_pages: 4 } }, ctx);
  if (jobs.length === 49) pass('fetch() keeps France-only postings when searching all of France');
  else fail(`expected 49 jobs, got ${jobs.length}`);
  if (sent.length === 2) pass('fetch() stops paging once a whole page is older than max_age_days');
  else fail(`requests = ${sent.length}`);
  if (sent.every((r) => r.opts?.redirect === 'error')) pass('fetch() passes redirect: "error" on every request');
  else fail('redirect must be "error"');
  const params = new URL(sent[0].url).searchParams;
  if (params.get('searchKeywords') === 'devops' && params.getAll('contracts').join() === 'permanent' && params.get('order') === 'date') pass('fetch() sends keywords, contract and newest-first order');
  else fail(`params = ${sent[0].url}`);

  const empty = await provider.fetch({ name: 'FW', freework: { queries: ['x'] } }, { sleep: async () => {}, fetchJson: async () => ({ 'hydra:member': [] }) });
  if (Array.isArray(empty) && empty.length === 0) pass('an empty member list returns []');
  else fail('empty board should return []');
  let shapeErr = null;
  try { await provider.fetch({ name: 'FW', freework: { queries: ['x'] } }, { sleep: async () => {}, fetchJson: async () => ({ items: [] }) }); } catch (e) { shapeErr = e; }
  if (shapeErr && /unexpected response/i.test(shapeErr.message)) pass('a payload without hydra:member throws');
  else fail('a malformed payload must throw rather than return []');

  let probeCalls = 0;
  await provider.fetch({ name: 'FW', freework: { queries: ['a', 'b'] } }, { maxPages: 1, sleep: async () => {}, fetchJson: async () => { probeCalls++; return { 'hydra:member': full }; } });
  if (probeCalls === 1) pass('probe (ctx.maxPages: 1) makes exactly one request');
  else fail(`probe made ${probeCalls} requests`);
} catch (err) {
  fail(`freework provider suite crashed: ${err.message}`);
}
