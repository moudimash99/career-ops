// tests/scan-history-prune.test.mjs — scan-history-prune.mjs removes only
// the rows the scanner would not save today (blacklist, title, location, each
// by its own source's filter), never another writer's rows, writes nothing
// without --apply, and backs up before it rewrites.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

console.log('\nscan-history-prune — drop the rows the scanner would not save today');

const HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation';
const row = (n, portal, title, company, location = 'Toulouse') => `https://x/${n}\t2026-09-01\t${portal}\t${title}\t${company}\tadded\t${location}`;
const ROWS = [
  row(1, 'wttj-api', 'Ingénieur Sysops Linux', 'A'),          // board: no role word, no drop word → stays
  row(2, 'wttj-api', 'Comptable', 'B'),                       // board: non-fit → title
  row(3, 'greenhouse-api', 'Ingénieur Sysops Linux', 'C'),    // company board: no role word → title
  row(4, 'greenhouse-api', 'Cloud Engineer', 'D'),            // stays
  row(5, 'workday-api', 'Cloud Engineer', 'Airbus'),          // blacklisted
  row(6, 'lever-api', 'Cloud Engineer', 'E', 'Bangalore, India'), // location
  row(7, 'hn', 'Comptable', 'F'),                             // another writer's row → untouched
  row(8, 'workday-full', 'Director of Cloud', 'G'),            // full sweep: drop word → title
];

try {
  const dir = mkdtempSync(join(tmpdir(), 'prune-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const history = join(dir, 'data', 'scan-history.tsv');
    const original = `${HEADER}\n${ROWS.join('\n')}\n`;
    writeFileSync(history, original);
    writeFileSync(join(dir, 'data', 'blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Airbus | 2026-09-01 | scan+apply | own pipeline |\n');
    writeFileSync(join(dir, 'portals.yml'), 'location_filter:\n  block: [India]\n');
    writeFileSync(join(dir, 'targets.yml'), `tiers:
  - points: 2
    groups:
      cloud: { match: [cloud] }
drop:
  seniority: ["word:director"]
non_fit: [comptable]
`);
    const env = { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: join(dir, 'portals.yml'), CAREER_OPS_TARGETS: join(dir, 'targets.yml'), CAREER_OPS_SCAN_HISTORY: history };
    const run = (...args) => execFileSync(NODE, [join(ROOT, 'scan-history-prune.mjs'), ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    const dry = run();
    if (readFileSync(history, 'utf8') === original && /8 rows, 5 would go, 3 stay/.test(dry)) pass('without --apply it only reports (5 of 8 would go) and writes nothing');
    else fail(`dry run: ${dry.split('\n')[0]} / file changed: ${readFileSync(history, 'utf8') !== original}`);

    run('--apply');
    const left = readFileSync(history, 'utf8').trim().split('\n').slice(1).map((l) => Number(l.match(/x\/(\d+)/)[1]));
    if (left.join() === '1,4,7') pass('--apply keeps the board title with no role word, the good job, and the other writer\'s row');
    else fail(`left = ${left.join()}`);
    const backups = readdirSync(join(dir, 'data')).filter((f) => /^scan-history\.backup-\d{4}-\d{2}-\d{2}\.tsv$/.test(f));
    if (backups.length === 1 && readFileSync(join(dir, 'data', backups[0]), 'utf8') === original) pass('--apply backs the old file up first');
    else fail(`backups = ${JSON.stringify(backups)}`);
    if (existsSync(history) && readFileSync(history, 'utf8').startsWith(HEADER)) pass('the header stays');
    else fail('header lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (err) {
  fail(`scan-history-prune suite crashed: ${err.message}${err.stderr ? `\n${err.stderr}` : ''}`);
}
