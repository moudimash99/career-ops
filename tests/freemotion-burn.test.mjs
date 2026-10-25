// tests/freemotion-burn.test.mjs — freemotion-night/burn.mjs: when each driver may apply, so the
// allowances are used without eating into the account the user works on (user, 2026-10-19). Offline.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nburn — applications on every allowance, the user\'s account on schedule');

const B = await import(pathToFileURL(join(ROOT, 'freemotion-night/burn.mjs')).href);
const s = { ...B.DEFAULTS, work: { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' } };
// Paris is UTC+2 until 2026-10-25.
const at = (iso) => Date.parse(`${iso}+02:00`);
const week = { weekPct: 50, weekReset: at('2026-10-20T16:00') };
const win = (pct, reset = '2026-10-19T19:40') => ({ fivePct: pct, fiveReset: at(reset), ...week });
const check = (label, got, allow) => (got.allow === allow ? pass(label) : fail(`${label}: ${got.allow} (${got.why})`));

// Monday, window resets 19:40, work ends 18:00: 90% left needs 3 h 10 with the margin.
check('working hours, on schedule: apply', B.decide({ now: at('2026-10-19T16:30'), win: win(10), s }), true);
check('working hours, too early: wait', B.decide({ now: at('2026-10-19T15:00'), win: win(10), s }), false);
check('the user works too, ahead of schedule: pause', B.decide({ now: at('2026-10-19T16:30'), win: win(50), s, active: true }), false);
check('a little ahead while applying: go on', B.decide({ now: at('2026-10-19T16:30'), win: win(15), s, active: true }), true);
check('after 18:00 the schedule is off', B.decide({ now: at('2026-10-19T18:30'), win: win(50), s, active: true }), true);
const later = B.decide({ now: at('2026-10-19T15:00'), win: win(50), s });
if (!later.allow && Math.abs(later.until - at('2026-10-19T17:50')) < 60_000) pass('at 50% the start moves to 1 h 50 before the reset');
else fail(`start at 50%: ${JSON.stringify(later)}`);
check('a fresh window in working hours is the user\'s', B.decide({ now: at('2026-10-20T10:45'), win: win(0, '2026-10-20T15:45'), s, active: true }), false);

// Buffer: in working hours applications stop at 100 - buffer.
check('working hours: the buffer is the user\'s', B.decide({ now: at('2026-10-19T17:00'), win: win(91), s, active: true }), false);
if (B.capAt(at('2026-10-19T19:00'), at('2026-10-19T19:40'), s) === 100) pass('an evening window may go to 100%'); else fail('evening cap');

// Night: at once, but a window still open at 09:00 keeps the buffer.
check('night: at once', B.decide({ now: at('2026-10-20T00:45'), win: win(0, '2026-10-20T05:40'), s }), true);
if (B.capAt(at('2026-10-20T06:00'), at('2026-10-20T10:40'), s) === 90) pass('a window open when work starts keeps the buffer'); else fail('morning cap');
check('weekend: no working hours', B.decide({ now: at('2026-10-24T14:00'), win: win(0, '2026-10-24T18:00'), s }), true);
const reset = B.decide({ now: at('2026-10-19T19:45'), win: win(100), s });
if (!reset.allow && reset.read) pass('a window past its reset is read again'); else fail(`after the reset: ${JSON.stringify(reset)}`);

// The week: keep week_keep% unless the week resets within week_free_hours.
const far = { fivePct: 0, fiveReset: at('2026-10-21T05:00'), weekPct: 86, weekReset: at('2026-10-27T16:00') };
check('week kept for the user', B.decide({ now: at('2026-10-21T01:00'), win: far, s }), false);
check('last day of the week: use it', B.decide({ now: at('2026-10-27T01:00'), win: { ...far, fiveReset: at('2026-10-27T05:00') }, s }), true);

// Copilot: 200 credits a month, spread evenly.
const nov = { entitlement: 200, resetMs: Date.parse('2026-12-01T00:00:00Z'), perJob: 10 };
if (B.monthlyGate({ ...nov, now: Date.parse('2026-11-16T00:00:00Z'), used: 80 }).allow) pass('copilot: under its share of the month, apply'); else fail('copilot under share');
const over = B.monthlyGate({ ...nov, now: Date.parse('2026-11-04T00:00:00Z'), used: 40 });
// 40 + 10 of 200 credits = a quarter of November: the 8th at noon.
if (!over.allow && over.until === Date.parse('2026-11-08T12:00:00Z')) pass('copilot: ahead of the month, wait for its share');
else fail(`copilot over share: ${JSON.stringify(over)}`);
if (!B.monthlyGate({ ...nov, resetMs: Date.parse('2026-11-01T00:00:00Z'), now: Date.parse('2026-10-19T16:00:00Z'), used: 200 }).allow) pass('copilot: month used up, wait for the reset'); else fail('copilot used up');

// Order: the week that resets soonest first; unknown resets keep the listed order, after.
const o = B.order(['sonnet1', 'agy', 'agy-sonnet', 'sonnet', 'codex', 'copilot'], { sonnet1: at('2026-10-20T16:00'), agy: at('2026-10-24T00:02'), 'agy-sonnet': at('2026-10-25T18:29'), sonnet: at('2026-10-25T01:00') });
if (o.join(' ') === 'sonnet1 agy sonnet agy-sonnet codex copilot') pass('drivers: the allowance lost soonest first'); else fail(`order: ${o.join(' ')}`);

// Left alone until a date (account2 until Thursday), and account1 gone after Tuesday 16:00.
const s2 = { ...s, not_before: { sonnet: '2026-10-22T00:00:00+02:00' } };
const resets = { sonnet1: at('2026-10-20T16:00'), agy: at('2026-10-24T00:02'), sonnet: at('2026-10-25T01:00') };
const mon = B.roundPlan(s2, at('2026-10-19T17:00'), resets);
if (mon.second === '.claude-account1' && !mon.docsWriters && mon.drivers.includes('sonnet')) pass('Monday: account1 writes, account2 stays in the order but paused');
else fail(`Monday plan: ${JSON.stringify(mon)}`);
const wed = B.roundPlan(s2, at('2026-10-21T10:00'), resets);
if (!wed.drivers.includes('sonnet1') && wed.docsWriters && !wed.docsWriters.includes('sonnet1')) pass('Wednesday: no Claude account at all, not even for CVs and letters');
else fail(`Wednesday plan: ${JSON.stringify(wed)}`);
const thu = B.roundPlan(s2, at('2026-10-22T08:00'), resets);
if (thu.second === '.claude-account2' && !thu.docsWriters && B.usableAt('sonnet', at('2026-10-22T08:00'), s2)) pass('Thursday: account2 is used again');
else fail(`Thursday plan: ${JSON.stringify(thu)}`);

// Codex: last resort, and only while it keeps its reserve (it writes about half the CVs).
if (thu.drivers.at(-1) === 'codex') pass('codex comes after every other driver'); else fail(`codex place: ${thu.drivers.join(' ')}`);
const res = { week: 50, five_hour: 30 };
const lim = (five, week) => ({ fivePct: five, fiveReset: at('2026-10-19T20:00'), weekPct: week, weekReset: at('2026-10-22T13:00') });
if (B.reserveGate({ now: at('2026-10-19T18:00'), limits: lim(20, 30), reserve: res }).allow) pass('codex above its reserve: may apply'); else fail('codex above reserve');
if (!B.reserveGate({ now: at('2026-10-19T18:00'), limits: lim(20, 55), reserve: res }).allow) pass('codex past half its week: kept for CVs'); else fail('codex week reserve');
if (!B.reserveGate({ now: at('2026-10-19T18:00'), limits: lim(75, 10), reserve: res }).allow) pass('codex 5-hour window low: kept for CVs'); else fail('codex 5h reserve');
if (B.reserveGate({ now: at('2026-10-19T21:00'), limits: lim(75, 10), reserve: res }).allow) pass('a window past its reset counts as unused'); else fail('codex after reset');
if (!B.reserveGate({ now: at('2026-10-19T18:00'), limits: null, reserve: res }).allow) pass('no reading of codex: not used'); else fail('codex unknown');

// Account2: after codex, only in the last hours of its week, and never as the CV/letter writer.
const s3 = { ...s, drivers: ['sonnet1', 'agy', 'codex', 'sonnet'], last_resort: ['codex', 'sonnet'] };
const fri = B.roundPlan(s3, at('2026-10-23T22:00'), resets);
if (fri.drivers.join(' ') === 'agy codex sonnet') pass('account2 comes after codex'); else fail(`account2 place: ${fri.drivers.join(' ')}`);
if (fri.docsWriters && !fri.docsWriters.includes('sonnet1')) pass('a last-resort account writes no CVs or letters'); else fail(`account2 writer: ${JSON.stringify(fri)}`);
const end = { week: 0, five_hour: 0, last_hours: 24 };
const early = B.reserveGate({ now: at('2026-10-21T12:00'), limits: lim(0, 20), reserve: end });
if (!early.allow && early.until === at('2026-10-21T13:00')) pass('account2 kept until the last 24 h of its week'); else fail(`account2 early: ${JSON.stringify(early)}`);
if (B.reserveGate({ now: at('2026-10-21T14:00'), limits: { ...lim(0, 20), fiveReset: at('2026-10-21T18:00') }, reserve: end }).allow) pass('account2 burns in its last 24 h'); else fail('account2 near the end');
if (!B.reserveGate({ now: at('2026-10-21T14:00'), limits: { ...lim(0, 100), fiveReset: at('2026-10-21T18:00') }, reserve: end }).allow) pass('account2 stops at a full week'); else fail('account2 full week');
if (!B.reserveGate({ now: at('2026-10-22T14:00'), limits: lim(0, 20), reserve: end }).allow) pass('account2 after its week reset: read again first'); else fail('account2 after reset');

// Burn (user, 2026-10-25): kept for CVs and letters, and only what would go unused is applied with, so the
// week ends near 100% at its reset. 60% left at 6 min per % plus 60 min = 7 h before the reset.
const burnRule = { minutes_per_pct: 6, margin_minutes: 60 };
const wk = (used, resetIso) => ({ weekPct: used, weekReset: at(resetIso), fivePct: 0, fiveReset: at('2026-10-27T10:00') });
const kept = B.burnGate({ now: at('2026-10-27T05:00'), limits: wk(40, '2026-10-27T13:00'), rule: burnRule });
if (!kept.allow && kept.until === at('2026-10-27T06:00')) pass('burn: kept for writing until the rest just fits before the reset');
else fail(`burn early: ${JSON.stringify(kept)}`);
check('burn: in its last hours, applies', B.burnGate({ now: at('2026-10-27T06:30'), limits: wk(40, '2026-10-27T13:00'), rule: burnRule }), true);
check('burn: CVs used more of the week, so it starts later', B.burnGate({ now: at('2026-10-27T06:30'), limits: wk(80, '2026-10-27T13:00'), rule: burnRule }), false);
check('burn: a used-up week waits for the reset', B.burnGate({ now: at('2026-10-27T12:00'), limits: wk(100, '2026-10-27T13:00'), rule: burnRule }), false);
check('burn: no reading, not used', B.burnGate({ now: at('2026-10-27T12:00'), limits: null, rule: burnRule }), false);

// One rule per driver; the old lists are read as rules.
const R = await import(pathToFileURL(join(ROOT, 'lib/driver-rules.mjs')).href);
const old = { drivers: ['sonnet1', 'agy', 'codex', 'copilot', 'sonnet'], scheduled: { sonnet1: { until: '2026-10-20T16:00:00+02:00' } }, monthly: ['copilot'], last_resort: ['codex', 'sonnet'], reserve: { codex: { week: 50, five_hour: 30 }, sonnet: { week: 0, five_hour: 0, last_hours: 24 } } };
const m = R.migrate(old);
const kinds = m.drivers.map((d) => m.rules[d].kind).join(' ');
if (kinds === 'schedule full reserve monthly burn' && !m.last_resort && !m.scheduled) pass('old settings become one rule per driver'); else fail(`migrate: ${kinds}`);
if (R.checkRule({ kind: 'burn', minutes_per_pct: 0, margin_minutes: 10 }).error && R.checkRule({ kind: 'reserve', week: 20, five_hour: 10 }).rule) pass('rules from the dashboard are checked');
else fail('checkRule');
const ruled = { ...s, drivers: ['agy', 'codex', 'copilot'], rules: { agy: { kind: 'burn' }, codex: { kind: 'full' }, copilot: { kind: 'monthly' } } };
if (B.roundPlan(ruled, at('2026-10-26T10:00'), {}).drivers.join(' ') === 'codex copilot agy') pass('a burn driver comes after the others, whatever its name'); else fail(`rule order: ${B.roundPlan(ruled, at('2026-10-26T10:00'), {}).drivers.join(' ')}`);
