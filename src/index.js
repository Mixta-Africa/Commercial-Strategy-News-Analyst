/**
 * Nigerian Real Estate News Research System
 * Main Pipeline Orchestrator
 * 
 * Workflow:
 * 1. Collect articles (50-100)
 * 2. Filter by whitelist & location
 * 3. Store in Google Sheets
 * 4. AI analysis (professional summaries)
 * 5. Detect trends (7/30/90-day)
 * 6. Detect anomalies
 * 7. Send email via Apps Script
 * 8. Update dashboard
 */

const fs = require('fs');
const path = require('path');
const Agents = require('./agents');
const DataSource = require('./datasource');
const SheetsClient = require('./sheets-client');
const { generateEmailHTML, sendEmail } = require('./email-service');
const whitelist = require('./whitelist.json');

class NewsPipeline {
  constructor() {
    this.articles = [];
    this.trends = {};
    this.alerts = [];
    this.sheetsClient = new SheetsClient();
    this.datasource = new DataSource();
    this.agents = new Agents();
    this.timestamp = new Date().toISOString();
  }

  /**
   * PHASE 1: Data Collection (target: 50-100 raw articles)
   */
  async collectArticles() {
    console.log('[PHASE 1] Collecting articles from all sources...');
    
    try {
      const [gNewsArticles, newsApiArticles, rssArticles, scrapedArticles] = 
        await Promise.all([
          this.datasource.fetchGNews(),
          this.datasource.fetchNewsAPI(),
          this.datasource.fetchRSSFeeds(),
          this.datasource.scrapeNewsWebsites(),
        ]);

      const allArticles = [
        ...gNewsArticles,
        ...newsApiArticles,
        ...rssArticles,
        ...scrapedArticles,
      ];

      console.log(`[PHASE 1] Collected ${allArticles.length} raw articles`);
      return allArticles;
    } catch (error) {
      console.error('[PHASE 1] Collection error:', error.message);
      return [];
    }
  }

  /**
   * PHASE 2: Filtering & Deduplication (target: 30-65 unique articles)
   */
  async filterArticles(rawArticles) {
    console.log('[PHASE 2] Filtering by whitelist and deduplication...');

    const whitelistSources = new Set(whitelist.coreSources);
    const seen = new Set();
    const filtered = [];

    for (const article of rawArticles) {
      const normalizedSource = article.source?.toLowerCase() || '';
      const normalizedTitle = article.title?.toLowerCase().trim() || '';

      // Skip if seen before
      if (seen.has(normalizedTitle)) continue;
      seen.add(normalizedTitle);

      // Check whitelist
      const isWhitelisted = whitelistSources.has(normalizedSource) ||
        whitelist.dynamicSources?.includes(normalizedSource);

      if (!isWhitelisted) {
        console.log(`[PHASE 2] Skipped non-whitelisted source: ${article.source}`);
        continue;
      }

      // Location validation (Southwest Nigeria)
      const validLocations = ['Lagos', 'Ibeju-Lekki', 'Ibadan', 'Abeokuta', 'Ogun', 'Nigeria'];
      const hasValidLocation = validLocations.some(loc => 
        article.title?.includes(loc) || article.content?.includes(loc)
      );

      if (!hasValidLocation) {
        console.log(`[PHASE 2] Skipped non-Southwest Nigeria article: ${article.title?.substring(0, 50)}`);
        continue;
      }

      filtered.push({
        ...article,
        addedAt: this.timestamp,
      });
    }

    console.log(`[PHASE 2] Filtered to ${filtered.length} unique, reputable articles`);
    return filtered;
  }

  /**
   * PHASE 3: Storage in Google Sheets
   */
  async storeArticles(articles) {
    console.log('[PHASE 3] Storing articles in Google Sheets...');

    try {
      const sheetsData = articles.map(a => [
        new Date().toISOString().split('T')[0],
        a.source || '',
        a.title || '',
        a.url || '',
        'untagged',
        '',
        '',
        '',
        '',
        new Date().toISOString(),
      ]);

      await this.sheetsClient.appendRows(sheetsData);
      console.log('[PHASE 3] Stored in Sheets successfully');
    } catch (error) {
      console.error('[PHASE 3] Storage error:', error.message);
    }
  }

  /**
   * PHASE 4: AI Analysis
   */
  async analyzeArticles(articles) {
    console.log('[PHASE 4] Running AI analysis with professional prompts...');

    const analyzed = [];

    for (const article of articles) {
      try {
        const analysis = await this.agents.analyzeArticle(article);
        analyzed.push({
          ...article,
          ...analysis,
        });
      } catch (error) {
        console.error(`[PHASE 4] Analysis failed for "${article.title?.substring(0, 50)}"`, error.message);
        analyzed.push({
          ...article,
          sentiment: 'unknown',
          summary: article.title || 'Unable to analyze',
          category: 'untagged',
        });
      }
    }

    console.log(`[PHASE 4] Analyzed ${analyzed.length} articles`);
    return analyzed;
  }

  /**
   * PHASE 5: Trend Detection
   */
  async detectTrends(articles) {
    console.log('[PHASE 5] Detecting trends across time horizons...');

    const trends = {
      '7day': this.calculateTrends(articles, 7),
      '30day': this.calculateTrends(articles, 30),
      '90day': this.calculateTrends(articles, 90),
    };

    return trends;
  }

