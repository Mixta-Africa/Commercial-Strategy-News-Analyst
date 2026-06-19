/**
 * Mixta Africa - Property Price Scraper (Apify Actor) - v2
 * ============================================================
 * REWRITTEN based on real diagnostic data (2026-06-19), not guesswork.
 *
 * KEY FINDING: Category/search pages (e.g. propertypro.ng/property-for-sale/...)
 * render their listing cards via JavaScript - Cheerio sees only the search
 * filter UI (price dropdowns, bedroom selects), not actual listings. 0 results
 * every time, confirmed across two separate real runs.
 *
 * WHAT ACTUALLY WORKS: individual listing detail pages (e.g.
 * propertypro.ng/property/5-bedroom-house-for-sale-...) are server-rendered
 * and Cheerio reads them fine. Crucially, every listing page also contains a
 * server-rendered "related/popular listings" block with 6-10 more real
 * listing URLs + their prices. This lets us CRAWL: start from one known
 * listing per site, harvest its related-listings links, follow those, repeat.
 * No JS rendering, no category page, no sitemap needed.
 *
 * Confirmed-working CSS structure per site (from real HTML, not assumed):
 *
 * PropertyPro listing page:
 *   Title:     h1.page-heading
 *   Price:     div.pricing h2 (contains "Naira-symbol number")
 *   Bedrooms:  div.property-pros ul li (e.g. "5 Beds")
 *   Related:   div.popular-block > div.popular-block-content > h4 (title) + a (link)
 *
 * PrivateProperty listing page:
 *   Title/bedrooms: h1, h2 (bedroom count embedded in title text, e.g. "4 bedroom Terrace...")
 *   Price:     p.price
 *   Related:   h2/h3 + a pairs in listing-card-style blocks
 */

const { Actor } = require('apify');
const { CheerioCrawler } = require('crawlee');
const https = require('https');

// NigerianPropertyCentre returns HTTP 403 even after fixing SSL - confirmed
// real bot block, not a code issue. Excluded for now; can revisit with a
// different IP/proxy strategy later.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Seed URLs - one REAL, CONFIRMED-EXISTING listing per site to start the crawl from.
const SEED_LISTINGS = [
  {
    site: 'PropertyPro',
    url: 'https://propertypro.ng/property/5-bedroom-house-for-sale-osapa-london-lekki-lagos-7PTJB',
  },
  {
    site: 'PrivateProperty',
    url: 'https://privateproperty.ng/listings/4-bedroom-terrace-for-rent-banana-island-estate-banana-island-ikoyi-lagos-1PDKMK',
  },
];

const MAX_LISTINGS_PER_SITE = 40; // crawl depth cap per site

// AMENITY TAXONOMY
const AMENITY_PATTERNS = [
  { label: '24/7 Electricity',    patterns: ['24/7 electricity', '24hr electricity', 'constant electricity', 'prepaid meter'] },
  { label: 'Standby Generator',   patterns: ['generator', 'power backup', 'diesel generator'] },
  { label: 'Solar Power',         patterns: ['solar'] },
  { label: 'Street Lights',       patterns: ['street light', 'streetlight'] },
  { label: 'Good Roads',          patterns: ['tarred road', 'good road', 'paved road', 'motorable'] },
  { label: 'Drainage System',     patterns: ['drainage'] },
  { label: 'Borehole / Water',    patterns: ['borehole', 'water supply', 'treated water', 'running water'] },
  { label: 'Swimming Pool',       patterns: ['swimming pool', 'pool'] },
  { label: 'Gym / Fitness',       patterns: ['gym', 'fitness'] },
  { label: '24hr Security',       patterns: ['security', 'gated', 'guarded', 'cctv'] },
  { label: 'Parking',             patterns: ['parking', 'garage', 'car park'] },
  { label: 'Serviced',            patterns: ['serviced', 'fully serviced'] },
  { label: 'Estate',              patterns: ['estate', 'gated community'] },
  { label: "Boys' Quarters",      patterns: ["boys' quarters", "boy's quarter", "bq"] },
  { label: 'Smart Home',          patterns: ['smart home', 'automated'] },
  { label: 'Air Conditioning',    patterns: ['air condition', 'a/c'] },
  { label: 'Fitted Kitchen',      patterns: ['fitted kitchen', 'modern kitchen'] },
  { label: 'Balcony',             patterns: ['balcony'] },
  { label: 'Garden / Green Area', patterns: ['garden', 'green area', 'lawn'] },
  { label: 'Elevator / Lift',     patterns: ['elevator', 'lift'] },
];

