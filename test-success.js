const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/axon/jobs/7823878003');
  await page.waitForTimeout(5000);
  
  // Fill first name to pass validation
  await page.fill('input[name="job_application[first_name]"]', 'Mohammad');
  await page.fill('input[name="job_application[last_name]"]', 'Machaka');
  await page.fill('input[name="job_application[email]"]', 'test@example.com');
  await page.fill('input[name="job_application[phone]"]', '1234567890');
  
  // click submit
  await page.click('[type="submit"]', {force: true});
  
  await page.waitForTimeout(5000);
  const html = await page.content();
  console.log(html);
  await page.screenshot({path: 'data/screenshots/test-success.png', fullPage: true});
  await browser.close();
})();
