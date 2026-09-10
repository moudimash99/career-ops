// tests/company-cap.test.mjs — the per-employer ceiling.
//
// The tracker reached 984 sent applications with 977 of them going to four
// companies: 410, 361, 145, 61. Nothing in the pipeline noticed, and one of
// those tenants dedupes by candidate email across requisitions, so most of
// those 410 never reached a human. The cap exists so the 411th cannot happen
// by accident.
//
// What the suite mostly guards is EVASION. A cap keyed on an exact company
// string is worth very little: the same employer arrives as "Thales", "THALES
// GROUP", "Capgemini Engineering" and "Airbus Defence and Space", and the
// tracker already carries some of those as separate rows.
//
// Run: node test-all.mjs --only company-cap

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ncompany-cap — no employer gets asked 411 times');

const { countByCompany, checkCompany, capKey, resolveCountedKey, report, DEFAULT_CAP } =
  await import(pathToFileURL(join(ROOT, 'lib/company-cap.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-01-01 | Thales | Eng | 4.0/5 | Applied | ❌ | - | x |
| 2 | 2026-01-02 | Thales | Eng | 4.0/5 | Applied | ❌ | - | x |
| 3 | 2026-01-03 | Thales | Eng | 4.0/5 | Rejected | ❌ | - | x |
| 4 | 2026-01-04 | Davidson | Eng | 4.5/5 | Applied | ❌ | - | x |
| 5 | 2026-01-05 | Davidson | Eng | 4.5/5 | Evaluated | ❌ | - | never sent |
| 6 | 2026-01-06 | SII | Arch | 4.5/5 | SKIP | ❌ | - | never sent |
`;

const counts = countByCompany(TRACKER);

check('sent rows are counted', counts.get('thales').sent, 3);
// A Rejected row is still an application that went out, and counting it is
// what keeps a company from being re-approached forever after it said no.
check('a rejection counts as sent — it reached them', counts.has('thales'), true);
check('an Evaluated row is not counted: nobody sent it', counts.get('davidson').sent, 1);
check('a SKIP row is not counted either', counts.has('sii'), false);
check('the header and separator rows are skipped', counts.size, 2);

// ------------------------------------------------------------ the key

check('a plain name is its own key', capKey('Davidson'), 'davidson');
check('a legal-form suffix is stripped', capKey('Thales Group SAS'), 'thales');
check('a division suffix is stripped', capKey('Capgemini Engineering'), 'capgemini');
check('case and punctuation do not matter', capKey('THALES,  GROUP.'), 'thales');
check('accents fold', capKey('Systèmes SA'), 'systemes');
// A leading word is part of the name; only trailing ones are legal forms.
check('a leading word is kept', capKey('Groupe SII'), 'groupe sii');
// Stripping must never leave nothing behind.
check('a company actually called Group keeps a key', capKey('Group'), 'group');
check('an empty name has no key', capKey(''), '');
check('a null name does not throw', capKey(null), '');

// ------------------------------------------------- division resolution

// Suffix stripping cannot reach this: "Defence and Space" is a business unit,
// and no list of legal forms will ever contain every division name.
check('a division resolves to its parent',
  resolveCountedKey('airbus defence and space', new Map([['airbus', { company: 'Airbus', sent: 145 }]])).sent, 145);

// Anchored on whole tokens at the start, so coincidences cannot fire.
check('a longer word that merely starts the same does not match',
  resolveCountedKey('airbush systems', new Map([['airbus', { company: 'Airbus', sent: 145 }]])), null);
check('mentioning an employer later is not being that employer',
  resolveCountedKey('consulting for airbus', new Map([['airbus', { company: 'Airbus', sent: 145 }]])), null);

check('the most specific parent wins',
  resolveCountedKey('airbus defence and space gmbh', new Map([
    ['airbus', { company: 'Airbus', sent: 145 }],
    ['airbus defence', { company: 'Airbus Defence', sent: 7 }],
  ])).sent, 7);

// ------------------------------------------------------------ the gate

const capped = new Map([['thales', { company: 'Thales', sent: 410 }], ['davidson', { company: 'Davidson', sent: 3 }]]);

check('an employer under the cap is allowed', checkCompany('Davidson', capped, 20).allowed, true);
check('and it says how much room is left', checkCompany('Davidson', capped, 20).remaining, 17);
check('an employer at the cap is refused', checkCompany('Thales', capped, 20).allowed, false);
check('a suffix variant is refused too', checkCompany('THALES GROUP SAS', capped, 20).allowed, false);
check('an unknown employer starts at zero', checkCompany('Somebody New', capped, 20).sent, 0);
check('exactly at the cap is refused, not allowed',
  checkCompany('X', new Map([['x', { company: 'X', sent: 20 }]]), 20).allowed, false);
check('one below the cap is allowed',
  checkCompany('X', new Map([['x', { company: 'X', sent: 19 }]]), 20).allowed, true);
check('the refusal says why', /410 applications already sent/.test(checkCompany('Thales', capped, 20).reason), true);
// When the block comes from a parent rather than the name given, say so.
check('a division block names what it matched',
  checkCompany('Airbus Atlantic', new Map([['airbus', { company: 'Airbus', sent: 145 }]]), 20).matchedAs, 'Airbus');

check('the default cap is the one the user chose', DEFAULT_CAP, 20);

// ---------------------------------------------------------- the report

const r = report(new Map([
  ['a', { company: 'A', sent: 40 }],
  ['b', { company: 'B', sent: 18 }],
  ['c', { company: 'C', sent: 2 }],
]), 20);
check('over-cap employers are listed', r.overCap.map((x) => x.company), ['A']);
check('near-cap employers are listed separately', r.nearCap.map((x) => x.company), ['B']);
check('and the total is the sum', r.total, 60);
check('an empty tracker reports nothing', report(new Map(), 20).overCap, []);
