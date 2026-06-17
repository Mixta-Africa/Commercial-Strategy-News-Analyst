/**
 * Nigerian Real Estate News Research System
 * Main Pipeline Orchestrator
 *
 * Workflow:
 * 1. Collect articles (50-100)
 * 2. Filter by whitelist & location
 * 3. Store raw in Google Sheets (Initial append)
 * 4. Content Enricher (Scrape body text)
 * 5. AI analysis (professional summaries)
 * 6. Update Google Sheets (Analyzed append) <-- FIXED
 * 7. Detect trends (7/30/90-day)
 * 8. Detect anomalies
 * 9. Synthesize Brief (with Drive Context)
 * 10. Send email via Apps Script
 * 11. Archive to Vault & Update dashboard
 */

const fs = require('fs');
const path = require('path');
const Agents = require('./agents');
const DataSource = require('./datasource');
const SheetsClient = require('./sheet-client'); // FIX: Ensure this matches your actual filename
const Synthesizer = require('./synthesizer');
const RunHealth = require('./health');
const { scoreRelevance } = require('./relevance');
const { getWatchListOverride, getSourcesOverride } = require('./config-loader');
const { enrichArticles } = require('./content-enricher');
const { generateEmailHTML, sendEmail } = require('./email-service');
const whitelist = require('./whitelist.json');

// NEW LAYER 2
const DriveClient = require('./drive-client');

class NewsPipeline {
  constructor() {
    this.articles = [];
    this.trends = {};
    this.alerts = [];
    this.sheetsClient = new SheetsClient();
    this.datasource = new DataSource();
    this.agents = new Agents();
    this.synthesizer = new Synthesizer(this.agents);
    this.timestamp = new Date().toISOString();
  }

  /**
   * PHASE 1: Data Collection
   */
  async collectArticles() {
    console.log('[PHASE 1] Collecting articles from all sources...');
    
    try {
      const [gNewsArticles, newsApiArticles, googleNewsArticles, rssArticles, directArticles] = 
        await Promise.all([
          this.datasource.fetchGNews(),
          this.datasource.fetchNewsAPI(),
          this.datasource.fetchGoogleNews(),
          this.datasource.fetchRSSFeeds(),
          this.datasource.fetchDirectUrls(),
        ]);

      const allArticles = [
        ...gNewsArticles,
        ...newsApiArticles,
        ...googleNewsArticles,
        ...rssArticles,
        ...directArticles,
      ];

      console.log(`[PHASE 1] Collected ${allArticles.length} raw articles`);
      return allArticles;
    } catch (error) {
      console.error('[PHASE 1] Collection error:', error.message);
      return [];
    }
  }

  /**
   * PHASE 2: Filtering, relevance scoring & deduplication
   */
  async filterArticles(rawArticles) {
    console.log('[PHASE 2] Filtering, scoring relevance, deduplicating...');

    const whitelistSources = new Set(
      whitelist.coreSources.map(s => s.toLowerCase())
    );
    const seen = new Set();
    const filtered = [];

    for (const article of rawArticles) {
      const normalizedSource = (article.source || '').toLowerCase().trim();
      const normalizedTitle = (article.title || '').toLowerCase().trim();
      
      if (seen.has(normalizedTitle)) {
        continue;
      }
      seen.add(normalizedTitle);

      if (!normalizedTitle) continue;

      if (!article.trustedSource) {
        const isWhitelisted = whitelistSources.has(normalizedSource) ||
          (whitelist.dynamicSources || []).map(s => s.toLowerCase()).includes(normalizedSource);

        if (!isWhitelisted) continue;
      }

      const verdict = scoreRelevance(article.title, article.content || article.description);
      if (!verdict.passed) continue;

      filtered.push({
        ...article,
        addedAt: this.timestamp,
        relevanceScore: verdict.score,
        relevanceTerms: [...verdict.strong, ...verdict.medium],
      });
    }

    console.log(`[PHASE 2] Filtered to ${filtered.length} unique real estate articles`);

    const maxAnalyze = this.datasource.config?.settings?.maxArticlesToAnalyze || 25;
    if (filtered.length > maxAnalyze) {
      filtered.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
      return filtered.slice(0, maxAnalyze);
    }
    return filtered;
  }

  /**
   * PHASE 3: Storage in Google Sheets (Raw Initial Dump)
   */
  async storeArticles(articles) {
    console.log('[PHASE 3] Storing initial raw articles in Google Sheets...');
    try {
      const sheetsData = articles.map(a => [
        new Date().toISOString().split('T')[0],
        a.source || '',
        a.title || '',
        a.url || '',
        'untagged',
        '', '', '', '',
        new Date().toISOString(),
      ]);
      await this.sheetsClient.appendRows(sheetsData);
    } catch (error) {
      console.error('[PHASE 3] Storage error:', error.message);
    }
  }

