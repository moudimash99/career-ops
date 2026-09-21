// tests/freemotion-factcheck.test.mjs — prose that claims what the files don't.
//
// Built from the six invented facts a real batch of generated cover letters
// carried, the worst being a degree the candidate does not hold, addressed to
// an employer who could check. Every one of them reads perfectly — which is
// exactly why a machine checks the claims before a human is asked to trust the
// writing.
//
// The rule this enforces is AGENTS.md's: keywords get reformulated, never
// fabricated; authorship and credential claims are non-negotiable.
//
// Run: node test-all.mjs --only freemotion-factcheck

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-factcheck — a number that moved is still a lie');

const { extractClaims, checkClaims, rejectionNote } = await import(
  pathToFileURL(join(ROOT, 'lib/freemotion-factcheck.mjs')).href
);

const check = (label, actual, expected) => {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (label, actual) => (actual ? pass(label) : fail(label));

// A CV with real figures and a real qualification, and no engineering degree.
const CV = `
# Mohammad Machaka
M.Sc. Data Science, Université de Toulouse.
B.Sc. Computer Science.
Cut p95 latency by 63% on the ingestion pipeline.
Ran a migration covering 140 services.
AWS Certified Solutions Architect.
`;

// --- the real failure: a degree that does not exist ----------------------

const invented = 'En tant qu\'ingénieur diplômé de l\'ISAE-SUPAERO, je suis ravi de postuler.';
const r1 = checkClaims(invented, [CV]);
check('an invented engineering degree is caught', r1.ok, false);
ok('and it is reported as a credential',
  r1.unsupported.some((u) => u.kind === 'credential'));

check('a degree the CV DOES list passes',
  checkClaims('My M.Sc. in Data Science is directly relevant.', [CV]).ok, true);
check('a certification the CV lists passes',
  checkClaims('I am AWS Certified Solutions Architect.', [CV]).ok, true);
check('a certification the CV does NOT list is caught',
  checkClaims('I hold a PhD in distributed systems.', [CV]).ok, false);

// --- figures --------------------------------------------------------------

check('a figure straight from the CV passes',
  checkClaims('I cut p95 latency by 63%.', [CV]).ok, true);
check('an inflated version of a real figure is caught',
  checkClaims('I cut p95 latency by 83%.', [CV]).ok, false);
check('a figure that appears nowhere is caught',
  checkClaims('I saved the company 250000 euros.', [CV]).ok, false);
check('a real count from the CV passes',
  checkClaims('The migration covered 140 services.', [CV]).ok, true);

// Single digits are left alone on purpose: "a team of 5" and "3 years" are
// everywhere in ordinary prose, and flagging them turns the check into noise
// that gets switched off.
check('a single digit is not flagged', checkClaims('I led a team of 5.', [CV]).ok, true);

// --- formatting the same number differently -------------------------------

check('a number written with a space still matches',
  checkClaims('Covering 140 services.', [CV, 'total 1 40']).ok, true);
check('a decimal comma matches a decimal point',
  checkClaims('Throughput rose 12,5%.', ['throughput rose 12.5 percent']).ok, true);

// --- accents and case ------------------------------------------------------

check('accents do not hide a supported credential',
  checkClaims('Mon diplôme de Master est pertinent.', ['master data science']).ok, true);

// --- extraction ------------------------------------------------------------

const claims = extractClaims('Cut latency 63% across 140 services, with an M.Sc. behind it.');
ok('percentages are extracted', claims.figures.includes('63%'));
ok('plain multi-digit numbers are extracted', claims.figures.includes('140'));
ok('credentials are extracted', claims.credentials.length > 0);

// --- the note sent back to the writer --------------------------------------

const note = rejectionNote([{ kind: 'credential', claim: 'ingénieur diplômé' }, { kind: 'figure', claim: '83%' }]);
ok('the note names each offending claim', note.includes('ingénieur diplômé') && note.includes('83%'));
ok('the note says to REMOVE, not to rephrase', /REMOVE them/.test(note));
ok('the note forbids swapping in a different number', /different number/.test(note));

// --- nothing to check ------------------------------------------------------

check('prose with no claims at all passes', checkClaims('I would like to apply.', [CV]).ok, true);
check('an empty draft passes', checkClaims('', [CV]).ok, true);
check('no sources means every claim is unsupported',
  checkClaims('I cut latency by 63%.', []).ok, false);
