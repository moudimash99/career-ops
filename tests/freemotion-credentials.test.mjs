// tests/freemotion-credentials.test.mjs — the local password store for sites
// that require an account before showing an application form (Requirement 2).
//
// Two properties carry the weight. A generated password must pass a typical
// registration policy on the FIRST try (a rejection mid-registration costs a
// retry on a page the run has already half-filled, and some validators only
// reveal the rule after the failure). And "no account here" must never be
// confused with "the account's password is unreadable" — the second, read as
// the first, registers a duplicate account on a site that already has one.
//
// Run: node test-all.mjs --only freemotion-credentials

import { pass, fail, ROOT, rmSync } from './helpers.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-credentials — the local account store');

const { credentialsPath, loadCredentials, saveCredentials, generatePassword } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-credentials.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'fm-cred-'));

try {
  // -------------------------------------------------------------- round-trip

  check('a domain never saved reads as null', loadCredentials('boards.greenhouse.io', { root: tmp }), null);

  const saved = saveCredentials('boards.greenhouse.io', { email: 'jane@example.com', password: 'Sw0rdf!sh-xyz' }, { root: tmp });
  const loaded = loadCredentials('boards.greenhouse.io', { root: tmp });
  check('save then load round-trips the email', loaded.email, 'jane@example.com');
  check('save then load round-trips the password', loaded.password, 'Sw0rdf!sh-xyz');
  check('the record carries its domain', loaded.domain, 'boards.greenhouse.io');
  check('the record is timestamped', typeof saved.createdAt === 'string' && !Number.isNaN(Date.parse(saved.createdAt)), true);

  // Overwriting is the documented behaviour: a re-registration replaces the
  // old password rather than accumulating files nobody can tell apart.
  saveCredentials('boards.greenhouse.io', { email: 'jane@example.com', password: 'second' }, { root: tmp });
  check('a second save overwrites the first', loadCredentials('boards.greenhouse.io', { root: tmp }).password, 'second');

  // ---------------------------------------------------------- domain casing

  check('the domain is case-insensitive', credentialsPath('Boards.Greenhouse.IO', { root: tmp }), credentialsPath('boards.greenhouse.io', { root: tmp }));
  check('  ...so a differently-cased host finds the same account', loadCredentials('BOARDS.GREENHOUSE.IO', { root: tmp })?.password, 'second');
  check('a different domain is a different file', credentialsPath('jobs.lever.co', { root: tmp }) !== credentialsPath('boards.greenhouse.io', { root: tmp }), true);

  // The filename must not enumerate the candidate's employers in a listing.
  check('the filename does not contain the hostname', credentialsPath('boards.greenhouse.io', { root: tmp }).includes('greenhouse'), false);

  // ------------------------------------------------- corrupt != "no account"

  const corruptPath = credentialsPath('corrupt.example.com', { root: tmp });
  mkdirSync(dirname(corruptPath), { recursive: true });
  writeFileSync(corruptPath, '{ this is not json');
  try {
    loadCredentials('corrupt.example.com', { root: tmp });
    fail('a corrupt credential file should throw, not read as "no account"');
  } catch (err) {
    check('a corrupt credential file throws rather than returning null', /corrupt credential file/.test(err.message), true);
  }

  // --------------------------------------------------- password policy shape

  const seen = new Set();
  let policyFailures = 0;
  let lengthFailures = 0;
  for (let i = 0; i < 100; i++) {
    const pw = generatePassword();
    seen.add(pw);
    if (!(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw))) policyFailures++;
    if (pw.length !== 20) lengthFailures++;
  }
  check('100 generated passwords are all distinct', seen.size, 100);
  check('every generated password has lower/upper/digit/symbol', policyFailures, 0);
  check('the default length is 20', lengthFailures, 0);

  check('an explicit length is honoured', generatePassword({ length: 32 }).length, 32);
  // The four-class guarantee cannot be met in fewer than four characters, so a
  // shorter request is raised rather than silently returning a weak password.
  check('a length below the four-class floor is raised, not silently weakened', generatePassword({ length: 2 }).length, 4);
  check('a nonsense length falls back to the floor', generatePassword({ length: NaN }).length, 4);

  // These are typed into web forms and echoed through ATS backends of unknown
  // quality; a password that breaks the form it is typed into is not a password.
  let unsafeChars = 0;
  for (let i = 0; i < 50; i++) {
    if (/["'<>&\\`]/.test(generatePassword())) unsafeChars++;
  }
  check('no form-hostile characters are ever generated', unsafeChars, 0);

  // The guaranteed characters must not always sit in positions 0..3.
  const firstFour = new Set();
  for (let i = 0; i < 60; i++) firstFour.add(generatePassword().slice(0, 4));
  check('the guaranteed characters are shuffled, not front-loaded', firstFour.size > 50, true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
