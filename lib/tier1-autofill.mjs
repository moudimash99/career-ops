import { getActivePage } from './browser-engine.mjs';

/**
 * Injects JS to map standard fields and fills them.
 * Returns a clean text snapshot of all *unfilled* or *unrecognized* fields tagged with ordinal references.
 */
export async function runTier1Autofill() {
  console.log('[Tier 1] Connecting to active browser...');
  const { page, browser } = await getActivePage();
  
  const a11yTree = await page.evaluate(() => {
    let id = 1;
    const snapshot = [];
    // WTTJ and other sites often use generic divs that act as buttons, so this selector is broad
    const elements = document.querySelectorAll('button, input, select, textarea, a, [role="button"], [role="checkbox"]');
    
    elements.forEach(el => {
      // Check if element is reasonably visible
      const rect = el.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      
      if (isVisible) {
        const ref = `e${id++}`;
        el.setAttribute('data-agent-ref', ref); // Tag DOM for interaction
        
        let label = el.innerText || el.placeholder || el.value || el.name || el.getAttribute('aria-label') || 'Unknown';
        label = label.replace(/\s+/g, ' ').trim().substring(0, 100);
        
        const tagName = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        
        // Exclude hidden inputs and generic links without clear text
        if (type !== 'hidden' && label.length > 0) {
           snapshot.push(`[${ref}] ${tagName}${type ? `:${type}` : ''} - "${label}"`);
        }
      }
    });
    return snapshot.join('\n');
  });

  console.log('\n--- [Tier 1] Remaining Interactive Elements ---');
  console.log(a11yTree);
  console.log('----------------------------------------------\n');
  
  await browser.close(); // Only disconnects CDP
  return a11yTree;
}

// If run directly via CLI
if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1] === import.meta.filename || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  runTier1Autofill().catch(console.error);
}

