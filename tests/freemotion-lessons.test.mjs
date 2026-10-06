// tests/freemotion-lessons.test.mjs — freemotion-night/lessons.mjs: the lessons log after each run
// and the weekly check of fixes (issue #27). Offline: no model call, a temp folder as the repo.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nfreemotion lessons — what went wrong, and whether the fix held');

const L = await import(pathToFileURL(join(ROOT, 'freemotion-night/lessons.mjs')).href);
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass(name); else fail(`${name}: got ${a}, want ${b}`);
};

// ---- the log file round-trips --------------------------------------------
const lessons = [
  { id: 'L2', title: 'agy asks for a Google sign-in', site: 'any', category: 'driver', status: 'open', what: 'Every agy job ends after 60 s.', cause: 'Sign-in expired.', fix: 'Treat it as the driver being out.', source: 'run r1' },
  { id: 'L1', title: 'HelloWork CAPTCHA', site: 'hellowork.com', category: 'captcha', status: 'fixed', what: 'A CAPTCHA after Postuler.', fixedIn: 'abc123 on 2026-10-01', source: 'run r0' },
];
const occ = [{ lesson: 'L1', run: 'r0', job: '5', date: '2026-09-30', site: 'hellowork.com', outcome: 'captcha', note: 'x' }];
const md = L.renderLessons(lessons, occ);
const back = L.parseLessons(md);
check('the log parses back to the same lessons, in id order', back.map((l) => [l.id, l.title, l.site, l.category, l.status, l.cause || '', l.fixedIn || '']),
  [['L1', 'HelloWork CAPTCHA', 'hellowork.com', 'captcha', 'fixed', '', 'abc123 on 2026-10-01'], ['L2', 'agy asks for a Google sign-in', 'any', 'driver', 'open', 'Sign-in expired.', '']]);
if (/- \*\*Seen:\*\* 1 time, first 2026-09-30, last 2026-09-30/.test(md)) pass('"Seen" is counted from the occurrences'); else fail('"Seen" line missing');

// ---- a review answer -------------------------------------------------------
{
  const ls = L.parseLessons(md), oc = [...occ];
  const jobs = [{ job: 7, date: '2026-10-05', site: 'hellowork.com', outcome: 'captcha' }, { job: 8, date: '2026-10-05', site: 'lever.co', outcome: 'errored' }];
  const r = L.applyAnswer(ls, oc, {
    new_lessons: [{ ref: 'N1', title: 'Lever already-received page not recorded', site: 'lever.co', category: 'record', what: 'w', cause: 'c', fix: 'f' }],
    updates: [{ lesson: 'L2', fix: 'Mark agy out for an hour.' }],
    occurrences: [{ job: 7, lesson: 'L1', note: 'CAPTCHA again' }, { job: 8, lesson: 'N1', note: 'not recorded' }, { job: 99, lesson: 'L1', note: 'no such job' }, { job: 7, lesson: 'L1', note: 'twice' }],
  }, { run: 'r2', jobs });
  check('a new lesson takes the next id and its ref resolves', [r.created, r.added.map((o) => [o.lesson, o.job])], [['L3'], [['L1', 7], ['L3', 8]]]);
  check('an unknown job is skipped, a repeat is dropped', r.skipped.length, 1);
  check('a fixed lesson that happens after its fix date has come back', ls.find((l) => l.id === 'L1').status, 'came back');
  check('an update with a fix moves an open lesson to "fix proposed"', [ls.find((l) => l.id === 'L2').status, ls.find((l) => l.id === 'L2').fix], ['fix proposed', 'Mark agy out for an hour.']);
}

