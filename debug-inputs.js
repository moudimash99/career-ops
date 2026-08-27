const { chromium } = require('playwright');
(async () => {
   const browser = await chromium.launch();
   const page = await browser.newPage();
   await page.goto('https://job-boards.greenhouse.io/accuweather/jobs/8153403', {waitUntil: 'domcontentloaded'});
   await page.waitForTimeout(3000);
   const inputs = await page.$$('input');
   console.log('Total inputs:', inputs.length);
   for (const i of inputs) {
      const id = await i.getAttribute('id');
      const type = await i.getAttribute('type');
      const vis = await i.isVisible();
      console.log(id, type, vis);
   }
   await browser.close();
})();
