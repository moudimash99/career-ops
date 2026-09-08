// tests/voice-check.test.mjs — the guardrail that stops AI-sounding prose
// reaching a form.
//
// The rules themselves live in voice-dna.md and are the user's to edit, so the
// tests here do NOT re-assert the user's word list. They assert the two things
// that must not regress: that the file is actually PARSED (so editing it
// changes the check), and that the structural tells which cannot be expressed
// as a word list are caught. Every fixture below is a real sentence shape from
// the 2026-09-07 run that shipped machine-sounding text into live forms.
//
// Run: node test-all.mjs --only voice-check

import { pass, fail, ROOT, rmSync } from './helpers.mjs';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nvoice-check — the anti-AI-slop gate');

const { parseVoiceDna, checkText, REGISTERS } =
  await import(pathToFileURL(join(ROOT, 'lib/voice-check.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'voice-'));
const fatalRules = (r) => r.findings.filter((f) => f.severity === 'fatal').map((f) => f.rule);
const warnRules = (r) => r.findings.filter((f) => f.severity === 'warn').map((f) => f.rule);

try {
  // ------------------------------------------------- voice-dna.md is PARSED

  // A tiny stand-in file. If the checker ever hardcodes its lists instead of
  // reading this, these assertions fail — which is the point: the user edits
  // voice-dna.md and the gate has to follow.
  const dnaPath = join(tmp, 'voice-dna.md');
  writeFileSync(dnaPath, `# VOICE DNA

## 3. BANNED LIST

### 3A. Dead AI vocabulary

zorptastic, flimflam, wibble

### 3B. Dead phrases

- "In today's [anything]..."
- "It's worth noting..."

### 3C. Dead transitions

- "Furthermore"
`, 'utf-8');

  const rules = parseVoiceDna(dnaPath);
  check('the banned word list is read from the file', rules.words.includes('zorptastic'), true);
  check('and so are the dead phrases', rules.phrases.some((p) => /worth noting/i.test(p)), true);
  check('and the transitions', rules.phrases.some((p) => /Furthermore/i.test(p)), true);
  check('the file is reported as found', rules.found, true);

  const custom = checkText('This is zorptastic work. Furthermore, it is worth noting the result.', { rules });
  check('a word from the user\'s own list is fatal',
    fatalRules(custom).some((r) => /zorptastic/.test(r)), true);
  check('and so is a phrase from it', fatalRules(custom).some((r) => /worth noting/i.test(r)), true);

  // A missing file must degrade, not explode: structural checks still run.
  const none = parseVoiceDna(join(tmp, 'nope.md'));
  check('a missing voice-dna is reported, not thrown', none.found, false);
  check('and yields no word rules', none.words.length, 0);
  check('but structural checks still fire without it',
    fatalRules(checkText('We shipped it — fast.', { rules: none })).length >= 1, true);

  // ------------------------------------------------------- HARD: em dashes

  const dash = checkText('I owned the platform — all of it.', { rules });
  check('an em dash is fatal', fatalRules(dash), ['em dash']);
  check('and it is counted', dash.stats.emDashes, 1);
  check('a hyphen is not an em dash', checkText('A well-run team.', { rules }).stats.emDashes, 0);

  // ----------------------------------- HARD: negative parallelism (§3F)

  // Every one of these is the same skeleton. The last two are the exact
  // constructions that got through on 2026-09-07.
  const skeletons = [
    "It's not about the tooling, it's about the constraints.",
    'Not only did we ship it, but also on time.',
    'Less process, more shipping.',
    "The question isn't whether to migrate.",
    "You don't need a bigger cluster, you need a smaller index.",
    'While that might seem obvious, the data says otherwise.',
    'Sure, it worked. But the cost was the problem.',
    'Batch jobs get all the attention, but streaming is where it broke.',
    'I designed it for retention rather than raw throughput.',
    'It taught me to size the budget up front instead of discovering it later.',
  ];
  let caught = 0;
  for (const s of skeletons) if (fatalRules(checkText(s, { rules })).some((r) => /negative parallelism/.test(r))) caught++;
  check('every negative-parallelism skeleton is caught', caught, skeletons.length);

  check('ordinary prose is not flagged as parallelism',
    fatalRules(checkText('I rebuilt the tile service on FastAPI and cut storage by 80%.', { rules }))
      .some((r) => /negative parallelism/.test(r)), false);

  // ------------------------------------------- HARD: copulative + meta

  check('copulative avoidance is fatal',
    fatalRules(checkText('The platform serves as the ingestion layer.', { rules }))
      .some((r) => /copulative/.test(r)), true);
  check('meta commentary is fatal',
    fatalRules(checkText('In this letter, I will describe my experience.', { rules }))
      .some((r) => /meta commentary/.test(r)), true);
  check('chat leakage is fatal',
    fatalRules(checkText('I hope this helps! Let me know.', { rules }))
      .some((r) => /meta commentary/.test(r)), true);

  // --------------------------------------------------- WARN: soft tells

  check('participle padding warns',
    warnRules(checkText('We cut latency by 60%, highlighting the value of caching.', { rules }))
      .some((r) => /participle/.test(r)), true);
  check('a mid-sentence -ing verb does not warn',
    warnRules(checkText('I am highlighting the row that failed.', { rules }))
      .some((r) => /participle/.test(r)), false);

  // §4B is about abstract padding, not real enumerations.
  check('abstract rule of three warns',
    warnRules(checkText('We delivered speed, efficiency and quality.', { rules }))
      .some((r) => /rule of three/.test(r)), true);
  check('a factual list of proper nouns does not warn',
    warnRules(checkText('I work in French, English and Arabic.', { rules }))
      .some((r) => /rule of three/.test(r)), false);
  check('nor does a list of named technologies',
    warnRules(checkText('Modules for VPC, EKS and versioned S3.', { rules }))
      .some((r) => /rule of three/.test(r)), false);

  // Metronome: 8 sentences all ~18 words, which is the shape of the essays
  // that prompted this file.
  const metronome = Array.from({ length: 8 }, (_, i) =>
    `I built the ${i} service and ran it in production for several months with monitoring and alerting in place.`).join(' ');
  check('even sentence lengths warn as metronome rhythm',
    warnRules(checkText(metronome, { rules })).some((r) => /metronome/.test(r)), true);

  const varied = 'I rebuilt it. Storage dropped 80%. The upstream DAGs were the harder half, because a scene that fails halfway leaves you with a partial mosaic and no way to tell. So I made them idempotent. That took a week.';
  check('varied rhythm does not warn',
    warnRules(checkText(varied, { rules })).some((r) => /metronome/.test(r)), false);

  // ------------------------------------------------------------- registers

  check('the registers are the two the writing guide defines', REGISTERS, ['conversational', 'ats']);

  // Long enough that the absence of a single contraction is a register choice
  // rather than an accident of length, which is what the rule keys on.
  const formal = 'Provisioned AWS EKS with Terraform and Karpenter across three environments. Authored reusable modules for VPC, EKS and versioned S3 storage. Instrumented the platform with Prometheus and Grafana dashboards. Ran deployments through GitHub Actions and Helm charts on every merge. Maintained pipeline SLA above 98 percent throughout the year. Reduced ingestion cost per scene by rewriting the mosaicking step. Documented the runbooks and handed them to the operations team. Migrated the token scheme and added request rate limiting to the public gateway. Cut median response time on the busiest endpoint by more than half.';
  check('a CV bullet block is not asked for contractions in ats register',
    warnRules(checkText(formal, { rules, register: 'ats' })).some((r) => /contractions|first person/.test(r)), false);
  check('but the same text is nudged in conversational register',
    warnRules(checkText(formal, { rules, register: 'conversational' })).some((r) => /contractions/.test(r)), true);

  // The conversational tier is language-specific. This candidate applies in
  // France, and a French letter has no English contractions and no "I" — it
  // elides (j'ai, c'est) and says "je". Nudging it to add either is noise.
  const frenchLetter = "Bonjour, je postule au poste de Senior Data Consultant a Paris. Je termine le Mastere Specialise en Ingenierie des Systemes de l'ISAE-SUPAERO, avec un stage chez Airbus jusqu'au 18 novembre. J'ai porte les couches cloud et data d'une plateforme qui transforme l'imagerie satellite en tuiles cartographiques. C'est ce travail qui se rapproche le plus de votre offre, et je reste disponible pour en echanger avec vous cette semaine.";
  check('a French letter is not told to add English contractions',
    warnRules(checkText(frenchLetter, { rules, register: 'conversational' }))
      .some((r) => /no contractions/.test(r)), false);
  check('nor to add the word "I"',
    warnRules(checkText(frenchLetter, { rules, register: 'conversational' }))
      .some((r) => /no first person/.test(r)), false);

  // A French draft that genuinely lacks the first person is still caught.
  const frenchImpersonal = 'Le poste de Senior Data Consultant a Paris correspond au profil recherche. Les couches cloud et data de la plateforme ont ete portees avec succes, et les tuiles cartographiques sont generees a la demande depuis le moteur de rendu. Les resultats obtenus sur ce projet sont conformes aux attentes du client, et les delais ont ete respectes sur toute la duree de la mission concernee. Les indicateurs de suivi ont ete mis en place des le debut du projet, puis presentes lors des comites hebdomadaires organises avec les equipes techniques et fonctionnelles du client.';
  check('but a French draft with no first person still warns',
    warnRules(checkText(frenchImpersonal, { rules, register: 'conversational' }))
      .some((r) => /no first person/.test(r)), true);

  // ------------------------------------------------------------- ok / stats

  const clean = checkText("I rebuilt the tile service. Storage dropped about 80%, and a refresh that took hours now takes 30 minutes. I'd do the caching differently next time.", { rules });
  check('clean prose passes', clean.ok, true);
  check('and reports no fatal findings', fatalRules(clean), []);
  check('stats count sentences', clean.stats.sentences, 3);

  check('ok is false when anything fatal fires', checkText('It — is fine.', { rules }).ok, false);
  check('warnings alone leave ok true',
    checkText('I work in French, English and Arabic. I did the work myself.', { rules }).ok, true);

  check('empty input is clean, not a crash', checkText('', { rules }).ok, true);
  check('null input is clean, not a crash', checkText(null, { rules }).ok, true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
