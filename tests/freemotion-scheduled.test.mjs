// tests/freemotion-scheduled.test.mjs — freemotion-night/scheduled.mjs: what a scheduled run puts in
// the agent inbox (issue #22). Only what needs a person, and each thing once. Offline.
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nscheduled runs — what reaches the agent inbox');

const S = await import(pathToFileURL(join(ROOT, 'freemotion-night/scheduled.mjs')).href);

const out = [
  'Inbox since 2026-09-06: 900 emails, 700 about an application',
  '',
  'A RECRUITER WANTS TO TALK (1): answer these yourself',
  '   2026-09-09  A Person | Echange opportunité  <a.person@example.com>',
  '',
  'PROPOSED CHANGES (2): nothing is changed until you run --apply',
  '  1  #12 Acme | DevOps: Applied -> Rejected   [2026-10-01, "n allons pas y donner suite"]',
  '  2  #13 Beta | Data: Applied -> Rejected   [2026-10-02, "not selected"]',
  '',
  'NO ROW IN THE TRACKER (0): nothing to update',
].join('\n');
const notes = S.replyNotes(out);
if (notes.length === 2 && /Recruiter wrote/.test(notes[0].text) && /^2 tracker change/.test(notes[1].text)) pass('a recruiter message and the proposed changes become notes');
else fail(`reply notes: ${JSON.stringify(notes)}`);
if (S.replyNotes('PROPOSED CHANGES (0): nothing is changed until you run --apply\n').length === 0) pass('nothing to do means no note'); else fail('a note for nothing');

const dir = mkdtempSync(join(tmpdir(), 'fm-sched-'));
try {
  const inbox = join(dir, 'agent-inbox.md'), seen = join(dir, 'noted.txt');
  writeFileSync(inbox, '# Agent Inbox\n');
  const a = S.note(notes[0].text, notes[0].key, { inbox, seen });
  const b = S.note(notes[0].text, notes[0].key, { inbox, seen });
  const lines = readFileSync(inbox, 'utf8').split('\n').filter((l) => l.startsWith('- [ ] '));
  if (a && !b && lines.length === 1) pass('the same thing is noted once, not every day'); else fail(`noted ${lines.length} times`);
} finally { rmSync(dir, { recursive: true, force: true }); }

if (S.LOOPS.length === 3 && S.LOOPS.every((l) => l.args.includes('--models') || l.args.includes('--model'))) pass('the three scoring loops are the README ones'); else fail('loops list changed');
