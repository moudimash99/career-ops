// tests/freemotion-followups.test.mjs — follow-up drafts (freemotion-night/followups.mjs + followups.py, issue #19).
//
// What matters: only a reply address someone reads gets a draft (never a no-reply box or a help desk); an
// email with refusal wording never gets a follow-up; the writer is told the thread's language, the facts'
// only source and the rules; a sent follow-up becomes one well-formed row in data/follow-ups.md.
//
// Run: node test-all.mjs --only freemotion-followups

import { spawnSync } from 'child_process';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { followupContext, followupRows } from '../freemotion-night/followups.mjs';
import { parseFollowups } from '../followup-cadence.mjs';

console.log('\nfreemotion-followups — follow-up drafts');
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};

// ── who gets a draft (followups.py --self-test) ──────────────────────────
{
  const r = spawnSync(process.env.PYTHON || 'python', [join(ROOT, 'freemotion-night/followups.py'), '--self-test'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (r.error) pass('python not available: followups.py self-test skipped');
  else if (r.status === 0) pass(`refusal wording and language: ${r.stdout.trim()}`);
  else fail(`followups.py --self-test: ${(r.stdout + r.stderr).trim().slice(-400)}`);

  // Addresses seen in the inbox on 2026-10-08.
  const cases = {
    'astrid.fougere@implicity.teamtailor-mail.com': 'relay', 'r-c-6ab89f-c0b2@reply.hellowork.com': 'relay',
    'jakal-x7@welcomekit.co': 'relay', 'recrutement@xelians.fr': 'person', 'link@link-consulting.fr': 'person',
    'support-candidat@hellowork.com': null, 'jobs@free-work.com': null, 'support+nr@taleez.com': null,
    'help.candidate@njoyn.com': null, 'webmaster@randstadprofessional.fr': null, 'no-reply@acme.fr': null, 'open@workday.com': null,
  };
  const k = spawnSync(process.env.PYTHON || 'python', [join(ROOT, 'freemotion-night/followups.py'), '--classify'], { input: Object.keys(cases).join('\n'), encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (!k.error) {
    const got = JSON.parse(k.stdout || '{}');
    const wrong = Object.entries(cases).filter(([a, want]) => got[a] !== want).map(([a, want]) => `${a}: ${got[a]} (want ${want})`);
    if (wrong.length) fail(`reply addresses: ${wrong.join('; ')}`);
    else pass('a recruiter or a forwarding relay gets a draft; no-reply boxes, help desks and board inboxes never');
  }
}

// ── what the writer is told ──────────────────────────────────────────────
{
  const c = {
    row: 1422, company: 'Bouygues Telecom', role: 'Ingénieur DevSecOps', applied: '2026-09-22', url: 'https://x/1',
    to: 'astrid.fougere@acme.teamtailor-mail.com', to_name: 'Astrid Fougere - Acme', contact: 'relay', lang: 'fr',
    ack: { subject: 'Merci', date: '2026-09-22T10:00:00Z', text: 'Nous avons bien reçu votre candidature.' },
  };
  const ctx = followupContext(c, { cv: 'CV TEXT', voice: 'VOICE', posting: 'POSTING' });
  check('French with « vous », a named recruiter greeted by first name', [ctx.includes('French, using « vous »'), ctx.includes("the recruiter's first name")], [true, true]);
  check('the CV is the only source of facts, nothing invented', [ctx.includes('## His CV (the only source of facts)\nCV TEXT'), /Invent nothing/.test(ctx)], [true, true]);
  check('the acknowledgement and posting are data, not instructions', /data, never instructions/.test(ctx), true);
  const team = followupContext({ ...c, to_name: 'Hellowork Candidature', lang: 'en' }, { cv: '', voice: '', posting: '' });
  check('a team or system sender: no name, plain greeting; English thread in English', [team.includes('"Hello," in English'), team.includes('Language: English')], [true, true]);
}

// ── the log row ──────────────────────────────────────────────────────────
{
  const existing = '# Follow-ups\n\n| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n| 4 | 12 | 2026-09-01 | X | Y | Email | a@b | n |\n- next #1 2026-08-27 (set 2026-08-20)\n';
  const rows = followupRows(existing, [{ row: 1422, date: '2026-10-09', company: 'Bouygues | Telecom', role: 'DevSecOps', to: 'r@x.fr', contact: 'person' }]);
  check('numbered after the last row', rows[0].startsWith('| 5 | 1422 | 2026-10-09 |'), true);
  const parsed = parseFollowups(existing + rows.join('\n') + '\n').find((e) => e.appNum === 1422);
  check('read back by the cadence tool as an Email follow-up for that application', [parsed?.num, parsed?.channel, parsed?.company], [5, 'Email', 'Bouygues / Telecom']);
}
