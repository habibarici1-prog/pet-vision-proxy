const puppeteer = require('puppeteer');
const fs = require('fs');
(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto('https://www.hepsiburada.com/ara?q=kedi+mamasi', { waitUntil: 'domcontentloaded' });
    // Wait for something like div[class*="product"]
    await new Promise(r => setTimeout(r, 3000));
    const html = await page.evaluate(() => {
        const productDivs = Array.from(document.querySelectorAll('div[class*="product"]'));
        return productDivs.slice(0, 10).map(e => e.outerHTML).join('\n\n\n=======================\n\n\n');
    });
    fs.writeFileSync('../hb-divs.html', html);
    await browser.close();
})();
