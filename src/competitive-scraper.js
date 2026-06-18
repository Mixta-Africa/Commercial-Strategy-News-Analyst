/**
 * Competitive Intelligence Scraper — v2
 * =======================================
 * Adds bedroom count extraction and amenity scraping to the base scraper.
 *
 * BEDROOM GROUPING STRATEGY (clutter reduction):
 *   Raw listings are scraped individually but grouped before Sheet write.
 *   Each Sheet row = one (PropertyType × Bedrooms × Location) group,
 *   showing count, min/max/avg price, and the top amenities for that group.
 *   Full raw listings are preserved in competitive-prices.json for the dashboard.
 *
 * AMENITY EXTRACTION:
 *   Extracted from listing cards using a broad keyword scanner.
 *   Normalised into a standard taxonomy (pools, parking, gym, security, etc.)
 *   so cross-site comparison is meaningful.
 */

const axios   = require('axios');
const xml2js  = require('xml2js');
const cheerio = require('cheerio');
const config  = require('./competitive-config');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const TIMEOUT = 15000;
const MAX_LISTINGS_PER_TYPE = 12; // slightly more to improve grouping quality

// ─── AMENITY TAXONOMY ─────────────────────────────────────────────────────────
// Each entry: { key, label, patterns }
// patterns are searched in the full listing text (title + description + card text).
const AMENITY_TAXONOMY = [
  { key: 'swimming_pool',   label: 'Swimming Pool',    patterns: ['pool', 'swimming'] },
  { key: 'gym',             label: 'Gym / Fitness',    patterns: ['gym', 'fitness', 'exercise room'] },
  { key: 'security',        label: '24hr Security',    patterns: ['security', 'gated', 'guarded', 'cctv'] },
  { key: 'parking',         label: 'Parking',          patterns: ['parking', 'garage', 'car park', 'carport'] },
  { key: 'generator',       label: 'Standby Generator',patterns: ['generator', 'gen', 'power backup'] },
  { key: 'borehole',        label: 'Borehole / Water', patterns: ['borehole', 'water supply', 'treated water'] },
  { key: 'serviced',        label: 'Serviced',         patterns: ['serviced', 'fully serviced'] },
  { key: 'estate',          label: 'Estate / Compound',patterns: ['estate', 'compound', 'gated community'] },
  { key: 'boys_quarters',   label: "Boys' Quarters",   patterns: ["boys' quarters", "bq", "boys quarter"] },
  { key: 'smart_home',      label: 'Smart Home',       patterns: ['smart home', 'smart house', 'automated'] },
  { key: 'solar',           label: 'Solar Power',      patterns: ['solar'] },
  { key: 'air_conditioning',label: 'Air Conditioning', patterns: ['air condition', 'ac unit', 'a/c'] },
  { key: 'fitted_kitchen',  label: 'Fitted Kitchen',   patterns: ['fitted kitchen', 'modern kitchen', 'equipped kitchen'] },
  { key: 'pop_ceiling',     label: 'POP Ceiling',      patterns: ['pop ceiling', 'pop', 'plaster ceiling'] },
  { key: 'balcony',         label: 'Balcony',          patterns: ['balcony', 'terrace'] },
  { key: 'green_area',      label: 'Green Area / Garden', patterns: ['garden', 'green area', 'lawn'] },
];

// ─── BEDROOM NORMALISATION ────────────────────────────────────────────────────
// Patterns to extract bedroom count from listing text.
const BEDROOM_PATTERNS = [
  /(\d+)\s*bed(?:room)?s?/i,
  /(\d+)\s*br\b/i,
  /(\d+)\s*bdrm/i,
  /(\d+)-bed/i,
];

function extractBedrooms(text) {
  if (!text) return null;
  for (const pat of BEDROOM_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 10) return n; // sanity gate
    }
  }
  return null;
}

function bedroomLabel(n) {
  if (!n) return 'Unspecified';
  if (n === 1) return '1 Bedroom';
  if (n >= 5) return '5+ Bedrooms';
  return `${n} Bedrooms`;
}

// ─── AMENITY EXTRACTOR ────────────────────────────────────────────────────────

function extractAmenities(text) {
  const lower = (text || '').toLowerCase();
  return AMENITY_TAXONOMY
    .filter(a => a.patterns.some(p => lower.includes(p)))
    .map(a => a.key);
}

