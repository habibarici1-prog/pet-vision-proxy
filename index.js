const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Render.com uyku modunu engellemek için sağlık taraması
app.get('/ping', (req, res) => res.status(200).send('pong'));

// ═══════════════════════════════════
// QUEUE (Kuyruk) Sistemi — RAM Koruması
// ═══════════════════════════════════
const MAX_CONCURRENT = 2;   // Aynı anda max 2 Puppeteer sekmesi
const MAX_QUEUE_SIZE = 10;  // Kuyrukta max 10 bekleyen istek
const QUEUE_TIMEOUT = 30000; // 30 saniye kuyruk bekleme limiti

let activeCount = 0;
const waitQueue = [];

function acquireSlot() {
    return new Promise((resolve, reject) => {
        // Boş slot varsa hemen ver
        if (activeCount < MAX_CONCURRENT) {
            activeCount++;
            return resolve();
        }
        // Kuyruk doluysa reddet
        if (waitQueue.length >= MAX_QUEUE_SIZE) {
            return reject(new Error('QUEUE_FULL'));
        }
        // Kuyruğa ekle, timeout ile
        const timer = setTimeout(() => {
            const idx = waitQueue.findIndex(w => w.resolve === resolve);
            if (idx !== -1) waitQueue.splice(idx, 1);
            reject(new Error('QUEUE_TIMEOUT'));
        }, QUEUE_TIMEOUT);

        waitQueue.push({ resolve, reject, timer });
    });
}

function releaseSlot() {
    activeCount--;
    // Kuyrukta bekleyen varsa onu çalıştır
    if (waitQueue.length > 0) {
        const next = waitQueue.shift();
        clearTimeout(next.timer);
        activeCount++;
        next.resolve();
    }
}

// ═══════════════════════════════════
// CACHE — Bellek içi, TTL destekli
// ═══════════════════════════════════
const cache = new Map();
const CACHE_TTL = {
    hepsiburada: 6 * 60 * 60 * 1000, // 6 saat
    n11: 6 * 60 * 60 * 1000,         // 6 saat
    chewy: 6 * 60 * 60 * 1000,
    petlove: 6 * 60 * 60 * 1000,
    cobasi: 6 * 60 * 60 * 1000,
    petcircle: 6 * 60 * 60 * 1000,
    petsathome: 6 * 60 * 60 * 1000,
    petz: 6 * 60 * 60 * 1000,
};

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data, ttl) {
    // Max 500 entry, taşarsa en eskileri sil
    if (cache.size > 500) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { data, time: Date.now(), ttl });
}

// ═══════════════════════════════════
// PUPPETEER TARAYICI
// ═══════════════════════════════════
let browser = null;

async function getBrowser() {
    if (browser && browser.connected) return browser;
    browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1920,1080',
            '--no-first-run',
            '--single-process',
        ],
        ignoreHTTPSErrors: true,
    });
    return browser;
}

