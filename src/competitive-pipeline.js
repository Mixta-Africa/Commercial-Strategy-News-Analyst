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
 *   data/competitive-briefing.json — AI narratives + grouped stats (latest run only)
 *   data/competitive-prices.json   — daily snapshot archive for trend charting
 *
 * PERSISTENCE MODEL for competitive-prices.json:
 *   Structure: { lastUpdated, dailySnapshots: [ { date, groupedListings, rawListings }, … ] }
 *   Each run APPENDS a new date-keyed snapshot rather than overwriting.
 *   If a snapshot already exists for today (re-run), it is REPLACED, not duplicated.
 *   Snapshots older than RETENTION_DAYS are pruned to keep the file bounded.
 *   This mirrors the trend-history.json pattern and is what powers the multi-day
 *   trend line on the dashboard.
 */

const fs   = require('fs');
const path = require('path');
const { google }             = require('googleapis');
const { CompetitiveScraper } = require('./competitive-scraper');
const CompetitiveAnalyst     = require('./competitive-analyst');

const DATA_DIR      = path.join(process.cwd(), 'data');
const RETENTION_DAYS = 365; // keep a full year of daily snapshots

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

/**
 * Merges today's scrape into the running competitive-prices.json archive.
 *
 * Schema:
 *   {
 *     lastUpdated: ISO string,
 *     totalSnapshots: number,
 *     dailySnapshots: [
 *       {
 *         date: "YYYY-MM-DD",
 *         scrapedAt: ISO string,
 *         listingCount: number,
 *         groupCount: number,
 *         groupedListings: [...],
 *         rawListings: [...]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Rules:
 *   - Same-day re-run: existing snapshot for today is REPLACED, not appended.
 *   - Snapshots are sorted ascending by date.
 *   - Snapshots older than RETENTION_DAYS are pruned.
 *   - A read failure (first ever run, corrupted file) starts fresh rather than crashing.
 */
