#!/usr/bin/env node
// node freemotion-night/record.mjs <run-id> <num> <slug> <company> <role> <url> <note>
// Records a CONFIRMED submission: closes the claim in data/freemotion-submissions.tsv
// and adds an Applied row to the tracker. Refuses any job not on this run's list
// (tmp/fm/night/allowed-urls.txt, written by make-jobs.mjs) and any note that
// reads like a failure, so a wrong call can't put a false "Applied" row in the tracker.
//
// Node, not bash: an agent runs commands through PowerShell or cmd, where `bash` can be WSL's
// (C:\Windows\System32\bash.exe), which cannot run this repo's scripts. On a new PC (2026-10-04)
// every `bash freemotion-night/record.sh` from agy failed that way. record.sh now calls this file.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 7) {
  console.log('Usage: node freemotion-night/record.mjs <run-id> <num> <slug> <company> <role> <url> <note>');
  process.exit(1);
}
const [RUN, NUM, SLUG, CO, ROLE, URL, NOTE] = args;

let allowed = [];
try { allowed = readFileSync(join(ROOT, 'tmp/fm/night/allowed-urls.txt'), 'utf8').split(/\r?\n/); } catch {}
if (!allowed.includes(URL)) {
  console.log(`REFUSED: ${URL} is not on this run's job list. Nothing recorded.`);
  process.exit(4);
}
if (/^(failed|error)|404|not found|introuvable|could not|unable to/i.test(NOTE)) {
  console.log('REFUSED: the note reads like a failure, not a confirmation. Nothing recorded. Only record a job the site confirmed.');
  process.exit(4);
}

const node = (script, ...rest) => execFileSync(process.execPath, [join(ROOT, script), ...rest], { cwd: ROOT, encoding: 'utf8' });
node('lib/freemotion-submissions.mjs', 'finalize', '--url', URL, '--outcome', 'submitted', '--run-id', RUN, '--report', '-', '--notes', NOTE);
const today = new Date().toLocaleDateString('sv-SE');
writeFileSync(join(ROOT, 'batch/tracker-additions', `${NUM}-${SLUG}.tsv`),
  [NUM, today, CO, ROLE, 'Applied', 'N/A', '❌', '-', `${NOTE} Run ${RUN}.`, URL].join('\t') + '\n');
const merged = node('merge-tracker.mjs');
console.log((merged.match(/Summary: \+.*/) ?? [''])[0]);
const rows = readFileSync(join(ROOT, 'data/applications.md'), 'utf8').split('\n').filter((l) => l.startsWith(`| ${NUM} `)).length;
console.log(rows);
