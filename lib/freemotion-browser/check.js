async (page) => {
  // The check before any Next/Submit: two validation reads 500ms apart (a field that
  // is still loading must not count as empty) plus the list of required fields still empty.
  // Must return requiredEmpty: 0 and no errors. Also look at a screenshot yourself.
  const P = 'lib/freemotion-browser/validate-global.js';
  const I = 'lib/freemotion-browser/inventory-global.js';
  let target = page.mainFrame(), bestN = -1;
  for (const f of page.frames()) {
    try {
      if (!(await f.evaluate(() => typeof window.__fmInventory === 'function'))) await f.addScriptTag({ path: I }).catch(() => { throw new Error('helpers not in page: run lib/freemotion-browser/setup.js first, then reload the page'); });
      const r = await f.evaluate(() => window.__fmInventory());
      const n = r.fields.length + r.groups.length + r.uploads.length;
      if (n > bestN) { bestN = n; target = f; }
    } catch (e) {}
  }
  if (!(await target.evaluate(() => typeof window.__fmValidate === 'function'))) await target.addScriptTag({ path: P }).catch(() => { throw new Error('helpers not in page: run lib/freemotion-browser/setup.js first, then reload the page'); });
  const a = await target.evaluate(() => window.__fmValidate());
  await page.waitForTimeout(500);
  const b = await target.evaluate(() => window.__fmValidate());
  const inv = await target.evaluate(() => window.__fmInventory());
  await page.evaluate((v) => { window.__fmGate = v; }, { captureA: a, captureB: b });
  return { requiredEmpty: inv.counts.requiredEmpty, errors: inv.errors, emptyRequired: inv.fields.filter(f => f.required && !f.honeypot && !(f.value || f.checked || f.chips)).map(f => f.label).concat(inv.groups.filter(g => g.required && !g.answered).map(g => g.question)) };
}
