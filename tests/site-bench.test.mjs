// tests/site-bench.test.mjs — lib/site-bench.mjs: the bench rules (W42 review; user, 2026-10-13). Offline.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nsite bench — CAPTCHAs, bot blocks, two-step verification, an employer\'s limit');

const { benchState, benchedFor, applyUrlOf, RULES } = await import(pathToFileURL(join(ROOT, 'lib/site-bench.mjs')).href);
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};
const H = 3600_000, D = 24 * H;
const T0 = Date.parse('2026-10-10T00:00:00Z');
const row = (h, url, outcome, note = '') => ({ at: new Date(T0 + h * H).toISOString(), apply_url: url, outcome, note });
const lever = 'https://jobs.lever.co/acme/123';

// captcha: 5+ in 3 days and 80%+ of the attempts
const five = [0, 5, 10, 15, 20].map((h) => row(h, lever, 'captcha'));
check('5 CAPTCHAs out of 5 in 3 days: benched', !!benchedFor(benchState(five, T0 + 21 * H), lever), true);
check('... for 7 days from the 5th', benchedFor(benchState(five, T0 + 21 * H), lever).until, T0 + 20 * H + RULES.captcha.bench);
check('4 CAPTCHAs: not benched', benchedFor(benchState(five.slice(0, 4), T0 + 21 * H), lever), null);
const mixed = [...five, row(1, lever, 'submitted'), row(2, lever, 'submitted')];
check('5 CAPTCHAs out of 7 (71%): not benched', benchedFor(benchState(mixed, T0 + 21 * H), lever), null);
const spread = [0, 30, 60, 90, 120].map((h) => row(h, lever, 'captcha'));
check('5 CAPTCHAs over 5 days: not benched', benchedFor(benchState(spread, T0 + 121 * H), lever), null);
check('another site is not touched', benchedFor(benchState(five, T0 + 21 * H), 'https://jobs.ashbyhq.com/acme/1'), null);

// waf: 30 min, then doubling; a sent application resets it
const sr = 'https://jobs.smartrecruiters.com/Devoteam/1';
check('one bot block: 30 minutes', benchedFor(benchState([row(0, sr, 'blocked-waf')], T0 + 0.25 * H), sr)?.until, T0 + 0.5 * H);
check('...over after 30 minutes', benchedFor(benchState([row(0, sr, 'blocked-waf')], T0 + 0.6 * H), sr), null);
check('a second block in a row: 1 hour', benchedFor(benchState([row(0, sr, 'blocked-waf'), row(1, sr, 'blocked-waf')], T0 + 1.5 * H), sr)?.until, T0 + 2 * H);
check('a sent application in between resets it', benchedFor(benchState([row(0, sr, 'blocked-waf'), row(0.7, sr, 'submitted'), row(1, sr, 'blocked-waf')], T0 + 1.2 * H), sr)?.until, T0 + 1.5 * H);

// two-step: 30 days, then for good
const ic = 'https://expleo-jobs-fr-fr.icims.com/jobs/1/job';
const twoNote = 'site forces two-step verification enrolment (authenticator app / SMS)';
check('two-step: benched 30 days', benchedFor(benchState([row(0, ic, 'errored', twoNote)], T0 + D), ic)?.until, T0 + RULES.twoStep.bench);
check('two-step again after 30 days: for good', benchedFor(benchState([row(0, ic, 'errored', twoNote), row(31 * 24, ic, 'errored', twoNote)], T0 + 32 * D), ic)?.until, null);   // Infinity → null in JSON
check('...shown as for good', benchedFor(benchState([row(0, ic, 'errored', twoNote), row(31 * 24, ic, 'errored', twoNote)], T0 + 32 * D), ic)?.why.includes('for good'), true);

// limit: the employer's own board, 90 days
const ash = 'https://jobs.ashbyhq.com/elevenlabs/3581';
const limitNote = "Ashby refused: 'I'm sorry we are limiting applications to give everyone a chance.'";
check('an employer limit benches that board', !!benchedFor(benchState([row(0, ash, 'errored', limitNote)], T0 + D), 'https://jobs.ashbyhq.com/elevenlabs/other-job'), true);
check('...not the other employers on the same host', benchedFor(benchState([row(0, ash, 'errored', limitNote)], T0 + D), 'https://jobs.ashbyhq.com/acme/1'), null);

// where the form was
check('the employer page of a HelloWork hand-off', applyUrlOf("x\nStart at the employer's page: https://jobs.lever.co/a/1\ny", 'https://www.hellowork.com/fr-fr/emplois/1.html'), 'https://jobs.lever.co/a/1');
check('else the posting', applyUrlOf('no hand-off', 'https://www.free-work.com/x'), 'https://www.free-work.com/x');
