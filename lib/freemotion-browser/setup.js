async (page) => {
  // Run ONCE per job, BEFORE opening the job page. Playwright reads the helper
  // code from disk and puts it into every page opened afterwards (not as a
  // <script> tag, so pages with a Trusted Types policy accept it).
  // Paths are relative to the repo root, which is where the browser tool runs.
  await page.context().addInitScript({ path: 'lib/freemotion-browser/inventory-global.js' });
  await page.context().addInitScript({ path: 'lib/freemotion-browser/validate-global.js' });
  return 'helpers registered: now open the job page';
}
