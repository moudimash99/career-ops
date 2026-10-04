// agy's own record of a session: ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/
// transcript.jsonl, one JSON object per step, written as agy works. Shared by agent-log.mjs (the step log)
// and control.mjs (the watch window).
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const BRAIN = process.env.AGY_BRAIN || join(homedir(), '.gemini', 'antigravity-cli', 'brain');
export const transcriptOf = (id) => join(BRAIN, id, '.system_generated', 'logs', 'transcript.jsonl');
export const parseLines = (text) => text.split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });

// The newest conversation, started at or after `since` (ms), whose first message names job-<job>.md.
export function findConversation(job, since) {
  if (!existsSync(BRAIN)) return null;
  const dirs = readdirSync(BRAIN)
    .map((id) => { try { return { id, t: statSync(transcriptOf(id)).mtimeMs }; } catch { return null; } })
    .filter((d) => d && d.t >= since)
    .sort((a, b) => b.t - a.t);
  for (const { id } of dirs) {
    const first = parseLines(readFileSync(transcriptOf(id), 'utf8').split('\n')[0] ?? '')[0];
    if (first && Date.parse(first.created_at) >= since - 60e3 && String(first.content ?? '').includes(`job-${job}.md`)) return id;
  }
  return null;
}

// Complete lines only: agy may be halfway through writing the last one.
export function readSteps(id) {
  let text;
  try { text = readFileSync(transcriptOf(id), 'utf8'); } catch { return []; }
  return parseLines(text.slice(0, text.lastIndexOf('\n') + 1));
}

// agy stores most argument values as JSON strings ("\"Clicking Postuler\"").
export const un = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