// ═══════════════════════════════════
// HEPSİBURADA PARSER
// ═══════════════════════════════════
async function searchHepsiburada(query) {
    const cacheKey = `hb:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    // Kuyruk sistemi — slot al
    await acquireSlot();

    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        // Gereksiz kaynakları engelle (hızlandırma)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(`https://www.hepsiburada.com/ara?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Ürün kartlarının yüklenmesini bekle
        await page.waitForSelector('[data-test-id="product-card-name"], .productListContent-frGrtf5XEsx8WGEV1TVS, ul[class*="productList"]', { timeout: 15000 }).catch(() => { });

        // Sayfada biraz bekle (JS rendering)
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];

            // Yöntem 1: DOM parse — Hepsiburada uses new React tags where a[class*="productCardLink"] is the root for a product
            const cards = document.querySelectorAll(
                'li[class*="productListContent"], li[class*="ProductListItem"], div[data-test-id="product-card"], article[class*="product"], li[class*="column"], a[class*="productCardLink"]'
            );

            for (const card of Array.from(cards).slice(0, 20)) {
                const isAnchor = card.tagName === 'A';
                const linkEl = isAnchor ? card : card.querySelector('a[aria-label], a[data-test-id="product-card-link"], a[href*="-p-"]');
                const titleEl = card.querySelector('[data-test-id*="title-"], h3[class*="name"], span[class*="ame"], h2[class*="title"]');
                const priceEl = card.querySelector('[data-test-id="price-current-price"], [class*="currentPrice"], [class*="Price__"]');
                const imgEl = card.querySelector('img[src*="productimage"], img[src*="hepsiburada"], img[src*="netimages"], img[class*="hbImage"]');

                // The title can be in the a's title attr, or h2's aria-label, etc
                let title = titleEl?.getAttribute('aria-label') || isAnchor && card.getAttribute('title') || linkEl?.getAttribute('title') || linkEl?.getAttribute('aria-label') || titleEl?.textContent?.trim() || '';

                // Hepsiburada includes price in aria-label sometimes: "Sepete ekle, fiyat: 1.390 TL, Purina One..."
                if (title && title.includes('fiyat:')) {
                    title = title.split(',').pop(); // Get last part which is likely the valid title
                }

                title = title.replace(/<[^>]+>/g, '').replace(/Reklam$/i, '').replace(/\s+/g, ' ').trim();

                if (!title || title.length < 5) continue;

                // Try to extract price from title if priceEl is missing but aria-label is like "fiyat: 1.390 TL"
                let priceText = priceEl?.textContent?.trim() || '';
                if (!priceText && titleEl?.getAttribute('aria-label') && titleEl.getAttribute('aria-label').includes('fiyat:')) {
                    const match = titleEl.getAttribute('aria-label').match(/fiyat:\s*([\d.,]+)\s*TL/i);
                    if (match) priceText = match[1];
                }

                const priceMatch = priceText.match(/([\d.,]+)/);
                const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : null;

                const imgSrc = imgEl?.src || imgEl?.dataset?.src || imgEl?.getAttribute('data-lazy') || imgEl?.srcset?.split(' ')[0] || '';
                const url = linkEl?.href || card.href || '';

                if (!url) continue;

                items.push({
                    title,
                    price: priceNum ? `${priceNum.toFixed(2)} TL` : null,
                    priceNum,
                    image: imgSrc,
                    url,
                    brand: '',
                });
            }

            // Yöntem 2: JSON-LD (fallback — DOM başarısızsa)
            if (items.length === 0) {
                const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of jsonLd) {
                    try {
                        const data = JSON.parse(script.textContent);
                        const elList = data['@type'] === 'ItemList' ? data.itemListElement : (data['@type'] === 'Product' ? [data] : []);
                        for (const el of elList.slice(0, 20)) {
                            const item = el.item || el;
                            const cleanTitle = String(item.name || '').replace(/<[^>]+>/g, '').trim();
                            if (!cleanTitle || cleanTitle.length < 5) continue;
                            items.push({
                                title: cleanTitle,
                                price: item.offers?.lowPrice ? `${item.offers.lowPrice} TL` : null,
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    } catch (e) { }
                }
            }

            return items;
        });

        // Sonuçları düzenle
        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Hepsiburada',
            source: 'hepsiburada',
            currency: 'TRY',
            url: p.url && !p.url.startsWith('http') ? `https://www.hepsiburada.com${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) {
            setCache(cacheKey, cleanProducts, CACHE_TTL.hepsiburada);
        }

        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// N11 PARSER
// ═══════════════════════════════════
async function searchN11(query) {
    const cacheKey = `n11:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    // Kuyruk sistemi — slot al
    await acquireSlot();

    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['stylesheet', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(`https://www.n11.com/arama?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });

        // Ürün listesinin yüklenmesini bekle
        await page.waitForSelector('.columnContent .pro, .listView .pro, .resultListItems .pro, div[class*="product"]', { timeout: 15000 }).catch(() => { });

        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];

            // Yöntem 1: JSON-LD
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        for (const el of data.itemListElement.slice(0, 20)) {
                            const item = el.item || el;
                            if (item.name) {
                                items.push({
                                    title: item.name,
                                    price: item.offers?.lowPrice ? `${item.offers.lowPrice} TL` : (item.offers?.price ? `${item.offers.price} TL` : null),
                                    priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                    image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                    url: item.url || '',
                                    brand: item.brand?.name || '',
                                });
                            }
                        }
                    }
                } catch (e) { }
            }

            // Yöntem 2: DOM parse
            if (items.length === 0) {
                const cards = document.querySelectorAll('.columnContent .pro, .listView .pro, .resultListItems li');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('.productName, h3 a, a[title]');
                    const priceEl = card.querySelector('.newPrice ins, .price ins, span[class*="Price"]');
                    const imgEl = card.querySelector('img[src*="n11"], img[data-original], img');
                    const linkEl = card.querySelector('a[href*="urun"], a[href*="n11.com"]');

                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : null;

                        items.push({
                            title: titleEl.textContent?.trim() || titleEl.getAttribute('title') || '',
                            price: priceNum ? `${priceNum} TL` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.original || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }

            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'N11',
            source: 'n11',
            currency: 'TRY',
            url: p.url && !p.url.startsWith('http') ? `https://www.n11.com${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) {
            setCache(cacheKey, cleanProducts, CACHE_TTL.n11);
        }

        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// CHEWY PARSER (🇺🇸 ABD — %4-8 komisyon)
// ═══════════════════════════════════
async function searchChewy(query) {
    const cacheKey = `chewy:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.chewy.com/s?rh=c%3A325702011&query=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="ProductCard"], article[class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];

            // JSON-LD
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement :
                        Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `$${parseFloat(item.offers.lowPrice).toFixed(2)}` : (item.offers?.price ? `$${parseFloat(item.offers.price).toFixed(2)}` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || item.offers?.url || '',
                                brand: item.brand?.name || '',
                                rating: item.aggregateRating?.ratingValue ? parseFloat(item.aggregateRating.ratingValue) : null,
                                reviewCount: item.aggregateRating?.reviewCount ? parseInt(item.aggregateRating.reviewCount) : 0,
                            });
                        }
                    }
                } catch (e) { }
            }

            // DOM fallback
            if (items.length === 0) {
                const cards = document.querySelectorAll('article[class*="product"], div[class*="ProductCard"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('a[class*="product-title"], h2, h3');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/dp/"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/\$?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `$${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Chewy',
            source: 'chewy',
            currency: 'USD',
            url: p.url && !p.url.startsWith('http') ? `https://www.chewy.com${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.chewy);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETS AT HOME PARSER (🇬🇧 İngiltere — %3-5 komisyon)
// ═══════════════════════════════════
async function searchPetsAtHome(query) {
    const cacheKey = `pah:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petsathome.com/search?query=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="product"], [data-product-id]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        for (const el of data.itemListElement.slice(0, 20)) {
                            const item = el.item || el;
                            if (item.name) {
                                items.push({
                                    title: item.name,
                                    price: item.offers?.price ? `£${parseFloat(item.offers.price).toFixed(2)}` : null,
                                    priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                    image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                    url: item.url || '',
                                    brand: item.brand?.name || '',
                                });
                            }
                        }
                    }
                } catch (e) { }
            }

            if (items.length === 0) {
                const cards = document.querySelectorAll('[class*="productCard"], [class*="product-card"], li[class*="product"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('h2, h3, a[class*="title"], [class*="name"]');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/product"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/£?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `£${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Pets at Home',
            source: 'petsathome',
            currency: 'GBP',
            url: p.url && !p.url.startsWith('http') ? `https://www.petsathome.com${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.petsathome);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETCIRCLE PARSER (🇦🇺 Avustralya — %5-6.5 komisyon)
// ═══════════════════════════════════
async function searchPetCircle(query) {
    const cacheKey = `pc:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petcircle.com.au/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="product"], [data-testid*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.price ? `A$${parseFloat(item.offers.price).toFixed(2)}` : null,
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }

            if (items.length === 0) {
                const cards = document.querySelectorAll('[class*="ProductCard"], [class*="product-card"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('h2, h3, a[class*="name"], [class*="title"]');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/product"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/\$?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `A$${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'PetCircle',
            source: 'petcircle',
            currency: 'AUD',
            url: p.url && !p.url.startsWith('http') ? `https://www.petcircle.com.au${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.petcircle);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETLOVE PARSER (🇧🇷 Brezilya — %5-15 komisyon)
// ═══════════════════════════════════
async function searchPetlove(query) {
    const cacheKey = `petlove:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petlove.com.br/busca?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="product"], [class*="Product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        for (const el of data.itemListElement.slice(0, 20)) {
                            const item = el.item || el;
                            if (item.name) {
                                const priceVal = parseFloat(item.offers?.lowPrice || item.offers?.price) || null;
                                items.push({
                                    title: item.name,
                                    price: priceVal ? `R$${priceVal.toFixed(2)}` : null,
                                    priceNum: priceVal,
                                    image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                    url: item.url || '',
                                    brand: item.brand?.name || '',
                                });
                            }
                        }
                    }
                } catch (e) { }
            }

            if (items.length === 0) {
                const cards = document.querySelectorAll('[class*="product-card"], [class*="ProductCard"], li[class*="product"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('h2, h3, [class*="name"], [class*="title"]');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/produto"], a[href*="/product"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/R?\$?\s?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `R$${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Petlove',
            source: 'petlove',
            currency: 'BRL',
            url: p.url && !p.url.startsWith('http') ? `https://www.petlove.com.br${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.petlove);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// COBASI PARSER (🇧🇷 Brezilya — %8.5 komisyon)
// ═══════════════════════════════════
async function searchCobasi(query) {
    const cacheKey = `cobasi:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.cobasi.com.br/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="product"], [class*="Product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        for (const el of data.itemListElement.slice(0, 20)) {
                            const item = el.item || el;
                            if (item.name) {
                                const priceVal = parseFloat(item.offers?.lowPrice || item.offers?.price) || null;
                                items.push({
                                    title: item.name,
                                    price: priceVal ? `R$${priceVal.toFixed(2)}` : null,
                                    priceNum: priceVal,
                                    image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                    url: item.url || '',
                                    brand: item.brand?.name || '',
                                });
                            }
                        }
                    }
                } catch (e) { }
            }

            if (items.length === 0) {
                const cards = document.querySelectorAll('[class*="product-card"], [class*="ProductCard"], [class*="productCard"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('h2, h3, [class*="name"], [class*="title"]');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/produto"], a[href*="/product"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/R?\$?\s?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `R$${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Cobasi',
            source: 'cobasi',
            currency: 'BRL',
            url: p.url && !p.url.startsWith('http') ? `https://www.cobasi.com.br${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.cobasi);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETZ PARSER (🇧🇷 Brezilya — %7 komisyon)
// ═══════════════════════════════════
async function searchPetz(query) {
    const cacheKey = `petz:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petz.com.br/busca?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });

        await page.waitForSelector('[class*="product"], [class*="Product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    if (data['@type'] === 'ItemList' && data.itemListElement) {
                        for (const el of data.itemListElement.slice(0, 20)) {
                            const item = el.item || el;
                            if (item.name) {
                                const priceVal = parseFloat(item.offers?.lowPrice || item.offers?.price) || null;
                                items.push({
                                    title: item.name,
                                    price: priceVal ? `R$${priceVal.toFixed(2)}` : null,
                                    priceNum: priceVal,
                                    image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                    url: item.url || '',
                                    brand: item.brand?.name || '',
                                });
                            }
                        }
                    }
                } catch (e) { }
            }

            if (items.length === 0) {
                const cards = document.querySelectorAll('[class*="product-card"], [class*="ProductCard"]');
                for (const card of Array.from(cards).slice(0, 20)) {
                    const titleEl = card.querySelector('h2, h3, [class*="name"], [class*="title"]');
                    const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
                    const imgEl = card.querySelector('img');
                    const linkEl = card.querySelector('a[href*="/produto"], a[href*="/product"]');
                    if (titleEl) {
                        const priceText = priceEl?.textContent?.trim() || '';
                        const priceMatch = priceText.match(/R?\$?\s?([\d.,]+)/);
                        const priceNum = priceMatch ? parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.')) : null;
                        items.push({
                            title: titleEl.textContent?.trim() || '',
                            price: priceNum ? `R$${priceNum.toFixed(2)}` : null,
                            priceNum,
                            image: imgEl?.src || imgEl?.dataset?.src || '',
                            url: linkEl?.href || '',
                            brand: '',
                        });
                    }
                }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p,
            seller: 'Petz',
            source: 'petz',
            currency: 'BRL',
            url: p.url && !p.url.startsWith('http') ? `https://www.petz.com.br${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, CACHE_TTL.petz);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETBARN PARSER (🇦🇺 Avustralya — %1.6-5 komisyon)
// ═══════════════════════════════════
async function searchPetbarn(query) {
    const cacheKey = `petbarn:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petbarn.com.au/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForSelector('.product-item, [class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `A$${parseFloat(item.offers.lowPrice).toFixed(2)}` : (item.offers?.price ? `A$${parseFloat(item.offers.price).toFixed(2)}` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p, seller: 'Petbarn', source: 'petbarn', currency: 'AUD',
            url: p.url && !p.url.startsWith('http') ? `https://www.petbarn.com.au${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, 3600000);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PETSTOCK PARSER (🇦🇺 Avustralya — %2-6 komisyon)
// ═══════════════════════════════════
async function searchPetStock(query) {
    const cacheKey = `petstock:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petstock.com.au/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForSelector('.product-item, [class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `A$${parseFloat(item.offers.lowPrice).toFixed(2)}` : (item.offers?.price ? `A$${parseFloat(item.offers.price).toFixed(2)}` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p, seller: 'PetStock', source: 'petstock', currency: 'AUD',
            url: p.url && !p.url.startsWith('http') ? `https://www.petstock.com.au${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, 3600000);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PET VALU PARSER (🇨🇦 Kanada)
// ═══════════════════════════════════
async function searchPetValu(query) {
    const cacheKey = `petvalu:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.petvalu.ca/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForSelector('.product-item, [class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `CA$${parseFloat(item.offers.lowPrice).toFixed(2)}` : (item.offers?.price ? `CA$${parseFloat(item.offers.price).toFixed(2)}` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p, seller: 'Pet Valu', source: 'petvalu', currency: 'CAD',
            url: p.url && !p.url.startsWith('http') ? `https://www.petvalu.ca${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, 3600000);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// YANDEX MARKET PARSER (🇷🇺 Rusya — %1-3 Admitad)
// ═══════════════════════════════════
async function searchYandexMarket(query) {
    const cacheKey = `yandex:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://market.yandex.ru/search?text=${encodeURIComponent(query)}&hid=15685457`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForSelector('[data-autotest-id="product-snippet"], [class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `${Math.round(parseFloat(item.offers.lowPrice)).toLocaleString()} ₽` : (item.offers?.price ? `${Math.round(parseFloat(item.offers.price)).toLocaleString()} ₽` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p, seller: 'Yandex Market', source: 'yandex_market', currency: 'RUB',
            url: p.url && !p.url.startsWith('http') ? `https://market.yandex.ru${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, 3600000);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// PUPPIS PARSER (🇦🇷 Arjantin)
// ═══════════════════════════════════
async function searchPuppis(query) {
    const cacheKey = `puppis:${query}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.goto(`https://www.puppis.com.ar/buscar?q=${encodeURIComponent(query)}`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
        });
        await page.waitForSelector('.product-item, [class*="product"]', { timeout: 15000 }).catch(() => { });
        await new Promise(r => setTimeout(r, 3000));

        const products = await page.evaluate(() => {
            const items = [];
            const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLd) {
                try {
                    const data = JSON.parse(script.textContent);
                    const list = data['@type'] === 'ItemList' ? data.itemListElement : Array.isArray(data) ? data : [data];
                    for (const el of list.slice(0, 20)) {
                        const item = el.item || el;
                        if (item['@type'] === 'Product' && item.name) {
                            items.push({
                                title: item.name,
                                price: item.offers?.lowPrice ? `AR$${parseFloat(item.offers.lowPrice).toFixed(2)}` : (item.offers?.price ? `AR$${parseFloat(item.offers.price).toFixed(2)}` : null),
                                priceNum: parseFloat(item.offers?.lowPrice || item.offers?.price) || null,
                                image: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                                url: item.url || '',
                                brand: item.brand?.name || '',
                            });
                        }
                    }
                } catch (e) { }
            }
            return items;
        });

        const cleanProducts = products.filter(p => p.title && p.title.length > 5).map(p => ({
            ...p, seller: 'Puppis', source: 'puppis', currency: 'ARS',
            url: p.url && !p.url.startsWith('http') ? `https://www.puppis.com.ar${p.url}` : p.url,
        }));

        if (cleanProducts.length > 0) setCache(cacheKey, cleanProducts, 3600000);
        return { products: cleanProducts, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// CIMRI (META-SCRAPER) PARSER
// ═══════════════════════════════════
async function searchCimri(query, pageParam = 1) {
    const pageNum = parseInt(pageParam) || 1;
    const cacheKey = `cimri:${query}:p${pageNum}`;
    const cached = getCached(cacheKey);
    if (cached) return { products: cached, fromCache: true };

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });

        // Gereksiz kaynakları engelle
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['stylesheet', 'font', 'media'].includes(type)) req.abort();
            else req.continue();
        });

        const url = `https://www.cimri.com/arama?q=${encodeURIComponent(query)}${pageNum > 1 ? `&page=${pageNum}` : ''}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('article', { timeout: 15000 }).catch(() => { });

        const html = await page.content();

        const regex = /<article[^>]*>(.+?)<\/article>/gs;
        let match;
        const products = [];

        while ((match = regex.exec(html)) !== null) {
            const card = match[1];

            const titleMatch = card.match(/title="([^"]+)"/) || card.match(/<h3[^>]*>(.+?)<\/h3>/);
            const priceMatch = card.match(/([\d.,]+)\s*TL/i);
            const imgMatch = card.match(/src="([^"]+)"/);
            const linkMatch = card.match(/href="([^"]+)"/);

            if (titleMatch && priceMatch) {
                let link = linkMatch ? linkMatch[1] : '';
                if (link && !link.startsWith('http')) {
                    link = 'https://www.cimri.com' + link;
                }
                const priceStr = priceMatch[1].replace(/\./g, '').replace(',', '.');
                const priceNum = parseFloat(priceStr);

                products.push({
                    title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
                    price: priceMatch[1] + ' TL',
                    priceNum: priceNum || null,
                    image: imgMatch ? imgMatch[1] : '',
                    url: link,
                    source: 'cimri',
                    seller: 'Cimri Fiyat Karşılaştırması',
                    currency: 'TRY'
                });
            }
        }

        if (products.length > 0) setCache(cacheKey, products, 3600000); // 1 saat
        return { products, fromCache: false };
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
}

// ═══════════════════════════════════
// API ENDPOINT'LERİ
// ═══════════════════════════════════
app.get('/search', async (req, res) => {
    const { site, q, page } = req.query;
    if (!site || !q) {
        return res.status(400).json({ success: false, error: 'site ve q parametreleri gerekli' });
    }

    try {
        let result;
        switch (site.toLowerCase()) {
            case 'cimri':
                result = await searchCimri(q, page);
                break;
            case 'hepsiburada':
                result = await searchHepsiburada(q);
                break;
            case 'n11':
                result = await searchN11(q);
                break;
            case 'chewy':
                result = await searchChewy(q);
                break;
            case 'petsathome':
            case 'pets_at_home':
                result = await searchPetsAtHome(q);
                break;
            case 'petcircle':
            case 'pet_circle':
                result = await searchPetCircle(q);
                break;
            case 'petlove':
                result = await searchPetlove(q);
                break;
            case 'cobasi':
                result = await searchCobasi(q);
                break;
            case 'petz':
                result = await searchPetz(q);
                break;
            case 'petbarn':
                result = await searchPetbarn(q);
                break;
            case 'petstock':
                result = await searchPetStock(q);
                break;
            case 'petvalu':
            case 'pet_valu':
                result = await searchPetValu(q);
                break;
            case 'yandex_market':
            case 'yandexmarket':
                result = await searchYandexMarket(q);
                break;
            case 'puppis':
                result = await searchPuppis(q);
                break;
            default:
                return res.status(400).json({ success: false, error: `Bilinmeyen site: ${site}` });
        }

        res.json({
            success: true,
            site,
            query: q,
            count: result.products.length,
            fromCache: result.fromCache,
            products: result.products,
        });
    } catch (e) {
        // Kuyruk hatalarını özel HTTP kodlarıyla döndür
        if (e.message === 'QUEUE_FULL') {
            return res.status(503).json({ success: false, error: 'Sunucu meşgul, lütfen tekrar deneyin', code: 'QUEUE_FULL' });
        }
        if (e.message === 'QUEUE_TIMEOUT') {
            return res.status(503).json({ success: false, error: 'İstek zaman aşımına uğradı', code: 'QUEUE_TIMEOUT' });
        }
        res.status(500).json({ success: false, error: e.message });
    }
});

// Health check + keep-alive endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        cacheSize: cache.size,
        browserConnected: browser?.connected || false,
        activeCount,
        queueLength: waitQueue.length,
        maxConcurrent: MAX_CONCURRENT,
        maxQueueSize: MAX_QUEUE_SIZE,
    });
});

// Cache temizleme
app.get('/cache/clear', (req, res) => {
    cache.clear();
    res.json({ status: 'cache cleared' });
});

// Debug endpoint — sayfanın HTML'ini ve screenshot'ını döndür
app.get('/debug', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parametresi gerekli' });

    await acquireSlot();
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1366, height: 768 });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 5000));

        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
        const title = await page.title();
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '');
        const jsonLdCount = await page.evaluate(() => document.querySelectorAll('script[type="application/ld+json"]').length);
        const productCards = await page.evaluate(() => {
            const selectors = [
                '.columnContent .pro', '.listView .pro', '.resultListItems .pro',
                'div[class*="product"]', '[class*="Product"]', '[data-test*="product"]',
                '.srp-product-list li', '.list-ul li',
            ];
            const results = {};
            for (const sel of selectors) {
                results[sel] = document.querySelectorAll(sel).length;
            }
            return results;
        });

        res.json({
            title,
            jsonLdCount,
            productCards,
            bodyTextPreview: bodyText.slice(0, 1000),
            screenshotBase64: screenshot,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await page.close().catch(() => { });
        releaseSlot();
    }
});

// ═══════════════════════════════════
// SUNUCU BAŞLAT
// ═══════════════════════════════════
app.listen(PORT, () => {
    console.log(`Pet Vision Proxy running on port ${PORT}`);
    // Tarayıcıyı önceden başlat
    getBrowser().then(() => console.log('Browser ready')).catch(console.error);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    if (browser) await browser.close();
    process.exit(0);
});
