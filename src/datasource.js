/**
 * Data Source Aggregator - COMPLETE VERSION
 * 
 * Collects articles from 5 sources:
 * 1. GNews API
 * 2. NewsAPI
 * 3. Google News RSS
 * 4. Custom RSS feeds (ThisDay, Punch, Daily Trust, Nairametrics, etc)
 * 5. Direct URLs (user-configured) - NEW
 */

const axios = require('axios');
const xml2js = require('xml2js');

class DataSource {
  constructor() {
    this.gNewsKey = process.env.GNEWS_API_KEY;
    this.newsApiKey = process.env.NEWSAPI_API_KEY;
    this.xmlParser = new xml2js.Parser();
  }

  /**
   * FETCH 1: GNews API
   */
  async fetchGNews() {
    console.log('[GNews] Fetching articles...');
    const articles = [];
    const queries = [
      '"real estate" Lagos',
      'property market Nigeria',
    ];

    if (!this.gNewsKey) {
      console.log('[GNews] API key not configured');
      return articles;
    }

    try {
      for (const query of queries) {
        try {
          const response = await axios.get('https://gnewsapi.com/api/search', {
            params: {
              q: query,
              token: this.gNewsKey,
              max: 25,
            },
            timeout: 8000,
          });

          if (response.data?.articles) {
            response.data.articles.forEach(article => {
              articles.push({
                title: article.title,
                description: article.description,
                url: article.url,
                source: 'GNews',
                pubDate: article.publishedAt,
              });
            });
          }
        } catch (error) {
          if (error.response?.status === 429) {
            console.log(`[GNews] Error on query "${query}": Request failed with status code 429`);
          } else {
            console.error(`[GNews] Error on query "${query}":`, error.message);
          }
        }
      }
    } catch (error) {
      console.error('[GNews] Fatal error:', error.message);
    }

    console.log(`[GNews] Fetched ${articles.length} total articles`);
    return articles;
  }

