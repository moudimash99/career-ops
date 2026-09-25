// tests/cv-write.test.mjs — the single pasted context agy writes CVs from.
// Run: node test-all.mjs --only cv-write
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ncv-write — pasted context for agy');
const w = await import(pathToFileURL(join(ROOT, 'cv-write.mjs')).href);
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};

const customMd = `# Custom\n\n## House Rules\nnot this\n\n## CV sections (x)\nsections rule\n\n## Application language (y)\nFrench when…\n\n## Parked tabs\nnot this either\n\n## pdf.md steps overridden (z)\nno strip\n`;
const pdfMd = 'intro\n### JSON Input Schema\ntext\n```json\n{"candidate": {}}\n```\nafter\n';
const ctx = w.buildCvContext({ customMd, pdfMd, cvMd: 'MY CV', jdText: 'THE JOB', arm: 'loose', lang: 'fr' });
check('only CV / language / pdf-override sections are pasted',
  ['sections rule', 'French when', 'no strip', 'not this'].map(s => ctx.includes(s)), [true, true, true, false]);
check('schema, CV and posting are pasted', ['{"candidate": {}}', 'MY CV', 'THE JOB'].every(s => ctx.includes(s)), true);
check('arm and language lines', [ctx.includes('ARM: loose'), ctx.includes('LANGUAGE: French.')], [true, true]);
check('no --lang defers to the Application language rule',
  w.buildCvContext({ customMd, pdfMd, cvMd: '', jdText: '', arm: 'strict' }).includes('follow the "Application language" rule'), true);
let threw = false;
try { w.buildCvContext({ customMd, pdfMd, cvMd: '', jdText: '', arm: 'medium' }); } catch { threw = true; }
check('unknown arm is refused', threw, true);
check('JSON is pulled out of a fenced or chatty reply',
  [w.extractJson('```json\n{"a":1}\n```'), w.extractJson('Here it is: {"a":{"b":2}} done')], [{ a: 1 }, { a: { b: 2 } }]);