  /**
   * PHASE 4: AI Analysis
   */
  async analyzeArticles(articles) {
    console.log('[PHASE 4] Running AI analysis...');
    const analyzed = [];

    for (const article of articles) {
      try {
        const analysis = await this.agents.analyzeArticle(article);
        analyzed.push({ ...article, ...analysis });
      } catch (error) {
        analyzed.push({
          ...article,
          sentiment: 'neutral',
          summary: article.title || 'Unable to analyze',
          category: 'untagged',
        });
      }
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
    return analyzed;
  }

  /**
   * PHASE 4.5: Update Sheets with Analyzed Data
   */
  async appendAnalyzedToSheets(analyzedArticles) {
    console.log('[PHASE 4.5] Appending fully analyzed articles to Google Sheets...');
    try {
      const sheetsData = analyzedArticles.map(a => {
        // Map to your 10 columns: Date, Source, Title, URL, Category, Sentiment, Summary, Mixta Flags, Notes, Timestamp
        return [
          new Date().toISOString().split('T')[0],
          a.source || 'N/A',
          a.title || 'N/A',
          a.url || 'N/A',
          a.category || 'untagged',
          a.sentiment || 'neutral',
          a.summary || '',
          a.mixta_relevance?.direct_impact || a.mixta_flags || '',
          '', // Notes
          new Date().toISOString()
        ];
      });

      await this.sheetsClient.appendRows(sheetsData);
      console.log(`[PHASE 4.5] Successfully appended ${sheetsData.length} analyzed rows.`);
    } catch (error) {
      console.error('[PHASE 4.5] Failed to append analyzed data to sheets:', error.message);
    }
  }

  // ... [Trends and Anomalies logic remains identical]
  async detectTrends(articles) {
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
    const relevant = articles.filter(a => new Date(a.addedAt || this.timestamp) >= cutoff);
    const sentiments = {};
    const topics = {};

    for (const article of relevant) {
      sentiments[article.sentiment] = (sentiments[article.sentiment] || 0) + 1;
      const articleTopics = (article.trending_topics || '').split(',');
      for (const topic of articleTopics) {
        const t = topic.trim();
        if (t) topics[t] = (topics[t] || 0) + 1;
      }
    }

    return {
      articleCount: relevant.length,
      sentimentBreakdown: sentiments,
      topTopics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([topic, count]) => ({ topic, count })),
      averageSentiment: this.calculateAverageSentiment(sentiments),
    };
  }

  calculateAverageSentiment(sentiments) {
    const bullish = sentiments['bullish'] || 0;
    const bearish = sentiments['bearish'] || 0;
    const neutral = sentiments['neutral'] || 0;
    const total = bullish + bearish + neutral;

    if (total === 0) return 'neutral';
    if (bullish > total * 0.5) return 'bullish';
    if (bearish > total * 0.3) return 'bearish';
    return 'neutral';
  }

  async detectAnomalies(articles, trends) {
    const alerts = [];
    if (articles.length > 50) alerts.push({ type: 'volume_spike', severity: 'high', message: 'Volume spike', timestamp: this.timestamp });
    const bearishCount = articles.filter(a => a.sentiment === 'bearish').length;
    if (bearishCount > articles.length * 0.4) alerts.push({ type: 'sentiment_reversal', severity: 'medium', message: 'High bearish', timestamp: this.timestamp });
    return alerts;
  }

  async generateAndSendEmail(articles, trends, alerts, briefing) {
    try {
      const htmlContent = generateEmailHTML(articles, trends, alerts, briefing);
      const recipients = (process.env.RECIPIENT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
      await sendEmail({ to: recipients, subject: `Nigerian Real Estate News Digest - ${new Date().toDateString()}`, html: htmlContent });
      return true;
    } catch (error) { return false; }
  }

  async updateDashboard(articles, trends, alerts, briefing) {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'articles.json'), JSON.stringify(articles, null, 2));
      fs.writeFileSync(path.join(dataDir, 'trends.json'), JSON.stringify(trends, null, 2));
      fs.writeFileSync(path.join(dataDir, 'alerts.json'), JSON.stringify(alerts, null, 2));

