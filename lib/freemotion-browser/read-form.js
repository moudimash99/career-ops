async (page) => {
  // Read the form: runs the inventory in every frame, keeps the frame with the most
  // fields, and stores the full result in window.__fmInv. Read it back with
  // browser_evaluate `() => window.__fmInv.inventory`.
  const P = 'lib/freemotion-browser/inventory-global.js';
  let best = null, bestUrl = null, bestN = -1, errs = [];
  for (const f of page.frames()) {
    try {
      if (!(await f.evaluate(() => typeof window.__fmInventory === 'function'))) await f.addScriptTag({ path: P }).catch(() => { throw new Error('helpers not in page: run lib/freemotion-browser/setup.js first, then reload the page'); });
      const r = await f.evaluate(() => window.__fmInventory());
      const n = r.fields.length + r.groups.length + r.uploads.length;
      if (n > bestN) { best = r; bestN = n; bestUrl = f.url(); }
    } catch (e) { errs.push(String(e).slice(0, 80)); }
  }
  await page.evaluate((v) => { window.__fmInv = v; }, { frameUrl: bestUrl, inventory: best });
  return { frameUrl: bestUrl, counts: best && best.counts, consentWall: best && best.consentWall, entry: best && best.entryPoints.length, frames: best && best.frames.length, errs };
}
