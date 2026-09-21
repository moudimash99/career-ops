// tests/freemotion-route-cache.test.mjs — the two cheap guards either side of
// a run: what we decide before opening a posting, and what we remember after.
//
// Both exist to stop spending. The route check refuses a posting before a
// browser launches; the answer cache stops paying twice for the same screening
// question at the same employer — and stops answering it two DIFFERENT ways,
// which a recruiter would notice.
//
// The route check is biased towards OPENING. A wasted run costs one run; a
// silently dropped posting costs a job nobody ever learns about. These tests
// pin that asymmetry, because it is the kind of thing a later "tidy-up"
// reverses.
//
// Run: node test-all.mjs --only freemotion-route-cache

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion route + answer cache — decide before, remember after');

const route = await import(pathToFileURL(join(ROOT, 'lib/freemotion-route.mjs')).href);
const cache = await import(pathToFileURL(join(ROOT, 'lib/freemotion-answer-cache.mjs')).href);

const check = (label, actual, expected) => {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (label, actual) => (actual ? pass(label) : fail(label));

// ---------------------------------------------------------------- the route

check('an ordinary posting is opened',
  route.routeFor('https://example-ats.com/jobs/123').open, true);

check('a CAPTCHA platform is skipped',
  route.routeFor('https://jobs.lever.co/acme/123').open, false);
check('and it says why', route.routeFor('https://jobs.lever.co/acme/123').signal, 'captcha-platform');

check('a blacklisted employer is skipped',
  route.routeFor('https://careers.acme.com/1', { company: 'Acme', blacklist: ['Acme'] }).open, false);
check('blacklist matching ignores case and accents',
  route.routeFor('https://x.com/1', { company: 'Thalès', blacklist: ['thales'] }).open, false);

check('a posting already submitted is skipped',
  route.routeFor('https://x.com/jobs/7', { submittedUrls: ['https://x.com/jobs/7'] }).open, false);
check('and tracking parameters do not hide that it is the same posting',
  route.routeFor('https://x.com/jobs/7?utm_source=mail', { submittedUrls: ['https://x.com/jobs/7'] }).open, false);
check('a DIFFERENT posting at the same employer is still opened',
  route.routeFor('https://x.com/jobs/8', { submittedUrls: ['https://x.com/jobs/7'] }).open, true);

// The bias. Each of these could be argued into a skip; each must not be.
check('an unparseable URL is opened, not guessed at', route.routeFor('not a url').open, true);
check('an unknown host is opened', route.routeFor('https://never-seen-before.example/1').open, true);
check('a company merely SIMILAR to a blacklisted one is still opened',
  route.routeFor('https://x.com/1', { company: 'Acme Digital', blacklist: ['Acme'] }).open, true);
ok('but the near-miss is reported for a human to look at',
  route.nearBlacklistMatches('Acme Digital', ['Acme']).length === 1);

// ---------------------------------------------------------------- the cache

const c = { entries: [] };
check('an ordinary answer is remembered',
  cache.remember(c, { employer: 'Acme', question: 'Notice period?', value: '3 months', fromUrl: 'u1' }).cached, true);
check('and comes back for the same employer and question',
  cache.lookup(c, 'Acme', 'Notice period?').value, '3 months');
check('spelling differences in the employer still hit',
  cache.lookup(c, 'ACME ', 'notice period').value, '3 months');
check('a different employer does not hit', cache.lookup(c, 'Other', 'Notice period?'), null);

check('an answer carries the date it was given',
  /^\d{4}-\d{2}-\d{2}$/.test(cache.lookup(c, 'Acme', 'Notice period?').at), true);
check('and the posting it came from',
  cache.lookup(c, 'Acme', 'Notice period?').fromUrl, 'u1');

// A correction must replace the mistake, not sit beside it.
cache.remember(c, { employer: 'Acme', question: 'Notice period?', value: '1 month', fromUrl: 'u2' });
check('a corrected answer replaces the old one', cache.lookup(c, 'Acme', 'Notice period?').value, '1 month');
check('and does not leave a duplicate behind', c.entries.length, 1);

// A letter is never reused. This is a decision, not an optimisation.
check('a cover letter field is refused by the cache',
  cache.remember(c, { employer: 'Acme', question: 'Lettre de motivation', value: 'Madame, Monsieur', fromUrl: 'u' }).cached,
  false);
check('a "why do you want to work here" field is refused too',
  cache.remember(c, { employer: 'Acme', question: 'Why do you want to join us?', value: 'Because', fromUrl: 'u' }).cached,
  false);
check('anything long enough to be prose is refused',
  cache.isCacheable('Tell me about a project', 'x'.repeat(cache.MAX_CACHEABLE_LENGTH + 1)), false);
check('an empty answer is not remembered', cache.remember(c, { employer: 'A', question: 'Q', value: '   ' }).cached, false);

// The same question at several employers should become a permanent rule.
const c2 = { entries: [] };
cache.remember(c2, { employer: 'Acme', question: 'How did you hear about us?', value: 'Job board' });
cache.remember(c2, { employer: 'Globex', question: 'How did you hear about us?', value: 'Job board' });
cache.remember(c2, { employer: 'Acme', question: 'Notice period?', value: '1 month' });
const candidates = cache.ruleCandidates(c2);
check('a question asked by two employers is a rule candidate', candidates.length, 1);
check('and it names both employers', candidates[0].employers.length, 2);
check('a question asked by one employer is not', candidates.some((x) => /notice/i.test(x.question)), false);

// A bad answer must be removable without losing everything else.
check('purging one employer removes only theirs', cache.purge(c2, { employer: 'Acme' }), 2);
check('the other employer survives', c2.entries.length, 1);

// A corrupt cache must never stop an application.
check('a missing cache file reads as empty', cache.loadCache('does/not/exist.json').entries.length, 0);