function mergeCompetitivePricesSnapshot(groupedListings, rawListings) {
  const pricesPath = path.join(DATA_DIR, 'competitive-prices.json');
  const today      = new Date().toISOString().slice(0, 10);

  // ── 1. Read existing archive (graceful fallback to empty) ──────────────────
  // Try competitive-prices.json first (the archive file).
  // If it doesn't exist yet, fall back to competitive-listings.json (the legacy
  // flat file written by every prior scrape run) so accumulated history is kept.
  const listingsPath = path.join(DATA_DIR, 'competitive-listings.json');
  let existing = { dailySnapshots: [] };

  const tryReadArchive = (filePath, label) => {
    try {
      const raw    = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.dailySnapshots) && parsed.dailySnapshots.length) {
        console.log(`[CompPipeline] Loaded ${parsed.dailySnapshots.length} existing snapshots from ${label}`);
        return { found: true, data: parsed };
      }
      // Flat schema — migrate to a single dated snapshot
      const rawL = parsed.listings || parsed.rawListings || [];
      const grpL = parsed.groupedListings || [];
      if (rawL.length || grpL.length) {
        const migratedDate = (parsed.generatedAt || '').slice(0, 10) || (() => {
          const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10);
        })();
        if (migratedDate && migratedDate !== today) {
          console.log(`[CompPipeline] Migrated flat ${label} → snapshot for ${migratedDate} (${rawL.length} listings)`);
          return { found: true, data: { dailySnapshots: [{
            date: migratedDate, scrapedAt: parsed.generatedAt || migratedDate,
            listingCount: rawL.length, groupCount: grpL.length,
            groupedListings: grpL, rawListings: rawL,
          }]}};
        }
      }
      return { found: false };
    } catch (e) {
      return { found: false };
    }
  };

  const archiveResult = tryReadArchive(pricesPath, 'competitive-prices.json');
  if (archiveResult.found) {
    existing = archiveResult.data;
  } else {
    const listingsResult = tryReadArchive(listingsPath, 'competitive-listings.json');
    if (listingsResult.found) {
      existing = listingsResult.data;
      console.log('[CompPipeline] Seeded archive from competitive-listings.json (first migration).');
    } else {
      console.log('[CompPipeline] No existing archive found — starting fresh.');
    }
  }

  // ── 2. Build today's snapshot ──────────────────────────────────────────────
  const todaySnapshot = {
    date:            today,
    scrapedAt:       new Date().toISOString(),
    listingCount:    rawListings.length,
    groupCount:      groupedListings.length,
    groupedListings,
    rawListings,
  };

  // ── 3. Replace today if exists, otherwise append ──────────────────────────
  let snapshots = (existing.dailySnapshots || []).filter(s => s.date !== today);
  snapshots.push(todaySnapshot);

  // ── 4. Prune snapshots older than RETENTION_DAYS ──────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const beforePrune = snapshots.length;
  snapshots = snapshots.filter(s => s.date >= cutoffStr);
  if (snapshots.length < beforePrune) {
    console.log(`[CompPipeline] Pruned ${beforePrune - snapshots.length} snapshots older than ${RETENTION_DAYS} days`);
  }

  // ── 5. Sort ascending by date ──────────────────────────────────────────────
  snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));

  // ── 6. Write merged archive ────────────────────────────────────────────────
  const archive = {
    lastUpdated:    new Date().toISOString(),
    totalSnapshots: snapshots.length,
    dailySnapshots: snapshots,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(pricesPath, JSON.stringify(archive, null, 2));
  console.log(`[CompPipeline] competitive-prices.json: ${snapshots.length} daily snapshots retained (today's ${snapshots.find(s => s.date === today) ? 'written' : 'missing'}).`);

  // ── 7. Write competitive-listings.json alias (flat today-only schema) ────────
  // Keeps backward compatibility for anything still referencing the legacy filename.
  // The dashboard now reads competitive-prices.json, but this ensures the workflow
  // git add and any other consumers never 404.
  const todaySnap = snapshots.find(s => s.date === today);
  if (todaySnap) {
    const listingsAlias = {
      generatedAt:    archive.lastUpdated,
      summary: {
        totalRawListings: (todaySnap.rawListings || []).length,
        totalGroups:      (todaySnap.groupedListings || []).length,
      },
      listings:        todaySnap.rawListings     || [],
      groupedListings: todaySnap.groupedListings || [],
    };
    fs.writeFileSync(listingsPath, JSON.stringify(listingsAlias, null, 2));
    console.log(`[CompPipeline] competitive-listings.json: alias written (${listingsAlias.listings.length} today's listings).`);
  }

  return archive;
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

  // ── competitive-briefing.json: latest run only (AI narratives) ─────────────
  const briefingPayload = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCompetitorNews: competitorNews.length,
      flaggedNews:         competitorNews.filter(n => n.flagged).length,
      totalRawListings:    priceListings.length,
      totalGroups:         groupedListings.length,
      priorityGroups:      groupedListings.filter(g => g.locationBucket === 'Priority Corridor').length,
      sitesScraped:        [...new Set(priceListings.map(l => l.source))].length,
    },
    groupedListings,
    priceTrendNarrative: analysis.priceTrendNarrative,
    competitorBriefing:  analysis.competitorBriefing,
    competitorNews,
  };
  writeJSON('competitive-briefing.json', briefingPayload);

  // ── competitive-prices.json: MERGE into daily snapshot archive ─────────────
  // This is the fix: instead of overwriting the file each run (which caused the
  // trend chart to show only one data point), we append today's snapshot to
  // the running archive and keep up to RETENTION_DAYS of history.
  mergeCompetitivePricesSnapshot(groupedListings, priceListings);

  console.log('\n[CompPipeline] ===== COMPLETE =====');
  console.log(`[CompPipeline] Finished: ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error('[CompPipeline] Fatal error:', err.message);
  process.exit(1);
});
