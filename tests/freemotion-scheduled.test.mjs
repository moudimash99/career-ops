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
  'STATUS CHANGES MADE (2)',
  '   #12 Acme | DevOps: Applied -> Rejected',
  '   #13 Beta | Data: Applied -> Responded',
  '',
  'NO APPLICATION FOUND (0): recorded without a tracker row',
].join('\n');
const notes = S.replyNotes(out);
if (notes.length === 2 && /Recruiter wrote/.test(notes[0].text) && /^2 tracker change/.test(notes[1].text)) pass('a recruiter message and the changes made become notes');
else fail(`reply notes: ${JSON.stringify(notes)}`);
if (S.replyNotes('STATUS CHANGES MADE (0)\n').length === 0) pass('nothing to do means no note'); else fail('a note for nothing');

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

// #41: start-night hands full-night.sh its settings and the drivers' environment, and refuses bad values.
const env = S.nightEnv(['--jobs', '30', '--end', '08:00', '--no-scan'], { PATH: 'C:\bin', CLAUDE_CONFIG_DIR: 'C:\c3', SECRET: 'x' });
if (env.ROUND_JOBS === '30' && env.END_AT === '08:00' && env.NO_SCAN === '1' && env.PATH === 'C:\bin' && env.CLAUDE_CONFIG_DIR === 'C:\c3' && !('SECRET' in env)) pass('start-night passes the settings, PATH and the Claude account, nothing else');
else fail(`night env: ${JSON.stringify(env)}`);
let refused = 0;
for (const bad of [['--jobs', 'many'], ['--end', 'nine'], ['--jobs'], ['--jobs', '--no-scan']]) { try { S.nightEnv(bad, {}); } catch { refused++; } }
if (refused === 4) pass('a bad --jobs or --end is refused before anything starts'); else fail(`refused ${refused} of 4`);
