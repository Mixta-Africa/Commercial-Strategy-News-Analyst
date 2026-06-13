/**
 * Data Source Module
 * 
 * Collects articles from 4 sources:
 * 1. GNews API (~15-30 articles)
 * 2. NewsAPI (~20-40 articles)
 * 3. RSS Feeds (~10-20 articles)
 * 4. Puppeteer Web Scraper (~15-25 articles)
 * 
 * Target: 50-100 raw articles per run
 */

const axios = require('axios');
const xml2js = require('xml2js');
const puppeteer = require('puppeteer');

class DataSource {
  constructor() {
    this.gNewsApiKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_KEY;
    this.timeout = 10000;
  }

  /**
   * GNews API (Free: 100 req/day)
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');
    
    try {
      const response = await axios.get('https://gnews.io/api/v4/search', {
        params: {
          q: '(real estate OR property OR housing OR construction) AND (Lagos OR Nigeria)',
          lang: 'en',
          sortby: 'publishedAt',
          limit: 30,
          apikey: this.gNewsApiKey,
        },
        timeout: this.timeout,
      });

      const articles = response.data?.articles || [];
      console.log(`[GNews] Fetched ${articles.length} articles`);

      return articles.map(a => ({
        title: a.title,
        description: a.description,
        content: a.content,
        url: a.url,
        source: a.source?.name || 'GNews',
        publishedAt: a.publishedAt,
        image: a.image,
      }));
    } catch (error) {
      console.error('[GNews] Error:', error.message);
      return [];
    }
  }

  /**
   * NewsAPI (Free: 100 req/day)
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');
    
    try {
      const response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: '(real estate OR property OR housing OR construction) AND (Lagos OR Nigeria)',
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: 40,
          apiKey: this.newsApiKey,
        },
        timeout: this.timeout,
      });

      const articles = response.data?.articles || [];
      console.log(`[NewsAPI] Fetched ${articles.length} articles`);

      return articles.map(a => ({
        title: a.title,
        description: a.description,
        content: a.content,
        url: a.url,
        source: a.source?.name || 'NewsAPI',
        publishedAt: a.publishedAt,
        image: a.urlToImage,
      }));
    } catch (error) {
      console.error('[NewsAPI] Error:', error.message);
      return [];
    }
  }

  /**
   * RSS Feeds (Property Pro Africa, Lagos State Gov, etc.)
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');

    const rssFeeds = [
      'https://www.thisdaylive.com/feed',
      'https://guardian.ng/feed',
      'https://www.premiumtimesng.com/feed',
      'https://businessday.ng/feed',
    ];

    const parser = new xml2js.Parser();
    const allArticles = [];

    for (const feedUrl of rssFeeds) {
      try {
        const response = await axios.get(feedUrl, { timeout: this.timeout });
        const parsed = await parser.parseStringPromise(response.data);
        
        const items = parsed?.rss?.channel?.[0]?.item || [];
        
        const articles = items
          .filter(item => {
            const title = item.title?.[0] || '';
            return title.toLowerCase().includes('real estate') ||
                   title.toLowerCase().includes('property') ||
                   title.toLowerCase().includes('housing') ||
                   title.toLowerCase().includes('construction');
          })
          .map(item => ({
            title: item.title?.[0] || '',
            description: item.description?.[0] || '',
            content: item.content || '',
            url: item.link?.[0] || '',
            source: feedUrl.split('/')[2] || 'RSS',
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
          }))
          .slice(0, 5);

        allArticles.push(...articles);
      } catch (error) {
        console.warn(`[RSS] Error fetching ${feedUrl}:`, error.message);
      }
    }

    console.log(`[RSS] Fetched ${allArticles.length} articles`);
    return allArticles;
  }

  /**
   * Web Scraper (Puppeteer) - Property Pro Africa website
   */
  async scrapeNewsWebsites() {
    console.log('[Scraper] Scraping news websites...');

    const websites = [
      {
        name: 'Property Pro Africa',
        url: 'https://www.propertypro.ng',
        selector: 'a[href*="/listings/"]',
      },
    ];

    const allArticles = [];

    for (const site of websites) {
      try {
        const articles = await this.scrapeSite(site);
        allArticles.push(...articles);
      } catch (error) {
        console.warn(`[Scraper] Error scraping ${site.name}:`, error.message);
      }
    }

    console.log(`[Scraper] Scraped ${allArticles.length} articles`);
    return allArticles;
  }

  /**
   * Individual site scraper
   */
  async scrapeSite(site) {
    let browser;

    try {
      browser = await puppeteer.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
      });
      
      const page = await browser.newPage();
      await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 15000 });

      const articles = await page.evaluate((selector) => {
        const elements = document.querySelectorAll(selector);
        return Array.from(elements)
          .slice(0, 10)
          .map(el => ({
            title: el.textContent?.trim() || '',
            url: el.href || '',
            source: window.location.hostname,
          }))
          .filter(a => a.title && a.url);
      }, site.selector);

      await browser.close();
      return articles;
    } catch (error) {
      if (browser) await browser.close();
      throw error;
    }
  }

  /**
   * Fetch all sources in parallel
   */
  async fetchAll() {
    const [gnews, newsapi, rss, scraped] = await Promise.allSettled([
      this.fetchGNews(),
      this.fetchNewsAPI(),
      this.fetchRSSFeeds(),
      this.scrapeNewsWebsites(),
    ]);

    return [
      gnews.status === 'fulfilled' ? gnews.value : [],
      newsapi.status === 'fulfilled' ? newsapi.value : [],
      rss.status === 'fulfilled' ? rss.value : [],
      scraped.status === 'fulfilled' ? scraped.value : [],
    ];
  }
}

module.exports = DataSource;
