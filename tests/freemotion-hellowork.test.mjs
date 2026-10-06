// tests/freemotion-hellowork.test.mjs — freemotion-night/sites/hellowork.mjs, the HelloWork part without a model.
//
// What matters: the script reads the right job, CV and letter from the sheet; what it tells the agent never
// invites a second "Postuler"; it reads HelloWork's answers correctly (success, duplicate, phone step,
// employer site); and "Mes candidatures" only counts as proof for THIS posting, sent today.
// The browser part is checked by the rehearsal (--dry-run), not here.
//
// Run: node test-all.mjs --only freemotion-hellowork

import { pass, fail } from './helpers.mjs';
import {
  HW_END, HW_START, classifyResult, fitLetter, frDay, handoffBlock, hasHandoff, historyLists, isHelloWork,
  parseConfirmation, parseSheet, withHandoff,
} from '../freemotion-night/sites/hellowork.mjs';

console.log('\nfreemotion-hellowork — the HelloWork script');
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};

const SHEET = `# Task: submit ONE job application (run fm-2026-10-07-night, job number 2401)

Root: C:/x

## Helper scripts already written (use them, do not rewrite them)
- FIRST

## The job (this is the ONLY job you may touch)
**Acme — Ingénieur DevOps H/F**, Toulouse, number 2401, slug \`acme\`, posting in French
   https://www.hellowork.com/fr-fr/emplois/84000001.html

## Data to use (invent nothing)
Jean · Dupont · jean.dupont@example.com · +33 6 12 34 56 78
CV: C:/x/output/fm/acme-1/cv-jean-dupont.pdf

## CV and cover letter (made for this posting; use exactly these)
<!-- docs:start -->
----- LETTER START -----
Bonjour,

Une phrase.
----- LETTER END -----
<!-- docs:end -->
`;

// ── the sheet ────────────────────────────────────────────────────────────
{
  const j = parseSheet(SHEET);
  check('job, run, company, role, slug, URL', [j.num, j.run, j.company, j.role, j.slug, j.url],
    ['2401', 'fm-2026-10-07-night', 'Acme', 'Ingénieur DevOps H/F', 'acme', 'https://www.hellowork.com/fr-fr/emplois/84000001.html']);
  check('candidate, and the phone without "+" (HelloWork refuses it)', [j.first, j.last, j.email, j.phone], ['Jean', 'Dupont', 'jean.dupont@example.com', '0612345678']);
  check('this job\'s CV and letter', [j.cvPath, j.letter], ['C:/x/output/fm/acme-1/cv-jean-dupont.pdf', 'Bonjour,\n\nUne phrase.']);
  check('no letter block = no letter', parseSheet(SHEET.replace(/----- LETTER START[\s\S]*LETTER END -----\n/, '')).letter, '');
  check('only HelloWork postings', [isHelloWork(j.url), isHelloWork('https://jobs.lever.co/acme/1'), isHelloWork('https://www.hellowork.com/fr-fr/entreprises/acme.html')], [true, false, false]);
}

// ── the hand-off ─────────────────────────────────────────────────────────
{
  const j = parseSheet(SHEET);
  const conf = handoffBlock({ kind: 'confirmed', text: 'Félicitations ! Votre candidature au poste de Ingénieur DevOps H/F va être transmise à Acme.', history: 'listed' }, j);
  check('confirmed: the agent only records, with the exact page text, and is told never to click "Postuler" again',
    [conf.includes('ONLY to record'), /do NOT click "Postuler"/.test(conf), conf.includes('record.mjs fm-2026-10-07-night 2401 acme "Acme" "Ingénieur DevOps H/F" "https://www.hellowork.com/fr-fr/emplois/84000001.html" "Félicitations !')],
    [true, true, true]);
  const unlisted = handoffBlock({ kind: 'confirmed', text: 'Félicitations ! x', history: 'not-listed', title: 'T', employer: 'E' }, j);
  check('confirmed but not in Mes candidatures: look first, finalize errored if absent', [unlisted.includes('mes-candidatures.html'), unlisted.includes('finalize `errored`')], [true, true]);
  const emp = handoffBlock({ kind: 'employer', employerUrl: 'https://jobs.lever.co/acme/1' }, j);
  check('employer site: start there, record under the HelloWork URL, not finished yet',
    [emp.includes('Start at the employer\'s page: https://jobs.lever.co/acme/1'), /NOT finished/.test(emp), /Do not open the HelloWork posting again/.test(emp)], [true, true, true]);
  const unclear = handoffBlock({ kind: 'unclear', why: 'no answer' }, j);
  check('unclear after "Postuler": check Mes candidatures first, never send twice', [unclear.includes('MAY have been sent'), /Never send it twice/.test(unclear)], [true, true]);
  const stopped = handoffBlock({ kind: 'stopped', why: 'unknown field', did: ['claimed'] }, j);
  check('every hand-off says the claim is done (a second claim is refused)', [stopped, emp, conf, unclear].every((b) => b.includes('already claimed this job')), true);
  check('stopped: nothing sent, do the whole task', [/stopped before sending anything/.test(stopped), stopped.includes('What the script did: claimed.')], [true, true]);

  const once = withHandoff(SHEET, stopped);
  check('the section goes before the helper scripts, the first thing the agent reads',
    once.indexOf(HW_START) < once.indexOf('## Helper scripts') && once.indexOf(HW_END) < once.indexOf('## Helper scripts'), true);
  const twice = withHandoff(once, emp);
  check('writing it again replaces it (one section, the latest)', [twice.split(HW_START).length, twice.includes('unknown field'), twice.includes('jobs.lever.co')], [2, false, true]);
  check('the rest of the sheet stays', twice.replace(/<!-- hw:start -->[\s\S]*<!-- hw:end -->\n\n/, ''), SHEET);
  check('hasHandoff', [hasHandoff(SHEET), hasHandoff(once)], [false, true]);
}

