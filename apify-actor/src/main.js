/**
 * DIAGNOSTIC MODE — Mixta Africa Property Scraper
 * ==================================================
 * This is a temporary diagnostic build. It does NOT try to extract prices
 * or listings. Instead, for each site it saves:
 *   - The raw HTML length received
 *   - The page title
 *   - A sample of HTML around any element containing a Naira symbol or
 *     "bed"/"bedroom" text (the most likely location of real listing data)
 *   - The first 3000 characters of the <body> as a fallback sample
 *
 * Purpose: see what these sites' ACTUAL current HTML structure looks like,
 * since the original selectors were written without being able to view
 * the live pages. Once we see real output here, real selectors get written
 * and this diagnostic file gets replaced by the working version.
 */

const { Actor } = require('apify');
const { CheerioCrawler } = require('crawlee');

const TEST_URLS = [
  { site: 'NigerianPropertyCentre', url: 'https://nigerianpropertycenter.com/for-sale/in-lagos/flats-apartments/' },
  { site: 'PropertyPro',            url: 'https://www.propertypro.ng/property-for-sale/flat-in-lagos' },
  { site: 'Tolet',                  url: 'https://tolet.com.ng/property/Lagos/flats/buy' },
  { site: 'PrivatePropertyNigeria', url: 'https://www.privateproperty.com.ng/for-sale?state=Lagos' },
];

Actor.main(async () => {
  console.log('[Diagnostic] Starting HTML structure inspection...');

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'NG',
  });

  const results = [];

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 45,
    maxConcurrency: 2,
    additionalMimeTypes: ['application/octet-stream'], // don't skip binary-flagged responses, inspect them anyway

    async requestHandler({ $, request, body, contentType, log }) {
      const site = request.userData.site;
      log.info(`Inspecting ${site}: ${request.url}`);

      const htmlLength = body ? body.length : 0;
      const pageTitle = $('title').text().trim();
      const detectedContentType = contentType?.type || 'unknown';

      // Find elements that mention Naira or bedrooms — likely listing data.
      const priceHits = [];
      $('*').each((_, el) => {
        const text = $(el).text();
        if (text.length < 200 && (text.includes('\u20a6') || /\d{1,3}(,\d{3})+/.test(text)) ) {
          const tag = el.tagName;
          const cls = $(el).attr('class') || '(no class)';
          const id = $(el).attr('id') || '(no id)';
          const sample = text.trim().substring(0, 80);
          if (sample) priceHits.push(`<${tag} class="${cls}" id="${id}"> ${sample}`);
        }
      });

      const bedroomHits = [];
      $('*').each((_, el) => {
        const text = $(el).text();
        if (text.length < 100 && /bed(room)?s?\b/i.test(text)) {
          const tag = el.tagName;
          const cls = $(el).attr('class') || '(no class)';
          const sample = text.trim().substring(0, 60);
          if (sample) bedroomHits.push(`<${tag} class="${cls}"> ${sample}`);
        }
      });

      // Sample raw body HTML for visual structure inspection.
      const bodyHtml = $('body').html() || '';
      const bodySample = bodyHtml.substring(0, 3000);

      results.push({
        site,
        url: request.url,
        detectedContentType,
        htmlLength,
        pageTitle,
        priceLikeElementsFound: priceHits.length,
        priceLikeSamples: priceHits.slice(0, 10),
        bedroomLikeElementsFound: bedroomHits.length,
        bedroomLikeSamples: bedroomHits.slice(0, 10),
        bodyHtmlSample: bodySample,
      });

      log.info(`  ${site}: htmlLength=${htmlLength}, priceHits=${priceHits.length}, bedroomHits=${bedroomHits.length}`);
    },

    failedRequestHandler({ request, log }) {
      results.push({
        site: request.userData.site,
        url: request.url,
        error: request.errorMessages?.join(', ') || 'unknown failure',
      });
      log.warning(`FAILED: ${request.url}`);
    },
  });

  await crawler.run(TEST_URLS.map(t => ({ url: t.url, userData: { site: t.site } })));

  console.log(`[Diagnostic] Inspected ${results.length} pages. Pushing to dataset...`);
  await Actor.pushData(results);
  console.log('[Diagnostic] Done. Check the Dataset tab for output.');
});
