#!/usr/bin/env node
// node freemotion-night/agent-log.mjs --job <N> [--since <ISO time>] [--follow] [--out <file>]
//
// What agy does on one job, one plain line per step, read from agy's own transcript
// (~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl, written as
// it works). Nothing here is summarized: each action line is agy's own label for the step plus what it
// acted on, "»" lines are agy's own words (the sheet asks for `NEXT: … — WHY: …` before each action),
// "→" is what the page or command answered, "✗" an error.
//
//   --follow  print steps as agy writes them, until killed (run.sh starts it next to an agy job)
//   --since   only a conversation started at or after this time (default: the last 24 h)
//   --out     also write the lines to this file (run.sh: tmp/fm/night/actions-<N>.log)
//   --conversation <id>  read that conversation instead of looking it up by job number
//
// Only agy writes this transcript; the other drivers leave their JSON output in tmp/fm/usage/.
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { findConversation as findByJob, readSteps, transcriptOf, parseLines, un } from './agy-transcript.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const JOB = arg('--job');
const FOLLOW = process.argv.includes('--follow');
const OUT = arg('--out');
const SINCE = arg('--since') ? Date.parse(arg('--since')) : Date.now() - 24 * 3600e3;
const CONV = arg('--conversation');
if (!JOB && !CONV) {
  console.error('Usage: node freemotion-night/agent-log.mjs --job <N> [--since <ISO>] [--follow] [--out <file>] [--conversation <id>]');
  process.exit(1);
}
const findConversation = () => CONV ?? findByJob(JOB, SINCE);

const one = (s, n) => String(s ?? '').replace(/\x1b?\[\d+m/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const rel = (p) => String(un(p) ?? '').replace(/\\/g, '/').replace(/^file:\/\/\//, '').replace(/^.*?career-ops\//, '');
const clock = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
const PAD = ' '.repeat(10);

function target(name, a) {
  if (name === 'call_mcp_tool') {
    const tool = String(un(a.ToolName) ?? '').replace(/^browser_/, '');
    const x = un(a.Arguments) ?? {};
    const args = typeof x === 'string' ? un(x) : x;
    if (typeof args !== 'object' || !args) return tool;
    if (args.url) return `${tool} ${args.url}`;
    if (args.filename) return `${tool} ${rel(args.filename)}`;
    if (args.paths) return `${tool} ${[].concat(args.paths).map(rel).join(', ')}`;
    if (args.element || args.target) return `${tool} ${one(args.element || args.target, 90)}${args.text ? ` ← "${one(args.text, 60)}"` : ''}`;
    if (args.code || args.function) {
      const body = String(args.code || args.function).split('\n').map((l) => l.trim())
        .filter((l) => l && !/^(async|await \(async|\(?async \(page\)|\/\/|return|}|\)|];?$)/.test(l));
      return `${tool}: ${one(body.slice(0, 2).join(' '), 120)}${body.length > 2 ? ` (+${body.length - 2} lines)` : ''}`;
    }
    const rest = JSON.stringify(args);
    return rest === '{}' ? tool : `${tool} ${one(rest, 100)}`;
  }
  if (name === 'run_command') return `$ ${one(un(a.CommandLine), 160)}`;
  if (name === 'view_file') return `read ${rel(a.AbsolutePath)}`;
  if (name === 'write_to_file' || name === 'replace_file_content') return `write ${rel(a.TargetFile ?? a.AbsolutePath)}`;
  if (name === 'schedule') return `wait ${un(a.DurationSeconds) ?? '?'} s`;
  return name;
}

// What a tool answered: the first line under "### Result", unless it is a screenshot or a page dump.
function answer(content) {
  const m = String(content ?? '').match(/### Result\s*\n([\s\S]*?)(\n###|$)/);
  if (!m) return null;
  const r = m[1].trim();
  if (!r || /^- \[(Screenshot|Snapshot)|^- Page (URL|Title)|^### Page/.test(r)) return null;
  return one(r, 220);
}

function render(step) {
  const t = clock(step.created_at);
  const lines = [];
  if (step.type === 'PLANNER_RESPONSE') {
    for (const l of String(step.content ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) lines.push(`${PAD}» ${one(l, 300)}`);
    for (const c of step.tool_calls ?? []) {
      const a = c.args ?? {};
      const label = one(un(a.toolAction) ?? c.name, 40);
      lines.push(`${t}  ${label.padEnd(36)} ${target(c.name, a)}`);
    }
  } else if (step.type === 'GENERIC') {
    if (step.status === 'ERROR' || step.status === 'INVALID') lines.push(`${PAD}✗ ${one(String(step.content ?? '').replace(/^Created At:.*?\n(Completed At:.*?\n)?/s, ''), 220)}`);
    else { const r = answer(step.content); if (r) lines.push(`${PAD}→ ${r}`); }
  } else if (step.type === 'ERROR_MESSAGE') {
    lines.push(`${PAD}✗ ${one(step.content, 220)}`);
  } else if (step.type === 'SYSTEM_MESSAGE') {
    const m = String(step.content ?? '').match(/exited with code (\d+)/);
    if (m) lines.push(`${PAD}→ background command ended, exit code ${m[1]}`);
  }
  return lines;
}

const emit = (lines) => {
  if (!lines.length) return;
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  if (OUT) appendFileSync(OUT, text);
};

let id = findConversation();
if (!FOLLOW) {
  if (!id) { console.error(`no agy conversation found for job ${JOB}`); process.exit(1); }
  if (OUT) writeFileSync(OUT, '');
  emit([`── agy, job ${JOB ?? '?'}, conversation ${id}`]);
  for (const s of readSteps(id)) emit(render(s));
  process.exit(0);
}

// --follow: wait for the conversation to appear, then print each new complete line once.
if (OUT) writeFileSync(OUT, '');
let done = 0;
const tick = () => {
  if (!id) { id = findConversation(); if (!id) return; emit([`── agy, job ${JOB ?? '?'}, conversation ${id}`]); }
  let text;
  try { text = readFileSync(transcriptOf(id), 'utf8'); } catch { return; }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
  for (const l of complete.slice(done)) { try { emit(render(JSON.parse(l))); } catch { /* a line agy rewrote mid-read */ } }
  done = complete.length;
};
tick();
setInterval(tick, 1000);
