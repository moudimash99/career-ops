import { getActivePage } from './browser-engine.mjs';
import fs from 'fs';
import path from 'path';

/**
 * Tier 3: Visual Validator (Eye in the Sky)
 * Uses a free-tier Multimodal API to validate the state of the form before submission.
 */
async function validateForm() {
  console.log('[Tier 3] Taking screenshot for validation...');
  
  const { page, browser } = await getActivePage();
  const screenshotDir = path.join(process.cwd(), 'scratch');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  
  const screenshotPath = path.join(screenshotDir, 'validation.jpg');
  await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 50, fullPage: true });
  await browser.close();
  
  console.log(`[Tier 3] Screenshot saved to ${screenshotPath}`);
  console.log('\n--- [Tier 3 Validation Action Required] ---');
  console.log('AGENT: You are now Tier 3. Use your `view_file` tool to inspect `scratch/validation.jpg`.');
  console.log('Evaluate if there are any red errors or empty mandatory fields before submitting.');
  console.log('-------------------------------------------\n');
}

validateForm().catch(console.error);
