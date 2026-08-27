#!/usr/bin/env node
// Backup helper for the career-ops personal data layer.
//
// The personal files (CV, profile, tracker, reports, generated CVs) are
// gitignored by the career-ops repo on purpose — they must never land in a
// commit that could be pushed upstream. That leaves them with no version
// history at all, which is why this second repo exists: its git dir lives
// OUTSIDE the career-ops checkout, so the backup survives deleting or
// re-cloning career-ops, while its work tree is the career-ops folder itself
// (nothing is copied or duplicated).
//
// Usage:
//   node scripts/backup.mjs status     what changed since the last save
//   node scripts/backup.mjs save       stage the personal files and commit
//   node scripts/backup.mjs save "msg" commit with your own message
//   node scripts/backup.mjs push       push to the private remote
//   node scripts/backup.mjs log        recent history
//   node scripts/backup.mjs remote <url>   attach the private GitHub repo
//
// `save` force-adds each path: the career-ops .gitignore covers these files and
// .gitignore outranks this repo's info/exclude, so a plain `git add` would skip
// every one of them.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const WORK_TREE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GIT_DIR = resolve(WORK_TREE, '..', 'career-ops-data.git');

// Everything in the user layer. Missing paths are skipped rather than fatal —
// most installs will not have every one of these (no resume.tex, no jds yet).
const TRACKED = [
  'cv.md', 'article-digest.md', 'voice-dna.md', 'portals.yml', 'resume.tex',
  'config/profile.yml',
  'modes/_profile.md', 'modes/_custom.md', 'modes/_brief.md',
  'data', 'reports', 'output', 'documents',
  'interview-prep', 'jds', 'writing-samples', 'scripts',
];

function git(args, { capture = true } = {}) {
  return execFileSync('git', ['--git-dir', GIT_DIR, '--work-tree', WORK_TREE, ...args], {
    cwd: WORK_TREE,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

if (!existsSync(GIT_DIR)) {
  console.error(`No backup repo at ${GIT_DIR}`);
  console.error('Expected a sibling of the career-ops folder. Re-create it, or fix the path above.');
  process.exit(1);
}

const [cmd = 'status', ...rest] = process.argv.slice(2);

function stage() {
  const present = TRACKED.filter(p => existsSync(join(WORK_TREE, p)));
  // -f is load-bearing: see the header note about .gitignore precedence.
  git(['add', '-f', ...present]);
  return present;
}

try {
  switch (cmd) {
    case 'status': {
      stage();
      const out = git(['diff', '--cached', '--stat']);
      if (out.trim()) {
        console.log(out.trim());
        console.log('\nRun `node scripts/backup.mjs save` to commit.');
      } else {
        console.log('Backup is up to date — nothing changed.');
      }
      break;
    }

    case 'save': {
      stage();
      if (!git(['diff', '--cached', '--name-only']).trim()) {
        console.log('Nothing to save.');
        break;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const msg = rest.join(' ') || `Backup ${stamp}`;
      git(['commit', '-q', '-m', msg]);
      console.log(git(['log', '--oneline', '-1']).trim());
      const hasRemote = git(['remote']).trim();
      console.log(hasRemote
        ? 'Saved locally. Run `node scripts/backup.mjs push` to send it off-machine.'
        : 'Saved locally. No remote yet — see `node scripts/backup.mjs remote <url>`.');
      break;
    }

    case 'push': {
      if (!git(['remote']).trim()) {
        console.error('No remote configured. Run: node scripts/backup.mjs remote <url>');
        process.exit(1);
      }
      git(['push', '-u', 'origin', 'main'], { capture: false });
      break;
    }

    case 'remote': {
      const url = rest[0];
      if (!url) {
        console.error('Usage: node scripts/backup.mjs remote <private-repo-url>');
        process.exit(1);
      }
      const existing = git(['remote']).trim();
      git([...(existing ? ['remote', 'set-url'] : ['remote', 'add']), 'origin', url]);
      console.log(`origin -> ${url}`);
      console.log('Now run: node scripts/backup.mjs push');
      break;
    }

    case 'log':
      console.log(git(['log', '--oneline', '-20']).trim());
      break;

    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Use: status | save | push | log | remote <url>');
      process.exit(1);
  }
} catch (err) {
  console.error(err.stderr?.toString().trim() || err.message);
  process.exit(1);
}
