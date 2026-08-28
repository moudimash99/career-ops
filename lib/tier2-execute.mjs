import { getActivePage } from './browser-engine.mjs';

/**
 * CLI utility used by agy to perform actions on the tagged DOM.
 * Usage: node tier2-execute.mjs --action TYPE --target e3 --value "My Answer"
 */
async function main() {
  const args = process.argv.slice(2);
  const actionIdx = args.indexOf('--action');
  const targetIdx = args.indexOf('--target');
  const valueIdx = args.indexOf('--value');

  if (actionIdx === -1 || targetIdx === -1) {
    console.error('Usage: --action <CLICK|TYPE|SELECT> --target <e#>');
    process.exit(1);
  }

  const action = args[actionIdx + 1];
  const target = args[targetIdx + 1];
  const value = valueIdx !== -1 ? args[valueIdx + 1] : null;

  console.log(`[Tier 2] Executing: ${action} on ${target} with value "${value || ''}"`);

  const { page, browser } = await getActivePage();
  
  try {
    const locator = page.locator(`[data-agent-ref="${target}"]`).first();
    
    // Ensure element exists before acting
    if (await locator.count() === 0) {
      throw new Error(`Element ${target} not found on page. It may have navigated away or not been tagged.`);
    }

    // Attempt to make it visible if obscured (WTTJ modals)
    await locator.scrollIntoViewIfNeeded().catch(() => {});

    if (action === 'CLICK') {
      // Force click because sometimes modal overlays or fixed headers block standard clicks
      await locator.click({ force: true, delay: 100 });
    } else if (action === 'TYPE') {
      if (!value) throw new Error("--value is required for TYPE action");
      await locator.fill(value);
    } else if (action === 'SELECT') {
      if (!value) throw new Error("--value is required for SELECT action");
      await locator.selectOption({ label: value });
    } else if (action === 'UPLOAD') {
      if (!value) throw new Error("--value is required for UPLOAD action");
      await locator.setInputFiles(value);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
    
    console.log(`✅ [Tier 2] Action ${action} completed successfully on ${target}.`);
  } catch (err) {
    console.error(`❌ [Tier 2] Execution Error: ${err.message}`);
  } finally {
    // Only disconnects CDP, does not kill browser
    await browser.close();
  }
}

main().catch(console.error);
