// @ts-check

/**
 * lib/camoufox-page.mjs — one hidden Camoufox page on a site, for scripts that
 * read a site's own JSON services from inside the site (APEC: the search and
 * offer-detail services answer plain requests with a DataDome page since
 * 2026-10-01).
 *
 * The browser is the one the Free Motion drivers use: the program path and the
 * disguise (CAMOU_CONFIG_* env, prefs) come from config/playwright-mcp-camoufox.json,
 * started through plain Playwright. It is always hidden, whatever "headless" the
 * file says during a HEADFUL=1 run: nobody watches a scan.
 *
 * The config is gitignored and machine-specific, so on a machine without it
 * camoufoxLaunchOptions() returns null and the caller keeps its plain-HTTP path.
 *
 * A CAPTCHA page is reported (isCaptchaPage), never worked around.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_CONFIG_PATH } from './freemotion-browser-mode.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Playwright launch options for the drivers' Camoufox, forced hidden, or null
 * when the config or the program it names is missing.
 *
 * @param {{ root?: string, configPath?: string }} [opts]
 * @returns {Record<string, any> | null}
 */
export function camoufoxLaunchOptions({ root = REPO_ROOT, configPath = DEFAULT_CONFIG_PATH } = {}) {
  const file = isAbsolute(configPath) ? configPath : join(root, configPath);
  if (!existsSync(file)) return null;
  let launch;
  try {
    launch = JSON.parse(readFileSync(file, 'utf8'))?.browser?.launchOptions;
  } catch {
    return null;
  }
  if (!launch || typeof launch.executablePath !== 'string' || !existsSync(launch.executablePath)) return null;
  return { ...launch, headless: true };
}

/** True when a non-JSON answer is DataDome's CAPTCHA / bot-check page. */
export function isCaptchaPage(text) {
  return /captcha-delivery|geo\.captcha|var dd=\{|Please enable JS and disable any ad blocker/i.test(String(text || ''));
}

/**
 * Open `url` in one hidden Camoufox page and wait `settleMs` for the site's
 * bot check to set its cookie. `fetchText` then runs fetch() inside the page,
 * same origin, exactly as the site's own scripts do.
 *
 * @param {string} url
 * @param {{ settleMs?: number, timeoutMs?: number, launchOptions?: Record<string, any> | null }} [opts]
 * @returns {Promise<{ fetchText: (path: string, init?: { method?: string, headers?: Record<string,string>, body?: string }) => Promise<{ status: number, text: string }>, close: () => Promise<void> }>}
 */
export async function openCamoufoxPage(url, { settleMs = 4000, timeoutMs = 45000, launchOptions = camoufoxLaunchOptions() } = {}) {
  if (!launchOptions) throw new Error('camoufox: no usable config/playwright-mcp-camoufox.json (or its Camoufox program is missing)');
  const { firefox } = await import('playwright');
  const browser = await firefox.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(settleMs);
    return {
      fetchText: (path, init = {}) => page.evaluate(async ({ path, init }) => {
        const x = await fetch(path, init);
        return { status: x.status, text: await x.text() };
      }, { path, init }),
      close: () => browser.close(),
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
