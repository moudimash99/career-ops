#!/usr/bin/env node

/**
 * freemotion-credentials.mjs — the local password store for sites that make
 * you register before they will show you an application form (Requirement 2).
 *
 * ORDERING IS THE WHOLE DESIGN. `saveCredentials` is called BEFORE the
 * registration form is submitted, never after. A password generated, typed
 * into a form, submitted, and only then written to disk is lost the moment
 * anything between those steps fails — and what is left behind is the worst
 * possible state: an account that exists on the employer's side with a
 * password that exists nowhere. Writing first can at worst leave a credential
 * for an account that was never created, which costs nothing.
 *
 * ONE FILE PER DOMAIN, NAMED BY HASH. The filename is a SHA-256 prefix of the
 * hostname, not the hostname itself, so a directory listing of `data/` does
 * not enumerate every employer the candidate has registered with. The domain
 * is stored in cleartext INSIDE the file — this is obfuscation of the listing,
 * not encryption, and the header says so plainly rather than implying a
 * security property the design does not have.
 *
 * THE EMAIL IS ALWAYS THE CANDIDATE'S REAL ONE, never a throwaway. The
 * verification link is read out of that inbox by `freemotion-inbox.mjs`
 * (Phase 9) and has to stay readable by a human as well; an address the
 * candidate cannot reach turns a recoverable `account-verification-pending`
 * into a dead account.
 *
 * `data/freemotion-credentials/` is already gitignored under the `data/`
 * prefix and covered by USER_PATHS. Nothing here is ever committed.
 *
 * Usage:
 *   node lib/freemotion-credentials.mjs load --domain <hostname> [--root <path>]
 *   node lib/freemotion-credentials.mjs generate --domain <hostname> --email <e> [--root <path>]
 *   node lib/freemotion-credentials.mjs save --domain <hostname> --email <e> [--root <path>]
 *     (an account made by hand: the password is read from stdin, never from
 *     the command line, so it stays out of shell history and `ps`)
 */

import { createHash, randomInt } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';

import { flagValue, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { writeFileAtomic } from '../tracker-utils.mjs';

/** Directory holding the per-domain credential files, relative to the data root. */
export const CREDENTIALS_RELATIVE_DIR = 'data/freemotion-credentials';

/**
 * Character classes a generated password draws from.
 *
 * Split into four so {@link generatePassword} can GUARANTEE one of each rather
 * than hope: a policy validator rejecting the password mid-registration costs a
 * retry loop on a page the run has already half-filled, and some of those
 * validators only reveal the rule after the failure.
 *
 * The symbol set is deliberately narrow. `<`, `>`, `&`, `"`, `'` and backslash
 * are omitted because these passwords are typed into web forms and echoed
 * through ATS backends of unknown quality; a password that survives generation
 * but breaks the form it is typed into is not a password.
 */
const CHARSETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digit: '23456789',
  symbol: '!#$%*+-=?@^_',
};

/** Minimum length that still satisfies the four-class guarantee. */
const MIN_PASSWORD_LENGTH = 4;

/**
 * Path of the credential file for one domain.
 *
 * @param {string} domain - Hostname only, e.g. `"boards.greenhouse.io"`.
 *   Lowercased before hashing so `Boards.Greenhouse.io` and
 *   `boards.greenhouse.io` are one site, not two.
 * @param {{root?: string}} [options]
 * @returns {string}
 */
export function credentialsPath(domain, { root } = {}) {
  const hash = createHash('sha256').update(String(domain ?? '').toLowerCase()).digest('hex').slice(0, 16);
  const base = root ?? getCareerOpsRoot();
  const dir = isAbsolute(CREDENTIALS_RELATIVE_DIR) ? CREDENTIALS_RELATIVE_DIR : join(base, CREDENTIALS_RELATIVE_DIR);
  return join(dir, `${hash}.json`);
}

/**
 * Load the stored credential for a domain.
 *
 * @param {string} domain - Hostname only.
 * @param {{root?: string}} [options]
 * @returns {{domain: string, email: string, password: string, createdAt: string}|null}
 *   `null` when nothing was ever stored for this domain.
 * @throws {Error} On an unreadable or corrupt file. Deliberately NOT folded
 *   into `null`: "no account here" and "the account's password is unreadable"
 *   lead to opposite actions, and returning `null` for the second would make
 *   the caller register a duplicate account on a site it already has one on.
 */
export function loadCredentials(domain, { root } = {}) {
  const path = credentialsPath(domain, { root });
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`corrupt credential file ${path}: ${err.message}`);
  }
}

