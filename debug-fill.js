const { chromium } = require('playwright');
(async () => {
   const browser = await chromium.launch();
   const page = await browser.newPage();
   await page.goto('https://job-boards.greenhouse.io/accuweather/jobs/8153403', {waitUntil: 'domcontentloaded'});
   await page.waitForTimeout(3000);
   const f = await page.$('#first_name');
   console.log('Got first name input');
   try {
      await f.fill('Test', {force: true});
      console.log('Fill success');
   } catch (e) {
      console.log('Fill error', e);
   }
   await browser.close();
})();