  /**
   * FETCH 2: NewsAPI
   */
  async fetchNewsAPI() {
    console.log('[NewsAPI] Fetching articles...');
    const articles = [];
    const queries = [
      '"real estate" AND (Lagos OR Nigeria)',
      '(property market OR housing market OR property development) AND Nigeria',
    ];

    if (!this.newsApiKey) {
      console.log('[NewsAPI] API key not configured');
      return articles;
    }

    try {
      for (const query of queries) {
        try {
          const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
              q: query,
              apiKey: this.newsApiKey,
              pageSize: 100,
              sortBy: 'publishedAt',
            },
            timeout: 8000,
          });

          if (response.data?.articles) {
            response.data.articles.forEach(article => {
              articles.push({
                title: article.title,
                description: article.description,
                url: article.url,
                source: article.source?.name || 'NewsAPI',
                pubDate: article.publishedAt,
              });
            });
          }

          console.log(`[NewsAPI] Query "${query}" → ${response.data?.articles?.length || 0} articles`);
        } catch (error) {
          console.error(`[NewsAPI] Error on query "${query}":`, error.message);
        }
      }
    } catch (error) {
      console.error('[NewsAPI] Fatal error:', error.message);
    }

    console.log(`[NewsAPI] Fetched ${articles.length} total articles`);
    return articles;
  }

  /**
   * FETCH 3: Google News RSS Feeds
   */
  async fetchGoogleNews() {
    console.log('[GoogleNews] Fetching query-based feeds...');
    const articles = [];
    const queries = [
      'Lagos real estate',
      'Nigeria property market',
      'Ibeju-Lekki property development',
      'Nigeria housing policy',
      'Lagos land prices',
      'Nigeria mortgage affordable housing',
      'Lekki property investment',
      'Nigeria real estate developer',
      'site:guardian.ng real estate OR property',
      'site:vanguardngr.com real estate OR property',
      'site:thecable.ng real estate OR property',
      'site:leadership.ng real estate OR property',
      'site:tribuneonlineng.com real estate OR property',
    ];

    try {
      for (const query of queries) {
        try {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}`;
          const response = await axios.get(rssUrl, {
            timeout: 8000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
          });

          const parsed = await this.xmlParser.parseStringPromise(response.data);
          if (parsed?.rss?.channel?.[0]?.item) {
            parsed.rss.channel[0].item.forEach(item => {
              articles.push({
                title: item.title?.[0] || 'Untitled',
                description: item.description?.[0] || '',
                url: item.link?.[0] || '',
                source: 'Google News',
                pubDate: item.pubDate?.[0] || new Date().toISOString(),
              });
            });
          }

          console.log(`[GoogleNews] "${query}": ${parsed?.rss?.channel?.[0]?.item?.length || 0} articles`);
        } catch (error) {
          console.error(`[GoogleNews] Error on query "${query}":`, error.message);
        }
      }
    } catch (error) {
      console.error('[GoogleNews] Fatal error:', error.message);
    }

    console.log(`[GoogleNews] Fetched ${articles.length} total articles`);
    return articles;
  }

  /**
   * FETCH 4: Custom RSS Feeds
   */
  async fetchRSSFeeds() {
    console.log('[RSS] Fetching from RSS feeds...');
    const articles = [];
    const feeds = [
      {
        name: 'ThisDay',
        url: 'https://www.thisday.com.ng/feed/',
      },
      {
        name: 'Premium Times',
        url: 'https://www.premiumtimesng.com/feed/',
      },
      {
        name: 'BusinessDay',
        url: 'https://businessday.ng/feed/',
      },
      {
        name: 'Nairametrics',
        url: 'https://www.nairametrics.com/feed/',
      },
      {
        name: 'Daily Trust',
        url: 'https://dailytrust.com/feed/',
      },
      {
        name: 'The Punch',
        url: 'https://punch.ng/feed/',
      },
    ];

    for (const feed of feeds) {
      try {
        const response = await axios.get(feed.url, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          },
        });

        const parsed = await this.xmlParser.parseStringPromise(response.data);
        let feedArticles = 0;

        if (parsed?.rss?.channel?.[0]?.item) {
          parsed.rss.channel[0].item.forEach(item => {
            articles.push({
              title: item.title?.[0] || 'Untitled',
              description: item.description?.[0] || item.content?.[0] || '',
              url: item.link?.[0] || '',
              source: feed.name,
              pubDate: item.pubDate?.[0] || new Date().toISOString(),
            });
            feedArticles++;
          });
        }

        console.log(`[RSS] ${feed.name}: ${feedArticles} real estate articles`);
      } catch (error) {
        console.error(`[RSS] Error fetching ${feed.name}:`, error.message);
      }
    }

    console.log(`[RSS] Total: ${articles.length} articles`);
    return articles;
  }

  /**
   * FETCH 5: Direct URLs - NEW FEATURE
   * 
   * Allows user to add custom news sources directly
   * Fetches each URL and extracts title/description
   * Gets priority boost (user-curated = high quality)
   */
  async fetchDirectUrls() {
    let config;
    try {
      config = require('./NEWS_SOURCES_CONFIG.js');
    } catch (error) {
      console.log('[DirectURL] Configuration file not found, skipping direct URLs');
      return [];
    }

    if (!config.directUrls || !config.directUrls.enabled || !config.directUrls.urls.length) {
      console.log('[DirectURL] No direct URLs configured');
      return [];
    }

    console.log(`[DirectURL] Processing ${config.directUrls.urls.length} manual URLs...`);
    const articles = [];

    try {
      for (const url of config.directUrls.urls) {
        try {
          const response = await axios.get(url, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });

          // Extract title from <title> tag
          const titleMatch = response.data.match(/<title[^>]*>([^<]+)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : 'Real Estate Article';

          // Extract description from meta tag
          const descMatch = response.data.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
          const description = descMatch ? descMatch[1] : '';

          articles.push({
            title,
            description,
            url,
            source: 'Direct URL',
            pubDate: new Date().toISOString(),
            trusted: true,  // Mark as user-curated (high quality)
          });

          console.log(`[DirectURL] ✓ Added: ${title.substring(0, 60)}`);
        } catch (error) {
          console.error(`[DirectURL] Failed to fetch "${url}":`, error.message);
        }
      }
    } catch (error) {
      console.error('[DirectURL] Fatal error:', error.message);
    }

    console.log(`[DirectURL] Fetched ${articles.length} articles from ${config.directUrls.urls.length} URLs`);
    return articles;
  }
}

module.exports = DataSource;
