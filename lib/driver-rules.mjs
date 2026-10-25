/**
 * lib/driver-rules.mjs — each driver's rule for taking jobs, read the same way by burn.mjs (which applies
 * the rules), hub-records.mjs (which shows them) and hub-agent.mjs (which saves them from the dashboard).
 *
 * data/burn-settings.json "rules": { <driver>: { kind, ...its numbers } }, one kind per driver:
 *   full      takes jobs until its own limit; run.sh hands the job on when it hits one.
 *   burn      kept for writing CVs and letters, but what would go unused is applied with (user, 2026-10-25):
 *             it starts when the rest of its week, at `minutes_per_pct` minutes of applying per % of the
 *             week, plus `margin_minutes`, just fits before the week resets. So the week ends near 100%
 *             and everything before that stays for writing. Measured: codex about 6 min per %
 *             (an application ~1.5% of its week), a Claude account about 37 (its 5-hour window caps it
 *             at ~8% of the week per 5 hours).
 *   reserve   takes jobs while it keeps `week`% of its week and `five_hour`% of its 5 hours.
 *   monthly   spreads its monthly credits evenly over the month, `credits_per_job` a job.
 *   schedule  an account the user works on: in working hours only on schedule, until `until`.
 * Burn and reserve drivers come after the others in a round. Besides its rule, a driver can wait for a
 * date (`not_before`) or be turned off (`off`).
 *
 * Settings written before "rules" (scheduled, monthly, last_resort, reserve) are read as rules too.
 */

export const KINDS = {
  full: 'Full allowance',
  burn: 'Burn what is left',
  reserve: 'Keep a reserve',
  monthly: 'Spread over the month',
  schedule: 'On schedule',
};
const BURN = { codex: { minutes_per_pct: 6, margin_minutes: 60 }, sonnet: { minutes_per_pct: 37, margin_minutes: 60 }, sonnet1: { minutes_per_pct: 37, margin_minutes: 60 } };
const BURN_ANY = { minutes_per_pct: 20, margin_minutes: 60 };

/** Driver `d`'s rule from the settings, with every number filled in. */
export function ruleOf(s, d) {
  const r = s.rules?.[d];
  if (r && KINDS[r.kind]) return fill(r, d, s);
  if (s.scheduled?.[d]) return fill({ kind: 'schedule', until: s.scheduled[d].until }, d, s);
  if ((s.monthly || []).includes(d)) return fill({ kind: 'monthly' }, d, s);
  if ((s.last_resort || []).includes(d)) {
    const rsv = s.reserve?.[d] || {};
    return rsv.last_hours ? fill({ kind: 'burn' }, d, s) : fill({ kind: 'reserve', week: rsv.week, five_hour: rsv.five_hour }, d, s);
  }
  return { kind: 'full' };
}
function fill(r, d, s) {
  if (r.kind === 'burn') return { kind: 'burn', ...(BURN[d] || BURN_ANY), ...pick(r, ['minutes_per_pct', 'margin_minutes']) };
  if (r.kind === 'reserve') return { kind: 'reserve', week: r.week ?? 50, five_hour: r.five_hour ?? 30 };
  if (r.kind === 'monthly') return { kind: 'monthly', credits_per_job: r.credits_per_job ?? s.credits_per_job ?? 10 };
  if (r.kind === 'schedule') return { kind: 'schedule', until: r.until || null };
  return { kind: 'full' };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

/** Burn and reserve drivers come after every other driver in a round. */
export const comesLast = (s, d) => ['burn', 'reserve'].includes(ruleOf(s, d).kind);

/** A rule as the dashboard sends it, checked: the rule to save, or an error. */
export function checkRule(r) {
  if (!r || !KINDS[r.kind]) return { error: 'Unknown rule' };
  const int = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  if (r.kind === 'burn') {
    if (!int(r.minutes_per_pct, 1, 240)) return { error: 'Minutes per %: 1 to 240' };
    if (!int(r.margin_minutes, 0, 1440)) return { error: 'Margin: 0 to 1440 minutes' };
    return { rule: { kind: 'burn', minutes_per_pct: Number(r.minutes_per_pct), margin_minutes: Number(r.margin_minutes) } };
  }
  if (r.kind === 'reserve') {
    if (!int(r.week, 0, 90) || !int(r.five_hour, 0, 90)) return { error: 'Reserves: 0 to 90%' };
    return { rule: { kind: 'reserve', week: Number(r.week), five_hour: Number(r.five_hour) } };
  }
  if (r.kind === 'monthly') {
    if (!int(r.credits_per_job, 1, 100)) return { error: 'Credits a job: 1 to 100' };
    return { rule: { kind: 'monthly', credits_per_job: Number(r.credits_per_job) } };
  }
  if (r.kind === 'schedule') {
    if (r.until && Number.isNaN(Date.parse(r.until))) return { error: 'The end date is not valid' };
    return { rule: { kind: 'schedule', until: r.until || null } };
  }
  return { rule: { kind: 'full' } };
}

/** The settings with every listed driver's rule written out under "rules" and the old keys gone. */
export function migrate(s) {
  const rules = Object.fromEntries((s.drivers || []).map((d) => [d, ruleOf(s, d)]));
  const out = { ...s, rules };
  for (const k of ['scheduled', 'monthly', 'last_resort', 'reserve']) delete out[k];
  return out;
}
