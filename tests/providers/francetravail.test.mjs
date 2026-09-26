// tests/providers/francetravail.test.mjs — France Travail (ex-Pôle Emploi).
//
// Offline: every request is served by a stub ctx, so the suite needs no
// credentials and never reaches the live API.
//
// NOTE ON COVERAGE. The field mapping in this provider is written from the
// published v2 contract and has not yet been confirmed against a live
// response (no credentials on this machine). These tests therefore pin the
// provider's OWN logic — credential handling, department validation, URL
// trust, dedup, refusal modes — and deliberately do not claim the upstream
// shape is verified. The provider's header carries the same warning.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — francetravail');

const CREDS = { FRANCETRAVAIL_CLIENT_ID: 'id', FRANCETRAVAIL_CLIENT_SECRET: 'secret' };

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/francetravail.mjs')).href);
  const provider = mod.default;
  const { normalizeFranceTravailOffer, normalizeDepartments, resolveCredentials } = mod;

  // ---- contract ----------------------------------------------------------
  if (provider?.id === 'francetravail') pass('id is "francetravail"');
  else fail(`id = ${JSON.stringify(provider?.id)}`);

  if (typeof provider?.fetch === 'function') pass('exports a fetch()');
  else fail('fetch() missing');

  if (provider.detect({ provider: 'francetravail' }) && provider.detect({ provider: 'x' }) === null) {
    pass('detect() claims only provider: francetravail');
  } else {
    fail('detect() should claim exactly the francetravail entries');
  }

  // ---- credentials -------------------------------------------------------
  // The important property: absent credentials must be LOUD. An empty array
  // here would read as "no jobs in France", silently deleting the source.
  let credErr = null;
  try {
    resolveCredentials({});
  } catch (e) {
    credErr = e;
  }
  if (credErr && /FRANCETRAVAIL_CLIENT_ID/.test(credErr.message)) {
    pass('resolveCredentials() throws a named, actionable error when unset');
  } else {
    fail('missing credentials must throw naming the env vars');
  }
  if (credErr && /francetravail\.io/.test(credErr.message)) {
    pass('the credential error tells the user where to register');
  } else {
    fail('the credential error should point at francetravail.io');
  }

  let blankErr = null;
  try {
    resolveCredentials({ FRANCETRAVAIL_CLIENT_ID: '   ', FRANCETRAVAIL_CLIENT_SECRET: 'x' });
  } catch (e) {
    blankErr = e;
  }
  if (blankErr) pass('resolveCredentials() treats whitespace-only as missing');
  else fail('a whitespace-only client id should be rejected');

  const ok = resolveCredentials({ ...CREDS });
  if (ok.clientId === 'id' && ok.clientSecret === 'secret') pass('resolveCredentials() returns both values');
  else fail(`resolveCredentials() = ${JSON.stringify(ok)}`);

  // ---- departments -------------------------------------------------------
  if (JSON.stringify(normalizeDepartments(['31', 75, '2b'])) === JSON.stringify(['31', '75', '2B'])) {
    pass('normalizeDepartments() accepts department codes');
  } else {
    fail(`normalizeDepartments() = ${JSON.stringify(normalizeDepartments(['31', 75, '2b']))}`);
  }
  if (normalizeDepartments(['../x', 'ZZ', '99999']).length === 0) {
    pass('normalizeDepartments() drops invalid codes rather than sending them');
  } else {
    fail('invalid department codes must be dropped');
  }

  // ---- offer normalisation ----------------------------------------------
  const offer = normalizeFranceTravailOffer({
    id: '190ABCD',
    intitule: '  Ingénieur DevOps (H/F)  ',
    description: 'Vous rejoignez une équipe plateforme.',
    dateCreation: '2026-09-11T08:00:00.000Z',
    lieuTravail: { libelle: '31 - TOULOUSE' },
    entreprise: { nom: 'ACME' },
  });
  if (offer?.title === 'Ingénieur DevOps (H/F)') pass('normalizeFranceTravailOffer() trims the title');
  else fail(`title = ${JSON.stringify(offer?.title)}`);

  if (offer?.url === 'https://candidat.francetravail.fr/offres/recherche/detail/190ABCD') {
    pass('falls back to the France Travail detail URL when no origin URL is given');
  } else {
    fail(`url = ${JSON.stringify(offer?.url)}`);
  }

  if (offer?.company === 'ACME' && offer?.location === '31 - TOULOUSE') {
    pass('maps entreprise.nom and lieuTravail.libelle');
  } else {
    fail(`company/location = ${JSON.stringify([offer?.company, offer?.location])}`);
  }

  if (offer?.postedAt === Date.parse('2026-09-11T08:00:00.000Z')) {
    pass('converts dateCreation to epoch ms');
  } else {
    fail(`postedAt = ${JSON.stringify(offer?.postedAt)}`);
  }

  // Salary is deliberately not parsed — `salaire.libelle` mixes hourly,
  // monthly and annual prose, and a wrong number would drive salary_filter.
  const withSalary = normalizeFranceTravailOffer({
    id: '1A',
    intitule: 'X',
    salaire: { libelle: 'Horaire de 15 Euros' },
  });
  if (withSalary && !('salary' in withSalary)) {
    pass('does not invent a salary from free-prose salaire.libelle');
  } else {
    fail('salary must be omitted until the live shape is sampled');
  }

  // An employer URL is third-party data: trusted only when absolute https.
  const httpsOrigin = normalizeFranceTravailOffer({
    id: '1A',
    intitule: 'X',
    origineOffre: { urlOrigine: 'https://careers.acme.test/jobs/1' },
  });
  if (httpsOrigin?.url === 'https://careers.acme.test/jobs/1') {
    pass('prefers an absolute https origineOffre.urlOrigine');
  } else {
    fail(`https origin url = ${JSON.stringify(httpsOrigin?.url)}`);
  }

  const badOrigins = ['javascript:alert(1)', 'http://insecure.test/x', 'not-a-url', '', null, 42];
  const rejected = badOrigins.every((urlOrigine) => {
    const r = normalizeFranceTravailOffer({ id: '1A', intitule: 'X', origineOffre: { urlOrigine } });
    return r?.url === 'https://candidat.francetravail.fr/offres/recherche/detail/1A';
  });
  if (rejected) {
    pass('ignores javascript:, http: and malformed origin URLs, keeping the safe fallback');
  } else {
    fail('an untrusted origineOffre.urlOrigine must not become the job URL');
  }

  const hostileIds = ['../../evil', 'a/b', 'x?y', '', null];
  if (hostileIds.every((id) => normalizeFranceTravailOffer({ id, intitule: 'X' }) === null)) {
    pass('drops offers whose id could escape the URL path');
  } else {
    fail('hostile ids must drop the row');
  }

  if (normalizeFranceTravailOffer({ id: '1A' }) === null && normalizeFranceTravailOffer(null) === null) {
    pass('drops a titleless offer and a non-object');
  } else {
    fail('titleless / non-object offers should drop');
  }

  const anon = normalizeFranceTravailOffer({ id: '1A', intitule: 'X' }, 'France Travail 31');
  if (anon?.company === 'France Travail 31') {
    pass('falls back to the entry name for an anonymised posting');
  } else {
    fail(`anonymised company = ${JSON.stringify(anon?.company)}`);
  }

  // ---- fetch() -----------------------------------------------------------
  let noQueryErr = null;
  try {
    await provider.fetch({ name: 'FT', _env: CREDS }, { fetchJson: async () => ({}) });
  } catch (e) {
    noQueryErr = e;
  }
  if (noQueryErr && /configure explicit searches/i.test(noQueryErr.message)) {
    pass('fetch() refuses to scan the national board without configured queries');
  } else {
    fail(`missing queries should throw, got ${noQueryErr ? noQueryErr.message : 'no error'}`);
  }

  // Credential failure must surface before any search request is made.
  let called = 0;
  let noCredErr = null;
  try {
    await provider.fetch(
      { name: 'FT', _env: {}, francetravail: { queries: ['devops'] } },
      { fetchJson: async () => { called += 1; return {}; } },
    );
  } catch (e) {
    noCredErr = e;
  }
  if (noCredErr && called === 0) {
    pass('fetch() fails on missing credentials without issuing a request');
  } else {
    fail(`expected zero requests on missing creds, saw ${called}`);
  }

  // Happy path: token, then one search per query, deduped.
  const seen = [];
  const stub = {
    fetchJson: async (url, opts) => {
      seen.push({ url, opts });
      if (url.includes('access_token')) return { access_token: 'tok-123' };
      return {
        resultats: [
          { id: 'DUP', intitule: 'Shared', lieuTravail: { libelle: '31 - TOULOUSE' } },
          { id: 'U' + seen.length, intitule: 'Unique', lieuTravail: { libelle: '31 - TOULOUSE' } },
        ],
      };
    },
  };
  const jobs = await provider.fetch(
    {
      name: 'FT',
      _env: CREDS,
      francetravail: { queries: ['devops', 'cloud'], departments: ['31'], max_hits: 20 },
    },
    stub,
  );

  if (jobs.length === 3) pass('fetch() de-duplicates the same offer across queries');
  else fail(`expected 3 unique jobs, got ${jobs.length}`);

  if (seen.length === 3 && seen[0].url.includes('access_token') && seen[0].opts.method === 'POST') {
    pass('fetch() POSTs for a token once, then searches per query');
  } else {
    fail(`request sequence = ${JSON.stringify(seen.map((s) => s.url.slice(0, 60)))}`);
  }

  const search = seen[1];
  if (search.opts.headers.authorization === 'Bearer tok-123') {
    pass('fetch() sends the bearer token on searches');
  } else {
    fail(`authorization = ${JSON.stringify(search.opts.headers.authorization)}`);
  }
  if (search.url.includes('departement=31')) pass('fetch() forwards departments as `departement`');
  else fail(`search url missing departement: ${search.url}`);
  if (search.url.includes('range=0-19')) pass('fetch() converts max_hits to an inclusive range');
  else fail(`range not 0-19 in ${search.url}`);

  // A token response without access_token must not proceed to search.
  let tokErr = null;
  try {
    await provider.fetch(
      { name: 'FT', _env: CREDS, francetravail: { queries: ['x'] } },
      { fetchJson: async () => ({ error: 'invalid_client' }) },
    );
  } catch (e) {
    tokErr = e;
  }
  if (tokErr && /no access_token/i.test(tokErr.message)) {
    pass('fetch() throws a diagnosable error when the token call returns no token');
  } else {
    fail('a tokenless auth response must throw');
  }

  // 204/no-content is a legitimate empty result, not a shape error.
  const emptyJobs = await provider.fetch(
    { name: 'FT', _env: CREDS, francetravail: { queries: ['x'] } },
    {
      fetchJson: async (url) => (url.includes('access_token') ? { access_token: 't' } : null),
    },
  );
  if (Array.isArray(emptyJobs) && emptyJobs.length === 0) {
    pass('fetch() treats an empty (204) search response as zero jobs, not an error');
  } else {
    fail('a null search body should yield []');
  }

  // But a genuinely wrong shape must be loud.
  let shapeErr = null;
  try {
    await provider.fetch(
      { name: 'FT', _env: CREDS, francetravail: { queries: ['x'] } },
      {
        fetchJson: async (url) => (url.includes('access_token') ? { access_token: 't' } : { nope: 1 }),
      },
    );
  } catch (e) {
    shapeErr = e;
  }
  if (shapeErr && /unexpected response/i.test(shapeErr.message)) {
    pass('fetch() throws when the search payload is missing `resultats`');
  } else {
    fail('a malformed search payload must throw rather than return []');
  }

  // ---- minYears from experienceExige / experienceLibelle (years filter) ----
  const ftOffer = { intitule: 'Ingénieur DevOps', id: '123ABC' };
  const y5 = normalizeFranceTravailOffer({ ...ftOffer, experienceExige: 'E', experienceLibelle: '5 An(s)' });
  const y3 = normalizeFranceTravailOffer({ ...ftOffer, experienceExige: 'E', experienceLibelle: 'Expérience exigée de 36 Mois' });
  const yD = normalizeFranceTravailOffer({ ...ftOffer, experienceExige: 'D', experienceLibelle: 'Débutant accepté' });
  const yNone = normalizeFranceTravailOffer(ftOffer);
  if (y5.minYears === 5 && y3.minYears === 3 && yD.minYears === 0 && !('minYears' in yNone)) {
    pass('normalizeFranceTravailOffer() reads the years asked from experienceLibelle / experienceExige');
  } else fail(`minYears = ${JSON.stringify([y5.minYears, y3.minYears, yD.minYears, yNone.minYears])}`);
} catch (err) {
  fail(`francetravail provider suite crashed: ${err.message}`);
}
