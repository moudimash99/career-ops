// tests/cv-typst.test.mjs — payload → RenderCV mapping and the one-page fit
// ladder. Pure functions only: RenderCV itself is not needed to run these.
//
// Run: node test-all.mjs --only cv-typst

import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'js-yaml';

console.log('\ncv-typst — RenderCV mapping and one-page fit ladder');

const b = await import(pathToFileURL(join(ROOT, 'build-cv-rendercv.mjs')).href);
const g = await import(pathToFileURL(join(ROOT, 'generate-cv-typst.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const payload = {
  lang: 'fr',
  page_format: 'a4',
  candidate: {
    name: 'Jane Smith',
    email: 'jane@example.com',
    phone: '+33 6 12 34 56 78',
    location: 'Toulouse, France',
    linkedin: { url: 'https://linkedin.com/in/janesmith', display: 'x' },
    github: { url: 'https://github.com/janes', display: 'x' },
    portfolio: { url: 'janesmith.dev', display: 'janesmith.dev' },
  },
  sections: { summary: 'Profil', experience: 'Expérience', skills: 'Compétences' },
  summary: 'R&D engineer, 100% #cloud, $5M budget.',
  competencies: ['AWS', 'Terraform'],
  experience: [{ company: 'Acme', role: 'SRE', location: 'Paris', dates: 'Janv. 2025 – Août 2025', bullets: ['Cut **P95** by 63%', ''] }],
  projects: [],
  education: [{ title: 'M.Sc. CS', org: 'UT3', year: '2024' }, { title: 'Bootcamp' }],
  certifications: [{ title: 'AWS SAA', org: 'Amazon', year: '2023' }],
  skills: [{ category: 'Cloud', items: ['AWS', 'GCP'] }, { items: 'Python' }],
};

const doc = b.buildRenderCvDocument(payload, { theme: 'classic' });
const titles = Object.keys(doc.cv.sections);

check('header: website gets a scheme', doc.cv.website, 'https://janesmith.dev');
check('header: social usernames parsed from URLs', doc.cv.social_networks,
  [{ network: 'LinkedIn', username: 'janesmith' }, { network: 'GitHub', username: 'janes' }]);
check('header: phone compacted for RenderCV', doc.cv.phone, '+33612345678');
check('localized titles kept, defaults for the rest, render order fixed', titles,
  ['Profil', 'Core Competencies', 'Expérience', 'Education', 'Certifications', 'Compétences']);
check('empty projects section dropped', titles.includes('Projects'), false);
check('special characters survive untouched', doc.cv.sections.Profil[0], 'R&D engineer, 100% #cloud, $5M budget.');
check('experience: free-text date, blank bullet dropped, bold kept', doc.cv.sections['Expérience'][0],
  { company: 'Acme', position: 'SRE', location: 'Paris', date: 'Janv. 2025 – Août 2025', highlights: ['Cut **P95** by 63%'] });
check('education with org → EducationEntry', doc.cv.sections.Education[0], { institution: 'UT3', area: 'M.Sc. CS', date: '2024' });
check('education without org → NormalEntry', doc.cv.sections.Education[1], { name: 'Bootcamp' });
check('certification → one bullet line', doc.cv.sections.Certifications[0], { bullet: 'AWS SAA · Amazon · 2023' });
check('skills: array joined, missing category labelled', doc.cv.sections['Compétences'],
  [{ label: 'Cloud', details: 'AWS, GCP' }, { label: 'Other', details: 'Python' }]);
check('a4 → a4, footer and top note off', [doc.design.page.size, doc.design.page.show_footer, doc.design.page.show_top_note], ['a4', false, false]);
check('letter → us-letter', b.buildRenderCvDocument({ ...payload, page_format: 'letter' }).design.page.size, 'us-letter');

const round = yaml.load(b.payloadToYaml(payload).yaml);
check('YAML round-trips', round.cv.sections.Profil[0], payload.summary);

let threw = false;
try { b.payloadToYaml({ ...payload, experience: [{ company: 'x' }] }); } catch { threw = true; }
check('invalid payload is rejected', threw, true);
threw = false;
try { b.buildRenderCvDocument(payload, { theme: 'nope' }); } catch { threw = true; }
check('unknown theme is rejected', threw, true);

// ── fit ladder ──────────────────────────────────────────────────────────
check('ladder order', g.FIT_STEPS.map(s => s.name), ['base', 'font-9.5', 'margins', 'spacing', 'font-9']);
check('default floor stops before 9pt', g.stepsUpTo().map(s => s.name), ['base', 'font-9.5', 'margins', 'spacing']);
const cumulative = g.stepsUpTo('margins').at(-1).design;
check('steps are cumulative', [cumulative.typography.font_size.body, cumulative.page.top_margin], ['9.5pt', '0.5in']);
threw = false;
try { g.stepsUpTo('tiny'); } catch { threw = true; }
check('unknown floor is rejected', threw, true);

const pagesByStep = { base: 3, 'font-9.5': 2, margins: 1, spacing: 1 };
const seen = [];
const fitted = await g.fitToOnePage((s) => { seen.push(s.name); return { pages: pagesByStep[s.name] }; }, g.stepsUpTo());
check('stops at the first step that fits', [fitted.fit, fitted.step.name, seen], [true, 'margins', ['base', 'font-9.5', 'margins']]);

const over = await g.fitToOnePage(() => ({ pages: 2 }), g.stepsUpTo('font-9.5'));
check('never goes past the floor, reports overflow', [over.fit, over.step.name, over.tried.length], [false, 'font-9.5', 2]);

// ── named styles ────────────────────────────────────────────────────────
const styles = b.loadStyles();
check('named styles load from templates/cv-rendercv-styles.yml', Object.keys(styles).length >= 7, true);
check('every style sits on a built-in theme', Object.values(styles).every(s => b.RENDERCV_THEMES.includes(s.theme)), true);
check('a style resolves to its base theme', b.resolveTheme('sb2nov-garamond', styles).theme, 'sb2nov');
const styled = b.buildRenderCvDocument(payload, { theme: 'executive-navy' });
check('style design applied, base page settings kept', [styled.design.theme, styled.design.typography.font_family, styled.design.page.show_footer], ['classic', 'XCharter', false]);
check('fit-step overrides still win over a style', b.buildRenderCvDocument(payload, { theme: 'executive-navy', design: { typography: { font_family: 'Lato' } } }).design.typography.font_family, 'Lato');

// ── floor-hit rate ──────────────────────────────────────────────────────
{
  const row = (pdf, outcome) => ({ pdf, outcome });
  const clean = Array.from({ length: 10 }, (_, i) => row(`cv${i}.pdf`, 'fit'));
  check('no floor hits → 0%, no alert', [g.fitStats(clean).rate, g.fitStats(clean).alert], [0, false]);

  const twoOfTen = [...clean.slice(0, 8), row('a.pdf', 'floor'), row('b.pdf', 'fit')];
  twoOfTen.splice(9, 1, row('b.pdf', 'overflow'), row('b.pdf', 'fit'));
  const s = g.fitStats(twoOfTen);
  check('an overflow later trimmed to fit still counts as one hit', [s.cvs, s.hits, s.rate], [10, 2, 20]);
  check('exactly at the 20% limit does not alert', s.alert, false);

  const three = [...clean.slice(0, 7), row('x.pdf', 'floor'), row('y.pdf', 'floor'), row('z.pdf', 'overflow')];
  check('above 20% alerts', g.fitStats(three).alert, true);
  check('custom threshold respected', g.fitStats(three, { threshold: 40 }).alert, false);
  check('too few CVs never alert', g.fitStats([row('q.pdf', 'floor')]).alert, false);
  const windowed = [...Array.from({ length: 5 }, (_, i) => row(`old${i}.pdf`, 'floor')), ...Array.from({ length: 50 }, (_, i) => row(`n${i}.pdf`, 'fit'))];
  check('only the most recent 50 CVs count', g.fitStats(windowed).hits, 0);
}
check('sb2nov education line has no dangling "in"',
  b.buildRenderCvDocument(payload, { theme: 'sb2nov-garamond' }).design.templates.education_entry.main_column.includes(' *in* '), false);

// ── fact gate: French percent spacing ───────────────────────────────────
{
  const { normalizeClaim } = await import(pathToFileURL(join(ROOT, 'verify-cv-facts.mjs')).href);
  check('"80 %" (French spacing) normalizes like "80%"', [normalizeClaim('80 %'), normalizeClaim('80 %'), normalizeClaim('80 %')], ['80%', '80%', '80%']);
}

// ── section_order ───────────────────────────────────────────────────────
{
  const ordered = b.buildRenderCvDocument({ ...payload, section_order: ['education', 'experience', 'bogus'] });
  check('section_order puts named sections first, rest keep default order',
    Object.keys(ordered.cv.sections), ['Education', 'Expérience', 'Profil', 'Core Competencies', 'Certifications', 'Compétences']);
  check('section_order is a known root key (no warning)',
    b.payloadToYaml({ ...payload, section_order: ['education'] }).warnings.some(w => w.startsWith('section_order')), false);
}

// ── required sections ───────────────────────────────────────────────────
check('complete payload has no missing required sections', b.missingRequiredSections(payload), []);
check('empty certifications and blank summary are reported',
  b.missingRequiredSections({ ...payload, certifications: [], summary: '  ' }), ['summary', 'certifications']);
check('projects are never required', b.DEFAULT_REQUIRED_SECTIONS.includes('projects'), false);
check('custom required list respected', b.missingRequiredSections({ ...payload, projects: [] }, ['projects']), ['projects']);

// ── rank-and-cut ────────────────────────────────────────────────────────
{
  const ranked = () => ({
    projects: [{ name: 'P-keep', priority: 1 }, { name: 'P-drop', priority: 2 }],
    experience: [
      { company: 'New', role: 'r', bullets: ['n1', { text: 'n2', priority: 2 }, { text: 'n3', priority: 3 }] },
      { company: 'Old', role: 'r', priority: 3, bullets: [{ text: 'o1', priority: 3 }, 'o2'] },
    ],
  });
  check('unranked items default to priority 1', [g.priorityOf('x'), g.priorityOf({}), g.priorityOf({ priority: 3 })], [1, 1, 3]);
  const p = ranked();
  check('cut order: p3 projects → p3 bullets (furthest down its list first, not oldest role) → p3 role → p2 projects → p2 bullets',
    g.cutPlan({ ...p, projects: [...p.projects, { name: 'P-three', priority: 3 }] }).map(o => o.label),
    ['project "P-three"', 'New: "n3"', 'Old: "o1"', 'role Old (r)', 'project "P-drop"', 'New: "n2"']);
  const tie = { experience: [
    { company: 'New', role: 'r', bullets: ['k', { text: 'a', priority: 3 }] },
    { company: 'Old', role: 'r', bullets: ['k', { text: 'b', priority: 3 }] },
  ] };
  check('same position, same tier: the older role breaks the tie', g.cutPlan(tie).map(o => o.label), ['Old: "b"', 'New: "a"']);
  check('a priority-1 project is never cut', g.cutPlan(p).some(o => o.label === 'project "P-keep"'), false);
  const q = ranked();
  const lastBullet = { kind: 'bullet', role: q.experience[1], bullet: 'o2' };
  g.applyCut(q, { kind: 'bullet', role: q.experience[1], bullet: q.experience[1].bullets[0] });
  check('a role never loses its last bullet', g.applyCut(q, lastBullet), false);
  const solo = { experience: [{ company: 'Only', role: 'r', priority: 3, bullets: ['a'] }] };
  check('the experience section never empties', g.applyCut(solo, { kind: 'role', role: solo.experience[0] }), false);

  // Stub renderer: pages = 1 once the payload has at most N bullets+projects.
  const size = (x) => x.experience.reduce((a, e) => a + e.bullets.length, 0) + (x.projects || []).length;
  const steps = g.stepsUpTo('margins');
  const cutFit = await g.fitWithCuts(ranked(), steps, (x) => ({ pages: size(x) <= 5 ? 1 : 2 }));
  check('cuts content at base before shrinking the layout', [cutFit.fit, cutFit.step.name, cutFit.dropped], [true, 'base', ['New: "n3"', 'Old: "o1"']]);
  const original = ranked();
  await g.fitWithCuts(original, steps, () => ({ pages: 1 }));
  check('the caller payload is never mutated', original.projects.length, 2);
  const layoutFit = await g.fitWithCuts(ranked(), steps, (x, s) => ({ pages: s.name === 'font-9.5' ? 1 : 2 }));
  check('when cuts run out, layout steps take over with the cuts kept', [layoutFit.step.name, layoutFit.dropped.length], ['font-9.5', 5]);
  const never = await g.fitWithCuts(ranked(), steps, () => ({ pages: 2 }));
  check('must-keep content that cannot fit fails at the floor', [never.fit, never.step.name, never.payload.projects.map(x => x.name)], [false, 'margins', ['P-keep']]);
  check('builder renders ranked bullets as plain text',
    b.buildRenderCvDocument({ ...payload, experience: [{ company: 'A', role: 'B', bullets: [{ text: 'hello', priority: 3 }] }] }).cv.sections['Expérience'][0].highlights, ['hello']);
}
check('"80 %" gets a non-breaking space so it never splits',
  b.buildRenderCvDocument({ ...payload, summary: 'réduit de 80 % et 90 %' }).cv.sections.Profil[0], 'réduit de 80 % et 90 %');

// ── dates: newest-first order and the current role ──────────────────────
{
  check('French and English date ranges parse', [
    b.parseDateRange('Avr. 2026 – Nov. 2026'), b.parseDateRange('Jan 2025 – Août 2025'),
    b.parseDateRange('Juin 2020 – Février 2021'), b.parseDateRange('Sep 2023 - present'),
    b.parseDateRange('2021–2024'), b.parseDateRange('bientôt'),
  ], [{ start: 202604, end: 202611 }, { start: 202501, end: 202508 }, { start: 202006, end: 202102 },
    { start: 202309, end: null }, { start: 202101, end: 202412 }, null].map(r => (r && r.end === null ? { ...r, end: Infinity } : r)));
  const roles = [
    { company: 'SAS', role: 'r', dates: 'Janv. 2023 – Juin 2024' },
    { company: 'GP', role: 'r', dates: 'Jan 2025 – Août 2025' },
    { company: 'EC', role: 'r', dates: 'Avr 2026 – Nov 2026' },
  ];
  check('roles are sorted newest-first', b.sortNewestFirst(roles).map(r => r.company), ['EC', 'GP', 'SAS']);
  check('an unreadable date keeps the payload order', b.sortNewestFirst([...roles, { company: 'X', role: 'r', dates: '??' }]).map(r => r.company), ['SAS', 'GP', 'EC', 'X']);
  const sept2026 = new Date(2026, 8, 25);
  check('a role ending after today is current', [b.isCurrentRole(roles[2], sept2026), b.isCurrentRole(roles[1], sept2026)], [true, false]);
  check('builder renders roles newest-first', b.buildRenderCvDocument({ ...payload, experience: roles.map(r => ({ ...r, bullets: ['x'] })) }).cv.sections['Expérience'].map(e => e.company), ['EC', 'GP', 'SAS']);

  const ranked = { experience: [
    { company: 'EC', role: 'r', dates: 'Avr 2026 – Nov 2026', priority: 3, bullets: ['a', { text: 'b', priority: 3 }] },
    { company: 'Old', role: 'r', dates: 'Mai 2021 – Janv. 2022', priority: 3, bullets: ['c'] },
  ] };
  const labels = g.cutPlan(ranked, { now: sept2026 }).map(o => o.label);
  check('the current role is never offered as a whole-role cut', labels.includes('role EC (r)'), false);
  check('...but its low-priority bullets still are, and old roles still go', [labels.includes('EC: "b"'), labels.includes('role Old (r)')], [true, true]);
  check('applyCut refuses to drop the current role', g.applyCut(ranked, { kind: 'role', role: ranked.experience[0] }, { now: sept2026 }), false);
}
