// tests/targets.test.mjs — config/targets.yml, the one list of target roles
// (targets.mjs), and how the scanner and the night list read it.
//
// Pinned here: the file in the repo loads; accents are optional in titles;
// tiers add their points once; drop wins over match; applyTargets() replaces
// title_filter and fills job boards' search words only where portals.yml has
// none; a missing file changes nothing. All offline and pure.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ntargets — one list of target roles');

const load = (p) => import(pathToFileURL(join(ROOT, p)).href);

try {
  const { compileTargets, loadTargets, applyTargets, withAccentFree } = await load('targets.mjs');

  // ---- the repo's own file ------------------------------------------------
  const real = loadTargets(join(ROOT, 'config/targets.yml'));
  if (real && real.groups.length >= 5 && real.titleFilter.positive.length > 0 && real.titleFilter.negative.length > 0) {
    pass('config/targets.yml loads and gives the scanner a title filter');
  } else fail(`config/targets.yml did not load: ${JSON.stringify(real && real.titleFilter)}`);
  if (real.judgeTitle('Ingenieur Data (H/F)').groups.includes('data') && real.judgeTitle('Ingénieur Data').groups.includes('data')) {
    pass('an accented keyword matches the title with or without accents');
  } else fail('accent-free spelling not matched');
  if (real.judgeTitle('Sr. Control System Software Engineer (Control Laws)').groups[0] !== 'cloud') {
    pass('"aws" is a whole word: "Laws" is not AWS');
  } else fail('"Laws" matched aws');
  const realDropped = (title) => real.judgeTitle(title).dropped;
  if (['Tech Lead DevOps', 'Lead Data Engineer', 'Engineering Manager Cloud', 'Responsable Plateforme Data', 'Chef de projet Cloud', 'Principal Cloud Engineer']
    .every((title) => realDropped(title) === null)) {
    pass('lead / manager / responsable / chef de projet / principal titles are kept');
  } else fail('a seniority title is still dropped');
  if (realDropped('Director of Platform Engineering') === 'seniority' && realDropped('VP Engineering') === 'seniority' && realDropped('Head of Data') === 'seniority') {
    pass('director / VP / head of are still dropped');
  } else fail('director / VP / head of not dropped');
  if (realDropped('Comptable Fournisseurs') === 'non_fit' && realDropped('Conducteur de travaux') === 'non_fit' && realDropped('Account Executive Sales') === 'non_fit') {
    pass('non-fit titles with no role word are dropped');
  } else fail('non_fit list not applied');
  const soft = real.judgeTitle('Senior Software Engineer - Sales Customer Care team');
  if (soft.dropped === null && soft.unsure && real.judgeTitle('Technicien Cloud Azure').unsure && !real.judgeTitle('Cloud Engineer').unsure) {
    pass('a non-fit word next to a role word is kept but marked unsure');
  } else fail(`soft non_fit = ${JSON.stringify(soft)}`);
  if (realDropped('Presales Engineer') === null && realDropped('Ingénieur Avant-Vente') === null && realDropped('Sales Engineer') === null
      && realDropped('Commercial Solutions Architect') === null && real.judgeTitle('Pre-Sales Consultant').rescued
      && !real.judgeTitle('Presales Engineer Cloud').unsure && realDropped('Sales Manager') === 'non_fit') {
    pass('rescue words beat "sales"/"commercial": pre-sales titles are kept, plain sales is not');
  } else fail('rescue list wrong');
  if (real.tooManyYears === 8 && real.candidate && Array.isArray(real.candidate.target_work)) {
    pass('too_many_years and the candidate block load');
  } else fail(`tooManyYears = ${real.tooManyYears}, candidate = ${JSON.stringify(real.candidate)}`);

  // ---- compile rules --------------------------------------------------------
  if (JSON.stringify(withAccentFree(['intégration', 'cloud', 'integration'])) === JSON.stringify(['intégration', 'integration', 'cloud'])) {
    pass('withAccentFree() adds the accent-free spelling once, order kept');
  } else fail(`withAccentFree = ${JSON.stringify(withAccentFree(['intégration', 'cloud', 'integration']))}`);

  const t = compileTargets({
    tiers: [
      { points: 2, groups: { cloud: { search: ['devops'], match: ['devops', 'cloud'] } } },
      { points: 1.5, groups: { data: { search: ['data engineer'], match: ['data engineer'] }, python: { match: ['python'] } } },
    ],
    drop: { seniority: ['word:lead'] },
    rank_low: ['word:java'],
  });
  const j = t.judgeTitle('Python Data Engineer');
  if (j.points === 1.5 && j.groups.join() === 'data,python') pass('two groups of one tier add its points once');
  else fail(`judgeTitle = ${JSON.stringify(j)}`);
  if (t.judgeTitle('Cloud Data Engineer').points === 3.5) pass('groups of different tiers add up');
  else fail(`cloud+data = ${t.judgeTitle('Cloud Data Engineer').points}`);
  if (t.judgeTitle('Lead DevOps').dropped === 'seniority' && t.judgeTitle('DevOps Leader').dropped === null) {
    pass('a drop word wins over a match; word: keeps it to whole words');
  } else fail('drop list wrong');
  if (t.judgeTitle('Java Cloud Engineer').rankLow && !t.judgeTitle('JavaScript Cloud Engineer').rankLow) pass('rank_low marks Java, not JavaScript');
  else fail('rank_low wrong');
  if (JSON.stringify(t.searchWords) === JSON.stringify(['devops', 'data engineer'])) pass('search words: every group, in file order');
  else fail(`searchWords = ${JSON.stringify(t.searchWords)}`);

  let threw = false;
  try { compileTargets({ tiers: [{ points: 1, groups: { x: { match: [] } } }] }); } catch { threw = true; }
  if (threw) pass('a group with no match words is refused, not read as "match everything"');
  else fail('empty group accepted');
  const badYears = ['8', 0, -1].filter((v) => {
    try { compileTargets({ tiers: [{ points: 1, groups: { x: { match: ['x'] } } }], too_many_years: v }); return false; } catch { return true; }
  });
  if (badYears.length === 3) pass('too_many_years must be a positive number');
  else fail(`too_many_years accepted a bad value (${3 - badYears.length} of 3)`);

  // ---- rescue, dropFilter, keepTitle -----------------------------------------
  const r = compileTargets({
    tiers: [{ points: 2, groups: { cloud: { match: ['cloud'] } } }],
    drop: { seniority: ['word:director'] },
    non_fit: ['word:sales'],
    rescue: ['sales engineer', 'presales'],
  });
  if (r.dropFilter('Sales Engineer') && r.dropFilter('Presales Architect') && !r.dropFilter('Sales Manager')
      && r.dropFilter('Cloud Sales Lead') && !r.dropFilter('Director Cloud') && r.dropFilter('Accountant')) {
    pass('dropFilter() drops drop words, and non-fit words only without a role word; rescue beats both');
  } else fail('dropFilter wrong');
  if (r.keepTitle('Cloud Engineer') && r.keepTitle('Presales Architect') && !r.keepTitle('Accountant')
      && r.keepTitle('Cloud Sales Lead') && !r.keepTitle('Director Cloud')) {
    pass('keepTitle() needs a group or rescue word and no unrescued drop word');
  } else fail('keepTitle wrong');
  if (r.judgeTitle('Cloud Sales Lead').unsure && !r.judgeTitle('Cloud Engineer').unsure && r.judgeTitle('Sales Manager').dropped === 'non_fit') {
    pass('judgeTitle() marks a non-fit word next to a role word as unsure');
  } else fail('unsure flag wrong');
  if (r.titleFilter.positive.includes('presales') && r.tooManyYears === null && r.candidate === null) {
    pass('rescue words join the positive list; no years limit or candidate unless set');
  } else fail(`titleFilter = ${JSON.stringify(r.titleFilter)}`);

  // ---- applyTargets ---------------------------------------------------------
  const portals = {
    title_filter: { positive: ['old'], negative: ['older'], seniority_boost: ['senior'] },
    job_boards: [
      { name: 'HelloWork', provider: 'hellowork', hellowork: { locations: ['Toulouse'] } },
      { name: 'LinkedIn', provider: 'linkedin', linkedin: { queries: ['devops'] } },
      { name: 'WTJ', provider: 'wttj', wttj: { filters: 'offices.country_code:FR' } },
      { name: 'Free-Work', provider: 'freework' },
      { name: 'Acme', provider: 'greenhouse' },
    ],
  };
  const notes = applyTargets(portals, t);
  const [hw, li, wttj, fw, gh] = portals.job_boards;
  if (portals.title_filter.positive.includes('devops') && !portals.title_filter.positive.includes('old')
      && portals.title_filter.negative.join() === 'word:lead' && portals.title_filter.seniority_boost.join() === 'senior') {
    pass('title_filter positive/negative come from the targets; its other keys stay');
  } else fail(`title_filter = ${JSON.stringify(portals.title_filter)}`);
  if (hw.hellowork.queries.join() === 'devops,data engineer' && hw.hellowork.locations.join() === 'Toulouse' && fw.freework.queries.length === 2) {
    pass('a board with no queries of its own searches with the targets\' words, keeping its other settings');
  } else fail(`hellowork = ${JSON.stringify(hw)}, freework = ${JSON.stringify(fw)}`);
  if (li.linkedin.queries.join() === 'devops' && wttj.wttj.queries === undefined && gh.greenhouse === undefined) {
    pass('own queries win; a WTJ block with filters and a non-search provider are left alone');
  } else fail(`linkedin/wttj/greenhouse = ${JSON.stringify([li, wttj, gh])}`);
  if (notes.some((n) => /ignored/.test(n))) pass('the scan log says the old title_filter words are ignored');
  else fail(`notes = ${JSON.stringify(notes)}`);

  const untouched = { title_filter: { positive: ['old'] } };
  if (applyTargets(untouched, null).length === 0 && untouched.title_filter.positive.join() === 'old') {
    pass('no targets file: portals.yml is used exactly as before');
  } else fail('applyTargets(null) changed the config');
  if (loadTargets(join(ROOT, 'config/does-not-exist.yml')) === null) pass('loadTargets() returns null for a missing file');
  else fail('missing file did not return null');
} catch (err) {
  fail(`targets suite crashed: ${err.message}`);
}
