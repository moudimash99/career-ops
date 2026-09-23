// tests/readme-hitl-markers.test.mjs — fork guard: no README may promise that
// career-ops never submits an application.
//
// This fork submits applications (Free Motion, AGENTS.md "Ethical Use":
// auto-submit is permitted). Upstream's version of this file enforced the
// opposite — a `<!-- hitl: absolute guarantee -->` marker and the sentence
// "never submits an application" in all 17 READMEs. An upstream merge brings
// that wording back quietly, in 17 languages, so this file now fails on it.
//
// What it catches, in every README:
//   - the upstream HITL marker comment;
//   - in README.md, the English "never submits" / "never applies in your name"
//     family of claims and the "Human-in-the-Loop" guarantee row.
// Translations cannot be scanned for every phrasing; they are derived from the
// English source and carried by the marker check, which is how upstream
// planted the guarantee in them in the first place.
//
// The A-H drift check at the bottom is kept from upstream unchanged.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nREADME auto-submit stance — no "never submits" promise returns');

const MARKER = '<!-- hitl:';
const readmes = readdirSync(ROOT).filter((f) => /^README[\w.-]*\.md$/.test(f)).sort();

// A check over an empty (or mis-globbed) list would pass vacuously.
if (readmes.length >= 17) pass(`found ${readmes.length} README files (17 expected as of Aug 2026)`);
else fail(`only ${readmes.length} README*.md files found — glob broken or files removed`);

const NEVER_SUBMITS = /never (submits?|applies|clicks submit)\b|never POSTs|\bhuman-in-the-loop\b|\|\s*\*\*Human-in-the-Loop\*\*/i;

for (const file of readmes) {
  const content = readFileSync(join(ROOT, file), 'utf8');

  if (content.includes(MARKER)) fail(`${file}: carries the upstream HITL "never submits" marker — remove the row`);
  else pass(`${file}: no upstream HITL marker`);

  if (file === 'README.md') {
    const hit = content.split('\n').find((l) => NEVER_SUBMITS.test(l));
    if (hit) fail(`README.md: promises the tool never submits — "${hit.trim().slice(0, 120)}"`);
    else pass('README.md: no "never submits" promise');
  }

  // Wholesale-drift control (upstream): every README describes the report as A-H.
  if (content.includes('A-H') || content.includes('A–H')) {
    pass(`${file}: mentions the A-H report structure`);
  } else {
    fail(`${file}: never mentions A-H — translation predates the current report structure`);
  }
}
