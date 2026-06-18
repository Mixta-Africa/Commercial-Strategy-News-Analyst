/**
 * Competitive Intelligence Scraper
 * ==================================
 * Two scraping lanes, fully isolated from the main briefing pipeline:
 *
 * LANE A — Competitor News
 *   Google News RSS queries per competitor. No API key required.
 *   Returns press coverage, launches, deals, regulatory mentions.
 *
 * LANE B — Property Price Listings
 *   Puppeteer (headless Chromium) + Cheerio for price extraction.
 *   Sites ranked by authenticity in competitive-config.js.
 *   Extracts: property type, location, price (NGN), bedrooms, source URL.
 *
 * Isolation guarantees:
 *   - Does NOT write to the main articles.json / briefing.json.
 *   - Does NOT consume agents.js Groq 8b/70b RPD buckets.
 *   - Uses its own per-article browser instance pattern (same as content-enricher.js).
 */

const axios = require('axios');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const config = require('./competitive-config');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const TIMEOUT = 15000;
const MAX_LISTINGS_PER_TYPE = 8; // listings per property type per site

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalisePrice(rawText) {
  if (!rawText) return null;
  const cleaned = rawText.replace(/[^\d,.]/g, '').replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1_000_000_000) return `₦${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `₦${(num / 1_000_000).toFixed(1)}M`;
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
  constructor() {
    this.parser = new xml2js.Parser();
  }

  async fetchCompetitorNews(competitor) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(competitor.newsQuery)}&hl=en-NG&gl=NG&ceid=NG:en`;
    const results = [];

    try {
      const res = await axios.get(url, { timeout: TIMEOUT, headers: BROWSER_HEADERS });
      const parsed = await this.parser.parseStringPromise(res.data);
      const items = parsed?.rss?.channel?.[0]?.item || [];

      for (const item of items.slice(0, 10)) {
        const rawTitle = item.title?.[0] || '';
        const sourceTag = item.source?.[0];
        const publisher = (typeof sourceTag === 'object' ? sourceTag._ : sourceTag) || 'Google News';
        const title = rawTitle.includes(' - ')
          ? rawTitle.substring(0, rawTitle.lastIndexOf(' - ')).trim()
          : rawTitle;

        if (!title) continue;

        const description = (item.description?.[0] || '').replace(/<[^>]+>/g, '').substring(0, 500);
        const fullText = `${title} ${description}`;
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
  constructor() {
    this.puppeteer = null; // lazy-loaded
  }

  async getPuppeteer() {
    if (!this.puppeteer) this.puppeteer = require('puppeteer');
    return this.puppeteer;
  }

  /**
   * Scrape a single URL with Puppeteer (isolated browser per call, same
   * pattern as content-enricher.js v4.1 to prevent OOM crashes).
   */
  async scrapeWithBrowser(url) {
    const puppeteer = await this.getPuppeteer();
    let browser = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--disable-gpu',
          '--single-process',
        ],
      });
      const page = await browser.newPage();
      await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
      await page.setDefaultNavigationTimeout(20000);

      await Promise.race([
        page.goto(url, { waitUntil: 'domcontentloaded' }),
        sleep(18000).then(() => { throw new Error('Navigation timeout'); }),
      ]);

      await sleep(1500); // allow JS-rendered content to settle
      return await page.content();
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Axios fallback for sites that serve full HTML without JS rendering.
   */
  async scrapeWithAxios(url) {
    const res = await axios.get(url, { timeout: TIMEOUT, headers: BROWSER_HEADERS });
    return res.data;
  }

  extractListings(html, site, propertyType) {
    const $ = cheerio.load(html);
    const listings = [];

    // We try a broad set of selectors since listing site DOM structures vary.
    // Each site's configured selectors are tried first; generic fallbacks after.
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

    // Build listing cards: zip title + price + location from parallel DOM positions.
    const prices = [];
    for (const sel of priceSelectors) {
      $(sel).each((_, el) => {
        const txt = $(el).text().trim();
        const num = normalisePrice(txt);
        if (num && num > 500_000) { // filter out noise (page numbers, etc.)
          prices.push({ raw: txt, value: num });
        }
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

    const count = Math.min(prices.length, MAX_LISTINGS_PER_TYPE);
    for (let i = 0; i < count; i++) {
      const locationText = locations[i] || '';
      const titleText = titles[i] || '';
      const fullText = `${titleText} ${locationText}`;
      const watchlistHits = checkWatchlist(fullText);

      listings.push({
        type: 'price_listing',
        source: site.name,
        sourceDomain: site.domain,
        sourceRank: site.rank,
        sourceAuthenticity: site.authenticity,
        propertyType: normaliseType(propertyType),
        title: titleText,
        location: locationText,
        priceRaw: prices[i]?.raw || 'N/A',
        priceValue: prices[i]?.value || null,
        priceFormatted: formatPrice(prices[i]?.value),
        priorityLocation: checkPriorityLocation(fullText),
        watchlistHits,
        flagged: watchlistHits.length > 0,
        scrapedAt: new Date().toISOString(),
        listingUrl: site.searchUrl.replace('{TYPE}', propertyType),
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
        // Try Axios first (fast, no overhead). Fall back to Puppeteer if it
        // returns too little content (JS-rendered sites return a skeleton).
        let html = '';
        try {
          html = await this.scrapeWithAxios(url);
        } catch (_) {
          html = '';
        }

        // Heuristic: if Axios returned <5k chars, the page is likely JS-rendered.
        if (html.length < 5000) {
          console.log(`[Listings] ${site.name}/${pType} — switching to Puppeteer`);
          html = await this.scrapeWithBrowser(url);
        }

        const listings = this.extractListings(html, site, pType);
        allListings.push(...listings);
        console.log(`[Listings] ${site.name} / ${pType}: ${listings.length} listings`);
        await sleep(1500); // polite crawl delay between property types
      } catch (err) {
        console.warn(`[Listings] ${site.name}/${pType} failed: ${err.message}`);
      }
    }
    return allListings;
  }

  async fetchAll() {
    console.log('\n[Listings] Starting property price collection...');
    const allListings = [];

    // Process sites sequentially to avoid OOM from parallel Puppeteer instances.
    for (const site of config.listingSites) {
      const listings = await this.scrapeSite(site);
      allListings.push(...listings);
      await sleep(2000); // inter-site delay
    }

    console.log(`[Listings] Total: ${allListings.length} price listings collected`);
    return allListings;
  }
}

// ─── ORCHESTRATOR ─────────────────────────────────────────────────────────────

class CompetitiveScraper {
  async run() {
    console.log('\n[Competitive] ===== SCRAPE START =====');

    const newsCollector = new CompetitorNewsCollector();
    const listingScraper = new ListingPriceScraper();

    // News can run in parallel with the first listing site (they don't share resources).
    const [competitorNews, priceListings] = await Promise.all([
      newsCollector.fetchAll(),
      listingScraper.fetchAll(),
    ]);

    const allData = { competitorNews, priceListings };

    // Summary stats for the pipeline log.
    const flaggedNews = competitorNews.filter(n => n.flagged).length;
    const flaggedListings = priceListings.filter(l => l.flagged).length;
    const priorityListings = priceListings.filter(l => l.priorityLocation).length;

    console.log(`\n[Competitive] ===== SCRAPE COMPLETE =====`);
    console.log(`  Competitor news:    ${competitorNews.length} items (${flaggedNews} flagged)`);
    console.log(`  Price listings:     ${priceListings.length} items (${flaggedListings} watchlist hits, ${priorityListings} priority locations)`);

    return allData;
  }
}

module.exports = CompetitiveScraper;
