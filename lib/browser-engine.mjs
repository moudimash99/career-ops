import { chromium } from 'playwright';

/**
 * Pluggable Browser Engine Factory
 * Supports local Chromium or Remote Stealth Daemon (e.g. Camoufox) via CDP.
 */
export async function getBrowserContext(profileConfig = {}) {
  const mode = profileConfig.BROWSER_MODE || process.env.BROWSER_MODE || 'local';
  
  if (mode === 'cdp') {
    const cdpUrl = profileConfig.CDP_ENDPOINT || process.env.CDP_ENDPOINT || 'ws://localhost:9222';
    console.log([Browser Engine] Connecting to stealth CDP daemon at );
    return await chromium.connectOverCDP(cdpUrl);
  }
  
  console.log('[Browser Engine] Launching standard Playwright Chromium...');
  return await chromium.launch({ headless: false });
}