      if (briefing) {
        fs.writeFileSync(path.join(dataDir, 'briefing.json'), JSON.stringify({ ...briefing, generatedAt: this.timestamp }, null, 2));
        const archiveDir = path.join(dataDir, 'archive');
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
        const dateStr = this.timestamp.split('T')[0];
        fs.writeFileSync(path.join(archiveDir, `briefing-${dateStr}.json`), JSON.stringify({ ...briefing, generatedAt: this.timestamp }, null, 2));
        
        const indexPath = path.join(dataDir, 'briefings-index.json');
        let index = [];
        try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')).briefings || []; } catch (e) { index = []; }
        index = index.filter(b => b.date !== dateStr);
        index.unshift({
          date: dateStr,
          generatedAt: this.timestamp,
          executive_summary: briefing.executive_summary || '',
          themeCount: briefing.themes?.length || 0,
          themeLabels: (briefing.themes || []).map(t => t.label),
        });
        index = index.slice(0, 180);
        fs.writeFileSync(indexPath, JSON.stringify({ briefings: index }, null, 2));
      }
    } catch (error) { console.error('[PHASE 8] Dashboard error:', error.message); }
  }

  async applyRemoteConfig() {
    try {
      const [sources, watchList] = await Promise.all([getSourcesOverride(), getWatchListOverride()]);
      if (sources) {
        this.datasource.config = { ...this.datasource.config, ...(sources.rssFeeds ? { rssFeeds: sources.rssFeeds } : {}), ...(sources.googleNewsQueries ? { googleNewsQueries: sources.googleNewsQueries } : {}) };
      }
      if (watchList) this.synthesizer.watchListOverride = watchList;
    } catch (e) { }
  }

  async sendOperatorAlert(health) {
    if (!health.needsAlert()) return;
    const to = process.env.ALERT_EMAIL || process.env.RECIPIENT_EMAIL;
    if (!to) return;
    try {
      const { subject, html } = health.buildAlertEmail();
      await sendEmail({ to, subject, html });
    } catch (e) { }
  }

  /**
   * Main Pipeline
   */
  async run() {
    console.log('='.repeat(60));
    console.log('Nigerian Real Estate News Pipeline Started');
    console.log('Timestamp:', this.timestamp);
    console.log('='.repeat(60));

    try {
      const health = new RunHealth(this.timestamp);
      await this.applyRemoteConfig();

      const rawArticles = await this.collectArticles();
      health.recordSources(this.datasource.sourceHealth);
      health.recordCounts({ raw: rawArticles.length });

      if (rawArticles.length === 0) {
        health.finalize({ fatal: true });
        health.persist();
        await this.sendOperatorAlert(health);
        return;
      }

      const filtered = await this.filterArticles(rawArticles);
      health.recordCounts({ filtered: filtered.length });

      if (filtered.length === 0) {
        health.finalize({ fatal: true });
        health.persist();
        await this.sendOperatorAlert(health);
        return;
      }

      await this.storeArticles(filtered); // Stores RAW data

      console.log('[PHASE 2.5] Enriching article content...');
      const enriched = await enrichArticles(filtered);

      const analyzed = await this.analyzeArticles(enriched);
      
      // FIX IMPLEMENTED HERE: Push analyzed data back to sheets
      await this.appendAnalyzedToSheets(analyzed);

      const aiFallbacks = analyzed.filter(a => !a.summary || a.summary.startsWith('Unable to generate')).length;
      health.recordCounts({ analyzed: analyzed.length, aiFallbacks });

      // DRIVE CONTEXT INJECTION
      let driveContext = [];
      try {
        const drive = new DriveClient();
        console.log('[Vault] Fetching last 3 archived briefs for pattern recognition...');
        driveContext = await drive.getRecentBriefsContext(3);
      } catch (vaultError) {
        console.warn('[Vault] Skipping Drive context lookup:', vaultError.message);
      }

      const trends = await this.detectTrends(analyzed);
      const alerts = await this.detectAnomalies(analyzed, trends);

      const safeBriefingData = analyzed.map(article => ({ ...article, content: article.content ? article.content.substring(0, 1000) + '...' : '' }));

      const briefing = await this.synthesizer.synthesize(safeBriefingData, driveContext); // Note driveContext passed in
      health.recordSynthesis(briefing);

      const emailSent = await this.generateAndSendEmail(analyzed, trends, alerts, briefing);
      health.recordEmail(emailSent);

      await this.updateDashboard(analyzed, trends, alerts, briefing);

      // SAVE TO DRIVE VAULT
      if (briefing) {
        try {
          const drive = new DriveClient();
          const dateStr = this.timestamp.split('T')[0];
          await drive.saveBrief(dateStr, briefing);
        } catch (saveError) {
          console.error('[Vault] Failed to save current run to Google Drive:', saveError.message);
        }
      }

      health.finalize();
      health.persist();
      await this.sendOperatorAlert(health);

      console.log('='.repeat(60));
      console.log(`Pipeline completed (status: ${health.record.status})`);
      console.log('='.repeat(60));
    } catch (error) {
      console.error('Fatal pipeline error:', error);
      try {
        const failHealth = new RunHealth(this.timestamp);
        failHealth.recordSources(this.datasource.sourceHealth);
        failHealth.addWarning(`Fatal error: ${error.message}`);
        failHealth.finalize({ fatal: true });
        failHealth.persist();
        await this.sendOperatorAlert(failHealth);
      } catch (e) {}
      process.exit(1);
    }
  }
}

const pipeline = new NewsPipeline();
pipeline.run().then(() => {
  process.exit(0);
});