function amenityLabels(keys) {
  return keys.map(k => {
    const a = AMENITY_TAXONOMY.find(t => t.key === k);
    return a ? a.label : k;
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalisePrice(rawText) {
  if (!rawText) return null;
  // Handle shorthand like "45M", "1.2B"
  const shorthand = String(rawText).match(/([\d.]+)\s*([MB])/i);
  if (shorthand) {
    const val = parseFloat(shorthand[1]);
    return shorthand[2].toUpperCase() === 'B' ? val * 1e9 : val * 1e6;
  }
  const cleaned = String(rawText).replace(/[^\d.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) || num < 500_000 ? null : num;
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return `₦${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `₦${(num / 1e6).toFixed(1)}M`;
  return `₦${num.toLocaleString()}`;
}

function normaliseType(raw) {
  if (!raw) return 'Unknown';
  const key = raw.toLowerCase().trim().replace(/\s+/g, '-');
  return config.propertyTypeMap[key] || config.propertyTypeMap[raw.toLowerCase()] || raw;
}

function checkWatchlist(text) {
  const lower = (text || '').toLowerCase();
  return config.watchlist.filter(term => lower.includes(term.toLowerCase()));
}

function checkPriorityLocation(text) {
  const lower = (text || '').toLowerCase();
  return config.priorityLocations.some(loc => lower.includes(loc.toLowerCase()));
}

// ─── LANE A: COMPETITOR NEWS ──────────────────────────────────────────────────

class CompetitorNewsCollector {
  constructor() { this.parser = new xml2js.Parser(); }

  async fetchCompetitorNews(competitor) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(competitor.newsQuery)}&hl=en-NG&gl=NG&ceid=NG:en`;
    const results = [];
    try {
      const res    = await axios.get(url, { timeout: TIMEOUT, headers: BROWSER_HEADERS });
      const parsed = await this.parser.parseStringPromise(res.data);
      const items  = parsed?.rss?.channel?.[0]?.item || [];

      for (const item of items.slice(0, 10)) {
        const rawTitle   = item.title?.[0] || '';
        const sourceTag  = item.source?.[0];
        const publisher  = (typeof sourceTag === 'object' ? sourceTag._ : sourceTag) || 'Google News';
        const title      = rawTitle.includes(' - ')
          ? rawTitle.substring(0, rawTitle.lastIndexOf(' - ')).trim()
          : rawTitle;
        if (!title) continue;

        const description  = (item.description?.[0] || '').replace(/<[^>]+>/g, '').substring(0, 500);
        const fullText     = `${title} ${description}`;
        const watchlistHits = checkWatchlist(fullText);

        results.push({
          type: 'competitor_news',
          competitor: competitor.name,
          domain: competitor.domain,
          title,
          description,
          url: item.link?.[0] || '',
          publisher,
          publishedAt: item.pubDate?.[0] || new Date().toISOString(),
          watchlistHits,
          flagged: watchlistHits.length > 0,
          priorityLocation: checkPriorityLocation(fullText),
        });
      }
      console.log(`[CompNews] ${competitor.name}: ${results.length} articles`);
    } catch (err) {
      console.warn(`[CompNews] ${competitor.name} failed: ${err.message}`);
    }
    return results;
  }

  async fetchAll() {
    console.log('\n[CompNews] Fetching competitor news...');
    const settled = await Promise.allSettled(
      config.competitors.map(c => this.fetchCompetitorNews(c))
    );
    const all = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') all.push(...s.value);
    }
    console.log(`[CompNews] Total: ${all.length} competitor news items`);
    return all;
  }
}

// ─── LANE B: PROPERTY PRICE LISTINGS ─────────────────────────────────────────

class ListingPriceScraper {
  constructor() { this.puppeteer = null; }

  async getPuppeteer() {
    if (!this.puppeteer) this.puppeteer = require('puppeteer');
    return this.puppeteer;
  }

  async scrapeWithBrowser(url) {
    const puppeteer = await this.getPuppeteer();
    let browser = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      });
      const page = await browser.newPage();
      await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
      await page.setDefaultNavigationTimeout(20000);
      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded' }),
        sleep(18000).then(() => { throw new Error('Navigation timeout'); }),
      ]);
      await sleep(1500);
      return await page.content();
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  async scrapeWithAxios(url) {
    const res = await axios.get(url, { timeout: TIMEOUT, headers: BROWSER_HEADERS });
    return res.data;
  }

  extractListings(html, site, propertyType) {
    const $ = cheerio.load(html);
    const listings = [];

    // ── Selector priority lists ──
    const priceSelectors = [
      site.priceSelector,
      '[class*="price"]', '[class*="Price"]', '[data-price]',
      '.amount', '.listing-price', 'span.price',
    ].filter(Boolean);

    const titleSelectors = [
      site.titleSelector,
      '[class*="title"]', '[class*="Title"]', 'h2', 'h3',
      '.property-name', '.listing-title',
    ].filter(Boolean);

    const locationSelectors = [
      site.locationSelector,
      '[class*="location"]', '[class*="address"]',
      '.area', '.neighbourhood',
    ].filter(Boolean);

    // Bedroom selectors — Nigerian sites often put this in a features list.
    const bedroomSelectors = [
      '[class*="bed"]', '[data-beds]', '.beds', '.bedroom',
      'span:contains("bed")', 'li:contains("bed")',
    ];

    // Amenity selectors — pull the full feature/description block.
    const amenitySelectors = [
      '[class*="feature"]', '[class*="amenity"]', '[class*="facility"]',
      '.description', '.property-description', 'ul.features', 'ul.amenities',
    ];

    // ── Extract parallel arrays ──
    const prices = [];
    for (const sel of priceSelectors) {
      $(sel).each((_, el) => {
        const txt = $(el).text().trim();
        const num = normalisePrice(txt);
        if (num) prices.push({ raw: txt, value: num });
      });
      if (prices.length) break;
    }

    const titles = [];
    for (const sel of titleSelectors) {
      $(sel).each((_, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 5 && txt.length < 200) titles.push(txt);
      });
      if (titles.length) break;
    }

    const locations = [];
    for (const sel of locationSelectors) {
      $(sel).each((_, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 3 && txt.length < 100) locations.push(txt);
      });
      if (locations.length) break;
    }

    // Bedroom counts — try to extract one per listing position.
    const bedroomTexts = [];
    for (const sel of bedroomSelectors) {
      try {
        $(sel).each((_, el) => bedroomTexts.push($(el).text().trim()));
        if (bedroomTexts.length) break;
      } catch (_) {}
    }

    // Amenity text blocks — concatenated for keyword scanning.
    const amenityBlocks = [];
    for (const sel of amenitySelectors) {
      $(sel).each((_, el) => amenityBlocks.push($(el).text()));
    }
    const globalAmenityText = amenityBlocks.join(' ');

    // ── Build listing objects ──
    const count = Math.min(prices.length, MAX_LISTINGS_PER_TYPE);
    for (let i = 0; i < count; i++) {
      const titleText    = titles[i] || '';
      const locationText = locations[i] || '';
      const bedroomText  = bedroomTexts[i] || titleText; // title often contains "3 bed"
      const fullText     = `${titleText} ${locationText} ${globalAmenityText}`;

      const bedrooms      = extractBedrooms(bedroomText) || extractBedrooms(titleText);
      const amenityKeys   = extractAmenities(fullText);
      const watchlistHits = checkWatchlist(fullText);

      listings.push({
        type:              'price_listing',
        source:            site.name,
        sourceDomain:      site.domain,
        sourceRank:        site.rank,
        propertyType:      normaliseType(propertyType),
        bedrooms,
        bedroomLabel:      bedroomLabel(bedrooms),
        title:             titleText,
        location:          locationText,
        priceRaw:          prices[i]?.raw || 'N/A',
        priceValue:        prices[i]?.value || null,
        priceFormatted:    formatPrice(prices[i]?.value),
        amenityKeys,
        amenityLabels:     amenityLabels(amenityKeys),
        priorityLocation:  checkPriorityLocation(fullText),
        watchlistHits,
        flagged:           watchlistHits.length > 0,
        scrapedAt:         new Date().toISOString(),
        listingUrl:        site.searchUrl.replace('{TYPE}', propertyType),
      });
    }
    return listings;
  }

  async scrapeSite(site) {
    const allListings = [];
    console.log(`[Listings] Scraping ${site.name} (Rank #${site.rank})...`);

    for (const pType of site.propertyTypes) {
      const url = site.searchUrl.replace('{TYPE}', pType);
      try {
        let html = '';
        try { html = await this.scrapeWithAxios(url); } catch (_) { html = ''; }
        if (html.length < 5000) {
          console.log(`[Listings] ${site.name}/${pType} — switching to Puppeteer`);
          html = await this.scrapeWithBrowser(url);
        }
        const listings = this.extractListings(html, site, pType);
        allListings.push(...listings);
        console.log(`[Listings] ${site.name}/${pType}: ${listings.length} listings`);
        await sleep(1500);
      } catch (err) {
        console.warn(`[Listings] ${site.name}/${pType} failed: ${err.message}`);
      }
    }
    return allListings;
  }

  async fetchAll() {
    console.log('\n[Listings] Starting property price collection...');
    const allListings = [];
    for (const site of config.listingSites) {
      const listings = await this.scrapeSite(site);
      allListings.push(...listings);
      await sleep(2000);
    }
    console.log(`[Listings] Total: ${allListings.length} listings collected`);
    return allListings;
  }
}

