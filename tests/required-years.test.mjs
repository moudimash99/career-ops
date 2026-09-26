// tests/required-years.test.mjs — lib/required-years.mjs, how many years of
// experience a posting asks for.
//
// Pinned here: every phrasing in tests/fixtures/required-years.json gives its
// expected number, including the traps that must stay null (company age,
// "forte de 25 ans d'expérience", study years). A wrong number drops a good
// job, so the traps matter as much as the hits. All offline and pure.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

console.log('\nrequired-years — years of experience a posting asks for');

try {
  const { requiredYears, requiredYearsFromLabel } = await import(pathToFileURL(join(ROOT, 'lib/required-years.mjs')).href);
  const cases = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/required-years.json'), 'utf8'));

  const wrong = cases.text.filter(([text, want]) => requiredYears(text) !== want)
    .map(([text, want]) => `${JSON.stringify(text)}: want ${want}, got ${requiredYears(text)}`);
  if (wrong.length === 0) pass(`requiredYears() reads all ${cases.text.length} posting phrasings, traps included`);
  else fail(`requiredYears() wrong on ${wrong.length}:\n    ${wrong.join('\n    ')}`);

  const wrongLabels = cases.label.filter(([label, want]) => requiredYearsFromLabel(label) !== want)
    .map(([label, want]) => `${JSON.stringify(label)}: want ${want}, got ${requiredYearsFromLabel(label)}`);
  if (wrongLabels.length === 0) pass(`requiredYearsFromLabel() reads all ${cases.label.length} board labels`);
  else fail(`requiredYearsFromLabel() wrong on ${wrongLabels.length}:\n    ${wrongLabels.join('\n    ')}`);

  if (requiredYears('') === null && requiredYears(undefined) === null && requiredYears('<p></p>') === null) {
    pass('no text gives null, never 0');
  } else fail('empty text must give null');
} catch (err) {
  fail(`required-years suite crashed: ${err.message}`);
}
