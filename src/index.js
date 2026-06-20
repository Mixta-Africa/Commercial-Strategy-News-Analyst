/**
 * Nigerian Real Estate News Research System
 * Main Pipeline Orchestrator
 * * Workflow:
 * 1. Collect articles (50-100)
 * 2. Filter by whitelist & location (Cross-checked with historical Google Sheets data + Strict 48hr Frame)
 * 3. Store in Google Sheets (Master Backup)
 * 4. AI analysis (professional summaries)
 * 5. Update Google Sheets (Smart Tab Routing)
 * 6. Detect trends (7/30/90-day)
 * 7. Detect anomalies
 * 8. Send email via Apps Script
 * 9. Update dashboard
 */

const fs = require('fs');
const path = require('path');
const Agents = require('./agents');
const DataSource = require('./datasource');
const SheetsClient = require('./sheets-client');
const Synthesizer = require('./synthesizer');
const RunHealth = require('./health');
const { scoreRelevance } = require('./relevance');
const { getWatchListOverride, getSourcesOverride } = require('./config-loader');
const { enrichArticles } = require('./content-enricher');
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
    this.synthesizer = new Synthesizer(this.agents);
    this.timestamp = new Date().toISOString();
  }

  /**
   * PHASE 1: Data Collection
   * FIX: Added fetchDirectUrls() to the parallel collection array
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
          this.datasource.fetchDirectUrls(), // Wired into the main collection phase
        ]);

      const allArticles = [
        ...gNewsArticles,
        ...newsApiArticles,
        ...googleNewsArticles,
        ...rssArticles,
        ...directArticles, // Spread manual injections into the main array
      ];

      console.log(`[PHASE 1] Collected ${allArticles.length} raw articles`);
      return allArticles;
    } catch (error) {
      console.error('[PHASE 1] Collection error:', error.message);
      return [];
    }
  }

  /**
   * PHASE 2: Filtering, relevance scoring & deduplication (WITH HISTORICAL MEMORY)
   */
  async filterArticles(rawArticles) {
    console.log('[PHASE 2] Filtering, scoring relevance, deduplicating...');

    // --- NEW: Fetch historical data to prevent cross-run duplicates ---
    let historicalTitles = new Set();
    let historicalUrls = new Set();
    try {
      const historicalRows = await this.sheetsClient.getAllRows();
      historicalRows.forEach(row => {
        if (row[2]) historicalTitles.add(row[2].toLowerCase().trim()); // Column C is Title
        if (row[3]) historicalUrls.add(row[3].toLowerCase().trim());   // Column D is URL
      });
      console.log(`[PHASE 2] Loaded ${historicalTitles.size} historical articles from Sheets to prevent duplicates.`);
    } catch (e) {
      console.warn('[PHASE 2] Could not load historical rows for deduplication:', e.message);
    }
    // -----------------------------------------------------------------

    const whitelistSources = new Set(
      whitelist.coreSources.map(s => s.toLowerCase())
    );
    const seen = new Set();
    const filtered = [];

    for (const article of rawArticles) {
      // ─── STRICT YESTERDAY AND TODAY DATE FILTER ──────────────────────────
      // Per explicit instruction: recency is the most important factor.
      // Rolling 2-day window (today + yesterday) so a daily run never misses
      // something published late in the previous cycle, while never reaching
      // further back than that.
      if (article.publishedAt) {
        try {
          const pubDate = new Date(article.publishedAt);
          if (isNaN(pubDate.getTime())) throw new Error('Unparseable date');

          const today = new Date();
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);

          const pubDateStr = pubDate.toISOString().split('T')[0];
          const todayStr = today.toISOString().split('T')[0];
          const yesterdayStr = yesterday.toISOString().split('T')[0];

          if (pubDateStr !== todayStr && pubDateStr !== yesterdayStr) {
            console.log(`[PHASE 2] Skipped old article (${pubDateStr}): ${article.title?.substring(0, 50)}`);
            continue;
          }
        } catch (e) {
          // FIX: this used to swallow the parse error and let the article
          // through with NO date check at all - the exact leak that was
          // letting stale articles bypass recency filtering. An article
          // with a malformed date can't be proven recent, so it's rejected
          // rather than given the benefit of the doubt.
          console.log(`[PHASE 2] Skipped (unparseable publishedAt): ${article.title?.substring(0, 50)}`);
          continue;
        }
      } else {
        // No publishedAt at all - same reasoning: can't verify recency, so
        // it doesn't pass. Stricter than before by design, per instruction
        // that recency is the most important factor.
        console.log(`[PHASE 2] Skipped (no publishedAt field): ${article.title?.substring(0, 50)}`);
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────

      const normalizedSource = (article.source || '').toLowerCase().trim();
      const normalizedTitle = (article.title || '').toLowerCase().trim();
      const normalizedUrl = (article.url || '').toLowerCase().trim();
      const normalizedContent = ((article.content || article.description || '') || '').toLowerCase().substring(0, 500);

      // Skip if duplicate in the CURRENT batch
      if (seen.has(normalizedTitle)) {
        console.log(`[PHASE 2] Skipped duplicate in current batch: ${article.title?.substring(0, 50)}`);
        continue;
      }
      seen.add(normalizedTitle);

      // --- NEW: Skip if duplicate in Google Sheets (Historical) ---
      if (historicalTitles.has(normalizedTitle) || (normalizedUrl && historicalUrls.has(normalizedUrl))) {
        console.log(`[PHASE 2] Skipped historical duplicate (already in Sheets): ${article.title?.substring(0, 50)}`);
        continue;
      }

      // Skip if no title
      if (!normalizedTitle) continue;

      // Curated feeds (RSS / Google News) are pre-vetted by being on our source
      // list, so they bypass the source whitelist — but still must pass keyword filter.
      if (!article.trustedSource) {
        const isWhitelisted = whitelistSources.has(normalizedSource) ||
          (whitelist.dynamicSources || []).map(s => s.toLowerCase()).includes(normalizedSource);

        if (!isWhitelisted) {
          console.log(`[PHASE 2] Skipped non-whitelisted source: ${article.source}`);
          continue;
        }
      }

      // Relevance scoring (authoritative gate) — applies to ALL sources.
      const verdict = scoreRelevance(article.title, article.content || article.description);
      if (!verdict.passed) {
        console.log(`[PHASE 2] Rejected (${verdict.reason}): ${article.title?.substring(0, 50)}`);
        continue;
      }

      filtered.push({
        ...article,
        addedAt: this.timestamp,
        relevanceScore: verdict.score,
        relevanceTerms: [...verdict.strong, ...verdict.medium],
      });
    }

    console.log(`[PHASE 2] Filtered to ${filtered.length} unique, fresh real estate articles`);

    // Cap how many we send to the AI, to protect Groq's rate limit. Keep most recent.
    const maxAnalyze = this.datasource.config?.settings?.maxArticlesToAnalyze || 25;
    if (filtered.length > maxAnalyze) {
      filtered.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
      const capped = filtered.slice(0, maxAnalyze);
      console.log(`[PHASE 2] Capped to ${maxAnalyze} most recent for analysis (from ${filtered.length}).`);
      return capped;
    }
    return filtered;
  }

  /**
   * PHASE 3: Storage in Google Sheets
   */
  async storeArticles(articles) {
    console.log('[PHASE 3] Storing raw articles in Google Sheets...');

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

      await this.sheetsClient.appendRows(sheetsData, 'Master Backup');
      console.log('[PHASE 3] Stored in Sheets successfully');
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
        analyzed.push({
          ...article,
          ...analysis,
        });
      } catch (error) {
        console.error(`[PHASE 4] Analysis failed for "${article.title?.substring(0, 50)}"`, error.message);
        analyzed.push({
          ...article,
          sentiment: 'neutral',
          summary: article.title || 'Unable to analyze',
          category: 'untagged',
        });
      }
      // Brief pause between calls to stay under Groq's rate limit (avoids 429s)
      await new Promise(resolve => setTimeout(resolve, 4000));
    }

    console.log(`[PHASE 4] Analyzed ${analyzed.length} articles`);
    return analyzed;
  }

  /**
   * PHASE 4.5: Update Sheets with Analyzed Data (Smart Tab Routing)
   */
  async appendAnalyzedToSheets(analyzedArticles) {
    console.log('[PHASE 4.5] Sorting articles by dashboard theme and appending to specific tabs...');
    try {
      const grouped = {};
      
      for (const a of analyzedArticles) {
        // --- SMART ROUTING: Map raw AI output to specific Dashboard Tabs ---
        let dashboardTheme = 'Uncategorized';
        const catStr = ((a.category || '') + ' ' + (a.trending_topics || '')).toLowerCase();
        
        if (catStr.includes('financ') || catStr.includes('capital') || catStr.includes('invest') || catStr.includes('econom') || catStr.includes('fund')) {
          dashboardTheme = 'Capital & Financing';
        } else if (catStr.includes('policy') || catStr.includes('regulat') || catStr.includes('govern') || catStr.includes('law')) {
          dashboardTheme = 'Land & Regulatory';
        } else if (catStr.includes('demand') || catStr.includes('market') || catStr.includes('trend') || catStr.includes('sale')) {
          dashboardTheme = 'Demand Intelligence';
        } else if (catStr.includes('partner') || catStr.includes('jv') || catStr.includes('collaborat')) {
          dashboardTheme = 'Partnership & JV';
        } else if (catStr.includes('geopolitic') || catStr.includes('risk') || catStr.includes('conflict') || catStr.includes('crisis') || catStr.includes('protest')) {
          dashboardTheme = 'Geopolitical Risk';
        } else if (catStr.includes('infrastructure') || catStr.includes('develop') || catStr.includes('creat') || catStr.includes('construct') || catStr.includes('project')) {
          dashboardTheme = 'Market Creation';
        }

        if (!grouped[dashboardTheme]) {
          grouped[dashboardTheme] = [];
        }

        grouped[dashboardTheme].push([
          new Date().toISOString().split('T')[0],
          a.source || 'N/A',
          a.title || 'N/A',
          a.url || 'N/A',
          dashboardTheme,
          a.sentiment || 'neutral',
          a.summary || '',
          a.mixta_relevance?.direct_impact || a.mixta_flags || '',
          '', // Notes
          new Date().toISOString()
        ]);
      }

      // Write each group to its specific Google Sheet tab
      for (const [theme, rows] of Object.entries(grouped)) {
        try {
          await this.sheetsClient.appendRows(rows, theme);
        } catch (tabError) {
          console.warn(`[PHASE 4.5] Tab '${theme}' not found. Falling back to Master Backup.`);
          await this.sheetsClient.appendRows(rows, 'Master Backup');
        }
      }

    } catch (error) {
      console.error('[PHASE 4.5] Failed to group and append data:', error.message);
    }
  }

  /**
   * PHASE 5: Trend Detection
   */
  async detectTrends(articles) {
    console.log('[PHASE 5] Detecting trends...');

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
      
      const articleTopics = (article.trending_topics || '').split(',');
      for (const topic of articleTopics) {
        const t = topic.trim();
        if (t) topics[t] = (topics[t] || 0) + 1;
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
    const bullish = sentiments['bullish'] || 0;
    const bearish = sentiments['bearish'] || 0;
    const neutral = sentiments['neutral'] || 0;
    const total = bullish + bearish + neutral;

    if (total === 0) return 'neutral';
    if (bullish > total * 0.5) return 'bullish';
    if (bearish > total * 0.3) return 'bearish';
    return 'neutral';
  }

  /**
   * PHASE 6: Anomaly Detection
   */
  async detectAnomalies(articles, trends) {
    console.log('[PHASE 6] Detecting anomalies...');

    const alerts = [];

    if (articles.length > 50) {
      alerts.push({
        type: 'volume_spike',
        severity: 'high',
        message: `Article volume spike: ${articles.length} articles today (normal: 30-50)`,
        timestamp: this.timestamp,
      });
    }

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
  async generateAndSendEmail(articles, trends, alerts, briefing) {
    console.log('[PHASE 7] Generating and sending email digest...');

    try {
      // Pass ALL analyzed articles + the executive briefing
      const htmlContent = generateEmailHTML(articles, trends, alerts, briefing);
      
      // Support multiple recipients (comma-separated) so leadership can subscribe
      const recipients = (process.env.RECIPIENT_EMAIL || '')
        .split(',').map(s => s.trim()).filter(Boolean).join(',');

      await sendEmail({
        to: recipients,
        subject: `Nigerian Real Estate News Digest - ${new Date().toDateString()}`,
        html: htmlContent,
      });

      console.log('[PHASE 7] Email sent successfully');
      return true;
    } catch (error) {
      console.error('[PHASE 7] Email error:', error.message);
      return false;
    }
  }

  /**
   * PHASE 8: Dashboard Updates
   */
  async updateDashboard(articles, trends, alerts, briefing) {
    console.log('[PHASE 8] Updating dashboard data...');

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

      if (briefing) {
        fs.writeFileSync(
          path.join(dataDir, 'briefing.json'),
          JSON.stringify({ ...briefing, generatedAt: this.timestamp }, null, 2)
        );

        // Archive: persist a dated copy + maintain a lightweight searchable index
        const archiveDir = path.join(dataDir, 'archive');
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
        const dateStr = this.timestamp.split('T')[0];
        fs.writeFileSync(
          path.join(archiveDir, `briefing-${dateStr}.json`),
          JSON.stringify({ ...briefing, generatedAt: this.timestamp }, null, 2)
        );

        const indexPath = path.join(dataDir, 'briefings-index.json');
        let index = [];
        try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')).briefings || []; } catch (e) { index = []; }
        // Replace any existing entry for today, then prepend
        index = index.filter(b => b.date !== dateStr);
        index.unshift({
          date: dateStr,
          generatedAt: this.timestamp,
          executive_summary: briefing.executive_summary || '',
          themeCount: briefing.themes?.length || 0,
          themeLabels: (briefing.themes || []).map(t => t.label),
        });
        index = index.slice(0, 180); // ~6 months of daily briefings
        fs.writeFileSync(indexPath, JSON.stringify({ briefings: index }, null, 2));
      }

      console.log('[PHASE 8] Dashboard data updated');
    } catch (error) {
      console.error('[PHASE 8] Dashboard update error:', error.message);
    }
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

      // Apply any dashboard-edited config (watch-list / sources) before collecting.
      await this.applyRemoteConfig();

      const rawArticles = await this.collectArticles();
      health.recordSources(this.datasource.sourceHealth);
      health.recordCounts({ raw: rawArticles.length });

      if (rawArticles.length === 0) {
        console.warn('No articles collected. Exiting.');
        health.finalize({ fatal: true });
        health.persist();
        await this.sendOperatorAlert(health);
        return;
      }

      const filtered = await this.filterArticles(rawArticles);
      health.recordCounts({ filtered: filtered.length });

      // ─── AMENDED RETRY & MINIMUM VOLUME THRESHOLD GATE ───────────────────
      if (filtered.length === 0) {
        console.warn('[PIPELINE GATE] Zero unique, fresh articles within the target 48-hour frame passed filtering.');
        console.warn('[PIPELINE GATE] Execution halted naturally to prevent redundant cycles or data fragmentation.');
        health.finalize({ fatal: false }); // Change from fatal crash to a natural rest cycle
        health.persist();
        return; 
      }
      // ─────────────────────────────────────────────────────────────────────

      await this.storeArticles(filtered);

      // PHASE 2.5: Content enrichment
      console.log('[PHASE 2.5] Enriching article content...');
      const enriched = await enrichArticles(filtered);

      const analyzed = await this.analyzeArticles(enriched);

      // --- NEW FIX: Smart Tab Routing ---
      await this.appendAnalyzedToSheets(analyzed);
      // ----------------------------------

      // Count AI fallbacks
      const aiFallbacks = analyzed.filter(a =>
        !a.summary || a.summary.startsWith('Unable to generate')
      ).length;
      health.recordCounts({ analyzed: analyzed.length, aiFallbacks });

      const trends = await this.detectTrends(analyzed);
      const alerts = await this.detectAnomalies(analyzed, trends);

      const safeBriefingData = analyzed.map(article => ({
        ...article,
        content: article.content ? article.content.substring(0, 1000) + '...' : ''
      }));

      // --- NEW: AI Routing Gate (Geo-Fencing) ---
      // Hides macro/global data from the Synthesizer so the executive text summary stays hyper-local
      const localizedBriefingData = safeBriefingData.filter(article => 
        article.geoScope === 'nigeria' || article.geoScope === 'lagos' || !article.geoScope
      );
      console.log(`[PHASE 6.5] Routing Gate: Withholding ${safeBriefingData.length - localizedBriefingData.length} macro articles from Executive Summary generation.`);

      // ─── DYNAMIC EXECUTIVES SUMMARY ALLOCATION GATE ──────────────────────
      let briefing = null;
      if (localizedBriefingData.length > 0) {
        briefing = await this.synthesizer.synthesize(localizedBriefingData);
        health.recordSynthesis(briefing);
      } else {
        console.log('[PIPELINE GATE] No localized Nigerian signals recorded inside this 48-hour frame. Skipping Executive Summary generation.');
      }
      // ─────────────────────────────────────────────────────────────────────

      const emailSent = await this.generateAndSendEmail(analyzed, trends, alerts, briefing);
      health.recordEmail(emailSent);

      await this.updateDashboard(analyzed, trends, alerts, briefing);

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
      } catch (e) {
        console.error('Could not send failure alert:', e.message);
      }
      process.exit(1);
    }
  }

  async applyRemoteConfig() {
    try {
      const [sources, watchList] = await Promise.all([
        getSourcesOverride(),
        getWatchListOverride(),
      ]);

      if (sources) {
        this.datasource.config = {
          ...this.datasource.config,
          ...(sources.rssFeeds ? { rssFeeds: sources.rssFeeds } : {}),
          ...(sources.googleNewsQueries ? { googleNewsQueries: sources.googleNewsQueries } : {}),
        };
      }
      if (watchList) {
        this.synthesizer.watchListOverride = watchList;
      }
    } catch (e) {
      console.warn('[Config] Remote config not applied:', e.message);
    }
  }

  async sendOperatorAlert(health) {
    if (!health.needsAlert()) return;
    const to = process.env.ALERT_EMAIL || process.env.RECIPIENT_EMAIL;
    if (!to) {
      console.warn('[Health] No ALERT_EMAIL/RECIPIENT_EMAIL set; cannot send operator alert.');
      return;
    }
    try {
      const { subject, html } = health.buildAlertEmail();
      await sendEmail({ to, subject, html });
      console.log(`[Health] Operator alert sent (${health.record.status}).`);
    } catch (e) {
      console.error('[Health] Failed to send operator alert:', e.message);
    }
  }
}

const pipeline = new NewsPipeline();
pipeline.run().then(() => {
  process.exit(0);
});