/**
 * Store the credential for a domain, overwriting any previous one.
 *
 * Atomic (`writeFileAtomic`): a torn write here leaves a JSON file that
 * {@link loadCredentials} throws on, which blocks the site permanently until
 * a human deletes it.
 *
 * @param {string} domain - Hostname only.
 * @param {{email: string, password: string}} credentials
 * @param {{root?: string}} [options]
 * @returns {{domain: string, email: string, password: string, createdAt: string}} What was written.
 */
export function saveCredentials(domain, { email, password }, { root } = {}) {
  const path = credentialsPath(domain, { root });
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    domain: String(domain ?? '').toLowerCase(),
    email,
    password,
    createdAt: new Date().toISOString(),
  };
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Generate a random password that satisfies a typical registration policy on
 * the first try.
 *
 * `crypto.randomInt` rather than `Math.random`: these protect real accounts on
 * real employer systems, and `randomInt` is also free of the modulo bias a
 * hand-rolled `randomBytes() % n` introduces.
 *
 * @param {{length?: number}} [options] - Default 20. Values below
 *   {@link MIN_PASSWORD_LENGTH} are raised to it, because the four-class
 *   guarantee cannot be met in fewer characters and silently returning a
 *   3-character password would be worse than ignoring the argument.
 * @returns {string}
 */
export function generatePassword({ length = 20 } = {}) {
  const size = Math.max(MIN_PASSWORD_LENGTH, Math.trunc(length) || 0);
  const classes = Object.values(CHARSETS);
  const all = classes.join('');

  // One guaranteed character per class first, then fill, then shuffle — so the
  // guaranteed ones are not always in positions 0..3, which some validators
  // (and any human reading a list of them) would notice.
  const chars = classes.map((set) => set[randomInt(set.length)]);
  while (chars.length < size) chars.push(all[randomInt(all.length)]);

  // Fisher-Yates, unbiased.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const USAGE = `Usage:
  node lib/freemotion-credentials.mjs load --domain <hostname> [--root <path>]
  node lib/freemotion-credentials.mjs generate --domain <hostname> --email <email> [--length N] [--root <path>]
  node lib/freemotion-credentials.mjs save --domain <hostname> --email <email> [--root <path>]

load     prints the stored credential JSON, or {"found": false} (exit 0 either way)
generate creates AND SAVES a new password for the domain, then prints it
save     stores the password of an account you made yourself; it is read from
         stdin (typed, hidden, or piped), never passed as an argument

Always run generate BEFORE submitting a registration form, never after.`;

const VALUE_FLAGS = ['--domain', '--email', '--length', '--root'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

/**
 * Read one password from stdin: typed with the echo off on a terminal, or the
 * first line of piped input. Trailing newline removed, nothing else trimmed —
 * a password may legitimately start or end with a space.
 *
 * @returns {Promise<string>}
 */
async function readPassword() {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += chunk;
    return text.split(/\r?\n/)[0];
  }
  process.stderr.write('Password (hidden): ');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  let out = '';
  try {
    for await (const chunk of stdin) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return out;
        if (ch === '\u0003') throw new Error('cancelled');
        if (ch === '\u007f' || ch === '\b') out = out.slice(0, -1);
        else out += ch;
      }
    }
    return out;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write('\n');
  }
}

/**
 * CLI entry: `load`, `generate` or `save`.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  const flags = command ? argv.slice(1) : argv;
  validateFlags(flags, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const domain = flagValue(flags, '--domain');
  const root = flagValue(flags, '--root');
  if (!command || !domain) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (command === 'load') {
    const found = loadCredentials(domain, { root });
    console.log(JSON.stringify(found ?? { found: false, domain }, null, 2));
    return;
  }

  if (command === 'generate') {
    const email = flagValue(flags, '--email');
    if (!email) {
      console.error('generate requires --email (the candidate\'s real address — see config/profile.yml candidate.email)');
      process.exitCode = 1;
      return;
    }
    const rawLength = flagValue(flags, '--length');
    const length = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    const password = generatePassword(length === undefined ? {} : { length });
    console.log(JSON.stringify(saveCredentials(domain, { email, password }, { root }), null, 2));
    return;
  }

  if (command === 'save') {
    const email = flagValue(flags, '--email');
    if (!email) {
      console.error('save requires --email (the address the account was made with)');
      process.exitCode = 1;
      return;
    }
    const password = await readPassword();
    if (!password) {
      console.error('save: no password given, nothing stored');
      process.exitCode = 1;
      return;
    }
    const { domain: saved, createdAt } = saveCredentials(domain, { email, password }, { root });
    // Never echo the password back: this output can land in a log.
    console.log(JSON.stringify({ saved: true, domain: saved, email, createdAt }, null, 2));
    return;
  }

  console.error(`unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
