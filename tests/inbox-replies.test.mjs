// tests/inbox-replies.test.mjs — freemotion-night/inbox-replies.py's wording and matching rules.
//
// The rules live in the Python file with their cases (`--self-test`): a conditional refusal in an
// acknowledgement ("no answer within a month means not retained") is not a rejection, a job board's
// copy of our own letter is not an invitation, and a company is matched as whole words only.
// Offline: the self-test never opens the inbox.
import { spawnSync } from 'child_process';
import { join } from 'path';
import { pass, fail, warn, ROOT } from './helpers.mjs';

console.log('\ninbox-replies — what employers answered');

const py = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['--version'], { encoding: 'utf8' }).status === 0);
if (!py) {
  warn('no Python on this machine: inbox-replies self-test skipped');
} else {
  const r = spawnSync(py, [join(ROOT, 'freemotion-night/inbox-replies.py'), '--self-test'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0 && /self-test: \d+ passed, 0 failed/.test(out)) pass(`wording and matching rules (${out.split('\n').pop()})`);
  else fail(`inbox-replies self-test failed:\n${out}`);
}
