/**
 * Competitive Intelligence Pipeline — Orchestrator
 * ==================================================
 * Runs the full competitive scrape → AI analysis → output chain.
 *
 * OUTPUTS (all isolated from the main briefing pipeline):
 *   1. Google Sheets — new tab "Competitive Intelligence" with raw listings + news
 *   2. data/competitive-briefing.json — AI narrative + raw data for dashboard
 *   3. data/competitive-prices.json   — price data only (future charting layer)
 *
 * Sheet schema:
 *   Competitor News tab  → Date | Competitor | Headline | Publisher | URL | Flagged | Watchlist Hits | Priority Location
 *   Price Listings tab   → Date | Source | Rank | Property Type | Location | Price (₦) | Price Formatted | Priority | Flagged | URL
 *
 * Designed for standalone operation today, dashboard integration tomorrow:
 *   - JSON outputs use a schema compatible with the existing dashboard's loadJSON() pattern.
 *   - When ready to integrate, the dashboard reads data/competitive-briefing.json directly.
 */

const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');
const CompetitiveScraper  = require('./competitive-scraper');
const CompetitiveAnalyst  = require('./competitive-analyst');

const DATA_DIR = path.join(process.cwd(), 'data');

// ─── SHEETS WRITER ────────────────────────────────────────────────────────────

class CompetitiveSheetsWriter {
  constructor() {
    this.spreadsheetId   = process.env.SPREADSHEET_ID;
    this.credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
    this.sheets = null;
  }

  async init() {
    if (!this.credentialsJson || !this.spreadsheetId) {
      console.warn('[CompSheets] Credentials or Spreadsheet ID not set — skipping Sheets write');
      return false;
    }
    try {
      const Buffer = require('buffer').Buffer;
      const creds = JSON.parse(Buffer.from(this.credentialsJson, 'base64').toString('utf8'));
      const auth  = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      return true;
    } catch (err) {
      console.error('[CompSheets] Auth failed:', err.message);
      return false;
    }
  }

