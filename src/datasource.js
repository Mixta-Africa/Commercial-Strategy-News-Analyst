/**
 * Data Source Module
 * 
 * Collects articles from 4 sources:
 * 1. GNews API (~15-30 articles)
 * 2. NewsAPI (~20-40 articles)
 * 3. RSS Feeds (~10-20 articles)
 * 4. Direct URLs — user-configured manual overrides (NEW)
 */

const axios = require('axios');
const xml2js = require('xml2js');
const sourcesConfig = require('./sources.json');
const { quickMatch } = require('./relevance');

// Realistic browser headers — the old 'NewsBot' UA was getting 403-blocked
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

class DataSource {
  constructor() {
    this.gNewsApiKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.timeout = 12000;
    this.config = sourcesConfig;
    // Per-source health for the reliability layer, populated during fetches
    this.sourceHealth = {
      gnews: { ok: false, count: 0, error: null },
      newsapi: { ok: false, count: 0, error: null },
      googlenews: { ok: false, count: 0, error: null },
      rss: { total: 0, feeds: {} },
      directurls: { ok: false, count: 0, error: null },
    };
  }

  /**
   * Real estate keywords used to filter feed items at the source.
   */
  get realEstateKeywords() {
    return [
      'real estate', 'property', 'properties', 'housing', 'land', 'developer',
      'apartment', 'residential', 'commercial', 'construction', 'building',
      'lekki', 'ibeju-lekki', 'ikoyi', 'victoria island', 'epe', 'ajah',
      'property market', 'home sales', 'property prices', 'rent', 'rental',
      'mortgage', 'housing market', 'estate agent', 'realty', 'real-estate',
      'urban development', 'property developer', 'landlord', 'tenancy',
      'house', 'homes', 'plot', 'estate', 'REIT', 'shortlet', 'duplex',
    ];
  }

  matchesRealEstate(title, desc) {
    return quickMatch(title || '', desc || '');
  }

