const fs = require('fs');
const html = fs.readFileSync('cimri_puppeteer.html', 'utf8');

const regex = /<article[^>]*>(.+?)<\/article>/gs;
let match;
const products = [];
while ((match = regex.exec(html)) !== null) {
    const card = match[1];

    // title
    const titleMatch = card.match(/title="([^"]+)"/) || card.match(/<h3[^>]*>(.+?)<\/h3>/);
    // price
    const priceMatch = card.match(/([\d.,]+)\s*TL/i);
    // image
    const imgMatch = card.match(/src="([^"]+)"/);
    // link
    const linkMatch = card.match(/href="([^"]+)"/);

    if (titleMatch && priceMatch) {
        let link = linkMatch ? linkMatch[1] : '';
        if (link && !link.startsWith('http')) {
            link = 'https://www.cimri.com' + link;
        }
        products.push({
            title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
            price: priceMatch[1] + ' TL',
            image: imgMatch ? imgMatch[1] : '',
            url: link
        });
    }
}
console.log(JSON.stringify(products.slice(0, 10), null, 2));
