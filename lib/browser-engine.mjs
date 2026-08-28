import { chromium } from 'playwright';

/**
 * Connects to an existing browser session via CDP. 
 * If running locally, tier0-navigate.mjs must first launch Chrome with --remote-debugging-port=9222.
 */
export async function getActivePage(profileConfig = {}) {
  const cdpUrl = profileConfig.CDP_ENDPOINT || process.env.CDP_ENDPOINT || 'http://localhost:9222';
  
  try {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error("No browser contexts found");
    const pages = contexts[0].pages();
    if (pages.length === 0) throw new Error("No open pages found");
    const page = pages[0]; // Get the currently active tab
    return { browser, page };
  } catch (err) {
    console.error(`❌ Could not connect to browser at ${cdpUrl}. Ensure tier0-navigate.mjs is running.`);
    console.error(err.message);
    process.exit(1);
  }
}