const PRIORITY_LOCATIONS = [
  'lekki', 'ibeju-lekki', 'ibeju lekki', 'epe', 'ajah', 'sangotedo',
  'lakowe', 'eleko', 'bogije', 'ibeju', 'victoria island', 'ikoyi',
  'banana island', 'oniru', 'chevron', 'jakande', 'ikota', 'vgc', 'lafiaji',
];

// HELPERS

function extractPrice(text) {
  if (!text) return null;
  const t = text.replace(/,/g, '').trim();
  const m = t.match(/(\d{6,})/); // 6+ digit raw number (handles "Naira-symbol 600000000")
  if (m) {
    const val = parseFloat(m[1]);
    if (val >= 500000) return val;
  }
  return null;
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return `NGN ${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `NGN ${(num / 1e6).toFixed(1)}M`;
  return `NGN ${num.toLocaleString()}`;
}

function extractBedrooms(text) {
  if (!text) return null;
  const patterns = [/(\d+)\s*bed(?:room)?s?/i, /(\d+)\s*br\b/i, /(\d+)-bed/i, /(\d+)Bed/];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 10) return n;
    }
  }
  return null;
}

function bedroomLabel(n) {
  if (!n) return 'Unspecified';
  if (n >= 5) return '5+ Bedrooms';
  return `${n} Bedroom${n > 1 ? 's' : ''}`;
}

function extractAmenities(text) {
  const lower = (text || '').toLowerCase();
  return AMENITY_PATTERNS.filter(a => a.patterns.some(p => lower.includes(p))).map(a => a.label);
}

function isPriorityLocation(text) {
  const lower = (text || '').toLowerCase();
  return PRIORITY_LOCATIONS.some(loc => lower.includes(loc));
}

function resolvePropertyType(title) {
  const text = (title || '').toLowerCase();
  if (text.includes('flat') || text.includes('apartment')) return 'Apartment / Flat';
  if (text.includes('duplex') || text.includes('maisonette')) return 'Duplex';
  if (text.includes('bungalow')) return 'Bungalow';
  if (text.includes('terrace')) return 'Terraced House';
  if (text.includes('land') || text.includes('plot')) return 'Land / Plot';
  if (text.includes('house') || text.includes('detached')) return 'Detached House';
  return 'Residential';
}

function resolveAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try {
    const base = new URL(baseUrl);
    return href.startsWith('/') ? `${base.protocol}//${base.host}${href}` : `${base.protocol}//${base.host}/${href}`;
  } catch (e) {
    return null;
  }
}

// SITE-SPECIFIC EXTRACTORS

function extractPropertyPro($, url) {
  const title = $('h1.page-heading').first().text().trim();
  if (!title) return null; // not a real listing page

  // Price: div.pricing contains the headline price, usually first h2 inside it
  const priceText = $('div.pricing').first().text() || $('h2').first().text();
  const priceValue = extractPrice(priceText);

  // Bedrooms: "div.property-pros" lists Beds/Baths/Toilets
  const prosText = $('div.property-pros').first().text();
  const bedrooms = extractBedrooms(prosText) || extractBedrooms(title);

  // Amenities: scan the whole page body text plus title (covers feature lists anywhere on page)
  const bodyText = $('body').text();
  const amenities = extractAmenities(`${title} ${bodyText.substring(0, 5000)}`);

  // Related listings: div.popular-block > div.popular-block-content with h4 + a
  const relatedLinks = [];
  $('div.popular-block').each((_, el) => {
    const block = $(el);
    const linkEl = block.find('a').first();
    const href = linkEl.attr('href');
    const absUrl = resolveAbsoluteUrl(href, url);
    if (absUrl && absUrl.includes('/property/')) relatedLinks.push(absUrl);
  });

  return {
    title,
    priceValue,
    priceText: priceText.trim().substring(0, 60),
    bedrooms,
    amenities,
    relatedLinks: [...new Set(relatedLinks)],
  };
}

