/**
 * Mixta Africa - Property Price Scraper (Apify Actor)
 * =====================================================
 * Runs on Apify's infrastructure with residential proxy routing,
 * bypassing Cloudflare WAF blocks that reject GitHub Actions IPs.
 *
 * Scrapes real listing pages (not news articles) for:
 *   - Actual sale price (NGN)
 *   - Bedroom count
 *   - Location / neighbourhood
 *   - Property type
 *   - Amenities / features
 *   - Direct listing URL
 *
 * Output is stored in Apify's dataset, then fetched by the GitHub
 * Actions workflow and written to Google Sheets + competitive-briefing.json.
 */

const { Actor }        = require('apify');
const { CheerioCrawler, ProxyConfiguration } = require('crawlee');

//  SITES TO SCRAPE 
// Ranked by data authenticity. URLs target Lagos sale listings directly.
const LISTING_SITES = [
  {
    name: 'NigerianPropertyCentre',
    rank: 1,
    urls: [
      'https://nigerianpropertycenter.com/for-sale/in-lagos/flats-apartments/',
      'https://nigerianpropertycenter.com/for-sale/in-lagos/houses/',
      'https://nigerianpropertycenter.com/for-sale/in-lagos/duplexes/',
      'https://nigerianpropertycenter.com/for-sale/in-lagos/bungalows/',
      'https://nigerianpropertycenter.com/for-sale/in-lagos/terraced-duplexes/',
      'https://nigerianpropertycenter.com/for-sale/in-lagos/land/',
    ],
    selectors: {
      listingContainer: '.listings-property, .property-item, article.listing',
      title:    '.listings-property-title, h3.property-name, .listing-name',
      price:    '.listings-property-price, .price, [class*="price"]',
      location: '.listings-property-location, .location, .address',
      bedrooms: '[class*="bed"], .bedrooms, [data-beds]',
      features: '.listings-features li, .property-features li, [class*="feature"] li',
      link:     'a.listings-property-title, a.property-name, .listing-title a',
    },
  },
  {
    name: 'PropertyPro',
    rank: 2,
    urls: [
      'https://www.propertypro.ng/property-for-sale/flat-in-lagos',
      'https://www.propertypro.ng/property-for-sale/house-in-lagos',
      'https://www.propertypro.ng/property-for-sale/duplex-in-lagos',
      'https://www.propertypro.ng/property-for-sale/bungalow-in-lagos',
      'https://www.propertypro.ng/property-for-sale/terraced-in-lagos',
      'https://www.propertypro.ng/property-for-sale/land-in-lagos',
    ],
    selectors: {
      listingContainer: '.single-room-dash, .listings-property',
      title:    'h3.listings-property-title, .property-name',
      price:    'h3.listings-property-price, .listings-property-amount',
      location: '.listings-property-location',
      bedrooms: '.fa-bed + span, [class*="bedroom"]',
      features: '.listings-features span, .fur-areea span',
      link:     'a[href*="/property/"]',
    },
  },
  {
    name: 'PrivatePropertyNigeria',
    rank: 3,
    urls: [
      'https://www.privateproperty.com.ng/for-sale?state=Lagos&propertyType=10',  // flats
      'https://www.privateproperty.com.ng/for-sale?state=Lagos&propertyType=2',   // houses
      'https://www.privateproperty.com.ng/for-sale?state=Lagos&propertyType=3',   // duplex
      'https://www.privateproperty.com.ng/for-sale?state=Lagos&propertyType=24',  // land
    ],
    selectors: {
      listingContainer: '.listing-item, .property-card, [class*="listing"]',
      title:    '.listing-title, h2.property-title',
      price:    '.listing-price, .price-display, [class*="price"]',
      location: '.listing-location, .location-name',
      bedrooms: '.bedrooms, [class*="bed"]',
      features: '.listing-features li, .property-extras li',
      link:     'a.listing-title, a[href*="/property/"]',
    },
  },
  {
    name: 'Tolet',
    rank: 4,
    urls: [
      'https://tolet.com.ng/property/Lagos/flats/buy',
      'https://tolet.com.ng/property/Lagos/houses/buy',
      'https://tolet.com.ng/property/Lagos/duplexes/buy',
      'https://tolet.com.ng/property/Lagos/land/buy',
    ],
    selectors: {
      listingContainer: '.property-item, .listing-card',
      title:    '.property-name, .listing-name',
      price:    '.property-price, .price',
      location: '.property-location',
      bedrooms: '[class*="bed"]',
      features: '.property-features li, [class*="feature"] li',
      link:     'a.property-item, a[href*="/property/"]',
    },
  },
];

