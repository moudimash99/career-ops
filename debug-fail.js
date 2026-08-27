const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/axon/jobs/7823878003');
  await page.waitForTimeout(5000);
  await page.click('[type="submit"]', {force: true});
  await page.waitForTimeout(5000);
  const html = await page.content();
  console.log(html);
  await browser.close();
})();