function extractPrivateProperty($, url) {
  const title = ($('h1').first().text() || $('h2').first().text()).trim();
  if (!title) return null;

  const priceText = $('p.price').first().text();
  const priceValue = extractPrice(priceText);
  const bedrooms = extractBedrooms(title);

  const bodyText = $('body').text();
  const amenities = extractAmenities(`${title} ${bodyText.substring(0, 5000)}`);

  // Related listings: look for h2/h3 headings near anchor tags pointing to /listings/
  const relatedLinks = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/listings/')) {
      const absUrl = resolveAbsoluteUrl(href, url);
      if (absUrl && absUrl !== url) relatedLinks.push(absUrl);
    }
  });

  return {
    title,
    priceValue,
    priceText: priceText.trim().substring(0, 60),
    bedrooms,
    amenities,
    relatedLinks: [...new Set(relatedLinks)],
  };
}

const SITE_EXTRACTORS = {
  PropertyPro: extractPropertyPro,
  PrivateProperty: extractPrivateProperty,
};

// ACTOR MAIN

Actor.main(async () => {
  console.log('[Actor] Mixta Africa Property Scraper v2 starting (crawl-from-seed strategy)...');

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'NG',
  });

  const allListings = [];
  const visitedPerSite = {};
  SEED_LISTINGS.forEach(s => { visitedPerSite[s.site] = 0; });

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 45,
    maxConcurrency: 2,
    additionalMimeTypes: ['application/octet-stream'],

    async requestHandler({ $, request, crawler, log }) {
      const site = request.userData.site;
      if ((visitedPerSite[site] || 0) >= MAX_LISTINGS_PER_SITE) return;

      const extractor = SITE_EXTRACTORS[site];
      if (!extractor) return;

      const data = extractor($, request.url);
      if (!data || !data.title) {
        log.info(`  ${site}: no listing data found at ${request.url} (skipping)`);
        return;
      }

      visitedPerSite[site] = (visitedPerSite[site] || 0) + 1;

      const propertyType = resolvePropertyType(data.title);
      const priority = isPriorityLocation(data.title) || isPriorityLocation(request.url);

      allListings.push({
        source: site,
        propertyType,
        bedrooms: data.bedrooms,
        bedroomLabel: bedroomLabel(data.bedrooms),
        locationBucket: priority ? 'Priority Corridor' : 'Other Lagos',
        title: data.title,
        priceValue: data.priceValue,
        priceFormatted: formatPrice(data.priceValue),
        amenities: data.amenities,
        amenitiesText: data.amenities.join(', '),
        listingUrl: request.url,
        scrapedAt: new Date().toISOString(),
      });

      log.info(`  ${site} [${visitedPerSite[site]}/${MAX_LISTINGS_PER_SITE}]: "${data.title.substring(0, 50)}" | ${formatPrice(data.priceValue)} | ${data.bedrooms || '?'} bed`);

      // Queue related listings discovered on this page, same site only.
      if (visitedPerSite[site] < MAX_LISTINGS_PER_SITE) {
        for (const link of data.relatedLinks.slice(0, 8)) {
          await crawler.addRequests([{ url: link, userData: { site } }]);
        }
      }
    },

    failedRequestHandler({ request, log }) {
      log.warning(`FAILED: ${request.url} (${request.userData.site})`);
    },
  });

  await crawler.run(SEED_LISTINGS.map(s => ({ url: s.url, userData: { site: s.site } })));

  // Deduplicate by URL.
  const seen = new Set();
  const deduped = allListings.filter(l => {
    if (seen.has(l.listingUrl)) return false;
    seen.add(l.listingUrl);
    return true;
  });

  console.log(`[Actor] Scraped ${deduped.length} unique listings from ${allListings.length} raw`);
  await Actor.pushData(deduped);
  console.log('[Actor] Complete. Data available in Apify dataset.');
});