//  AMENITY TAXONOMY 
const AMENITY_PATTERNS = [
  { label: '24/7 Electricity',    patterns: ['24/7 electricity', '24hr electricity', 'constant electricity', 'uninterrupted power', 'prepaid meter'] },
  { label: 'Standby Generator',   patterns: ['generator', 'gen', 'power backup', 'diesel generator'] },
  { label: 'Solar Power',         patterns: ['solar'] },
  { label: 'Street Lights',       patterns: ['street light', 'street lighting', 'streetlight'] },
  { label: 'Good Roads',          patterns: ['tarred road', 'good road', 'paved road', 'road network', 'motorable'] },
  { label: 'Drainage System',     patterns: ['drainage', 'drainage system', 'gutter'] },
  { label: 'Borehole / Water',    patterns: ['borehole', 'water supply', 'treated water', 'running water'] },
  { label: 'Swimming Pool',       patterns: ['swimming pool', 'pool'] },
  { label: 'Gym / Fitness',       patterns: ['gym', 'fitness', 'exercise room'] },
  { label: '24hr Security',       patterns: ['security', 'gated', 'guarded', 'cctv', 'security post'] },
  { label: 'Parking',             patterns: ['parking', 'garage', 'car park', 'carport'] },
  { label: 'Serviced',            patterns: ['serviced', 'fully serviced'] },
  { label: 'Estate',              patterns: ['estate', 'gated community', 'gated estate'] },
  { label: "Boys' Quarters",      patterns: ["boys' quarters", "boy's quarter", "bq"] },
  { label: 'Smart Home',          patterns: ['smart home', 'automated'] },
  { label: 'Air Conditioning',    patterns: ['air condition', 'a/c', 'ac unit'] },
  { label: 'Fitted Kitchen',      patterns: ['fitted kitchen', 'modern kitchen'] },
  { label: 'Balcony',             patterns: ['balcony'] },
  { label: 'Garden / Green Area', patterns: ['garden', 'green area', 'lawn'] },
  { label: 'Elevator / Lift',     patterns: ['elevator', 'lift'] },
  { label: 'Intercom',            patterns: ['intercom'] },
  { label: 'Perimeter Fence',     patterns: ['perimeter fence', 'fenced', 'fence'] },
];

//  HELPERS 

