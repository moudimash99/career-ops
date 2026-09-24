// tests/providers/francetravail-apply-link.test.mjs — France Travail: the parts
// added after the first live runs (2026-09-23/24).
//
//   - the job URL is the recruiter's link (contact.urlPostulation), else the
//     partner board's (origineOffre.partenaires[].url), else urlOrigine, else
//     France Travail's page — urlOrigine is always France Travail's own page
//     in live data, so preferring it hid every recruiter link;
//   - only the yearly salary form is read;
//   - contract type and age filters are sent to the API;
//   - big result sets are paged by `range`, bounded by our own max_pages.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — francetravail (apply link, salary, filters, paging)');

const CREDS = { FRANCETRAVAIL_CLIENT_ID: 'id', FRANCETRAVAIL_CLIENT_SECRET: 'secret' };
const FT_PAGE = 'https://candidat.francetravail.fr/offres/recherche/detail/';

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/francetravail.mjs')).href);
  const provider = mod.default;
  const { normalizeFranceTravailOffer: norm, parseFranceTravailSalary: sal } = mod;

  // ---- URL preference ----------------------------------------------------
  const base = { id: '214ABC', intitule: 'DevOps' };
  const recruiter = norm({ ...base, contact: { urlPostulation: 'https://taleez.com/apply/x' },
    origineOffre: { urlOrigine: `${FT_PAGE}214ABC`, partenaires: [{ nom: 'METEOJOB', url: 'https://www.meteojob.com/x' }] } });
  if (recruiter?.url === 'https://taleez.com/apply/x') pass("the recruiter's urlPostulation wins");
  else fail(`url = ${recruiter?.url}`);
  const partner = norm({ ...base, origineOffre: { urlOrigine: `${FT_PAGE}214ABC`, partenaires: [{ url: 'http://insecure.test/x' }, { url: 'https://www.jobposting.pro/x' }] } });
  if (partner?.url === 'https://www.jobposting.pro/x') pass('else the first https partner link wins over urlOrigine');
  else fail(`url = ${partner?.url}`);
  const plain = norm({ ...base, origineOffre: { urlOrigine: 'not a url', partenaires: [] } });
  if (plain?.url === `${FT_PAGE}214ABC`) pass("else France Travail's own page");
  else fail(`url = ${plain?.url}`);

  // ---- salary ------------------------------------------------------------
  const cases = [
    ['Annuel de 35000.0 Euros à 45000.0 Euros', { min: 35000, max: 45000 }],
    ['Annuel de 40000 Euros sur 12 mois', { min: 40000, max: 40000 }],
    ['Annuel de 38000.0 Euros à 43000.0 Euros sur 13 mois', { min: 38000, max: 43000 }],
  ];
  if (cases.every(([t, e]) => { const r = sal(t); return r && r.min === e.min && r.max === e.max && r.currency === 'EUR'; })) pass('yearly salaries are read, "sur N mois" is not a figure');
  else fail(`yearly = ${JSON.stringify(cases.map(([t]) => sal(t)))}`);
  if (['Mensuel de 3000.0 Euros', 'Horaire de 15.0 Euros', 'Selon profil', '', null].every((t) => sal(t) === null)) pass('monthly, hourly and prose salaries are ignored');
  else fail('non-yearly salary must be null');
  if (norm({ ...base, salaire: { libelle: 'Annuel de 45000 Euros' } })?.salary?.min === 45000) pass('the offer carries the parsed salary');
  else fail('salary missing on the offer');

  // ---- filters and paging ------------------------------------------------
  const offers = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `X${from + i}`, intitule: `Job ${from + i}` }));
  const searches = [];
  const jobs = await provider.fetch(
    { name: 'FT', _env: CREDS, francetravail: { queries: ['devops'], contract_types: ['CDI', 'bad value'], published_within_days: 10, max_hits: 150 } },
    {
      sleep: async () => {},
      fetchJson: async (url) => {
        if (url.includes('access_token')) return { access_token: 'tok' };
        const p = new URL(url).searchParams;
        searches.push(p);
        const [first] = p.get('range').split('-').map(Number);
        return { resultats: first === 0 ? offers(0, 150) : offers(150, 20) };
      },
    },
  );
  if (searches.length === 2 && searches[0].get('range') === '0-149' && searches[1].get('range') === '150-299') pass('a full page of 150 fetches the next range, a short page stops');
  else fail(`ranges = ${JSON.stringify(searches.map((p) => p.get('range')))}`);
  if (jobs.length === 170) pass('offers from both ranges are kept');
  else fail(`jobs = ${jobs.length}`);
  if (searches[0].get('typeContrat') === 'CDI' && searches[0].get('publieeDepuis') === '14') pass('contract type is sent and 10 days rounds up to the allowed 14');
  else fail(`typeContrat=${searches[0].get('typeContrat')} publieeDepuis=${searches[0].get('publieeDepuis')}`);

  let calls = 0;
  const origWarn = console.warn;
  let warned = '';
  console.warn = (m) => { warned += m; };
  try {
    await provider.fetch({ name: 'FT', _env: CREDS, francetravail: { queries: ['x'], max_pages: 2 } }, {
      sleep: async () => {},
      fetchJson: async (url) => { if (url.includes('access_token')) return { access_token: 't' }; calls++; return { resultats: offers(calls * 1000, 150) }; },
    });
  } finally {
    console.warn = origWarn;
  }
  if (calls === 2 && /raise max_pages/.test(warned)) pass('max_pages bounds the walk and warns when it truncated a full board');
  else fail(`calls = ${calls}, warned = ${JSON.stringify(warned)}`);

  // A search with no match answers 204 with an empty body; the JSON reader throws a SyntaxError.
  let after = 0;
  const none = await provider.fetch({ name: 'FT', _env: CREDS, francetravail: { queries: ['nothing', 'devops'] } }, {
    sleep: async () => {},
    fetchJson: async (url) => {
      if (url.includes('access_token')) return { access_token: 't' };
      if (url.includes('motsCles=nothing')) throw new SyntaxError('Unexpected end of JSON input');
      after++;
      return { resultats: offers(0, 3) };
    },
  });
  if (none.length === 3 && after === 1) pass('an empty 204 answer counts as "no match" and the next query still runs');
  else fail(`empty-body handling: jobs=${none.length}, later queries=${after}`);

  let probeSearches = 0;
  await provider.fetch({ name: 'FT', _env: CREDS, francetravail: { queries: ['a', 'b'] } }, {
    maxPages: 1,
    sleep: async () => {},
    fetchJson: async (url) => { if (url.includes('access_token')) return { access_token: 't' }; probeSearches++; return { resultats: offers(0, 150) }; },
  });
  if (probeSearches === 2) pass('probe (ctx.maxPages: 1) reads one range per query');
  else fail(`probe made ${probeSearches} searches`);
} catch (err) {
  fail(`francetravail apply-link suite crashed: ${err.message}`);
}
