/**
 * Nigerian Real Estate News Research System
 * Main Pipeline Orchestrator
 * 
 * Workflow:
 * 1. Collect articles (50-100) - NOW WITH DIRECT URLS
 * 2. Filter by whitelist & location
 * 3. Store in Google Sheets
 * 4. Enrich thin articles (fallback strategy)
 * 5. AI analysis (professional summaries)
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
   * PHASE 1: Data Collection (NOW WITH DIRECT URLS)
   */
  async collectArticles() {
    console.log('[PHASE 1] Collecting articles from all sources...');
    
    try {
      // UPDATED: Added directUrlArticles to the Promise.all
      const [gNewsArticles, newsApiArticles, googleNewsArticles, rssArticles, directUrlArticles] = 
        await Promise.all([
          this.datasource.fetchGNews(),
          this.datasource.fetchNewsAPI(),
          this.datasource.fetchGoogleNews(),
          this.datasource.fetchRSSFeeds(),
          this.datasource.fetchDirectUrls(),  // NEW: Direct URL fetcher
        ]);

      // UPDATED: Added directUrlArticles to the collection
      const allArticles = [
        ...gNewsArticles,
        ...newsApiArticles,
        ...googleNewsArticles,
        ...rssArticles,
        ...directUrlArticles,  // NEW: Include direct URLs
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
      const normalizedContent = ((article.content || article.description || '') || '').toLowerCase().substring(0, 500);

      // Skip if duplicate
      if (seen.has(normalizedTitle)) {
        console.log(`[PHASE 2] Skipped duplicate: ${article.title?.substring(0, 50)}`);
        continue;
      }
      seen.add(normalizedTitle);

      // Check whitelist
      if (whitelist.coreSources && whitelist.coreSources.length > 0) {
        const isWhitelisted = Array.from(whitelistSources).some(ws => 
          normalizedSource.includes(ws) || article.url?.includes(ws.replace(/\s+/g, ''))
        );
        
        if (!isWhitelisted && !article.trusted) {
          console.log(`[PHASE 2] Skipped non-whitelisted source: ${normalizedSource}`);
          continue;
        }
      }

      // Score relevance
      const relevanceScore = scoreRelevance(article);
      if (relevanceScore.score < 0.3) {
        console.log(`[PHASE 2] Rejected (${relevanceScore.reason}): ${article.title?.substring(0, 70)}`);
        continue;
      }

      filtered.push({ ...article, relevanceScore: relevanceScore.score });
    }

    // Sort by relevance, then by date
    filtered.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      const dateB = new Date(b.pubDate || 0).getTime();
      const dateA = new Date(a.pubDate || 0).getTime();
      return dateB - dateA;
    });

    console.log(`[PHASE 2] Filtered to ${filtered.length} unique real estate articles`);
    
    // Cap at 15 most relevant for analysis
    const capped = filtered.slice(0, 15);
    console.log(`[PHASE 2] Capped to ${capped.length} most recent for analysis (from ${filtered.length}).`);
    
    return capped;
  }

  /**
   * PHASE 3: Store in Google Sheets
   */
  async storeArticles(articles, health = null) {
    console.log('[PHASE 3] Storing articles in Google Sheets...');
    
    try {
      const rows = articles.map(a => [
        a.title || '',
        a.source || '',
        a.pubDate || new Date().toISOString(),
        a.url || '',
        a.description || '',
      ]);

      const result = await this.sheetsClient.appendRows(rows);
      console.log(`[Sheets] Appended ${result?.updatedRows || 0} rows`);
      
      if (result?.updatedRows > 0) {
        console.log('[PHASE 3] Stored in Sheets successfully');
        return true;
      } else {
        throw new Error('No rows were appended');
      }
    } catch (error) {
      console.error('[PHASE 3] Google Sheets error:', error.message);
      if (health) {
        health.addWarning('[Sheets] Failed to store articles: ' + error.message);
      }
      return false;
    }
  }

  /**
   * PHASE 2.5: Enrich thin articles (FALLBACK STRATEGY)
   */
  async enrichContent(articles) {
    console.log('[PHASE 2.5] Enriching article content...');
    const enriched = await enrichArticles(articles);
    return enriched;
  }

  /**
   * PHASE 4: AI Analysis
   */
  async analyzeArticles(articles) {
    console.log('[PHASE 4] Running AI analysis...');
    
    const analysisResults = [];
    
    for (const article of articles) {
      try {
        const result = await this.agents.analyze(article);
        analysisResults.push({
          ...article,
          analysis: result,
        });
      } catch (error) {
        console.error(`[PHASE 4] Analysis error for "${article.title?.substring(0, 50)}":`, error.message);
        analysisResults.push({
          ...article,
          analysis: {
            summary: article.description || article.title,
            sentiment: 'neutral',
            category: 'real_estate',
            market_impact_severity: 'low',
            mixta_relevance: 'indirect_impact',
          },
        });
      }
    }

    console.log(`[PHASE 4] Analyzed ${analysisResults.length} articles`);
    return analysisResults;
  }

  /**
   * PHASES 5 & 6: Analytics (Trends & Anomalies)
   */
  async calculateTrends(analysisResults) {
    console.log('[PHASES 5 & 6] Calculating trends and anomalies...');
    
    // Simple trend detection
    const sentimentTally = { bullish: 0, bearish: 0, neutral: 0 };
    analysisResults.forEach(a => {
      if (a.analysis?.sentiment) {
        sentimentTally[a.analysis.sentiment]++;
      }
    });

    this.trends = {
      date: this.timestamp,
      articles_analyzed: analysisResults.length,
      sentiment_breakdown: sentimentTally,
      calculated_at: new Date().toISOString(),
    };

    // Anomalies (simple threshold)
    this.alerts = [];
    if (sentimentTally.bullish > analysisResults.length * 0.7) {
      this.alerts.push({
        type: 'bullish_spike',
        message: 'Unusually high positive sentiment detected',
      });
    }

    return { trends: this.trends, alerts: this.alerts };
  }

  /**
   * PHASE 4.5: Synthesize Executive Briefing
   */
  async synthesizeBriefing(analysisResults) {
    console.log('[PHASE 4.5] Synthesizing executive briefing...');
    
    try {
      const briefing = await this.synthesizer.synthesize(analysisResults);
      return briefing;
    } catch (error) {
      console.error('[PHASE 4.5] Synthesis error:', error.message);
      return {
        executive_summary: 'Unable to generate briefing',
        themes: [],
        watch_list_hits: [],
      };
    }
  }

  /**
   * PHASES 7 & 8: Email & Dashboard Output
   */
  async deliverBriefing(briefing, articles) {
    console.log('[PHASES 7 & 8] Delivering briefing...');
    
    try {
      const html = generateEmailHTML(briefing, articles);
      await sendEmail(html);
      console.log('[PHASE 7] Email sent successfully');
      
      // Update dashboard
      const dashboardData = {
        briefing,
        articles,
        trends: this.trends,
        alerts: this.alerts,
        generated_at: this.timestamp,
      };
      
      fs.writeFileSync(
        path.join(__dirname, '../data/briefing.json'),
        JSON.stringify(dashboardData, null, 2)
      );
      console.log('[PHASE 8] Dashboard updated');
      
      return true;
    } catch (error) {
      console.error('[PHASES 7 & 8] Delivery error:', error.message);
      return false;
    }
  }

  /**
   * Main Pipeline Runner
   */
  async run(health) {
    console.log('============================================================');
    console.log('Nigerian Real Estate News Pipeline Started');
    console.log(`Timestamp: ${this.timestamp}`);
    console.log('============================================================');

    try {
      // Phase 1: Collect
      const rawArticles = await this.collectArticles();
      if (!rawArticles.length) {
        console.log('No articles collected, exiting');
        return { success: false, message: 'No articles collected' };
      }

      // Phase 2: Filter
      const filteredArticles = await this.filterArticles(rawArticles);
      if (!filteredArticles.length) {
        console.log('No articles passed filtering, exiting');
        return { success: false, message: 'No articles after filtering' };
      }

      // Phase 3: Store in Sheets
      const sheetsStored = await this.storeArticles(filteredArticles, health);

      // Phase 2.5: Enrich
      const enrichedArticles = await this.enrichContent(filteredArticles);

      // Phase 4: Analyze
      const analysisResults = await this.analyzeArticles(enrichedArticles);

      // Phases 5 & 6: Trends
      await this.calculateTrends(analysisResults);

      // Phase 4.5: Synthesize
      const briefing = await this.synthesizeBriefing(analysisResults);

      // Phases 7 & 8: Deliver
      await this.deliverBriefing(briefing, enrichedArticles);

      console.log('============================================================');
      console.log('Pipeline Completed Successfully');
      console.log('============================================================');

      return {
        success: true,
        articlesCollected: rawArticles.length,
        articlesFiltered: filteredArticles.length,
        briefing,
      };
    } catch (error) {
      console.error('[MAIN] Pipeline error:', error.message);
      if (health) {
        health.recordError('[MAIN] Pipeline error: ' + error.message);
      }
      return { success: false, message: error.message };
    }
  }
}

// ============================================================================
// EXECUTION
// ============================================================================

async function main() {
  const health = new RunHealth();

  try {
    const pipeline = new NewsPipeline();
    const result = await pipeline.run(health);

    // Save health report
    const healthReport = health.getReport();
    fs.writeFileSync(
      path.join(__dirname, '../data/health.json'),
      JSON.stringify(healthReport, null, 2)
    );

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = NewsPipeline;