// ─── GROUPING ENGINE ──────────────────────────────────────────────────────────
/**
 * Groups raw listings by (PropertyType × BedroomLabel × LocationBucket).
 * This is the clutter-reduction layer: instead of 80 rows of raw Lekki
 * apartments, the Sheet gets one row per group with aggregated stats.
 *
 * LocationBucket: "Priority" (Lekki/Ibeju-Lekki corridor) vs "Other Lagos".
 * This keeps the Sheet readable while preserving granularity where it matters.
 */
function groupListings(listings) {
  const groups = {};

  for (const l of listings) {
    if (!l.priceValue) continue; // skip listings with no price — noise

    const locationBucket = l.priorityLocation ? 'Priority Corridor' : 'Other Lagos';
    const key = `${l.propertyType}||${l.bedroomLabel}||${locationBucket}`;

    if (!groups[key]) {
      groups[key] = {
        propertyType:   l.propertyType,
        bedroomLabel:   l.bedroomLabel,
        bedrooms:       l.bedrooms,
        locationBucket,
        prices:         [],
        amenityCounts:  {},
        sources:        new Set(),
        flagged:        false,
        watchlistHits:  new Set(),
        sampleListings: [],
      };
    }

    const g = groups[key];
    g.prices.push(l.priceValue);
    g.sources.add(l.source);
    if (l.flagged) g.flagged = true;
    l.watchlistHits.forEach(h => g.watchlistHits.add(h));

    // Count amenity frequency across listings in the group.
    for (const a of l.amenityKeys) {
      g.amenityCounts[a] = (g.amenityCounts[a] || 0) + 1;
    }

    // Keep up to 3 sample listing titles for context in the Sheet.
    if (g.sampleListings.length < 3 && l.title) {
      g.sampleListings.push(l.title);
    }
  }

  // Compute stats per group and pick top amenities.
  return Object.values(groups).map(g => {
    const sorted = g.prices.slice().sort((a, b) => a - b);
    const avg    = g.prices.reduce((s, v) => s + v, 0) / g.prices.length;

    // Top amenities = those present in >30% of listings in the group, sorted by frequency.
    const threshold = Math.max(1, Math.ceil(g.prices.length * 0.3));
    const topAmenities = Object.entries(g.amenityCounts)
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key]) => {
        const a = AMENITY_TAXONOMY.find(t => t.key === key);
        return a ? a.label : key;
      });

    return {
      propertyType:    g.propertyType,
      bedroomLabel:    g.bedroomLabel,
      bedrooms:        g.bedrooms,
      locationBucket:  g.locationBucket,
      listingCount:    g.prices.length,
      minPrice:        sorted[0],
      maxPrice:        sorted[sorted.length - 1],
      avgPrice:        Math.round(avg),
      medianPrice:     sorted[Math.floor(sorted.length / 2)],
      minFormatted:    formatPrice(sorted[0]),
      maxFormatted:    formatPrice(sorted[sorted.length - 1]),
      avgFormatted:    formatPrice(Math.round(avg)),
      sources:         [...g.sources].join(', '),
      topAmenities:    topAmenities.join(', ') || 'None detected',
      flagged:         g.flagged,
      watchlistHits:   [...g.watchlistHits].join(', ') || '',
      sampleListings:  g.sampleListings.join(' | '),
    };
  }).sort((a, b) => {
    // Sort: Priority Corridor first, then by property type, then bedrooms.
    if (a.locationBucket !== b.locationBucket) return a.locationBucket === 'Priority Corridor' ? -1 : 1;
    if (a.propertyType !== b.propertyType) return a.propertyType.localeCompare(b.propertyType);
    return (a.bedrooms || 99) - (b.bedrooms || 99);
  });
}

// ─── ORCHESTRATOR ─────────────────────────────────────────────────────────────

class CompetitiveScraper {
  async run() {
    console.log('\n[Competitive] ===== SCRAPE START =====');

    const newsCollector  = new CompetitorNewsCollector();
    const listingScraper = new ListingPriceScraper();

    const [competitorNews, priceListings] = await Promise.all([
      newsCollector.fetchAll(),
      listingScraper.fetchAll(),
    ]);

    const groupedListings = groupListings(priceListings);

    const flaggedNews     = competitorNews.filter(n => n.flagged).length;
    const flaggedListings = priceListings.filter(l => l.flagged).length;
    const priorityGroups  = groupedListings.filter(g => g.locationBucket === 'Priority Corridor').length;

    console.log(`\n[Competitive] ===== SCRAPE COMPLETE =====`);
    console.log(`  Competitor news:    ${competitorNews.length} items (${flaggedNews} flagged)`);
    console.log(`  Price listings:     ${priceListings.length} raw → ${groupedListings.length} groups (${priorityGroups} priority corridor)`);

    return { competitorNews, priceListings, groupedListings };
  }
}

module.exports = { CompetitiveScraper, groupListings, AMENITY_TAXONOMY };
