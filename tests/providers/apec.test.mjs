// tests/providers/apec.test.mjs — APEC, the French national cadre board.
//
// Offline throughout: provider.fetch() is driven with a stub ctx, so the suite
// never touches apec.fr. The behaviours pinned here are the ones that would
// silently corrupt a scan rather than throw:
//   - a posting id goes straight into a URL path, so it must be constrained;
//   - `salaireTexte` is prose and a misparse would feed scan.mjs's salary_filter
//     a wrong number, which is worse than no number at all;
//   - an unrecognised department code makes APEC answer with an EMPTY result
//     set, indistinguishable from "no jobs in this region" — so bad codes must
//     be dropped before the request, never sent.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — apec');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/apec.mjs')).href);
  const provider = mod.default;
  const { normalizeApecHit, parseApecSalary, normalizeDepartments } = mod;

  // ---- contract ----------------------------------------------------------
  if (provider?.id === 'apec') pass('id is "apec"');
  else fail(`id = ${JSON.stringify(provider?.id)}`);

  if (typeof provider?.fetch === 'function') pass('exports a fetch()');
  else fail('fetch() missing');

  if (provider.detect({ provider: 'apec' }) && provider.detect({ provider: 'other' }) === null) {
    pass('detect() claims only provider: apec');
  } else {
    fail('detect() should claim exactly the apec entries');
  }

  // ---- salary parsing ----------------------------------------------------
  const range = parseApecSalary('65 - 75 k€ brut annuel');
  if (range && range.min === 65000 && range.max === 75000 && range.currency === 'EUR') {
    pass('parseApecSalary() scales a k€ range to 65000-75000 EUR');
  } else {
    fail(`k€ range parsed as ${JSON.stringify(range)}`);
  }

  const single = parseApecSalary('45 k€ brut annuel');
  if (single && single.min === 45000 && single.max === 45000) {
    pass('parseApecSalary() maps a single k€ figure to min === max');
  } else {
    fail(`single k€ parsed as ${JSON.stringify(single)}`);
  }

  // "Selon profil" is the most common value on the board. Returning a number
  // here would invent a salary the employer never published.
  const vague = ['Selon profil', '', null, undefined, 'A négocier', 42].map(parseApecSalary);
  if (vague.every((v) => v === null)) {
    pass('parseApecSalary() returns null for prose, empty, non-string and bare numbers');
  } else {
    fail(`non-k€ inputs parsed as ${JSON.stringify(vague)}`);
  }

  // ---- department normalisation -----------------------------------------
  const depts = normalizeDepartments(['31', 75, '2a', '  92 ', '971']);
  if (JSON.stringify(depts) === JSON.stringify(['31', '75', '2A', '92', '971'])) {
    pass('normalizeDepartments() accepts 2-digit, 3-digit, Corsican and numeric codes');
  } else {
    fail(`normalizeDepartments() = ${JSON.stringify(depts)}`);
  }

  const junk = normalizeDepartments(['../etc', 'ABC', '', null, '12345', {}, []]);
  if (Array.isArray(junk) && junk.length === 0) {
    pass('normalizeDepartments() drops path-ish, alphabetic and over-long codes');
  } else {
    fail(`junk codes survived: ${JSON.stringify(junk)}`);
  }

  if (normalizeDepartments('31').length === 0 && normalizeDepartments(undefined).length === 0) {
    pass('normalizeDepartments() returns [] for a non-array');
  } else {
    fail('non-array input should yield []');
  }

  const dedup = normalizeDepartments(['31', '31', 31]);
  if (dedup.length === 1) pass('normalizeDepartments() de-duplicates');
  else fail(`duplicates survived: ${JSON.stringify(dedup)}`);

  // ---- hit normalisation -------------------------------------------------
  const hit = normalizeApecHit({
    intitule: '  Ingénieur DevOps F/H  ',
    numeroOffre: '179410350W',
    nomCommercial: 'ADVEEZ',
    lieuTexte: 'Colomiers - 31',
    texteOffre: 'Vous rejoignez une équipe plateforme.',
    datePublication: '2026-09-11T10:49:02.000+0000',
    salaireTexte: '45 - 55 k€ brut annuel',
  });
  if (hit?.title === 'Ingénieur DevOps F/H') pass('normalizeApecHit() trims the title');
  else fail(`title = ${JSON.stringify(hit?.title)}`);

  if (hit?.url === 'https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/179410350W') {
    pass('normalizeApecHit() builds the public detail URL from numeroOffre');
  } else {
    fail(`url = ${JSON.stringify(hit?.url)}`);
  }

  if (hit?.company === 'ADVEEZ' && hit?.location === 'Colomiers - 31') {
    pass('normalizeApecHit() maps company and location');
  } else {
    fail(`company/location = ${JSON.stringify([hit?.company, hit?.location])}`);
  }

  if (hit?.postedAt === Date.parse('2026-09-11T10:49:02.000+0000')) {
    pass('normalizeApecHit() converts datePublication to epoch ms');
  } else {
    fail(`postedAt = ${JSON.stringify(hit?.postedAt)}`);
  }

  if (hit?.description === 'Vous rejoignez une équipe plateforme.') {
    pass('normalizeApecHit() carries texteOffre as description (no extra request)');
  } else {
    fail(`description = ${JSON.stringify(hit?.description)}`);
  }

  // A posting id is interpolated into a URL path. Anything that could add a
  // segment, a query or a host must drop the whole row.
  const hostile = ['../../evil', 'a/b', 'x?y=1', 'x#y', 'http://evil.test', '', '   ', null];
  const hostileOut = hostile.map((numeroOffre) => normalizeApecHit({ intitule: 'X', numeroOffre }));
  if (hostileOut.every((r) => r === null)) {
    pass('normalizeApecHit() drops ids containing path, query, fragment or host characters');
  } else {
    fail(`hostile ids survived: ${JSON.stringify(hostileOut.filter(Boolean).map((r) => r.url))}`);
  }

  if (normalizeApecHit({ numeroOffre: '123W' }) === null && normalizeApecHit(null) === null) {
    pass('normalizeApecHit() drops a titleless hit and a non-object');
  } else {
    fail('titleless / non-object hits should drop');
  }

  // A confidential posting has no nomCommercial; fall back to the entry name.
  const confidential = normalizeApecHit({ intitule: 'X', numeroOffre: '1W' }, 'APEC Toulouse');
  if (confidential?.company === 'APEC Toulouse') {
    pass('normalizeApecHit() falls back to the entry name for a confidential posting');
  } else {
    fail(`confidential company = ${JSON.stringify(confidential?.company)}`);
  }

  const noSalary = normalizeApecHit({ intitule: 'X', numeroOffre: '1W', salaireTexte: 'Selon profil' });
  if (noSalary && !('salary' in noSalary)) {
    pass('normalizeApecHit() omits salary entirely when none is published');
  } else {
    fail('an unpublished salary must not appear on the job');
  }

  // ---- fetch() -----------------------------------------------------------
  if (Array.isArray(mod) === false) {
    let threw = null;
    try {
      await provider.fetch({ name: 'APEC' }, { fetchJson: async () => ({ resultats: [] }) });
    } catch (e) {
      threw = e;
    }
    if (threw && /configure explicit searches/i.test(threw.message)) {
      pass('fetch() refuses to scan the national board without configured queries');
    } else {
      fail(`missing queries should throw, got ${threw ? threw.message : 'no error'}`);
    }
  }

  // Two queries returning an overlapping row must collapse to one job.
  const sent = [];
  const stubCtx = {
    fetchJson: async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body), method: opts.method });
      return {
        resultats: [
          { intitule: 'Shared', numeroOffre: 'DUP1', nomCommercial: 'A', lieuTexte: 'Toulouse - 31' },
          { intitule: 'Unique ' + sent.length, numeroOffre: 'U' + sent.length, nomCommercial: 'B', lieuTexte: 'Toulouse - 31' },
        ],
      };
    },
  };
  const jobs = await provider.fetch(
    { name: 'APEC', apec: { queries: ['devops', 'kubernetes'], departments: ['31'], max_hits: 50 } },
    stubCtx,
  );
  if (jobs.length === 3) pass('fetch() de-duplicates the same posting across queries');
  else fail(`expected 3 unique jobs, got ${jobs.length}`);

  if (sent.length === 2 && sent.every((r) => r.method === 'POST')) {
    pass('fetch() issues one POST per configured query');
  } else {
    fail(`requests = ${JSON.stringify(sent.map((r) => r.method))}`);
  }

  if (sent.every((r) => JSON.stringify(r.body.lieux) === JSON.stringify(['31']))) {
    pass('fetch() forwards departments as `lieux`');
  } else {
    fail(`lieux sent = ${JSON.stringify(sent.map((r) => r.body.lieux))}`);
  }

  if (sent[0].body.pagination.range === 50 && sent[0].body.motsCles === 'devops') {
    pass('fetch() sends max_hits as pagination.range and the query as motsCles');
  } else {
    fail(`body = ${JSON.stringify(sent[0].body)}`);
  }

  // Absent departments must omit `lieux` rather than send an empty array,
  // whose behaviour against the live API is unverified.
  const sent2 = [];
  await provider.fetch(
    { name: 'APEC', apec: { queries: ['devops'] } },
    {
      fetchJson: async (url, opts) => {
        sent2.push(JSON.parse(opts.body));
        return { resultats: [] };
      },
    },
  );
  if (sent2.length === 1 && !('lieux' in sent2[0])) {
    pass('fetch() omits `lieux` when no departments are configured');
  } else {
    fail(`lieux key present without config: ${JSON.stringify(sent2[0])}`);
  }

  // max_hits is capped so a typo cannot ask APEC for an unbounded page.
  const sent3 = [];
  await provider.fetch(
    { name: 'APEC', apec: { queries: ['x'], max_hits: 99999 } },
    {
      fetchJson: async (url, opts) => {
        sent3.push(JSON.parse(opts.body));
        return { resultats: [] };
      },
    },
  );
  if (sent3[0].pagination.range === 200) pass('fetch() caps max_hits at 200');
  else fail(`range = ${sent3[0].pagination.range}, expected the 200 cap`);

  // A shape change upstream must be loud, not an empty scan.
  let shapeErr = null;
  try {
    await provider.fetch(
      { name: 'APEC', apec: { queries: ['x'] } },
      { fetchJson: async () => ({ unexpected: true }) },
    );
  } catch (e) {
    shapeErr = e;
  }
  if (shapeErr && /unexpected response/i.test(shapeErr.message)) {
    pass('fetch() throws when the payload is missing `resultats`');
  } else {
    fail('a malformed payload must throw rather than return []');
  }
} catch (err) {
  fail(`apec provider suite crashed: ${err.message}`);
}
