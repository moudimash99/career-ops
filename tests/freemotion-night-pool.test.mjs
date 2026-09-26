// tests/freemotion-night-pool.test.mjs — the night-list rules and merge
// (freemotion-night/pool-rules.mjs, make-pool.mjs, site-review.mjs).
//
// Pinned here: the matching keys follow the word lists the user approved on
// 2026-09-24 exactly (whole words only, no truncation), the apply routes, the
// merge keeping the easiest place to apply, the site blacklist and the weekly
// review's suggestion rule. All offline and pure.
import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-night — pool rules, routes, merge, site review');

const load = (p) => import(pathToFileURL(join(ROOT, p)).href);

try {
  const { titleKey, companyKey, placeFlags, judge, capPerCompany } = await load('freemotion-night/pool-rules.mjs');
  const { linkKey, routeOf, mergeSameJobs, parseSiteBlacklist, isBlockedSite, SCHEDULED } = await load('freemotion-night/make-pool.mjs');
  const { tallySites } = await load('freemotion-night/site-review.mjs');

  // ---- title key ---------------------------------------------------------
  const same = ['Ingénieur DevOps (H/F)', 'Ingénieur DevOps F/H', 'Ingénieur DevOps - Toulouse (31) - CDI', 'INGENIEUR DEVOPS H/F/X'].map(titleKey);
  if (same.every((k) => k === 'ingenieur devops')) pass('titleKey() removes accents, gender markers, CDI, listed cities and (31)');
  else fail(`titleKey variants = ${JSON.stringify(same)}`);
  if (titleKey('Développeur Cdiscount data') === 'developpeur cdiscount data') pass('titleKey() removes "cdi" only as a whole word (Cdiscount survives)');
  else fail(`cdiscount = ${titleKey('Développeur Cdiscount data')}`);
  if (titleKey('DevOps Engineer') !== titleKey('Ingénieur DevOps')) pass('titleKey() does not treat different words as the same title');
  else fail('different wording must not match');
  if (titleKey('Data Engineer Montpellier') === 'data engineer montpellier') pass('titleKey() leaves a city that is not on the list');
  else fail(`unlisted city = ${titleKey('Data Engineer Montpellier')}`);

  // ---- company key -------------------------------------------------------
  if (companyKey('SOPRA STERIA GROUP') === companyKey('Sopra Steria') && companyKey('ALTEN SA') === 'alten') pass('companyKey() removes only the listed legal-form words');
  else fail(`company keys = ${companyKey('SOPRA STERIA GROUP')} / ${companyKey('Sopra Steria')} / ${companyKey('ALTEN SA')}`);
  if (companyKey('IT Link') === 'itlink' && companyKey('CGI France') === 'cgifrance' && companyKey('Capgemini Engineering') !== companyKey('Capgemini Invent')) {
    pass('companyKey() keeps "it"/"france" and never truncates');
  } else fail(`kept words / truncation: ${companyKey('IT Link')} ${companyKey('CGI France')}`);

  // ---- places ------------------------------------------------------------
  const pl = ['Toulouse - 31', '31 - LABEGE', 'Paris 16 - 75', '92 - Suresnes', 'Lyon 3e - 69', 'Montpellier (34)'].map(placeFlags);
  if (pl[0].toulouse && pl[1].toulouse && pl[2].paris && pl[3].paris && !pl[4].toulouse && !pl[4].paris && !pl[5].toulouse) pass('placeFlags() reads Toulouse / Paris from the listed places and department numbers only');
  else fail(`places = ${JSON.stringify(pl)}`);

  // ---- judge -------------------------------------------------------------
  const J = (title, extra = {}) => judge({ title, co: 'X', loc: 'Toulouse - 31', ageDays: 2, ...extra });
  if (J('Développeur Frontend React H/F').why === 'frontend' && J('Angular Developer').why === 'frontend') pass('judge() drops frontend titles');
  else fail('frontend must be dropped');
  if (J('Full Stack Developer').ok) pass('judge() keeps full-stack');
  else fail('full-stack must stay');
  if (J('Ingénieur DevOps', { ageDays: 20 }).why === 'older than 14 days' && J('Director of DevOps').why === 'seniority' && J('Stage DevOps').ok === false) pass('judge() drops old postings, directors and internships');
  else fail('age / seniority / internship rules');
  if (J('Lead DevOps').ok && J('DevOps Manager').ok && J('Responsable Data Platform').ok) pass('judge() keeps lead, manager and responsable titles');
  else fail(`lead/manager/responsable = ${JSON.stringify([J('Lead DevOps'), J('DevOps Manager'), J('Responsable Data Platform')])}`);
  if (J('Technicien Cloud Azure').why === 'non-fit word, needs the model' && J('Comptable').why === 'non_fit') pass('judge() leaves a non-fit word next to a role word to the model');
  else fail(`non-fit = ${JSON.stringify([J('Technicien Cloud Azure'), J('Comptable')])}`);
  if (J('Java Developer').ok && J('Java Developer').fields.offstack) pass('judge() keeps Java but marks it off-stack (ranked low)');
  else fail('Java should be kept and ranked low');
  if (capPerCompany(Array.from({ length: 6 }, (_, i) => ({ co: i < 5 ? 'ACME SAS' : 'Other', title: `t${i}` }))).length === 5) pass('capPerCompany() keeps 4 per company key');
  else fail('cap per company');

  // ---- routes ------------------------------------------------------------
  const r = (source, url, apec) => routeOf({ source, url }, apec);
  const APEC = 'https://www.apec.fr/candidat/recherche-emploi.html/emploi/detail-offre/1W';
  const routes = [
    r('hellowork', 'https://www.hellowork.com/fr-fr/emplois/1.html').route,
    r('linkedin', 'https://www.linkedin.com/jobs/view/1').route,
    r('francetravail', 'https://fr.linkedin.com/jobs/view/x').route,
    r('freework', 'https://www.free-work.com/fr/tech-it/x/job-mission/y').route,
    r('freework', 'https://careers.acme.test/1').route,
    r('francetravail', 'https://candidat.francetravail.fr/offres/recherche/detail/1').route,
    r('apec', APEC).route,
    r('apec', APEC, { applyType: 'EMAIL_ONLY' }).route,
  ];
  if (JSON.stringify(routes) === JSON.stringify(['apply-here', 'linkedin-lead', 'linkedin-lead', 'freework-account', 'apply-here', 'francetravail-page', 'apec-unrouted', 'apec-account'])) {
    pass('routeOf() maps each source and link to its apply route (any LinkedIn link is a lead)');
  } else fail(`routes = ${JSON.stringify(routes)}`);
  const partner = r('apec', APEC, { applyType: 'URL_ONLY', applyUrl: 'https://www.hellowork.com/fr-fr/emplois/9.html?utm_campaign=x' });
  if (partner.route === 'apply-here' && partner.url.startsWith('https://www.hellowork.com') && partner.apecUrl === APEC) pass('an APEC partner job goes straight to the partner link, keeping the APEC link');
  else fail(`partner = ${JSON.stringify(partner)}`);
  if ('drop' in r('apec', APEC, { gone: true })) pass('a gone APEC posting is dropped');
  else fail('gone APEC posting must drop');
  if (JSON.stringify([...SCHEDULED].sort()) === JSON.stringify(['apec-account', 'apply-here', 'freework-account'])) pass('only apply-here, apec-account and freework-account are scheduled');
  else fail(`scheduled set = ${JSON.stringify([...SCHEDULED])}`);

  // ---- merge -------------------------------------------------------------
  if (linkKey('https://www.hellowork.com/fr-fr/emplois/9.html?utm_campaign=x') === linkKey('https://hellowork.com/fr-fr/emplois/9.html')) pass('linkKey() matches HelloWork by job number');
  else fail('HelloWork link key');
  if (linkKey('https://jobs.test/a?utm_source=x&id=3') === linkKey('https://jobs.test/a/?id=3')) pass('linkKey() drops tracking parameters and a trailing slash');
  else fail('tracking parameters');
  const row = (source, route, co, title, url, score, extra = {}) => ({ source, route, co, title, url, score, seenOn: [source], ...extra });
  const { kept, merges } = mergeSameJobs([
    row('linkedin', 'linkedin-lead', 'Sopra Steria', 'Ingénieur DevOps H/F', 'https://www.linkedin.com/jobs/view/1', 9),
    row('hellowork', 'apply-here', 'SOPRA STERIA GROUP', 'Ingénieur DevOps (F/H)', 'https://www.hellowork.com/fr-fr/emplois/5.html', 3),
    row('apec', 'apply-here', 'Hellowork', 'Ingénieur Infra', 'https://www.hellowork.com/fr-fr/emplois/7.html?utm_campaign=apec', 8, { apecUrl: APEC }),
    row('hellowork', 'apply-here', 'SOPHIA ENGINEERING', 'Ingénieur Infrastructure H/F', 'https://www.hellowork.com/fr-fr/emplois/7.html', 2),
    row('wttj', 'apply-here', 'Other', 'Ingénieur DevOps', 'https://www.welcometothejungle.com/x', 5),
  ]);
  const keptUrls = kept.map((k) => k.url).sort();
  if (kept.length === 3 && merges.length === 2) pass('mergeSameJobs() merges by apply link and by company + title');
  else fail(`kept ${kept.length}, merges ${merges.length}: ${JSON.stringify(keptUrls)}`);
  const devops = kept.find((k) => k.co === 'SOPRA STERIA GROUP');
  if (devops && devops.source === 'hellowork' && devops.seenOn.includes('linkedin')) pass('the HelloWork copy wins over LinkedIn and records where else it was seen');
  else fail(`devops kept = ${JSON.stringify(devops)}`);
  const infra = kept.find((k) => /emplois\/7/.test(k.url));
  if (infra && infra.source === 'hellowork' && infra.co === 'SOPHIA ENGINEERING') pass("the APEC re-post merges into HelloWork's own copy (real employer name kept)");
  else fail(`infra kept = ${JSON.stringify(infra)}`);

  // ---- site blacklist and review ----------------------------------------
  const hosts = parseSiteBlacklist('| Site | Added | Reason |\n|---|---|---|\n| myworkdayjobs.com | 2026-09-30 | x |\n| https://www.icims.com/ | 2026-09-30 | y |\n| not a host | - | - |');
  if (JSON.stringify(hosts) === JSON.stringify(['myworkdayjobs.com', 'icims.com'])) pass('parseSiteBlacklist() reads hosts and skips header and junk rows');
  else fail(`hosts = ${JSON.stringify(hosts)}`);
  if (isBlockedSite('https://thales.wd3.myworkdayjobs.com/x', hosts) && !isBlockedSite('https://notmyworkdayjobs.com/x', hosts)) pass('isBlockedSite() covers subdomains, not look-alike names');
  else fail('subdomain matching');
  const now = Date.now();
  const tally = tallySites([
    { rawUrl: 'https://a.wd3.myworkdayjobs.com/1', outcome: 'validation-failed', timestamp: new Date(now).toISOString(), notes: 'x' },
    { rawUrl: 'https://b.wd1.myworkdayjobs.com/2', outcome: 'errored', timestamp: new Date(now).toISOString(), notes: 'y' },
    { rawUrl: 'https://jobs.lever.co/c/1', outcome: 'errored', timestamp: new Date(now).toISOString(), notes: '' },
    { rawUrl: 'https://jobs.lever.co/c/2', outcome: 'submitted', timestamp: new Date(now).toISOString(), notes: '' },
    { rawUrl: 'https://jobs.lever.co/c/3', outcome: 'errored', timestamp: new Date(now).toISOString(), notes: '' },
    { rawUrl: 'https://x.test/1', outcome: 'rehearsal', timestamp: new Date(now).toISOString(), notes: '' },
    { rawUrl: 'https://old.test/1', outcome: 'captcha', timestamp: new Date(now - 30 * 86_400_000).toISOString(), notes: '' },
  ], now - 7 * 86_400_000);
  const wd = tally.find((s) => s.site === 'myworkdayjobs.com');
  const lever = tally.find((s) => s.site === 'lever.co');
  if (wd?.suggest && wd.failed === 2 && lever && !lever.suggest && !tally.find((s) => s.site === 'x.test' || s.site === 'old.test')) {
    pass('tallySites() groups tenants, suggests 2+ failures with no success, ignores practice runs and old rows');
  } else fail(`tally = ${JSON.stringify(tally)}`);
} catch (err) {
  fail(`night-pool suite crashed: ${err.message}`);
}
