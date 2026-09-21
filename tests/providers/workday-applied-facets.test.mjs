// tests/providers/workday-applied-facets.test.mjs — entry-level server-side
// narrowing (`applied_facets` / `search_text`), and the one way it must not
// interact with upstream's facet split.
//
// This is a LOCAL feature: portals.yml pins several Workday tenants to a single
// locationCountry so a global directory bigger than the CXS 2,000-result
// ceiling still yields the France postings the search is actually about. It is
// not upstream's mechanism (upstream recovers a clamped board by splitting it
// after the fact), so no upstream test covers it and a future `update-system
// apply` that takes the upstream provider wholesale would drop it silently.
// That is exactly what this file exists to catch.
//
// The assertion that matters most is the collision guard. Both mechanisms write
// the SAME appliedFacets object, so if the split ever chooses a facet the entry
// already pinned, the slice value replaces the pin — a board scoped to France
// gets re-sliced into Brazil and India, and foreign roles flood back into the
// scan looking like a normal successful crawl.
//
// Run: node test-all.mjs --only workday-applied-facets

import { pass, fail, ROOT, captureConsoleErrors } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — workday applied_facets (local narrowing)');

const workday = (await import(pathToFileURL(join(ROOT, 'providers/workday.mjs')).href)).default;

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const CAREERS = 'https://capgemini.wd3.myworkdayjobs.com/CapgeminiCareers';

/** Collect every request body a fetch() produces against a canned response. */
const capture = async (entry, response) => {
  const bodies = [];
  const ctx = {
    fetchJson: async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return response; },
    sleep: async () => {},
  };
  // A clamped board logs its recovery line via console.error; capture it so the
  // suite output stays readable.
  await captureConsoleErrors(() => workday.fetch(entry, ctx));
  return bodies;
};

const EMPTY = { total: 0, jobPostings: [], facets: [] };

// ── The feature itself ────────────────────────────────────────────────────
let bodies = await capture(
  { name: 'Capgemini', careers_url: CAREERS, applied_facets: { locationCountry: 'FR-id' }, search_text: 'cloud' },
  EMPTY,
);
check('a scoped entry sends its facets and search text',
  [bodies[0].appliedFacets, bodies[0].searchText], [{ locationCountry: ['FR-id'] }, 'cloud']);
check('  ...a bare string value is normalized to the array the API requires',
  Array.isArray(bodies[0].appliedFacets.locationCountry), true);

bodies = await capture(
  { name: 'Multi', careers_url: CAREERS, applied_facets: { locationCountry: ['FR-id', 'BE-id'], jobFamily: 'eng' } },
  EMPTY,
);
check('multiple facets and multi-value facets pass through intact',
  bodies[0].appliedFacets, { locationCountry: ['FR-id', 'BE-id'], jobFamily: ['eng'] });

// Omitting the keys must reproduce the unfiltered behaviour byte for byte —
// every un-scoped tenant in portals.yml depends on that.
bodies = await capture({ name: 'Plain', careers_url: CAREERS }, EMPTY);
check('an entry with neither key is unfiltered, exactly as before',
  [bodies[0].appliedFacets, bodies[0].searchText], [{}, '']);

for (const [label, raw] of [['a list', ['a']], ['a string', 'x'], ['null', null], ['a number', 7]]) {
  bodies = await capture({ name: 'Junk', careers_url: CAREERS, applied_facets: raw }, EMPTY);
  const ok = JSON.stringify(bodies[0].appliedFacets) === (Array.isArray(raw) || typeof raw !== 'object' || raw === null ? '{}' : '{}');
  if (ok) pass(`a malformed applied_facets (${label}) degrades to unfiltered, never throws`);
  else fail(`malformed applied_facets (${label}) produced ${JSON.stringify(bodies[0].appliedFacets)}`);
}

bodies = await capture({ name: 'Empties', careers_url: CAREERS, applied_facets: { a: [], b: [''], c: ['ok'] } }, EMPTY);
check('facets with no usable values are dropped rather than sent empty',
  bodies[0].appliedFacets, { c: ['ok'] });

// ── The collision guard ───────────────────────────────────────────────────
// A board that stays clamped: `total` pinned at the ceiling while the facets
// describe a far bigger one. locationCountry has the smallest largest-slice, so
// chooseSplitFacet would pick it — the collision — unless it is excluded.
const CLAMPED = {
  total: 2000,
  jobPostings: [],
  facets: [
    { facetParameter: 'locationCountry', values: [
      { id: 'FR-id', count: 2100 }, { id: 'BR-id', count: 2200 }, { id: 'IN-id', count: 2300 }] },
    { facetParameter: 'jobFamily', values: [
      { id: 'eng', count: 4000 }, { id: 'ops', count: 2600 }] },
  ],
};

bodies = await capture(
  { name: 'Capgemini', careers_url: CAREERS, applied_facets: { locationCountry: 'FR-id' } },
  CLAMPED,
);
const countriesSent = [...new Set(bodies.map((b) => JSON.stringify(b.appliedFacets.locationCountry)))];
check('the entry pin holds on EVERY request a clamped board makes',
  countriesSent, ['["FR-id"]']);
check('  ...so the split falls to the next facet instead of overriding it',
  [...new Set(bodies.flatMap((b) => Object.keys(b.appliedFacets)))].sort(),
  ['jobFamily', 'locationCountry']);
check('  ...and it did split, rather than giving up on the clamped board',
  bodies.length > 1, true);

// With no entry pin, the same board splits on locationCountry as upstream
// intends — the guard excludes only what the entry actually pinned, and must
// not disable the split generally. (Every slice here is itself still over the
// ceiling, so upstream then nests a second facet; that is the split working,
// not the guard leaking.)
bodies = await capture({ name: 'Unscoped', careers_url: CAREERS }, CLAMPED);
const unscopedFirstSlice = bodies.find((b) => Object.keys(b.appliedFacets).length > 0);
check('an unscoped clamped board splits on locationCountry — nothing is excluded',
  Object.keys(unscopedFirstSlice.appliedFacets), ['locationCountry']);
check('  ...and reaches values the scoped run must never send',
  bodies.some((b) => JSON.stringify(b.appliedFacets.locationCountry) === '["BR-id"]'), true);

// ── The real portals.yml entries this protects ────────────────────────────
const { readFileSync, existsSync } = await import('fs');
const portalsPath = join(ROOT, 'portals.yml');
if (!existsSync(portalsPath)) {
  pass('no portals.yml in this checkout to cross-check (skipped)');
} else {
  const yaml = await import('js-yaml');
  const portals = yaml.load(readFileSync(portalsPath, 'utf-8'));
  const scoped = (portals?.tracked_companies ?? [])
    .filter((c) => c && typeof c === 'object' && c.applied_facets);
  if (scoped.length === 0) {
    pass('portals.yml has no applied_facets entries to cross-check (skipped)');
  } else {
    let allUsable = true;
    for (const entry of scoped) {
      const sent = (await capture(entry, EMPTY))[0]?.appliedFacets ?? {};
      if (Object.keys(sent).length === 0) { allUsable = false; fail(`portals.yml entry "${entry.name}" has applied_facets the provider drops`); }
    }
    if (allUsable) pass(`all ${scoped.length} scoped portals.yml entries produce a non-empty appliedFacets body`);
  }
}
