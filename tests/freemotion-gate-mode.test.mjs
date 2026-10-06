// tests/freemotion-gate-mode.test.mjs — the quick title check's strict and loose modes (issue #21).
//
// Pinned: config/targets.yml's gate: block compiles (no block = loose); strict instructions carry
// the experience list and loose ones do not; answers are stored per mode, rows from before modes
// count as loose; strict answers are asked again when the experience list changes; an older store
// gets the `mode` column in its header without losing a row. Offline: a fake model.
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nquick title check — strict and loose');

const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const { compileGate, loadTargets } = await load('targets.mjs');
const S = await load('freemotion-night/llm-score.mjs');

// ---- config ----------------------------------------------------------------
if (compileGate(undefined).mode === 'loose') pass('no gate: block means loose'); else fail('missing block is not loose');
try { compileGate({ mode: 'medium' }); fail('an unknown mode was accepted'); } catch { pass('an unknown mode is refused'); }
try { compileGate({ mode: 'strict', experience: {} }); fail('strict without roles was accepted'); } catch { pass('strict needs the roles it checks against'); }
const real = loadTargets(join(ROOT, 'config/targets.yml'));
if (['strict', 'loose'].includes(real.gate.mode) && real.gate.experience.roles.length > 0) pass(`config/targets.yml has a gate block (${real.gate.mode}, ${real.gate.experience.roles.length} roles)`);
else fail(`config/targets.yml gate block missing or empty: ${JSON.stringify(real.gate)}`);

// ---- instructions ------------------------------------------------------------
const who = { trade: 'Cloud engineer' };
const strict = { mode: 'strict', experience: { roles: ['Cloud / DevOps engineer'], skills: ['Terraform'], domains: ['Aerospace'] } };
const looseText = S.buildGateInstructions(who, { mode: 'loose' });
const strictText = S.buildGateInstructions(who, strict);
if (/STRICT check/.test(strictText) && strictText.includes('Cloud / DevOps engineer') && strictText.includes('Terraform')) pass('strict instructions carry the experience list');
else fail('strict instructions lack the list');
if (!/STRICT/.test(looseText) && /Answer no-go ONLY when the title clearly means other work/.test(looseText) && looseText === S.buildGateInstructions(who)) pass('loose instructions are the old ones, and the default');
else fail('loose instructions changed');

// ---- storage per mode ----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'fm-gate-'));
try {
  const path = join(dir, 'llm-gate.tsv');
  // A store from before modes: 8 columns, CRLF.
  writeFileSync(path, ['key\ttitle\tcompany\tgo\treason\tmodel\tversion\tat', 'acme|java developer\tJava Developer\tAcme\tgo\tdigital\tm\tv0\t2026-09-28T00:00:00Z'].join('\r\n') + '\r\n');
  if (S.readGate(path).get('acme|java developer')?.go === true && S.readGate(path, { mode: 'strict' }).size === 0) pass('rows from before modes are loose answers, never strict ones');
  else fail('old rows read wrong');

  const asked = [];
  const fake = (answer) => async (_instructions, prompt) => {
    const ids = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    asked.push(ids.length);
    return JSON.stringify({ results: ids.map((id) => ({ id, go: answer, reason: 'test' })) });
  };
  const jobs = [{ title: 'Java Developer', co: 'Acme' }, { title: 'DevOps Engineer', co: 'Beta' }];
  const r1 = await S.gateJobs(jobs, { generate: fake(false), candidate: who, gate: strict, model: 'fake', path });
  const store = S.gateStore(who, strict);
  const text = readFileSync(path, 'utf8');
  if (r1.asked === 2 && text.split(/\r?\n/)[0].endsWith('\tmode') && text.includes('Java Developer\tAcme\tgo\tdigital')) pass('strict asks both titles; the old store gets the mode column and keeps its row');
  else fail(`strict first pass: ${JSON.stringify(r1)} / header ${text.split(/\r?\n/)[0]}`);
  if (S.readGate(path, store).get('acme|java developer')?.go === false && S.readGate(path).get('acme|java developer')?.go === true) pass('the strict no-go and the old loose go are kept apart');
  else fail('modes mixed in the store');

  const r2 = await S.gateJobs(jobs, { generate: fake(false), candidate: who, gate: strict, model: 'fake', path });
  if (r2.asked === 0) pass('stored strict answers are not asked again'); else fail(`asked again: ${r2.asked}`);
  const changed = { ...strict, experience: { ...strict.experience, roles: [...strict.experience.roles, 'Java developer'] } };
  const r3 = await S.gateJobs(jobs, { generate: fake(true), candidate: who, gate: changed, model: 'fake', path });
  if (r3.asked === 2 && S.gateStore(who, changed).version !== store.version) pass('a changed experience list asks the strict titles again');
  else fail(`after a list change: ${JSON.stringify(r3)}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
