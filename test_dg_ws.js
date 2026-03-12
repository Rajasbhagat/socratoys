const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    if (msg.text().includes('[Deepgram]')) {
      console.log('BROWSER CONSOLE:', msg.text());
    }
  });

  await page.goto('http://localhost:3000');
  await page.click('#toggle-btn');
  await page.waitForTimeout(5000);
  await browser.close();
})();
