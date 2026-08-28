// Tier 1: Deterministic Autofill

/**
 * Injects JS to map standard fields and fills them.
 * Returns a clean text snapshot of all *unfilled* or *unrecognized* fields tagged with ordinal references.
 */
export async function runTier1Autofill(page, profile) {
  console.log('[Tier 1] Running deterministic autofill...');
  
  // Note: Future implementations will fill fields here based on `profile`
  
  const a11yTree = await page.evaluate(() => {
    let id = 1;
    const snapshot = [];
    const elements = document.querySelectorAll('button, input, select, textarea, a');
    elements.forEach(el => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) { // Ensure element is visible
        const ref = `e${id++}`;
        el.setAttribute('data-agent-ref', ref); // Tag DOM for interaction
        
        let label = el.innerText || el.placeholder || el.value || el.name || 'Unknown';
        // Filter out filled inputs (basic mockup)
        if (!el.value || el.tagName.toLowerCase() === 'button') {
          snapshot.push(`[${ref}] ${el.tagName.toLowerCase()} - "${label.trim()}"`);
        }
      }
    });
    return snapshot.join('\n');
  });

  console.log('[Tier 1] Remaining A11y Tree:');
  console.log(a11yTree);
  return a11yTree;
}
