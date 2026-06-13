/**
 * Data Collection Module
 * 
 * Collects articles from:
 * 1. GNews API (15-30 articles, ~2s)
 * 2. NewsAPI (20-40 articles, ~2s)
 * 3. RSS Feeds (10-20 articles, ~1s)
 * 4. Puppeteer Scraper (15-25 articles, ~45s)
 * Total target: 50-100 articles per run
 */

const axios = require('axios');
const xml2js = require('xml2js');
const puppeteer = require('puppeteer');

class DataSource {
  constructor() {
    this.gNewsApiKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.timeout = 10000; // 10 seconds
    this.retryAttempts = 2;
  }

  /**
   * GNews API: Nigerian real estate news
   * Returns ~15-30 articles
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');
    try {
      const response = await axios.get('https://gnews.io/api/v4/search', {
        params: {
          q: 'Lagos real estate Nigeria property OR housing OR development OR construction',
          token: this.gNewsApiKey,
          lang: 'en',
          country: 'NG',
          sortby: 'publishedAt',
          max: 30,
        },
        timeout: this.timeout,
      });

      const articles = (response.data?.articles || []).map(a => ({
        source: a.source?.name || 'GNews',
        title: a.title,
        url: a.url,
        content: a.description,
        image: a.image,
        publishedAt: a.publishedAt,
      }));

      console.log(`[GNews] Fetched ${articles.length} articles`);
      return articles;
    } catch (error) {
      console.error('[GNews] Error:', error.message);
      return [];
    }
  }

  /**
   * NewsAPI: Nigerian property/real estate news
   * Returns ~20-40 articles
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');
    try {
      const response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: '(Lagos OR Lekki OR "real estate" OR property OR housing OR construction) AND Nigeria',
          sortBy: 'publishedAt',
          language: 'en',
          pageSize: 40,
          apiKey: this.newsApiKey,
        },
        timeout: this.timeout,
      });

      const articles = (response.data?.articles || []).map(a => ({
        source: a.source?.name || 'NewsAPI',
        title: a.title,
        url: a.url,
        content: a.description,
        image: a.urlToImage,
        publishedAt: a.publishedAt,
      }));

      console.log(`[NewsAPI] Fetched ${articles.length} articles`);
      return articles;
    } catch (error) {
      console.error('[NewsAPI] Error:', error.message);
      return [];
    }
  }

  /**
   * RSS Feeds: Nigerian news sources
   * Returns ~10-20 articles
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from feeds...');
    const feeds = [
      'https://feeds.bloomberg.com/markets/news.rss',
      'https://feeds.reuters.com/reuters/businessNews',
      'https://feeds.ft.com/ft/companies',
    ];

    const parser = new xml2js.Parser({ explicitArray: false });
    const allArticles = [];

    for (const feedUrl of feeds) {
      try {
        const response = await axios.get(feedUrl, { timeout: this.timeout });
        const parsed = await parser.parseStringPromise(response.data);

        const items = parsed.rss?.channel?.item || [];
        const articlesFromFeed = (Array.isArray(items) ? items : [items])
          .slice(0, 10)
          .map(item => ({
            source: parsed.rss?.channel?.title || 'RSS Feed',
            title: item.title,
            url: item.link,
            content: item.description,
            publishedAt: item.pubDate,
          }))
          .filter(a => a.title && a.url);

        allArticles.push(...articlesFromFeed);
      } catch (error) {
        console.warn(`[RSS] Error fetching ${feedUrl}:`, error.message);
      }
    }

    console.log(`[RSS] Fetched ${allArticles.length} articles`);
    return allArticles;
  }

  /**
   * Puppeteer Scraper: Direct scrape from major Nigerian news sites
   * Returns ~15-25 articles
   * Target sites: ThisDay, Guardian, Premium Times, BusinessDay, Vanguard
   */
  async scrapeNewsWebsites() {
    console.log('[Scraper] Starting Puppeteer scraper...');
    
    const sites = [
      {
        url: 'https://www.thisdaylive.com/index.php/2024/01/property/',
        selector: 'a[href*="/property/"]',
        source: 'ThisDay',
      },
      {
        url: 'https://guardian.ng/property/',
        selector: 'a.story-link',
        source: 'Guardian',
      },
      {
        url: 'https://www.premiumtimesng.com/property/',
        selector: 'a.single-story',
        source: 'Premium Times',
      },
    ];

    let browser;
    const articles = [];

    try {
      browser = await puppeteer.launch({ headless: 'new' });

      for (const site of sites) {
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10000);

          await page.goto(site.url, { waitUntil: 'networkidle2' });

          const pageArticles = await page.evaluate((selector, source) => {
            const links = document.querySelectorAll(selector);
            const results = [];

            links.forEach(link => {
              const title = link.textContent?.trim() || link.title;
              const url = link.href;
              if (title && url && title.length > 10) {
                results.push({
                  title,
                  url,
                  source,
                });
              }
            });

            return results.slice(0, 10);
          }, site.selector, site.source);

          articles.push(...pageArticles);
          await page.close();
        } catch (error) {
          console.warn(`[Scraper] Error scraping ${site.url}:`, error.message);
        }
      }

      await browser.close();
      console.log(`[Scraper] Scraped ${articles.length} articles`);
    } catch (error) {
      console.error('[Scraper] Fatal error:', error.message);
      if (browser) await browser.close();
    }

    return articles;
  }

  /**
   * Fetch full article content for analysis
   * Used to enrich summaries with full article text
   */
  async fetchFullContent(url) {
    try {
      const response = await axios.get(url, { timeout: 5000 });
      return response.data;
    } catch (error) {
      console.warn(`[Content Fetch] Error fetching ${url}:`, error.message);
      return '';
    }
  }

  /**
   * Main orchestration: collect from all sources
   */
  async collectAll() {
    const [gnews, newsapi, rss, scraped] = await Promise.all([
      this.fetchGNews(),
      this.fetchNewsAPI(),
      this.fetchRSSFeeds(),
      this.scrapeNewsWebsites(),
    ]);

    return [...gnews, ...newsapi, ...rss, ...scraped];
  }
}

module.exports = DataSource;