  /**
   * GNews API — targeted real estate query
   * FIX: Pointing correctly to gnews.io
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');
    if (!this.gNewsApiKey) {
      console.log('[GNews] Skipped — API key not configured');
      this.sourceHealth.gnews.error = 'API key missing';
      return [];
    }

    const queries = [
      '"real estate" Lagos',
      'property market Nigeria',
    ];

    const seen = new Set();
    const allArticles = [];

    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      if (qi > 0) await new Promise(r => setTimeout(r, 2000));
      try {
        const response = await axios.get('https://gnews.io/api/v4/search', {
          params: {
            q,
            lang: 'en',
            sortby: 'publishedAt',
            limit: 10,
            apikey: this.gNewsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        console.log(`[GNews] Query "${q}" → ${articles.length} articles`);

        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          allArticles.push({
            title: a.title,
            description: a.description,
            content: a.content,
            url: a.url,
            source: a.source?.name || 'GNews',
            publishedAt: a.publishedAt,
            image: a.image,
          });
        }
      } catch (error) {
        console.error(`[GNews] Error on query "${q}":`, error.message);
        this.sourceHealth.gnews.error = error.response?.status
          ? `HTTP ${error.response.status}` : error.message;
      }
    }

    console.log(`[GNews] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.gnews.count = allArticles.length;
    this.sourceHealth.gnews.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * NewsAPI — strict real estate query
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');
    if (!this.newsApiKey) {
      console.log('[NewsAPI] Skipped — API key not configured');
      this.sourceHealth.newsapi.error = 'API key missing';
      return [];
    }

    const queries = [
      '"real estate" AND (Lagos OR Nigeria)',
      '(property market OR housing market OR property developer OR mortgage) AND (Lagos OR Nigeria)',
      '(Lekki OR "Ibeju-Lekki" OR Ajah OR Lakowe) AND (property OR real estate OR development)',
      '(housing policy OR land use OR FMBN OR "housing deficit") AND Nigeria',
    ];

    const seen = new Set();
    const allArticles = [];

    for (const q of queries) {
      try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
          params: {
            q,
            language: 'en',
            sortBy: 'publishedAt',
            pageSize: 20,
            apiKey: this.newsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        console.log(`[NewsAPI] Query "${q.substring(0, 40)}..." → ${articles.length} articles`);

        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          allArticles.push({
            title: a.title,
            description: a.description,
            content: a.content,
            url: a.url,
            source: a.source?.name || 'NewsAPI',
            publishedAt: a.publishedAt,
            image: a.urlToImage,
          });
        }
      } catch (error) {
        console.error(`[NewsAPI] Error on query "${q.substring(0, 40)}...":`, error.message);
        this.sourceHealth.newsapi.error = error.response?.status
          ? `HTTP ${error.response.status}` : error.message;
      }
    }

    console.log(`[NewsAPI] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.newsapi.count = allArticles.length;
    this.sourceHealth.newsapi.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * RSS Feeds — config-driven, browser-headered, keyword-filtered at source.
   * FIX: Added structural try/catch around XML string parsing to shield from broken publisher formats.
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');

    const rssFeeds = this.config.rssFeeds || [];
    const maxPer = this.config.settings?.maxPerRssFeed || 10;
    const parser = new xml2js.Parser();
    const allArticles = [];

    for (const feed of rssFeeds) {
      try {
        const response = await axios.get(feed.url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });

        // Parse XML safely
        let parsed;
        try {
          parsed = await parser.parseStringPromise(response.data);
        } catch (xmlError) {
          throw new Error(`XML Parsing Malformed Payload: ${xmlError.message}`);
        }

        const items = parsed?.rss?.channel?.[0]?.item || [];

        const articles = items
          .filter(item => this.matchesRealEstate(item.title?.[0], item.description?.[0]))
          .map(item => ({
            title: item.title?.[0] || '',
            description: item.description?.[0] || '',
            content: item['content:encoded']?.[0] || item.description?.[0] || '',
            url: item.link?.[0] || '',
            source: feed.source,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
            trustedSource: true,
            // FIX: sources.json tags every RSS feed with a "geo" field for
            // the geoslicer map (same pattern as googleNewsQueries), but
            // this was never being read here - propagating it now.
            ...(feed.geo ? { geoScope: feed.geo } : {}),
          }))
          .slice(0, maxPer);

        allArticles.push(...articles);
        console.log(`[RSS] ${feed.source}: ${articles.length} real estate articles`);
        this.sourceHealth.rss.feeds[feed.source] = { ok: true, count: articles.length, error: null };
      } catch (error) {
        console.warn(`[RSS] Error fetching ${feed.source}:`, error.message);
        this.sourceHealth.rss.feeds[feed.source] = {
          ok: false,
          count: 0,
          error: error.response?.status ? `HTTP ${error.response.status}` : error.message,
        };
      }
    }

    console.log(`[RSS] Total: ${allArticles.length} articles`);
    this.sourceHealth.rss.total = allArticles.length;
    return allArticles;
  }

  /**
   * Google News RSS — query-based feeds.
   */
  async fetchGoogleNews() {
    console.log('[GoogleNews] Fetching query-based feeds...');

    const queryEntries = this.config.googleNewsQueries || [];
    const maxPer = this.config.settings?.maxPerGoogleQuery || 8;
    const parser = new xml2js.Parser();
    const seen = new Set();
    const allArticles = [];
    let lastError = null;

    for (const entry of queryEntries) {
      // FIX: sources.json was upgraded so each entry is now an object
      // { query, geo } (added to tag articles for the geoslicer map),
      // but this loop was still treating entries as plain strings.
      // encodeURIComponent(object) silently stringifies to the literal
      // text "[object Object]", which Google's RSS search interpreted as
      // a real (nonsense) search term and returned 0 results for every
      // single query - the exact symptom seen in the run log. Support
      // both shapes so older plain-string configs still work too.
      const query = typeof entry === 'string' ? entry : entry?.query;
      const geo = typeof entry === 'object' ? entry?.geo : undefined;

      if (!query) {
        console.warn('[GoogleNews] Skipping malformed query entry:', JSON.stringify(entry));
        continue;
      }

      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-NG&gl=NG&ceid=NG:en`;
      try {
        const response = await axios.get(url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });

        const parsed = await parser.parseStringPromise(response.data);
        const items = parsed?.rss?.channel?.[0]?.item || [];

        let added = 0;
        for (const item of items) {
          if (added >= maxPer) break;
          const rawTitle = item.title?.[0] || '';
          const sourceTag = item.source?.[0];
          const publisher = (typeof sourceTag === 'object' ? sourceTag._ : sourceTag)
            || (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop() : 'Google News');
          const title = rawTitle.includes(' - ')
            ? rawTitle.substring(0, rawTitle.lastIndexOf(' - ')).trim()
            : rawTitle;

          const key = title.toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          if (!this.matchesRealEstate(title, item.description?.[0])) continue;
          seen.add(key);

          allArticles.push({
            title,
            description: (item.description?.[0] || '').replace(/<[^>]+>/g, '').substring(0, 400),
            content: (item.description?.[0] || '').replace(/<[^>]+>/g, ''),
            url: item.link?.[0] || '',
            source: publisher,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
            trustedSource: true, // Forces bypass of standard whitelist gate in index.js
            ...(geo ? { geoScope: geo } : {}), // Carries the geo tag through for the geoslicer map
          });
          added++;
        }
        console.log(`[GoogleNews] "${query}": ${added} articles`);
      } catch (error) {
        lastError = error.response?.status ? `HTTP ${error.response.status}` : error.message;
        console.warn(`[GoogleNews] Error on "${query}":`, error.message);
      }
    }

    console.log(`[GoogleNews] Fetched ${allArticles.length} total articles`);
    this.sourceHealth.googlenews.count = allArticles.length;
    this.sourceHealth.googlenews.ok = allArticles.length > 0;
    this.sourceHealth.googlenews.error = allArticles.length === 0 ? lastError : null;
    return allArticles;
  }

  /**
   * Direct URLs Source (Manual Override Configuration Engine)
   */
  async fetchDirectUrls() {
    let cfg;
    try {
      cfg = require('./NEWS_SOURCES_CONFIG.js');
    } catch (e) {
      console.log('[DirectURL] NEWS_SOURCES_CONFIG.js not found — skipping direct URLs');
      return [];
    }

    const urls = cfg?.directUrls?.urls || [];
    if (!cfg?.directUrls?.enabled || urls.length === 0) {
      console.log('[DirectURL] No direct URLs enabled or configured');
      return [];
    }

    console.log(`[DirectURL] Processing ${urls.length} manual overrides...`);
    const allArticles = [];

    for (const url of urls) {
      try {
        const response = await axios.get(url, {
          timeout: this.timeout,
          headers: BROWSER_HEADERS,
        });
        const html = response.data || '';

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = (titleMatch?.[1] || 'Manual Real Estate Spotlight').trim();

        const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
        const description = (descMatch?.[1] || '').trim();

        allArticles.push({
          title,
          description,
          content: description, 
          url,
          source: 'Direct Configuration Override',
          publishedAt: new Date().toISOString(),
          trustedSource: true,  // Bypasses downstream gating strings entirely
        });
        console.log(`[DirectURL] Successfully extracted: ${title.substring(0, 50)}...`);
      } catch (error) {
        console.error(`[DirectURL] Failed processing execution on "${url}":`, error.message);
      }
    }

    console.log(`[DirectURL] Fetched ${allArticles.length} manual injection overrides`);
    this.sourceHealth.directurls.count = allArticles.length;
    this.sourceHealth.directurls.ok = allArticles.length > 0;
    return allArticles;
  }

  /**
   * Cross-Sector Market Signals — fetches articles from non-real-estate sectors
   * that carry verifiable demand transmission mechanisms for Lagos residential property.
   *
   * SELECTION CRITERIA (McKinsey-grade gate):
   * 1. Sector specificity: article must explicitly mention one of the 7 impact sectors
   * 2. Economic measurability: must contain a rate, price, volume, policy, or timeline
   * 3. Transmission plausibility: must have a credible path to Lagos property demand
   * Reject: opinion without data, general politics, crime, sports
   * Accept: CBN rate decisions, infrastructure milestones, FX policy, corporate expansion
   *
   * Output tagged with geoScope for map plotting and sectorTag for Markets panel routing.
   */
  async fetchCrossSectorSignals() {
    console.log('[CrossSector] Fetching cross-sector market signals...');
    if (!this.newsApiKey) {
      console.log('[CrossSector] Skipped — NewsAPI key not configured');
      return [];
    }

    const queries = [
      // Monetary policy — direct mortgage affordability signal
      '(CBN OR "Central Bank of Nigeria") AND ("interest rate" OR "monetary policy" OR "MPR" OR inflation) AND Nigeria',
      // Infrastructure — corridor value multiplier
      '(Lekki OR "Ibeju-Lekki" OR Lagos) AND (expressway OR highway OR bridge OR "4th Mainland" OR infrastructure) AND (completion OR construction OR contract)',
      // FX and diaspora — buyer pool signal
      '(naira OR forex OR "exchange rate") AND (Nigeria OR Nigerian) AND (dollar OR pound OR remittance OR diaspora)',
      // Corporate expansion — direct B2B demand
      '(Lagos OR Nigeria) AND ("new headquarters" OR "office expansion" OR "free trade zone" OR "Lekki FTZ") AND (company OR firm OR employer)',
      // Energy/power — residential quality signal
      '(Nigeria OR Lagos) AND ("electricity" OR "power supply" OR "energy sector") AND (reform OR improvement OR investment)',
      // Capital markets — buyer financing signal
      '(Nigeria OR Lagos) AND (REIT OR mortgage OR "pension fund" OR "capital market") AND (real estate OR property OR housing)',
    ];

    const seen = new Set();
    const allArticles = [];

    // Selection gate — must contain at least one measurable economic signal
    const economicSignals = [
      /\d+(\.\d+)?%/, /₦[\d,.]+/, /\$[\d,.]+/, /\bN\d+(\.\d+)?[bm]n?\b/i,
      /billion|million|trillion/, /basis point|bps/, /per cent|percent/,
      /deadline|completion|milestone|launch|signed|approved|awarded/i,
    ];

    for (const q of queries) {
      try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
          params: {
            q, language: 'en', sortBy: 'publishedAt', pageSize: 15,
            apiKey: this.newsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          // Apply economic measurability gate
          const text = `${a.title || ''} ${a.description || ''}`;
          const hasEconomicSignal = economicSignals.some(re => re.test(text));
          if (!hasEconomicSignal) continue;
          seen.add(key);
          allArticles.push({
            title: a.title, description: a.description, content: a.content,
            url: a.url, source: a.source?.name || 'NewsAPI',
            publishedAt: a.publishedAt, image: a.urlToImage,
            _lane: 'cross-sector', geoScope: 'nigeria',
          });
        }
        console.log(`[CrossSector] Query "${q.substring(0, 45)}..." → ${articles.length} raw, ${allArticles.length} total kept`);
      } catch (error) {
        console.error(`[CrossSector] Error:`, error.message);
      }
    }

    console.log(`[CrossSector] Fetched ${allArticles.length} cross-sector signals`);
    return allArticles;
  }

  /**
   * Innovation Hub — fetches global real estate innovation and disruption content.
   *
   * SELECTION CRITERIA:
   * 1. Novelty: technology, design concept, business model, or regulatory framework
   *    that is NEW — launched, announced, or described as emerging
   * 2. Application: direct relevance to residential/commercial real estate development,
   *    construction, transaction, or financing
   * 3. Global scope: NOT a local Nigerian market report (that belongs in briefing)
   * Reject: price reports, developer news, housing shortage opinion, local market analysis
   * Accept: proptech launches, sustainable construction, modular/prefab, AI valuation,
   *         smart cities, tokenisation, new financing models, international planning
   */
  async fetchInnovationHub() {
    console.log('[InnoHub] Fetching global real estate innovation...');
    if (!this.newsApiKey) {
      console.log('[InnoHub] Skipped — NewsAPI key not configured');
      return [];
    }

    const queries = [
      // Proptech and digital real estate
      '(proptech OR "property technology") AND (launch OR funding OR platform OR AI)',
      // Sustainable and green construction
      '("sustainable construction" OR "green building" OR "net zero" OR "passive house") AND (real estate OR development OR housing)',
      // Modular, prefab, alternative construction
      '("modular housing" OR "prefab" OR "3D printed" OR "factory-built") AND (home OR housing OR development)',
      // AI and data in real estate
      '("artificial intelligence" OR "machine learning" OR "digital twin") AND (real estate OR property OR construction)',
      // Smart cities and urban innovation
      '("smart city" OR "smart building" OR "urban innovation") AND (real estate OR housing OR development)',
      // New financing and ownership models
      '("real estate tokenization" OR "fractional ownership" OR "co-living" OR "build-to-rent") AND (platform OR model OR launch OR fund)',
      // Global design and planning innovation
      '("mixed-use development" OR "transit-oriented" OR "walkable city") AND (design OR planning OR innovation)',
    ];

    const seen = new Set();
    const allArticles = [];

    // Novelty gate — must contain at least one innovation signal
    const noveltySignals = [
      /launch(ed|es)?|announce(d|s|ment)?|unveil(ed|s)?|introduc(ed|es|tion)?|pioneer/i,
      /new (platform|model|concept|technology|approach|method|system)/i,
      /first (ever|in|to)|world.s first|breakthrough|disrupt/i,
      /fund(ed|ing|raise)|Series [A-D]|\$\d+m? (round|raise|funding)/i,
      /innovation|emerging|transform|revolutio/i,
    ];

    // Hard reject — these are briefing-lane articles
    const rejectPatterns = [
      /nigeria property|lagos real estate|lekki (property|prices|development)/i,
      /housing deficit.*nigeria|nigeria.*housing deficit/i,
      /affordable housing.*nigeria|fmbn|nhf|lsdpc/i,
    ];

    // Real estate presence gate — blocks consumer tech, geopolitics, and general AI
    // articles that match innovation keywords but have no real estate relevance.
    // An article must contain at least one real estate term in its title or description.
    const realEstateGate = [
      /real estate|property|housing|construction|development|proptech|mortgage/i,
      /building|tenant|landlord|reit|mixed.use|urban|city planning|smart building/i,
      /co.living|build.to.rent|fractional ownership|tokeniz.*real|property.*invest/i,
    ];

    for (const q of queries) {
      try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
          params: {
            q, language: 'en', sortBy: 'publishedAt', pageSize: 15,
            apiKey: this.newsApiKey,
          },
          timeout: this.timeout,
        });

        const articles = response.data?.articles || [];
        for (const a of articles) {
          const key = (a.title || '').toLowerCase().trim();
          if (!key || seen.has(key)) continue;
          const text = `${a.title || ''} ${a.description || ''}`;
          // Apply hard reject (briefing-lane content)
          if (rejectPatterns.some(re => re.test(text))) continue;
          // Apply real estate presence gate — article must be about real estate
          if (!realEstateGate.some(re => re.test(text))) continue;
          // Apply novelty gate
          const hasNovelty = noveltySignals.some(re => re.test(text));
          if (!hasNovelty) continue;
          seen.add(key);
          allArticles.push({
            title: a.title, description: a.description, content: a.content,
            url: a.url, source: a.source?.name || 'NewsAPI',
            publishedAt: a.publishedAt, image: a.urlToImage,
            _lane: 'innovation', geoScope: 'global',
          });
        }
        console.log(`[InnoHub] Query "${q.substring(0, 45)}..." → ${articles.length} raw`);
      } catch (error) {
        console.error(`[InnoHub] Error:`, error.message);
      }
    }

    console.log(`[InnoHub] Fetched ${allArticles.length} innovation articles`);
    return allArticles;
  }

  /**
   * Fetch all sources
   */
  async fetchAll() {
    const [gnews, newsapi, rss, direct] = await Promise.allSettled([
      this.fetchGNews(),
      this.fetchNewsAPI(),
      this.fetchRSSFeeds(),
      this.fetchDirectUrls(),
    ]);

    return [
      gnews.status === 'fulfilled' ? gnews.value : [],
      newsapi.status === 'fulfilled' ? newsapi.value : [],
      rss.status === 'fulfilled' ? rss.value : [],
      direct.status === 'fulfilled' ? direct.value : [],
    ];
  }
}

module.exports = DataSource;