  calculateTrends(articles, days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const relevant = articles.filter(a => 
      new Date(a.addedAt || this.timestamp) >= cutoff
    );

    const sentiments = {};
    const topics = {};

    for (const article of relevant) {
      sentiments[article.sentiment] = (sentiments[article.sentiment] || 0) + 1;
      
      const articleTopics = article.trending_topics?.split(',') || [];
      for (const topic of articleTopics) {
        topics[topic.trim()] = (topics[topic.trim()] || 0) + 1;
      }
    }

    return {
      articleCount: relevant.length,
      sentimentBreakdown: sentiments,
      topTopics: Object.entries(topics)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count })),
      averageSentiment: this.calculateAverageSentiment(sentiments),
    };
  }

  calculateAverageSentiment(sentiments) {
    const bullishCount = sentiments['bullish'] || 0;
    const bearishCount = sentiments['bearish'] || 0;
    const neutralCount = sentiments['neutral'] || 0;
    const total = bullishCount + bearishCount + neutralCount;

    if (total === 0) return 'neutral';
    if (bullishCount > total * 0.5) return 'bullish';
    if (bearishCount > total * 0.3) return 'bearish';
    return 'neutral';
  }

  /**
   * PHASE 6: Anomaly Detection
   */
  async detectAnomalies(articles, trends) {
    console.log('[PHASE 6] Detecting anomalies and sentiment reversals...');

    const alerts = [];

    // Volume spike detection
    if (articles.length > 50) {
      alerts.push({
        type: 'volume_spike',
        severity: 'high',
        message: `Article volume spike: ${articles.length} articles collected today (normal: 30-50)`,
        timestamp: this.timestamp,
      });
    }

    // Sentiment reversal detection
    const bullishCount = articles.filter(a => a.sentiment === 'bullish').length;
    const bearishCount = articles.filter(a => a.sentiment === 'bearish').length;
    
    if (bearishCount > articles.length * 0.4) {
      alerts.push({
        type: 'sentiment_reversal',
        severity: 'medium',
        message: `High bearish sentiment: ${bearishCount}/${articles.length} articles are bearish`,
        timestamp: this.timestamp,
      });
    }

    console.log(`[PHASE 6] Detected ${alerts.length} anomalies`);
    return alerts;
  }

  /**
   * PHASE 7: Email Generation & Delivery
   */
  async generateAndSendEmail(articles, trends, alerts) {
    console.log('[PHASE 7] Generating and sending email digest...');

    try {
      const topArticles = articles.slice(0, 5);
      const htmlContent = generateEmailHTML(topArticles, trends, alerts);
      
      await sendEmail({
        to: process.env.RECIPIENT_EMAIL,
        subject: `Nigerian Real Estate News Digest - ${new Date().toDateString()}`,
        html: htmlContent,
      });

      console.log('[PHASE 7] Email sent successfully');
    } catch (error) {
      console.error('[PHASE 7] Email error:', error.message);
    }
  }

  /**
   * PHASE 8: Dashboard Updates
   */
  async updateDashboard(articles, trends, alerts) {
    console.log('[PHASE 8] Updating GitHub Pages dashboard...');

    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      fs.writeFileSync(
        path.join(dataDir, 'articles.json'),
        JSON.stringify(articles, null, 2)
      );

      fs.writeFileSync(
        path.join(dataDir, 'trends.json'),
        JSON.stringify(trends, null, 2)
      );

      fs.writeFileSync(
        path.join(dataDir, 'alerts.json'),
        JSON.stringify(alerts, null, 2)
      );

      console.log('[PHASE 8] Dashboard data updated');
    } catch (error) {
      console.error('[PHASE 8] Dashboard update error:', error.message);
    }
  }

  /**
   * Main Pipeline Orchestration
   */
  async run() {
    console.log('='.repeat(60));
    console.log('Nigerian Real Estate News Pipeline Started');
    console.log('Timestamp:', this.timestamp);
    console.log('='.repeat(60));

    try {
      // Phase 1: Collect
      const rawArticles = await this.collectArticles();
      if (rawArticles.length === 0) {
        console.warn('No articles collected. Exiting.');
        return;
      }

      // Phase 2: Filter
      const filtered = await this.filterArticles(rawArticles);
      if (filtered.length === 0) {
        console.warn('No articles passed filtering. Exiting.');
        return;
      }

      // Phase 3: Store
      await this.storeArticles(filtered);

      // Phase 4: Analyze
      const analyzed = await this.analyzeArticles(filtered);

      // Phase 5: Detect Trends
      const trends = await this.detectTrends(analyzed);

      // Phase 6: Detect Anomalies
      const alerts = await this.detectAnomalies(analyzed, trends);

      // Phase 7: Email
      await this.generateAndSendEmail(analyzed, trends, alerts);

      // Phase 8: Dashboard
      await this.updateDashboard(analyzed, trends, alerts);

      console.log('='.repeat(60));
      console.log('Pipeline completed successfully');
      console.log('='.repeat(60));
    } catch (error) {
      console.error('Fatal pipeline error:', error);
      process.exit(1);
    }
  }
}

// Execute
const pipeline = new NewsPipeline();
pipeline.run();
