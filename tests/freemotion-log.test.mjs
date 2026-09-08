// tests/freemotion-log.test.mjs — the append-only record of what Free Motion
// wrote into forms under the candidate's name.
//
// The property that matters: a run killed mid-write must still leave a
// READABLE log. That is the moment the log is worth having, and it is exactly
// the moment its last line is half-written — so a reader that throws on a torn
// line makes the audit trail useless precisely when it is needed.
//
// Run: node test-all.mjs --only freemotion-log

import { pass, fail, ROOT, rmSync } from './helpers.mjs';
import { appendFileSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-log — the per-run audit trail');

const { appendLogEntry, readRunLog, runLogPath, ANSWER_SOURCES } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-log.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'fm-log-'));

try {
  // ------------------------------------------------ append then read back

  appendLogEntry('run-1', { event: 'answer', ref: 'f2e20', question: 'First Name', value: 'Jane', source: 'profile' }, { root: tmp });
  appendLogEntry('run-1', { event: 'answer', ref: 'f2e140', question: 'Sponsorship?', value: 'No', source: 'fallback' }, { root: tmp });

  const read = readRunLog('run-1', { root: tmp });
  check('both entries come back', read.entries.length, 2);
  check('no warnings on a clean log', read.warnings, []);
  check('order is preserved', read.entries.map((e) => e.ref), ['f2e20', 'f2e140']);
  check('the source is recorded', read.entries[1].source, 'fallback');
  check('the question is recorded verbatim', read.entries[0].question, 'First Name');
  check('a timestamp is stamped on write', typeof read.entries[0].ts === 'string' && !Number.isNaN(Date.parse(read.entries[0].ts)), true);

  // ts is stamped here, not accepted from the caller, so ordering reflects
  // when things happened rather than what a caller claimed.
  appendLogEntry('run-ts', { event: 'answer', ts: '1999-01-01T00:00:00.000Z', value: 'x' }, { root: tmp });
  check('a caller-supplied ts does not override the real one', readRunLog('run-ts', { root: tmp }).entries[0].ts.startsWith('1999'), false);

  // --------------------------------------------- a torn last line survives

  const path = runLogPath('run-1', { root: tmp });
  appendFileSync(path, '{"event":"answer","value":"half-writ', 'utf-8');
  const torn = readRunLog('run-1', { root: tmp });
  check('the good entries still come back after a crash', torn.entries.length, 2);
  check('the torn line is reported as a warning', torn.warnings.length, 1);
  check('  ...and names the line', /line 3/.test(torn.warnings[0]), true);

  // ------------------------------------------------------- missing log

  const missing = readRunLog('never-ran', { root: tmp });
  check('a missing log reads as empty, not an error', missing, { entries: [], warnings: [] });

  // ------------------------------------------------- values that break JSONL

  // A newline inside a value would split one entry into two lines, the second
  // of which is not JSON — turning a logged answer into a parse warning.
  const nasty = 'line one\nline two\ttabbed "quoted" \\ backslash';
  appendLogEntry('run-nasty', { event: 'answer', value: nasty, question: 'Why us?' }, { root: tmp });
  const nastyRead = readRunLog('run-nasty', { root: tmp });
  check('a multi-line value stays ONE entry', nastyRead.entries.length, 1);
  check('  ...round-trips byte-exact', nastyRead.entries[0].value, nasty);
  check('  ...and produces no warnings', nastyRead.warnings, []);

  // ------------------------------------------------ runId cannot escape data/

  // A caller-supplied id reaching the filesystem verbatim is how an audit log
  // ends up written outside data/.
  for (const hostile of ['../../escape', 'a/b/c', '..\\..\\win', 'C:\\abs']) {
    const p = runLogPath(hostile, { root: tmp });
    const inside = p.startsWith(join(tmp, 'data', 'freemotion-runs'));
    if (inside) pass(`a hostile runId (${JSON.stringify(hostile)}) stays inside the run-log dir`);
    else fail(`a hostile runId (${JSON.stringify(hostile)}) escaped to ${p}`);
  }
  check('an empty runId still yields a usable path', runLogPath('', { root: tmp }).endsWith('unknown-run.jsonl'), true);

  // ------------------------------------------------------------- contract

  check('ANSWER_SOURCES is the four the plan specifies', ANSWER_SOURCES, ['profile', 'fallback', 'entailed', 'inferred']);

  // Every line must be independently parseable — that is what JSONL buys.
  appendLogEntry('run-lines', { event: 'a' }, { root: tmp });
  appendLogEntry('run-lines', { event: 'b' }, { root: tmp });
  const raw = readFileSync(runLogPath('run-lines', { root: tmp }), 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  check('one line per entry', lines.length, 2);
  let allParse = true;
  for (const line of lines) { try { JSON.parse(line); } catch { allParse = false; } }
  check('every line parses on its own', allParse, true);
  check('the file ends with a newline (so the next append starts a new line)', raw.endsWith('\n'), true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
