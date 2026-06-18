/**
 * Competitive Intelligence Pipeline — v2
 * ========================================
 * Orchestrates scrape → AI analysis → Sheets write → JSON output.
 *
 * SHEET STRUCTURE (separate spreadsheet via COMPETITIVE_SPREADSHEET_ID):
 *
 *   Tab 1 "Price Groups"
 *     One row per (PropertyType × Bedrooms × Location) group.
 *     Columns: Date | Property Type | Bedrooms | Location Bucket | # Listings |
 *              Min Price | Max Price | Avg Price | Median Price |
 *              Common Amenities | Sources | Flagged | Watchlist Hits | Sample Titles
 *
 *   Tab 2 "Competitor News"
 *     One row per news article.
 *     Columns: Date | Competitor | Headline | Publisher | URL | Flagged | Watchlist Hits
 *
 * JSON OUTPUTS (dashboard-ready):
 *   data/competitive-briefing.json — AI narratives + grouped stats
 *   data/competitive-prices.json   — raw listings for future charting
 */

const fs   = require('fs');
const path = require('path');
const { google }            = require('googleapis');
const { CompetitiveScraper } = require('./competitive-scraper');
const CompetitiveAnalyst    = require('./competitive-analyst');

const DATA_DIR = path.join(process.cwd(), 'data');

// ─── SHEETS WRITER ────────────────────────────────────────────────────────────

class CompetitiveSheetsWriter {
  constructor() {
    // SEPARATE spreadsheet — never touches the main pipeline's sheet.
    this.spreadsheetId   = process.env.COMPETITIVE_SPREADSHEET_ID;
    this.credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS;
    this.sheets = null;
  }

  async init() {
    if (!this.credentialsJson) {
      console.warn('[CompSheets] GOOGLE_SHEETS_CREDENTIALS not set — skipping Sheets write');
      return false;
    }
    if (!this.spreadsheetId) {
      console.warn('[CompSheets] COMPETITIVE_SPREADSHEET_ID not set — skipping Sheets write');
      return false;
    }
    try {
      const { Buffer } = require('buffer');
      const creds = JSON.parse(Buffer.from(this.credentialsJson, 'base64').toString('utf8'));
      const auth  = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      console.log('[CompSheets] Auth initialised');
      return true;
    } catch (err) {
      console.error('[CompSheets] Auth failed:', err.message);
      return false;
    }
  }

  async ensureTab(tabName) {
    try {
      const meta   = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
      const exists = meta.data.sheets.some(s => s.properties.title === tabName);
      if (!exists) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
        });
        console.log(`[CompSheets] Created tab: "${tabName}"`);
      }
    } catch (err) {
      console.error(`[CompSheets] ensureTab("${tabName}") failed:`, err.message);
    }
  }

  async writeHeaders(tabName, headers) {
    try {
      const existing = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `'${tabName}'!A1:A1`,
      });
      if (!existing.data.values?.length) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `'${tabName}'!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [headers] },
        });
        console.log(`[CompSheets] Headers written to "${tabName}"`);
      }
    } catch (err) {
      console.error(`[CompSheets] Header write failed for "${tabName}":`, err.message);
    }
  }

  async appendRows(tabName, rows) {
    if (!rows.length) return;
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: `'${tabName}'!A:Z`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });
      console.log(`[CompSheets] Appended ${rows.length} rows → "${tabName}"`);
    } catch (err) {
      console.error(`[CompSheets] Append to "${tabName}" failed:`, err.message);
    }
  }

  async writePriceGroups(groupedListings) {
    const TAB = 'Price Groups';
    await this.ensureTab(TAB);
    await this.writeHeaders(TAB, [
      'Date', 'Property Type', 'Bedrooms', 'Location Bucket',
      '# Listings', 'Min Price', 'Max Price', 'Avg Price', 'Median Price',
      'Common Amenities', 'Data Sources', 'Flagged', 'Watchlist Hits', 'Sample Titles',
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = groupedListings.map(g => [
      today,
      g.propertyType,
      g.bedroomLabel,
      g.locationBucket,
      g.listingCount,
      g.minFormatted,
      g.maxFormatted,
      g.avgFormatted,
      formatPrice(g.medianPrice),
      g.topAmenities,
      g.sources,
      g.flagged ? 'YES' : '',
      g.watchlistHits,
      g.sampleListings,
    ]);
    await this.appendRows(TAB, rows);
  }

  async writeCompetitorNews(news) {
    const TAB = 'Competitor News';
    await this.ensureTab(TAB);
    await this.writeHeaders(TAB, [
      'Date', 'Competitor', 'Headline', 'Publisher',
      'URL', 'Flagged', 'Watchlist Hits', 'Priority Location',
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const rows = news.map(n => [
      today,
      n.competitor,
      n.title,
      n.publisher,
      n.url,
      n.flagged ? 'YES' : '',
      n.watchlistHits.join(', ') || '',
      n.priorityLocation ? 'YES' : '',
    ]);
    await this.appendRows(TAB, rows);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return `₦${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `₦${(num / 1e6).toFixed(1)}M`;
  return `₦${num.toLocaleString()}`;
}

function writeJSON(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`[CompPipeline] Wrote ${filename}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n[CompPipeline] ===== COMPETITIVE INTELLIGENCE PIPELINE =====');
  console.log(`[CompPipeline] Started: ${new Date().toISOString()}`);

  const scraper = new CompetitiveScraper();
  const analyst = new CompetitiveAnalyst();
  const sheets  = new CompetitiveSheetsWriter();

  // Scrape first.
  const scrapedData = await scraper.run();
  const { competitorNews, priceListings, groupedListings } = scrapedData;

  // AI analysis + Sheets init in parallel.
  const [analysis, sheetsReady] = await Promise.all([
    analyst.analyse({ competitorNews, priceListings }),
    sheets.init(),
  ]);

  // Write to separate Google Sheet.
  if (sheetsReady) {
    await sheets.writePriceGroups(groupedListings);
    await sheets.writeCompetitorNews(competitorNews);
  }

  // JSON output — dashboard-ready schema.
  const briefingPayload = {
    generatedAt:          new Date().toISOString(),
    summary: {
      totalCompetitorNews:  competitorNews.length,
      flaggedNews:          competitorNews.filter(n => n.flagged).length,
      totalRawListings:     priceListings.length,
      totalGroups:          groupedListings.length,
      priorityGroups:       groupedListings.filter(g => g.locationBucket === 'Priority Corridor').length,
      sitesScraped:         [...new Set(priceListings.map(l => l.source))].length,
    },
    groupedListings,
    priceTrendNarrative:  analysis.priceTrendNarrative,
    competitorBriefing:   analysis.competitorBriefing,
    competitorNews,
  };

  writeJSON('competitive-briefing.json', briefingPayload);
  writeJSON('competitive-prices.json', {
    generatedAt:    new Date().toISOString(),
    groupedListings,
    rawListings:    priceListings,
  });

  console.log('\n[CompPipeline] ===== COMPLETE =====');
  console.log(`[CompPipeline] Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('[CompPipeline] Fatal error:', err.message);
  process.exit(1);
});
