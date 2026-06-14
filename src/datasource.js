/**
 * Data Source Module
 * 
 * Collects articles from 3 sources:
 * 1. GNews API (~15-30 articles)
 * 2. NewsAPI (~20-40 articles)
 * 3. RSS Feeds (~10-20 articles)
 */

const axios = require('axios');
const xml2js = require('xml2js');

class DataSource {
  constructor() {
    this.gNewsApiKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.timeout = 10000;
  }

  /**
   * GNews API — targeted real estate query
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');

    const queries = [
      '"real estate" Lagos',
      'property market Nigeria',
    ];

    const seen = new Set();
    const allArticles = [];

    for (const q of queries) {
      try {
        const response = await axios.get('https://gnews.io/api/v4/search', {
          params: {
            q,
            lang: 'en',
            country: 'ng',
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
      }
    }

    console.log(`[GNews] Fetched ${allArticles.length} total articles`);
    return allArticles;
  }

  /**
   * NewsAPI — strict real estate query
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');

    // Run two targeted queries and merge results
    const queries = [
      '"real estate" AND (Lagos OR Nigeria)',
      '(property market OR housing market OR property developer OR mortgage) AND (Lagos OR Nigeria)',
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
      }
    }

    console.log(`[NewsAPI] Fetched ${allArticles.length} total articles`);
    return allArticles;
  }

  /**
   * RSS Feeds — real estate keyword filter applied at source
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');

    const rssFeeds = [
      { url: 'https://www.thisdaylive.com/feed', source: 'ThisDay' },
      { url: 'https://www.premiumtimesng.com/feed', source: 'Premium Times' },
      { url: 'https://businessday.ng/feed', source: 'BusinessDay' },
      { url: 'https://guardian.ng/feed', source: 'Guardian' },
      { url: 'https://punchng.com/feed', source: 'The Punch' },
      { url: 'https://www.vanguardngr.com/feed', source: 'Vanguard' },
    ];

    // Real estate keywords to filter RSS items at the source
    const realEstateKeywords = [
      'real estate', 'property', 'housing', 'land', 'developer',
      'apartment', 'residential', 'commercial', 'construction',
      'building', 'lekki', 'ibeju-lekki', 'ikoyi', 'victoria island',
      'property market', 'home sales', 'property prices', 'rent',
      'mortgage', 'housing market', 'estate agent', 'realty',
      'urban development', 'rental market', 'property developer',
    ];

    const parser = new xml2js.Parser();
    const allArticles = [];

    for (const feed of rssFeeds) {
      try {
        const response = await axios.get(feed.url, {
          timeout: this.timeout,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
          },
        });

        const parsed = await parser.parseStringPromise(response.data);
        const items = parsed?.rss?.channel?.[0]?.item || [];

        const articles = items
          .filter(item => {
            const title = (item.title?.[0] || '').toLowerCase();
            const desc = (item.description?.[0] || '').toLowerCase().substring(0, 300);
            return realEstateKeywords.some(kw => title.includes(kw) || desc.includes(kw));
          })
          .map(item => ({
            title: item.title?.[0] || '',
            description: item.description?.[0] || '',
            content: item['content:encoded']?.[0] || item.description?.[0] || '',
            url: item.link?.[0] || '',
            source: feed.source,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
          }))
          .slice(0, 10);

        allArticles.push(...articles);
        console.log(`[RSS] ${feed.source}: ${articles.length} real estate articles`);
      } catch (error) {
        console.warn(`[RSS] Error fetching ${feed.source}:`, error.message);
      }
    }

    console.log(`[RSS] Total: ${allArticles.length} articles`);
    return allArticles;
  }

  /**
   * Fetch all sources
   */
  async fetchAll() {
    const [gnews, newsapi, rss] = await Promise.allSettled([
      this.fetchGNews(),
      this.fetchNewsAPI(),
      this.fetchRSSFeeds(),
    ]);

    return [
      gnews.status === 'fulfilled' ? gnews.value : [],
      newsapi.status === 'fulfilled' ? newsapi.value : [],
      rss.status === 'fulfilled' ? rss.value : [],
      [], // Empty array replacing scraper
    ];
  }
}

module.exports = DataSource;
