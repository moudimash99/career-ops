// tests/freemotion-night-sector.test.mjs — sectors on the night list (user,
// 2026-10-04): defence, government and clearance jobs get score 0, space
// ranks 1 lower (config/targets.yml `sectors:`).
//
// Pinned here: the free title / company / clearance rules hit what they should
// and nothing a consultancy merely lists (and Safran is not one of them); the
// fit score's answer carries the sector, which is stored next to the score
// without touching data/llm-scores.tsv; applySectors zeroes and penalizes by
// the config, never on a missing answer. All offline: the model is a stub.
//
// Run: node test-all.mjs --only freemotion-night-sector

import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-night — sectors (defence, government, clearance, space)');

const load = (p) => import(pathToFileURL(join(ROOT, p)).href);
const dir = mkdtempSync(join(tmpdir(), 'fm-sector-'));

try {
  const { judge, rankScore } = await load('freemotion-night/pool-rules.mjs');
  const { compileSectors } = await load('targets.mjs');
  const { clearanceRule, applySectors, readSectors, parseSectorAnswer } = await load('freemotion-night/llm-sector.mjs');
  const { jobKey, parseAnswer, scoreJobs, scoreJobsBatch, buildInstructions, RESPONSE_SCHEMA, DEFAULT_MODEL } = await load('freemotion-night/llm-score.mjs');

  // ---- free title / company rules (pool-rules.mjs) -------------------------
  const J = (title, co = 'X', loc = 'Toulouse - 31') => judge({ title, co, loc, ageDays: 2 });
  if (J('Ingénieur DevOps Anti-drones').why === 'defence/ministry' && J('Ingénieur Logiciel Systèmes Militaires').why === 'defence/ministry'
    && J('DevOps Engineer', 'KNDS France').why === 'defence/ministry' && J('Ingénieur Systèmes', 'Dassault Aviation').why === 'defence/ministry') {
    pass('judge() drops anti-drone and military titles and defence makers (Dassault Aviation kept on the list)');
  } else fail(`defence title rule: ${JSON.stringify(J('Ingénieur DevOps Anti-drones'))}`);
  if (J('Ingénieur Cloud', 'Safran Aircraft Engines').ok && J('Data Engineer', 'SAFRAN').ok) {
    pass('judge() no longer drops Safran by name: its jobs are judged by the sector answer');
  } else fail('Safran must not be on the defence keyword list');
  if (J('Ingénieur DevOps', 'X', 'La Défense, Île-de-France').ok && J('Administrateur Systèmes Linux').ok && J('Ingénieur Cloud', 'Dassault Systèmes').ok) {
    pass('judge() still keeps La Défense, administrateur and Dassault Systèmes');
  } else fail('the defence rule must not hit the La Défense district, "administrateur" or Dassault Systèmes');
  if (J('Ingénieur Infrastructure', 'Mairie de Garges').why === 'government' && J('Data Engineer', 'Conseil Départemental de la Haute-Garonne').why === 'government') {
    pass('judge() drops public administrations named in the company or title');
  } else fail(`government rule: ${JSON.stringify(J('Ingénieur Infrastructure', 'Mairie de Garges'))}`);

  // ---- clearance words in the text ------------------------------------------
  const hits = ['Profil habilitable', 'Habilitation Secret Défense requise', 'une habilitation confidentiel défense', 'Active security clearance required', 'La nationalité française est requise'];
  const misses = ['Nous accompagnons la défense, le spatial et la banque', 'Bureaux à La Défense', 'Gestion des habilitations Active Directory', 'clearing house'];
  if (hits.every((t) => clearanceRule({ text: t })) && misses.every((t) => !clearanceRule({ text: t }))) {
    pass('clearanceRule() finds clearance and nationality demands, not sector lists or AD "habilitations"');
  } else fail(`clearanceRule hits=${JSON.stringify(hits.map((t) => clearanceRule({ text: t })))} misses=${JSON.stringify(misses.map((t) => clearanceRule({ text: t })))}`);

  // ---- targets.yml sectors: -----------------------------------------------
  const cfg = compileSectors({ drop: ['defence', 'government', 'clearance'], penalty: { space: -1 } });
  if (JSON.stringify(cfg) === JSON.stringify({ drop: ['defence', 'government', 'clearance'], penalty: { space: -1 } })
    && JSON.stringify(compileSectors(undefined)) === JSON.stringify({ drop: [], penalty: {} })) {
    pass('compileSectors() reads drop and penalty; absent means nothing dropped, no penalty');
  } else fail(`compileSectors = ${JSON.stringify(cfg)}`);
  const bad = [{ drop: ['navy'] }, { penalty: { space: 1 } }, { drop: ['space'], penalty: { space: -1 } }, { drop: 'defence' }];
  const threw = bad.filter((b) => { try { compileSectors(b); return false; } catch { return true; } });
  if (threw.length === bad.length) pass('compileSectors() refuses unknown sectors, positive penalties, a sector both dropped and penalized, a non-list drop');
  else fail(`accepted: ${JSON.stringify(bad.filter((b) => !threw.includes(b)))}`);

  // ---- the question is part of the fit score -------------------------------
  const ins = buildInstructions({ trade: 'cloud engineer' });
  if (/sector/.test(ins) && /France 2030/.test(ins) && /cyber/i.test(ins) && /Counter-UAS/.test(ins) && /Altiva/.test(ins)) {
    pass('the fit-score instructions carry the sector question, its three rules and the worked examples');
  } else fail('sector guide missing from the fit-score instructions');
  if (RESPONSE_SCHEMA.required.includes('sector') && RESPONSE_SCHEMA.required.includes('clearance')
    && RESPONSE_SCHEMA.propertyOrdering.indexOf('sector') < RESPONSE_SCHEMA.propertyOrdering.indexOf('summary')
    && RESPONSE_SCHEMA.properties.sector.propertyOrdering[0] === 'evidence') {
    pass('the fit-score schema asks for sector (evidence first) and clearance');
  } else fail(`schema = ${JSON.stringify(RESPONSE_SCHEMA.propertyOrdering)}`);
  if (DEFAULT_MODEL === 'gemini-3.1-flash-lite') pass('fit scoring starts on 3.1 Flash-Lite');
  else fail(`DEFAULT_MODEL = ${DEFAULT_MODEL}`);

  const factors = { role: { evidence: 'x', score: 5 }, skills: { evidence: 'x', score: 4 }, experience: { evidence: 'x', score: 5 }, language: { evidence: 'x', score: 4 }, blockers: { evidence: 'x', score: 5 } };
  const answer = (sector, clearance = false) => JSON.stringify({ ...factors, years_required: null, sector: { evidence: 'programme de frégates', value: sector }, clearance, summary: 'ok' });
  const withSector = parseAnswer(answer('defence'));
  const oldShape = parseAnswer(JSON.stringify({ ...factors, years_required: null, summary: 'ok' }));
  const badSector = parseAnswer(answer('navy'));
  if (withSector.ok && withSector.value.sector?.sector === 'defence' && oldShape.ok && oldShape.value.sector === null && badSector.ok && badSector.value.sector === null) {
    pass('parseAnswer() reads the sector; a missing or unknown one leaves the fit score valid and the sector unanswered');
  } else fail(`parse: ${JSON.stringify([withSector, oldShape.ok, badSector.ok])}`);
  if (parseSectorAnswer({ sector: { evidence: 'e', value: 'space' }, clearance: 'yes' }) === null) pass('a clearance that is not true/false makes the sector unanswered');
  else fail('clearance must be a boolean');

  // scoreJobs: the sector goes to llm-sector.tsv beside the store; llm-scores.tsv keeps its columns.
  const store = join(dir, 'llm-scores.tsv');
  const jobs = [{ title: 'Ingénieur Systèmes', co: 'Altiva', url: 'https://x/1' }, { title: 'DevOps', co: 'Plain', url: 'https://x/2' }];
  const answers = [answer('defence'), JSON.stringify({ ...factors, years_required: null, summary: 'no sector' })];
  let n = 0;
  const r = await scoreJobs(jobs, { generate: async () => answers[n++], candidate: { trade: 'x' }, model: 'stub', rpm: 6000, storePath: store, sleep: async () => {} });
  const sectors = readSectors(join(dir, 'llm-sector.tsv'));
  const header = readFileSync(store, 'utf8').split('\n')[0];
  if (r.scored === 2 && sectors.size === 1 && sectors.get(jobKey(jobs[0])).sector === 'defence' && !header.includes('sector')) {
    pass('scoreJobs() stores the sector answer beside the score store, and only when there is one');
  } else fail(`scored ${r.scored}, sectors ${sectors.size}, header ${header}`);

  const bstore = join(dir, 'batch', 'llm-scores.tsv');
  const bjobs = [{ title: 'A', co: 'One' }, { title: 'B', co: 'Two' }];
  const batchAnswer = JSON.stringify({ jobs: [
    { id: 1, ...factors, years_required: null, sector: { evidence: 'satellite', value: 'space' }, clearance: false, summary: 's' },
    { id: 2, ...factors, years_required: null, sector: { evidence: 'métropole', value: 'government' }, clearance: true, summary: 's' },
  ] });
  const rb = await scoreJobsBatch(bjobs, { generate: async () => batchAnswer, candidate: { trade: 'x' }, model: 'stub', storePath: bstore, sleep: async () => {} });
  const bsec = readSectors(join(dir, 'batch', 'llm-sector.tsv'));
  if (rb.scored === 2 && bsec.get(jobKey(bjobs[0])).sector === 'space' && bsec.get(jobKey(bjobs[1])).clearance === true) {
    pass('scoreJobsBatch() (Flash, 10 a call) stores each job\'s sector too');
  } else fail(`batch: ${JSON.stringify(rb)} ${JSON.stringify([...bsec])}`);

  // ---- applySectors: score 0 / penalty ------------------------------------
  const key = (co, title) => `${co.toLowerCase()}|${title.toLowerCase()}`;
  const row = (co, title, extra = {}) => ({ co, title, url: `https://x/${co}`, score: 10, fit: 4.8, rank: rankScore({ fit: 4.8 }), ...extra });
  const rows = [row('Def', 'Ingenieur Systemes'), row('Gov', 'Data Engineer'), row('Sat', 'Ingenieur Integration'), row('Plain', 'DevOps'), row('New', 'SRE'), row('Clr', 'Cloud'), row('ClrText', 'Python')];
  const stored = new Map([
    [key('Def', 'Ingenieur Systemes'), { sector: 'defence', clearance: false, evidence: 'défense navale' }],
    [key('Gov', 'Data Engineer'), { sector: 'government', clearance: false, evidence: 'secteur public' }],
    [key('Sat', 'Ingenieur Integration'), { sector: 'space', clearance: false, evidence: 'segments sol spatiaux' }],
    [key('Plain', 'DevOps'), { sector: 'none', clearance: false, evidence: 'not stated' }],
    [key('Clr', 'Cloud'), { sector: 'none', clearance: true, evidence: 'habilitable' }],
    [key('ClrText', 'Python'), { sector: 'none', clearance: false, evidence: 'not stated' }],
  ]);
  const keyOk = rows.every((x) => jobKey(x) === key(x.co, x.title));
  const texts = new Map([['https://x/ClrText', 'Poste nécessitant une habilitation secret défense.']]);
  const a = applySectors(rows, stored, texts, cfg);
  const why = Object.fromEntries(a.dropped.map((d) => [d.row.co, d.why]));
  const zeroed = a.dropped.every((d) => d.row.fit === 0);
  const sat = a.kept.find((x) => x.co === 'Sat');
  const plain = a.kept.find((x) => x.co === 'Plain');
  if (keyOk && zeroed && why.Def === 'score 0: defence (model)' && why.Gov === 'score 0: government (model)'
    && why.Clr === 'score 0: needs a clearance (model)' && why.ClrText === 'score 0: needs a clearance (text)') {
    pass('applySectors() gives defence, government and clearance jobs score 0 (model answer or clearance words)');
  } else fail(`dropped = ${JSON.stringify(why)} (keys ok: ${keyOk}, zeroed: ${zeroed})`);
  if (sat && sat.sectorPenalty === -1 && sat.rank === +(plain.rank - 1).toFixed(2) && sat.score === 9 && plain.sectorPenalty === undefined) {
    pass('applySectors() ranks a space job exactly 1 lower and leaves "none" alone');
  } else fail(`space row = ${JSON.stringify(sat)}, plain = ${JSON.stringify(plain)}`);
  if (a.kept.some((x) => x.co === 'New') && a.unanswered === 1) pass('a job with no answer yet keeps its place and is counted as not judged');
  else fail(`unanswered = ${a.unanswered}`);
  const off = applySectors(rows, stored, texts, compileSectors(undefined));
  if (off.dropped.length === 0 && off.kept.every((x) => !x.sectorPenalty)) pass('without a sectors: block nothing is zeroed or penalized');
  else fail(`no config: dropped ${off.dropped.length}`);
} catch (err) {
  fail(`sector suite crashed: ${err.stack || err.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
