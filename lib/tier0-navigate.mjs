import { chromium } from 'playwright';

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  
  if (urlIdx === -1 || !args[urlIdx + 1]) {
    console.error('Usage: node tier0-navigate.mjs --url <URL>');
    process.exit(1);
  }
  
  const url = args[urlIdx + 1];
  console.log(`[Tier 0] Launching browser on port 9222 and navigating to ${url}`);

  // Launch browser with debugging port so Tier 1, 2, and 3 can connect to it
  const browser = await chromium.launch({
    headless: false,
    args: ['--remote-debugging-port=9222']
  });
  
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  
  console.log(`✅ [Tier 0] Successfully navigated. Browser is open and listening for CDP connections.`);
  console.log(`[Tier 0] Press Ctrl+C to close the browser when finished.`);
  
  // Keep the script running to keep the browser alive
  await new Promise(() => {});
}

main().catch(console.error);
