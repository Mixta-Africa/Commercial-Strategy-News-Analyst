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
   * GNews API
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
   * NewsAPI
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
   * RSS Feeds
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');

    const rssFeeds = [
      { url: 'https://www.thisdaylive.com/feed', source: 'ThisDay' },
      { url: 'https://www.premiumtimesng.com/feed', source: 'Premium Times' },
      { url: 'https://businessday.ng/feed', source: 'BusinessDay' },
      { url: 'https://guardian.ng/feed', source: 'Guardian' },
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
            return title.includes('real estate') ||
                   title.includes('property') ||
                   title.includes('housing') ||
                   title.includes('construction') ||
                   title.includes('lagos') ||
                   title.includes('lekki') ||
                   title.includes('mortgage');
          })
          .map(item => ({
            title: item.title?.[0] || '',
            description: item.description?.[0] || '',
            content: item.content || '',
            url: item.link?.[0] || '',
            source: feed.source,
            publishedAt: item.pubDate?.[0] || new Date().toISOString(),
          }))
          .slice(0, 10);

        allArticles.push(...articles);
        console.log(`[RSS] ${feed.source}: ${articles.length} articles`);
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
