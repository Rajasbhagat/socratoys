import { chromium } from 'playwright';
(async () => {
    const browser = await chromium.launch({ headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const page = await browser.newPage();

    page.on('console', msg => {
        if (msg.text().includes('[Deepgram]')) {
            // ignore pure ws messages to keep it clean, or keep them? Keep them briefly
            console.log('BROWSER CONSOLE:', msg.text());
        } else {
            console.log('BROWSER CONSOLE:', msg.text());
        }
    });

    page.on('request', req => {
        if (req.url().includes('/api/logs')) {
            console.log('API LOGS REQ:', req.postData());
        }
    });

    page.on('response', async res => {
        if (res.url().includes('/api/logs')) {
            console.log('API LOGS RES:', res.status());
        }
    });

    await page.goto('http://localhost:3000');
    await page.click('#toggle-btn');
    await page.waitForTimeout(8000);
    await browser.close();
})();