  /**
   * Ensure a named sheet tab exists; create it if not.
   */
  async ensureTab(tabName) {
    try {
      const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const exists = meta.data.sheets.some(s => s.properties.title === tabName);
      if (!exists) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: tabName } } }],
          },
        });
        console.log(`[CompSheets] Created tab: ${tabName}`);
      }
    } catch (err) {
      console.error(`[CompSheets] ensureTab(${tabName}) failed:`, err.message);
    }
  }

  async appendRows(tabName, rows) {
    if (!this.sheets) return;
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `${tabName}!A:Z`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });
      console.log(`[CompSheets] Appended ${rows.length} rows to "${tabName}"`);
    } catch (err) {
      console.error(`[CompSheets] Append to "${tabName}" failed:`, err.message);
    }
  }

  async writeHeaders(tabName, headers) {
    if (!this.sheets) return;
    try {
      // Only write headers if the tab is empty (row 1 is blank).
      const existing = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${tabName}!A1:A1`,
      });
      if (!existing.data.values?.length) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${tabName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [headers] },
        });
        console.log(`[CompSheets] Headers written to "${tabName}"`);
      }
    } catch (err) {
      console.error(`[CompSheets] Header write failed:`, err.message);
    }
  }

  async writeCompetitorNews(news) {
    const TAB = 'Competitor News';
    await this.ensureTab(TAB);
    await this.writeHeaders(TAB, [
      'Date', 'Competitor', 'Headline', 'Publisher', 'URL',
      'Flagged', 'Watchlist Hits', 'Priority Location',
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = news.map(n => [
      today,
      n.competitor,
      n.title,
      n.publisher,
      n.url,
      n.flagged ? 'YES' : 'no',
      n.watchlistHits.join(', ') || '',
      n.priorityLocation ? 'YES' : 'no',
    ]);
    await this.appendRows(TAB, rows);
  }

  async writePriceListings(listings) {
    const TAB = 'Price Listings';
    await this.ensureTab(TAB);
    await this.writeHeaders(TAB, [
      'Date', 'Source', 'Source Rank', 'Property Type', 'Title',
      'Location', 'Price (₦)', 'Price Formatted', 'Priority Location',
      'Flagged', 'Watchlist Hits', 'Listing URL',
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = listings.map(l => [
      today,
      l.source,
      l.sourceRank,
      l.propertyType,
      l.title,
      l.location,
      l.priceValue || '',
      l.priceFormatted,
      l.priorityLocation ? 'YES' : 'no',
      l.flagged ? 'YES' : 'no',
      l.watchlistHits.join(', ') || '',
      l.listingUrl,
    ]);
    await this.appendRows(TAB, rows);
  }
}

// ─── JSON OUTPUT WRITER ───────────────────────────────────────────────────────

function writeJSON(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`[CompPipeline] Wrote ${filename}`);
}

// ─── STATS BUILDER ────────────────────────────────────────────────────────────

function buildStats(scrapedData) {
  const { competitorNews, priceListings } = scrapedData;

  // Price stats by property type.
  const priceByType = {};
  for (const l of priceListings) {
    if (!l.priceValue) continue;
    const t = l.propertyType;
    if (!priceByType[t]) priceByType[t] = [];
    priceByType[t].push(l.priceValue);
  }

  const priceStats = Object.entries(priceByType).map(([type, prices]) => {
    const sorted = prices.slice().sort((a, b) => a - b);
    const avg    = prices.reduce((s, v) => s + v, 0) / prices.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    return {
      propertyType: type,
      count: prices.length,
      minNgn: sorted[0],
      maxNgn: sorted[sorted.length - 1],
      avgNgn: Math.round(avg),
      medianNgn: median,
      minFormatted: formatPrice(sorted[0]),
      maxFormatted: formatPrice(sorted[sorted.length - 1]),
      avgFormatted: formatPrice(Math.round(avg)),
    };
  }).sort((a, b) => b.count - a.count);

  // Competitor news counts.
  const newsByCompetitor = {};
  for (const n of competitorNews) {
    newsByCompetitor[n.competitor] = (newsByCompetitor[n.competitor] || 0) + 1;
  }

  return { priceStats, newsByCompetitor };
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1_000_000_000) return `₦${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000)     return `₦${(num / 1_000_000).toFixed(1)}M`;
  return `₦${num.toLocaleString()}`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n[CompPipeline] ========== COMPETITIVE INTELLIGENCE PIPELINE ==========');
  console.log(`[CompPipeline] Started: ${new Date().toISOString()}`);

  const scraper  = new CompetitiveScraper();
  const analyst  = new CompetitiveAnalyst();
  const sheets   = new CompetitiveSheetsWriter();

  // 1. Scrape.
  const scrapedData = await scraper.run();

  // 2. AI analysis (runs in parallel with Sheets init).
  const [analysis, sheetsReady] = await Promise.all([
    analyst.analyse(scrapedData),
    sheets.init(),
  ]);

  // 3. Write to Sheets (two separate tabs).
  if (sheetsReady) {
    await sheets.writeCompetitorNews(scrapedData.competitorNews);
    await sheets.writePriceListings(scrapedData.priceListings);
  }

  // 4. Build stats.
  const stats = buildStats(scrapedData);

  // 5. Write JSON outputs for dashboard (future integration ready).
  const briefingPayload = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCompetitorNews:   scrapedData.competitorNews.length,
      flaggedNews:           scrapedData.competitorNews.filter(n => n.flagged).length,
      totalPriceListings:    scrapedData.priceListings.length,
      priorityListings:      scrapedData.priceListings.filter(l => l.priorityLocation).length,
      sitesScraped:          [...new Set(scrapedData.priceListings.map(l => l.source))].length,
    },
    priceStats:             stats.priceStats,
    newsByCompetitor:       stats.newsByCompetitor,
    priceTrendNarrative:    analysis.priceTrendNarrative,
    competitorBriefing:     analysis.competitorBriefing,
    // Full raw data arrays — dashboard can render these directly.
    competitorNews:         scrapedData.competitorNews,
    priceListings:          scrapedData.priceListings,
  };

  writeJSON('competitive-briefing.json', briefingPayload);
  writeJSON('competitive-prices.json', {
    generatedAt: new Date().toISOString(),
    priceStats:  stats.priceStats,
    listings:    scrapedData.priceListings,
  });

  console.log('\n[CompPipeline] ========== COMPLETE ==========');
  console.log(`[CompPipeline] Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  // Non-zero exit so the workflow step registers failure — but never
  // interferes with the main pipeline since this runs in its own job.
  console.error('[CompPipeline] Fatal error:', err.message);
  process.exit(1);
});
