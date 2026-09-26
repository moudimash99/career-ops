// tests/freemotion-night-model.test.mjs — how the night list uses the model
// (make-pool.mjs applyScores) and fetches HelloWork / LinkedIn text without a
// browser (lib/posting-fetch.mjs).
//
// Pinned here: an overall below 2 drops a job; a title that needs the model
// waits until scored and then needs 3+; the overall replaces the role-word
// points; 8+ years from the text drops, from the model only when the text
// states no number; the fetcher reads the posting's JSON-LD / LinkedIn
// description and never contacts another host. All offline.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-night — model scores in the night list, posting text fetch');

const load = (p) => import(pathToFileURL(join(ROOT, p)).href);

try {
  const { applyScores, rankOrder } = await load('freemotion-night/make-pool.mjs');
  const { jobKey } = await load('freemotion-night/llm-score.mjs');

  const job = (n, extra = {}) => ({ title: `Job ${n}`, co: `Co${n}`, url: `https://x/${n}`, score: 10, points: 2, needsModel: false, ...extra });
  const row = (overall, extra = {}) => ({ overall: String(overall), role: '5', skills: '4', experience: '3', language: '3', blockers: '5', years_required: '', summary: 's', ...extra });
  const jobs = [
    job(1),                                   // matched, not scored → kept as is
    job(2, { needsModel: true, points: 0 }),  // unmatched, not scored → waits
    job(3, { needsModel: true, points: 0 }),  // unmatched, 3.4 → kept, go
    job(4, { needsModel: true, points: 0 }),  // unmatched, 2.6 → kept, stretch
    job(5),                                   // matched, 2.6 → kept, stretch
    job(6),                                   // matched, 1.5 → dropped (no-go)
    job(7),                                   // model reads 10 years, no text number → dropped
    job(8),                                   // model reads 10 years, text says 5 → kept
    job(9),                                   // text says 9 years → dropped
  ];
  const scores = new Map([
    [jobKey(jobs[2]), row(3.4)], [jobKey(jobs[3]), row(2.6)], [jobKey(jobs[4]), row(2.6)], [jobKey(jobs[5]), row(1.5)],
    [jobKey(jobs[6]), row(4, { years_required: '10' })], [jobKey(jobs[7]), row(4, { years_required: '10' })],
  ]);
  const textYears = new Map([['https://x/8', 5], ['https://x/9', 9]]);
  const { kept, dropped } = applyScores(jobs, scores, { tooManyYears: 8, textYears });
  const keptIds = kept.map((x) => x.title.slice(4)).join();
  const why = Object.fromEntries(dropped.map((d) => [d.row.title.slice(4), d.why]));
  if (keptIds === '1,3,4,5,8') pass('applyScores() keeps go and stretch jobs, drops no-go');
  else fail(`kept ${keptIds}; dropped ${JSON.stringify(why)}`);
  if (why[2] === 'waiting for the model' && why[6] === 'model: no-go'
      && why[7] === 'asks 8+ years (model)' && why[9] === 'asks 8+ years') {
    pass('each drop says why: waiting, no-go, years from the model or the text');
  } else fail(`why = ${JSON.stringify(why)}`);
  const k = Object.fromEntries(kept.map((x) => [x.title.slice(4), x]));
  if (k[1].tier === 'go' && k[1].fit === undefined && k[3].tier === 'go' && k[4].tier === 'stretch' && k[5].tier === 'stretch'
      && k[3].score === 11.4 && k[5].score === 8.6 && k[3].factors.role === 5) {
    pass('each kept job carries its tier; the overall replaces the role-word points (overall − 2)');
  } else fail(`kept = ${JSON.stringify(kept.map((x) => [x.title, x.tier, x.score, x.fit]))}`);
  const order = [
    { title: 'stretch, high score', route: 'apply-here', tier: 'stretch', score: 50 },
    { title: 'go, low score', route: 'apply-here', tier: 'go', score: 1 },
    { title: 'go, not scheduled', route: 'linkedin-lead', tier: 'go', score: 99 },
    { title: 'go, high score', route: 'apply-here', tier: 'go', score: 9 },
  ].sort(rankOrder).map((x) => x.title);
  if (order.join() === 'go, high score,go, low score,stretch, high score,go, not scheduled') {
    pass('the night list ranks scheduled first, then every go job before any stretch job, then score');
  } else fail(`order = ${order.join(' | ')}`);

  // ---- posting text fetch ----------------------------------------------------------
  const { jobPostingText, linkedinPostingText, fetchPostingText } = await load('lib/posting-fetch.mjs');
  const hwPage = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},
    {"@type":"JobPosting","title":"Ingénieur Sysops","description":"<p>Vous avez <b>5 ans d'expérience</b> sur Linux.</p>"}]}</script></head><body>menu 30 ans</body></html>`;
  if (jobPostingText(hwPage) === "Vous avez 5 ans d'expérience sur Linux." && jobPostingText('<html>no ld</html>') === null) {
    pass('jobPostingText() reads the JobPosting description from JSON-LD, nothing else on the page');
  } else fail(`jobPostingText = ${JSON.stringify(jobPostingText(hwPage))}`);
  const li = readFileSync(join(ROOT, 'tests/fixtures/linkedin-guest-live-onsite.html'), 'utf8');
  if (/Own reporting end to end/.test(linkedinPostingText(li) || '') && linkedinPostingText('<html></html>') === null) {
    pass('linkedinPostingText() reads the guest page\'s description block');
  } else fail(`linkedinPostingText = ${JSON.stringify(linkedinPostingText(li))}`);

  const asked = [];
  const fetchImpl = async (u) => { asked.push(u); return { ok: true, text: async () => (u.includes('linkedin') ? li : hwPage) }; };
  const throttle = async () => 0;
  const a = await fetchPostingText('https://www.hellowork.com/fr-fr/emplois/82647998.html', { fetchImpl, throttle });
  const b = await fetchPostingText('https://www.linkedin.com/jobs/view/devops-engineer-at-acme-4012345678', { fetchImpl, throttle });
  const w = await fetchPostingText('https://www.welcometothejungle.com/en/companies/acme/jobs/cloud-engineer_toulouse', { fetchImpl, throttle });
  const c = await fetchPostingText('https://evil.example.com/job/1', { fetchImpl, throttle });
  const d = await fetchPostingText('http://www.hellowork.com/fr-fr/emplois/1.html', { fetchImpl, throttle });
  if (/5 ans/.test(a) && /Own reporting/.test(b) && /5 ans/.test(w) && c === null && d === null
      && asked.length === 3 && asked[1] === 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678') {
    pass('fetchPostingText() reads HelloWork, WTJ (JSON-LD) and LinkedIn (guest endpoint) only, over https');
  } else fail(`fetch = ${JSON.stringify({ a, b, w, c, d, asked })}`);
} catch (err) {
  fail(`night-list model suite crashed: ${err.message}`);
}
