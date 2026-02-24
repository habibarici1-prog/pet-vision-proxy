const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('https://www.hepsiburada.com/ara?q=kedi+mamasi', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));
    const html = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('li'));
        const products = els.filter(e => e.innerText.includes('TL'));
        return products.slice(0, 5).map(e => e.outerHTML).join('\n\n\n=======================\n\n\n');
    });
    fs.writeFileSync('../hb-dom.html', html);
    await browser.close();
})();
