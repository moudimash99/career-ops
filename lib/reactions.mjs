/**
 * lib/reactions.mjs — how far each application got, from data/reactions.tsv.
 *
 * freemotion-night/inbox-replies.py writes the ledger: one row per reaction an employer had (read
 * from email by the Gemini API, or told by the user, e.g. a phone call). Columns:
 *   ref  num  date  level  company  role  source  who  summary  evidence  reply_needed  by  at
 * Levels, lowest first: viewed, contacted, call, assessment, interview, offer; "rejected" is kept
 * apart, so a call followed by a no still counts as reaching a call. Per email (ref), only the rows
 * of its latest reading count (`at`), and level "none" rows withdraw an earlier reading. The same
 * rule is effective() in inbox-replies.py.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export const REACTIONS = 'data/reactions.tsv';
export const COLUMNS = ['ref', 'num', 'date', 'level', 'company', 'role', 'source', 'who', 'summary', 'evidence', 'reply_needed', 'by', 'at'];
export const LEVELS = ['viewed', 'contacted', 'call', 'assessment', 'interview', 'offer'];
/** Rank of a level: 0 for none, rejected or unknown. */
export const rank = (level) => LEVELS.indexOf(level) + 1;
/** "Contacted or higher": a person reacted to the application. What the experiments count as a callback. */
export const isPositive = (level) => rank(level) >= rank('contacted');

/** The reactions that count, oldest first. */
export function parseReactions(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const c = line.split('\t');
    if (c.length < COLUMNS.length) continue;
    const r = Object.fromEntries(COLUMNS.map((k, i) => [k, c[i]]));
    r.num = /^\d+$/.test(r.num) ? Number(r.num) : null;
    r.reply_needed = r.reply_needed === 'yes';
    rows.push(r);
  }
  const last = new Map();
  for (const r of rows) if (!last.has(r.ref) || r.at > last.get(r.ref)) last.set(r.ref, r.at);
  return rows.filter((r) => r.at === last.get(r.ref) && r.level !== 'none').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function readReactions(root) {
  try { return parseReactions(readFileSync(join(root, REACTIONS), 'utf8')); } catch { return []; }
}

/** Per tracker row: { level (the highest reached, '' if none), rejected, reactions }. */
export function bestLevels(reactions) {
  const out = new Map();
  for (const r of reactions) {
    if (r.num == null) continue;
    const b = out.get(r.num) || { level: '', rejected: false, reactions: [] };
    b.reactions.push(r);
    if (r.level === 'rejected') b.rejected = true;
    else if (rank(r.level) > rank(b.level)) b.level = r.level;
    out.set(r.num, b);
  }
  return out;
}