// ── HelloWork's answers ──────────────────────────────────────────────────
{
  const ok = 'Menu\nFélicitations ! Votre candidature au poste de Data Engineer H/F va être transmise à Eurofiber. Retrouvez l\'historique de vos candidatures dans votre espace candidat.\nPasser cette étape';
  check('success message', classifyResult({ text: ok, url: 'https://www.hellowork.com/fr-fr/bounce/multiapply?x' }).kind, 'confirmed');
  check('success text kept whole for the record', classifyResult({ text: ok }).text.startsWith('Félicitations ! Votre candidature au poste de Data Engineer H/F va être transmise à Eurofiber.'), true);
  check('title and employer from it', parseConfirmation(ok), { title: 'Data Engineer H/F', employer: 'Eurofiber' });
  check('duplicate', classifyResult({ text: 'Vous avez déjà postulé à cette offre. Nous ne pouvons pas transmettre une 2ème fois votre candidature au recruteur.' }).kind, 'already-applied');
  check('phone step', classifyResult({ text: 'Acme a besoin d\'une information complémentaire pour enregistrer votre candidature : Téléphone' }).kind, 'step2');
  check('employer site in a new tab', classifyResult({ text: '', url: 'https://www.hellowork.com/fr-fr/emplois/1.html', popupUrl: 'https://jobs.lever.co/acme/1' }), { kind: 'employer', employerUrl: 'https://jobs.lever.co/acme/1' });
  check('HelloWork\'s own redirect page is not the employer yet', classifyResult({ popupUrl: 'https://www.hellowork.com/fr-fr/emplois/redirectionexterne.html?offerId=1' }).kind, 'pending');
  check('nothing known yet', classifyResult({ text: 'Envoyez votre candidature', url: 'https://www.hellowork.com/fr-fr/emplois/1.html' }).kind, 'pending');
}

// ── Mes candidatures ─────────────────────────────────────────────────────
{
  const now = new Date(2026, 9, 7, 2, 0);
  const page = `253 candidatures
En cours d'envoi
Data Engineer H/F

Eurofiber

Toulouse - 31
Envoyée le ${frDay(now)}
Voir le détail
A finaliser
Backend Software Engineer Python - DevOps H/F

Scaleway
Envoyée le ${frDay(now)}
Voir le détail
Envoyée
Ingénieur DevOps H/F

CELAD
Envoyée le 04 octobre
Voir le détail`;
  check('French date', frDay(now), '07 octobre');
  check('sent today, being sent', historyLists(page, { title: 'Data Engineer H/F', employer: 'Eurofiber' }, now), true);
  check('"A finaliser" (passed on) is not a sent application', historyLists(page, { title: 'Backend Software Engineer Python - DevOps H/F', employer: 'Scaleway' }, now), false);
  check('an older application to the same kind of job is not proof', historyLists(page, { title: 'Ingénieur DevOps H/F', employer: 'CELAD' }, now), false);
  check('yesterday counts, for a run across midnight', historyLists(page.replace(frDay(now), '06 octobre'), { title: 'Data Engineer H/F', employer: 'Eurofiber' }, now), true);
  check('another employer is not proof', historyLists(page, { title: 'Data Engineer H/F', employer: 'Acme' }, now), false);
  check('no title, no proof', historyLists(page, { title: '', employer: 'Eurofiber' }, now), false);
}

// ── the letter limit ─────────────────────────────────────────────────────
{
  const text = 'Bonjour,\n\nPremière phrase. Deuxième phrase un peu plus longue. Troisième.';
  check('fits: unchanged', fitLetter(text, 2900), text);
  check('too long: whole sentences dropped from the end', fitLetter(text, 30), 'Bonjour,\n\nPremière phrase.');
  check('never longer than the limit', fitLetter(text, 50).length <= 50, true);
}
