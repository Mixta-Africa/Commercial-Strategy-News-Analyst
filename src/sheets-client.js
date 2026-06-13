/**
 * Google Sheets Client Module
 * 
 * Manages integration with Google Sheets for:
 * - Appending new articles
 * - Querying historical data (7/30/90-day windows)
 * - Trend analysis
 * 
 * Uses Service Account credentials via GitHub Secrets
 */

const { google } = require('googleapis');

class SheetsClient {
  constructor() {
    this.spreadsheetId = process.env.SPREADSHEET_ID;
    this.apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    this.sheets = google.sheets({ version: 'v4' });
    this.auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS || '{}'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  /**
   * Initialize sheets if they don't exist
   * Creates headers for articles sheet
   */
  async initializeSheets() {
    try {
      await this.sheets.spreadsheets.create({
        auth: this.auth,
        requestBody: {
          properties: {
            title: 'Nigerian Real Estate News Archive',
          },
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: 'Articles',
              },
              data: [{
                rowData: [{
                  values: [
                    { userEnteredValue: { stringValue: 'Date' } },
                    { userEnteredValue: { stringValue: 'Source' } },
                    { userEnteredValue: { stringValue: 'Title' } },
                    { userEnteredValue: { stringValue: 'URL' } },
                    { userEnteredValue: { stringValue: 'Category' } },
                    { userEnteredValue: { stringValue: 'Location Tags' } },
                    { userEnteredValue: { stringValue: 'Sentiment' } },
                    { userEnteredValue: { stringValue: 'Summary' } },
                    { userEnteredValue: { stringValue: 'Trending Topics' } },
                    { userEnteredValue: { stringValue: 'Date Stored' } },
                  ],
                }],
              }],
            },
          ],
        },
      });
      console.log('[Sheets] Initialized new spreadsheet');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('[Sheets] Spreadsheet already exists');
      } else {
        throw error;
      }
    }
  }

  /**
   * Append rows to the Articles sheet
   * Each row: [date, source, title, url, category, locations, sentiment, summary, topics, timestamp]
   */
  async appendRows(values) {
    if (!values || values.length === 0) {
      console.log('[Sheets] No rows to append');
      return;
    }

    try {
      const auth = await this.auth.getClient();
      const response = await this.sheets.spreadsheets.values.append({
        auth,
        spreadsheetId: this.spreadsheetId,
        range: 'Articles!A:J',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values,
        },
      });

      console.log(`[Sheets] Appended ${response.data.updates.updatedRows} rows`);
      return response.data;
    } catch (error) {
      console.error('[Sheets] Append error:', error.message);
      throw error;
    }
  }

  /**
   * Query articles from last N days
   * Returns structured array of articles
   */
  async queryLastNDays(days) {
    try {
      const auth = await this.auth.getClient();
      const response = await this.sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: this.spreadsheetId,
        range: 'Articles!A:J',
      });

      const rows = response.data.values || [];
      const headers = rows[0] || [];
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const articles = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const articleDate = new Date(row[0]);

        if (articleDate >= cutoffDate) {
          articles.push({
            date: row[0],
            source: row[1],
            title: row[2],
            url: row[3],
            category: row[4],
            location_tags: row[5],
            sentiment: row[6],
            summary: row[7],
            trending_topics: row[8],
            date_stored: row[9],
          });
        }
      }

      console.log(`[Sheets] Queried ${articles.length} articles from last ${days} days`);
      return articles;
    } catch (error) {
      console.error('[Sheets] Query error:', error.message);
      return [];
    }
  }

  /**
   * Get all articles (full archive)
   */
  async getAllArticles() {
    try {
      const auth = await this.auth.getClient();
      const response = await this.sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: this.spreadsheetId,
        range: 'Articles!A:J',
      });

      const rows = response.data.values || [];
      const articles = [];

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        articles.push({
          date: row[0],
          source: row[1],
          title: row[2],
          url: row[3],
          category: row[4],
          location_tags: row[5],
          sentiment: row[6],
          summary: row[7],
          trending_topics: row[8],
          date_stored: row[9],
        });
      }

      console.log(`[Sheets] Retrieved ${articles.length} total articles`);
      return articles;
    } catch (error) {
      console.error('[Sheets] Get all error:', error.message);
      return [];
    }
  }

  /**
   * Calculate sentiment distribution for given date range
   */
  async calculateSentimentTrend(days) {
    const articles = await this.queryLastNDays(days);
    const sentiment = {
      bullish: 0,
      bearish: 0,
      neutral: 0,
    };

    for (const article of articles) {
      const s = (article.sentiment || 'neutral').toLowerCase();
      if (s in sentiment) sentiment[s]++;
    }

    return {
      period: `${days}d`,
      total: articles.length,
      sentiment,
      dominantSentiment: Object.entries(sentiment)
        .sort((a, b) => b[1] - a[1])[0][0],
    };
  }

  /**
   * Get trending topics for date range
   */
  async getTrendingTopics(days) {
    const articles = await this.queryLastNDays(days);
    const topicCounts = {};

    for (const article of articles) {
      const topics = (article.trending_topics || '')
        .split(',')
        .map(t => t.trim())
        .filter(t => t);

      for (const topic of topics) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }

    return Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));
  }

  /**
   * Update a specific article (by row index)
   */
  async updateArticle(rowIndex, updates) {
    try {
      const auth = await this.auth.getClient();
      const range = `Articles!A${rowIndex}:J${rowIndex}`;

      const response = await this.sheets.spreadsheets.values.update({
        auth,
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: {
          values: [updates],
        },
      });

      console.log(`[Sheets] Updated row ${rowIndex}`);
      return response.data;
    } catch (error) {
      console.error('[Sheets] Update error:', error.message);
      throw error;
    }
  }

  /**
   * Search articles by keyword
   */
  async searchArticles(keyword) {
    try {
      const auth = await this.auth.getClient();
      const response = await this.sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: this.spreadsheetId,
        range: 'Articles!A:J',
      });

      const rows = response.data.values || [];
      const results = [];
      const lowerKeyword = (keyword || '').toLowerCase();

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const fullText = `${row[1]} ${row[2]} ${row[7]}`.toLowerCase(); // source + title + summary

        if (fullText.includes(lowerKeyword)) {
          results.push({
            date: row[0],
            source: row[1],
            title: row[2],
            url: row[3],
            category: row[4],
            location_tags: row[5],
            sentiment: row[6],
            summary: row[7],
            trending_topics: row[8],
            date_stored: row[9],
          });
        }
      }

      console.log(`[Sheets] Found ${results.length} articles matching "${keyword}"`);
      return results;
    } catch (error) {
      console.error('[Sheets] Search error:', error.message);
      return [];
    }
  }
}

module.exports = SheetsClient;