function extractPrice(text) {
  if (!text) return null;
  const t = text.replace(/,/g, '').trim();

  const shorthand = t.match(/[#]?\s*([\d.]+)\s*(billion|million|[BM])\b/i);
  if (shorthand) {
    const val  = parseFloat(shorthand[1]);
    const unit = shorthand[2].toLowerCase();
    if (unit === 'b' || unit === 'billion') return val * 1e9;
    if (unit === 'm' || unit === 'million') return val * 1e6;
  }

  const raw = t.match(/[#]([\d.]+)/);
  if (raw) {
    const val = parseFloat(raw[1]);
    if (val >= 500_000) return val;
  }

  const worded = t.match(/([\d.]+)\s+million\s+naira/i);
  if (worded) return parseFloat(worded[1]) * 1e6;

  // Plain large number with naira context nearby
  const plain = t.match(/\b(\d{7,})\b/);
  if (plain) {
    const val = parseFloat(plain[1]);
    if (val >= 1_000_000) return val;
  }

  return null;
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  return `${num.toLocaleString()}`;
}

function extractBedrooms(text) {
  if (!text) return null;
  const patterns = [/(\d+)\s*bed(?:room)?s?/i, /(\d+)\s*br\b/i, /(\d+)-bed/i];
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
  return AMENITY_PATTERNS
    .filter(a => a.patterns.some(p => lower.includes(p)))
    .map(a => a.label);
}

const PRIORITY_LOCATIONS = [
  'lekki', 'ibeju-lekki', 'ibeju lekki', 'epe', 'ajah', 'sangotedo',
  'lakowe', 'eleko', 'bogije', 'ibeju', 'victoria island', 'ikoyi',
  'banana island', 'oniru', 'chevron', 'jakande', 'ikota', 'vgc', 'lafiaji',
];

function isPriorityLocation(text) {
  const lower = (text || '').toLowerCase();
  return PRIORITY_LOCATIONS.some(loc => lower.includes(loc));
}

function resolvePropertyType(url, title) {
  const text = `${url} ${title}`.toLowerCase();
  if (text.includes('flat') || text.includes('apartment')) return 'Apartment / Flat';
  if (text.includes('duplex') || text.includes('maisonette')) return 'Duplex';
  if (text.includes('bungalow')) return 'Bungalow';
  if (text.includes('terraced')) return 'Terraced House';
  if (text.includes('land')) return 'Land / Plot';
  if (text.includes('house') || text.includes('detached')) return 'Detached House';
  return 'Residential';
}

//  ACTOR MAIN 

Actor.main(async () => {
  console.log('[Actor] Mixta Africa Property Scraper starting...');

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],   // Apify residential proxy pool - bypasses Cloudflare
    countryCode: 'NG',         // Nigerian IPs where possible
  });

  const allListings = [];

  // Build the full request list across all sites and URL types.
  const requestList = LISTING_SITES.flatMap(site =>
    site.urls.map(url => ({ url, userData: { site } }))
  );

  const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    maxConcurrency: 2,   // polite - avoid hammering sites

    async requestHandler({ $, request, log }) {
      const { site } = request.userData;
      const sel      = site.selectors;
      const pageUrl  = request.url;

      log.info(`Scraping ${site.name}: ${pageUrl}`);

      const containers = $(sel.listingContainer);
      log.info(`  Found ${containers.length} listing containers`);

      containers.each((_, el) => {
        const container = $(el);

        //  Extract fields 
        const titleEl   = container.find(sel.title).first();
        const priceEl   = container.find(sel.price).first();
        const locationEl= container.find(sel.location).first();
        const bedroomEl = container.find(sel.bedrooms).first();
        const linkEl    = container.find(sel.link).first();

        const titleText    = titleEl.text().trim();
        const priceText    = priceEl.text().trim();
        const locationText = locationEl.text().trim();
        const bedroomText  = bedroomEl.text().trim();

        // Resolve listing URL - handle relative paths.
        let listingUrl = linkEl.attr('href') || '';
        if (listingUrl && !listingUrl.startsWith('http')) {
          const base = new URL(pageUrl);
          listingUrl = `${base.protocol}//${base.host}${listingUrl.startsWith('/') ? '' : '/'}${listingUrl}`;
        }

        //  Extract amenities from feature list 
        const featureTexts = [];
        container.find(sel.features).each((_, f) => featureTexts.push($(f).text().trim()));
        const featureBlock  = featureTexts.join(' ');
        const fullText      = `${titleText} ${locationText} ${featureBlock}`;
        const amenities     = extractAmenities(fullText);

        //  Parse values 
        const priceValue    = extractPrice(priceText) || extractPrice(titleText);
        const bedrooms      = extractBedrooms(bedroomText) || extractBedrooms(titleText);
        const propertyType  = resolvePropertyType(pageUrl, titleText);
        const priority      = isPriorityLocation(locationText) || isPriorityLocation(titleText);

        // Skip entries with no price and no title - they're navigation elements.
        if (!titleText && !priceValue) return;

        allListings.push({
          source:          site.name,
          sourceRank:      site.rank,
          propertyType,
          bedrooms,
          bedroomLabel:    bedroomLabel(bedrooms),
          locationBucket:  priority ? 'Priority Corridor' : 'Other Lagos',
          title:           titleText || 'Untitled listing',
          location:        locationText,
          priceText:       priceText,
          priceValue:      priceValue || null,
          priceFormatted:  formatPrice(priceValue),
          amenities,
          amenitiesText:   amenities.join(', '),
          listingUrl:      listingUrl || pageUrl,
          scrapedAt:       new Date().toISOString(),
        });
      });

      log.info(`  Extracted ${containers.length} entries from ${site.name}`);
    },

    failedRequestHandler({ request, log }) {
      log.warning(`Failed: ${request.url} - ${request.errorMessages?.join(', ')}`);
    },
  });

  await crawler.run(requestList.map(r => ({ url: r.url, userData: r.userData })));

  // Deduplicate by listing URL.
  const seen = new Set();
  const deduped = allListings.filter(l => {
    const key = l.listingUrl || l.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[Actor] Scraped ${deduped.length} unique listings from ${allListings.length} raw`);

  // Push to Apify dataset - GitHub Actions fetches this via API.
  await Actor.pushData(deduped);

  console.log('[Actor] Complete. Data available in Apify dataset.');
});
