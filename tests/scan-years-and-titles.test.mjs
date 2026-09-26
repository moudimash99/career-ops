// tests/scan-years-and-titles.test.mjs — scan.mjs with config/targets.yml:
// postings asking too_many_years or more are not saved, company boards keep
// the full title filter (rescue words beat drop words), job boards keep every
// title except drop / non-fit words, and new postings' text is cached for the
// night list (lib/posting-text.mjs).
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

console.log('\nscan.mjs — years filter, board vs company titles, posting-text cache');

const TARGETS = `tiers:
  - points: 2
    groups:
      cloud: { match: [cloud, devops, data engineer] }
drop:
  seniority: ["word:director"]
non_fit: ["word:sales", comptable]
rescue: [presales]
too_many_years: 8
`;

try {
  // ---- whole scan over a fixture board ------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'scan-years-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`);
    writeFileSync(join(dir, 'data', 'pipeline.md'), '# Pipeline\n\n');
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, `tracked_companies:
  - name: Fixture Co
    careers_url: https://jobs.example.com/
    parser:
      command: node
      script: tests/fixtures/years-board.mjs
`);
    const targets = join(dir, 'targets.yml');
    writeFileSync(targets, TARGETS);
    const out = execFileSync(NODE, [join(ROOT, 'scan.mjs')], {
      cwd: dir,
      env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals, CAREER_OPS_TARGETS: targets },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const saved = readFileSync(join(dir, 'data', 'pipeline.md'), 'utf-8').split('\n')
      .filter((l) => /^- \[[ x]\]\s+https?:\/\//.test(l))
      .map((l) => Number(l.match(/example\.com\/(\d+)/)?.[1]))
      .sort((a, b) => a - b);

    if (!saved.includes(1) && saved.includes(2) && saved.includes(3)) {
      pass('a posting asking 10 years is not saved; 3 years and a company-age "30 ans" are');
    } else fail(`saved = ${JSON.stringify(saved)}`);
    if (saved.includes(4) && saved.includes(5) && !saved.includes(6) && !saved.includes(7) && !saved.includes(8)) {
      pass('company board: Lead kept, Presales rescued, Sales / Director / Comptable dropped');
    } else fail(`saved = ${JSON.stringify(saved)}`);
    if (/Filtered by years:\s+1 removed \(asked 8\+ years\)/.test(out) && /local-parser\s+2\/\d+ stated their years, 1 asked 8\+/.test(out)) {
      pass('the scan summary counts the years drop per source');
    } else fail(`summary did not report the years filter:\n${out.split('\n').filter((l) => /years|stated/.test(l)).join('\n')}`);

    const { loadPostingTexts } = await import(pathToFileURL(join(ROOT, 'lib/posting-text.mjs')).href);
    const texts = loadPostingTexts(dir, ['https://jobs.example.com/2', 'https://jobs.example.com/4', 'https://jobs.example.com/1']);
    if (texts.get('https://jobs.example.com/2')?.includes('3 ans') && !texts.has('https://jobs.example.com/4') && !texts.has('https://jobs.example.com/1')) {
      pass('saved postings with text are cached; no text, or not saved, means no cache entry');
    } else fail(`cache = ${JSON.stringify([...texts])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- which filter a provider gets ----------------------------------------
  const { titleFilterFor } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);
  const full = () => 'full';
  const board = () => 'board';
  if (['wttj', 'apec', 'hellowork', 'freework', 'francetravail', 'linkedin'].every((id) => titleFilterFor(id, full, board)() === 'board')
      && ['greenhouse', 'lever', 'workday', 'local-parser'].every((id) => titleFilterFor(id, full, board)() === 'full')) {
    pass('job boards get the drop-words-only filter; company boards the full one');
  } else fail('titleFilterFor picked the wrong filter');

  // ---- the cache on its own -------------------------------------------------
  const { savePostingTexts, loadPostingTexts, KEEP_DAYS, MAX_CHARS } = await import(pathToFileURL(join(ROOT, 'lib/posting-text.mjs')).href);
  const root = mkdtempSync(join(tmpdir(), 'posting-text-'));
  try {
    savePostingTexts(root, [{ url: 'u1', description: 'first   text' }], '2026-09-01');
    savePostingTexts(root, [{ url: 'u2', description: 'x'.repeat(MAX_CHARS + 50) }, { url: 'u3', description: '' }], '2026-09-01');
    savePostingTexts(root, [{ url: 'u1', text: 'newer text' }], '2026-09-02');
    const got = loadPostingTexts(root, ['u1', 'u2', 'u3']);
    if (got.get('u1') === 'newer text' && got.get('u2').length === MAX_CHARS && !got.has('u3')) {
      pass('two writes to one day file read back as one; the newer day wins; text is clipped');
    } else fail(`loaded = ${JSON.stringify([...got].map(([k, v]) => [k, v.length]))}`);
    savePostingTexts(root, [{ url: 'u4', description: 'later' }], `2026-09-${String(2 + KEEP_DAYS + 1).padStart(2, '0')}`);
    const files = readdirSync(join(root, 'data/posting-text'));
    if (!files.includes('2026-09-01.jsonl.gz') && files.length === 1) pass(`day files older than ${KEEP_DAYS} days are deleted`);
    else fail(`files = ${JSON.stringify(files)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} catch (err) {
  fail(`scan years/titles suite crashed: ${err.message}`);
}
