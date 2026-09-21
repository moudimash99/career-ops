// tests/blacklist-match.test.mjs — the do-not-apply list has to catch the employer, not the string.
//
// data/blacklist.md names employers. Postings name whatever the feed calls
// them. On 2026-09-11 a scan put three "Accenture France" postings into the
// pipeline one day after the user blacklisted "Accenture", because every
// consumer looked the posting up by exact normalized name — the scan, the
// full-ATS scan, the pipeline pruner, and the Free Motion applier's own gate.
//
// Run: node test-all.mjs --only blacklist-match

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nblacklist-match — a blacklisted employer is blacklisted under every spelling');

const { matchBlacklist } = await import(pathToFileURL(join(ROOT, 'lib/company-cap.mjs')).href);
const { parseBlacklist } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const blacklist = parseBlacklist([
  '| Company | Since | Scope | Reason |',
  '|---------|-------|-------|--------|',
  '| Accenture Federal Services | 2026-08-25 | scan+apply | US clearance |',
  '| Airbus | 2026-09-10 | scan+apply | manual |',
  '| Airbus Defence | 2026-09-10 | scan+apply | division row |',
  '| Accenture | 2026-09-10 | scan+apply | manual |',
  '| NTT | 2026-09-10 | scan+apply | manual |',
  '| Capgemini | 2026-09-10 | scan+apply | manual |',
  '| Thales | 2026-09-10 | scan+apply | manual |',
  '| Acme Corp. | 2026-01-15 | company | exact-tier row |',
].join('\n'));

const listedAs = (company) => matchBlacklist(blacklist, company)?.company ?? null;
const check = (label, actual, expected) => {
  if (actual === expected) pass(label);
  else fail(`${label} => ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// The leak this file exists for.
check('"Accenture France" is caught by the "Accenture" row', listedAs('Accenture France'), 'Accenture');

// Division and legal-form spellings of listed employers.
check('"NTT DATA" is caught by "NTT"', listedAs('NTT DATA'), 'NTT');
check('"Thales Alenia Space" is caught by "Thales"', listedAs('Thales Alenia Space'), 'Thales');
check('"THALES GROUP" is caught by "Thales"', listedAs('THALES GROUP'), 'Thales');
check('"Capgemini Engineering" is caught by "Capgemini"', listedAs('Capgemini Engineering'), 'Capgemini');
check('accents and case do not matter', listedAs('capgémini'), 'Capgemini');

// The exact tier still behaves exactly as before.
check('exact tier: "ACME-CORP" still hits "Acme Corp."', listedAs('ACME-CORP'), 'Acme Corp.');
check('exact tier wins: "Accenture Federal Services" keeps its own row and reason',
  matchBlacklist(blacklist, 'Accenture Federal Services')?.reason, 'US clearance');

// Most specific row wins when two rows prefix the posting's name.
check('longest prefix wins: "Airbus Defence and Space" resolves to "Airbus Defence"',
  listedAs('Airbus Defence and Space'), 'Airbus Defence');
check('the bare employer still resolves to its own row', listedAs('Airbus Operations'), 'Airbus');

// Anchored on whole leading tokens, so it cannot fire on a coincidence.
check('a name that mentions a listed employer later is not caught', listedAs('Consulting for Airbus'), null);
check('a shared first letters are not a shared token', listedAs('Airbush Systems'), null);
check('"NTTX Labs" is not "NTT"', listedAs('NTTX Labs'), null);
check('an unlisted employer is not caught', listedAs('Lengow'), null);

// Degenerate inputs never throw and never match.
check('empty company name', listedAs(''), null);
check('undefined company name', listedAs(undefined), null);
check('empty blacklist', matchBlacklist(new Map(), 'Accenture France'), null);
check('missing blacklist', matchBlacklist(undefined, 'Accenture France'), null);