// ---- weekly ----------------------------------------------------------------
check('fix commits name their lessons', L.fixesFromLog('b2\t2026-10-03\tfix(run): fixes L4 and L5\na1\t2026-10-02\tfeat: nothing here').map((f) => [f.id, f.commit, f.date]),
  [['L4', 'b2', '2026-10-03'], ['L5', 'b2', '2026-10-03']]);
{
  const ls = [
    { id: 'L4', title: 'a', site: 'hellowork.com', status: 'open' },
    { id: 'L5', title: 'b', site: 'any', status: 'open' },
    { id: 'L6', title: 'c', site: 'any', status: 'open' },
  ];
  const oc = [
    { lesson: 'L5', date: '2026-10-08' },
    { lesson: 'L6', date: '2026-10-09' }, { lesson: 'L6', date: '2026-10-10' }, { lesson: 'L6', date: '2026-09-30' },
  ];
  const attempts = Array.from({ length: 12 }, (_, i) => ({ date: '2026-10-05', site: i < 11 ? 'hellowork.com' : 'apec.fr' }));
  const w = L.weekly(ls, oc, attempts, [{ id: 'L4', commit: 'b2', date: '2026-10-03' }, { id: 'L5', commit: 'b2', date: '2026-10-03' }], new Date('2026-10-12T12:00:00Z'));
  check('a fix with 10+ later jobs on its site and no repeat is verified; one that repeats has come back',
    ls.map((l) => [l.id, l.status]), [['L4', 'verified'], ['L5', 'came back'], ['L6', 'open']]);
  check('recurring lessons are counted this week against the week before', w.recurring.map((x) => [x.l.id, x.week, x.prev]), [['L6', 2, 1], ['L5', 1, 0]]);
  check('the week is named the ISO way', w.week, '2026-W42');
}

// ---- the old findings ------------------------------------------------------
check('findings are read from their headings', L.findingsFrom('intro\n### G1. Never set a field with page code\n\nBody one.\n\n### G2. Second\n\nBody two.\n## Open gaps\n', 'findings').map((f) => [f.g, f.title, f.what]),
  [['G1', 'Never set a field with page code', 'Body one.'], ['G2', 'Second', 'Body two.']]);

// ---- collecting a run's failures from the files a run leaves -----------------
{
  const root = mkdtempSync(join(tmpdir(), 'fm-lessons-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true }); mkdirSync(join(root, 'tmp/fm/night'), { recursive: true }); mkdirSync(join(root, 'tmp/fm/usage'), { recursive: true });
    const u1 = 'https://www.example.com/jobs/1', u2 = 'https://www.example.com/jobs/2';
    writeFileSync(join(root, 'data/freemotion-submissions.tsv'), ['url_key\traw_url\tcompany\trole\treport_num\toutcome\ttimestamp\trun_id\tnotes',
      `${u1}\t${u1}\tAcme\tDevOps\t-\tin-progress\t2026-10-05T01:00:00Z\tr9\t`,
      `${u1}\t${u1}\tAcme\tDevOps\t-\terrored\t2026-10-05T01:10:00Z\tr9\tagy usage limit mid-job`,
      `${u2}\t${u2}\tBeta\tData\t-\tsubmitted\t2026-10-05T02:00:00Z\tr9\tok`,
      `${u1}\t${u1}\tAcme\tDevOps\t-\terrored\t2026-10-01T01:00:00Z\tr8\tother run`].join('\n') + '\n');
    writeFileSync(join(root, 'tmp/fm/night/job-41.json'), JSON.stringify({ num: 41, url: u1, co: 'Acme', title: 'DevOps' }));
    writeFileSync(join(root, 'tmp/fm/night/report-41.md'), '# Report 41\nThe sign-in page did not load.\n');
    writeFileSync(join(root, 'tmp/fm/usage/night-runs.tsv'), '41\t2026-10-05T01:00:00Z\t2026-10-05T01:09:00Z\tagy\theadless\n');
    writeFileSync(join(root, 'tmp/fm/usage/agy-41.err'), 'Authentication required. Please visit https://accounts.example.com/o/oauth2/auth?' + 'x'.repeat(200) + '\nError: authentication timed out.\n');
    const c = L.collect(root, 'r9');
    check('only the run\'s failed jobs are collected', [c.jobs, c.failures.map((f) => [f.job, f.company, f.outcome])], [2, [[41, 'Acme', 'errored']]]);
    const f = c.failures[0];
    if (f.evidence.report && f.evidence['agy error output'] && f.attempts[0].startsWith('agy 01:00')) pass('the report, the driver\'s error output and the attempts are attached');
    else fail(`evidence missing: ${JSON.stringify(f)}`);
    if (f.evidence['agy error output'][0].length < 140) pass('long sign-in links are shortened'); else fail('a long link was kept whole');
    if (/^## job 41: Acme \| DevOps \(example.com\), ended errored/m.test(L.renderErrors(c))) pass('the errors file names job, company, site and outcome'); else fail('errors file heading wrong');
  } finally { rmSync(root, { recursive: true, force: true }); }
}
