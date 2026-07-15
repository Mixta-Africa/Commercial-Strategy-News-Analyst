# Commercial Strategy News Analyst

A Nigerian real estate and commercial market intelligence system that autonomously aggregates news, analyzes sentiment, and tracks competitive strategy trends across West Africa. Built for executive decision-making with real-time interactive dashboards and automated market briefings.

**Status:** Active Development | **Language:** JavaScript/HTML | **License:** MIT

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [System Architecture](#system-architecture)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Running the Pipeline](#running-the-pipeline)
- [Project Structure](#project-structure)
- [Usage](#usage)
  - [Data Pipeline](#data-pipeline)
  - [Dashboard Navigation](#dashboard-navigation)
- [Key Components](#key-components)
- [Data Sources & Integration](#data-sources--integration)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## Overview

This system delivers **daily market intelligence briefings** for Mixta Africa's Commercial Strategy team. It synthesizes real estate and commercial news from multiple sources, applies sentiment analysis, and surfaces strategic signals through an interactive web-based dashboard.

**Core Use Cases:**
- **Market Surveillance** – Track commercial real estate trends across Lagos, Abuja, Accra, Dakar, and Casablanca
- **Competitive Intelligence** – Monitor competitor activities and market positioning
- **Outreach Calendar** – Identify high-impact events and decision-maker engagement opportunities
- **Sentiment Analysis** – Quantify bullish/bearish market sentiment over time
- **Cross-Sector Monitoring** – Detect demand signals from adjacent sectors (construction, finance, sustainability, policy)

---

## Features

### 🎯 **Intelligence Dashboard**

- **Briefing View** – Daily top-signal summary with hero story, strategic indicators, and evidence feed
- **Markets & Geospatial** – Leaflet-based interactive map showing regional focus (Lagos, Abuja, Accra, Dakar, Casablanca) with cross-sector impact rankings
- **Themes & Narrative Momentum** – Recurring themes tracked across days, ranked by consecutive appearance; historical topic volume charted by week
- **Competitive Positioning** – Real-time competitor price benchmarking with Mixta positioning overlay
- **Outreach Calendar** – Event-triggered signals + consolidated calendar view for B2B engagement planning
- **Innovation Hub** – PropTech, sustainability, design, finance, AI, and construction innovation tracking
- **Cross-Sector Intelligence** – Non-real-estate sectors ranked by market impact (e.g., infrastructure policy changes affecting Ibeju-Lekki)
- **Library/Archive** – Full-text search and temporal browsing of all processed articles

### 🔄 **Automated Data Pipeline**

- **Autonomous Daily Runs** – Scheduled news ingestion and analysis
- **Multi-Source Scraping** – Puppeteer-based web crawling + Cheerio DOM parsing
- **Real-Time Integration** – Google Sheets API + Firebase database sync
- **Sentiment Classification** – Bullish/bearish/neutral labeling for market signals
- **Thematic Grouping** – Automatic categorization of articles into recurring narratives

### 🎨 **Executive Design**

- Modern editorial typography (Poppins, Inter, IBM Plex Mono)
- Maroon brand palette with warm paper aesthetic
- Fully responsive (desktop, tablet, mobile)
- Accessibility-first UI (focus indicators, semantic HTML)
- Smooth animations and microinteractions

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│         Daily Pipeline Execution (src/index.js)              │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. NEWS INGESTION                                           │
│     ├─ Puppeteer + Cheerio web scraping                     │
│     ├─ Multi-source aggregation                             │
│     └─ Article deduplication & normalization                │
│                                                               │
│  2. DATA ENRICHMENT                                          │
│     ├─ Sentiment analysis (bullish/bearish/neutral)         │
│     ├─ Thematic categorization                              │
│     ├─ Geolocation tagging (Lagos, Abuja, Accra, etc.)     │
│     └─ Competitor tracking                                  │
│                                                               │
│  3. STORAGE & SYNC                                           │
│     ├─ Firebase Realtime Database                           │
│     ├─ Google Sheets (live data source)                     │
│     └─ Local data/ directory (JSON, CSV)                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                          ↓
         Interactive Dashboard (index.html)
         ├─ Briefing (hero story + signals)
         ├─ Markets (geospatial + cross-sector)
         ├─ Themes (narrative momentum + volume)
         ├─ Competition (positioning + pricing)
         ├─ Outreach (calendar + event signals)
         ├─ Innovation (PropTech hub)
         └─ Library (archive search)
```

---

## Tech Stack

### Backend & Pipeline
| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| **Runtime** | Node.js | ≥18.0.0 | JavaScript execution |
| **HTTP Client** | axios | ^1.6.0 | API requests & data fetching |
| **DOM Parsing** | cheerio | ^1.0.0-rc.12 | Server-side HTML parsing |
| **Browser Automation** | puppeteer | ^22.0.0 | Headless browser scraping |
| **Google Integration** | googleapis | ^118.0.0 | Sheets & Drive API access |
| **Data Transform** | xml2js | ^0.6.0 | XML to JSON conversion |

### Frontend & Dashboard
| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Markup** | HTML5 | Semantic document structure |
| **Styling** | CSS3 (Custom Properties) | Editorial design system |
| **Fonts** | Google Fonts | Poppins (headlines), Inter (UI), IBM Plex Mono (data) |
| **Maps** | Leaflet 1.9.4 | Interactive geospatial visualization |
| **Data Vis** | SVG (D3-style) | Sentiment calendars, trend charts, scatter plots |
| **Database** | Firebase (v8.10.1) | Real-time data sync |

### Infrastructure
| Service | Role |
|---------|------|
| **Google Sheets** | Master data store & configuration |
| **Firebase Realtime DB** | Live dashboard data sync |
| **Apify** | Distributed scraping (Lagos property listings) |
| **GitHub Actions** | CI/CD automation |

---

## Getting Started

### Prerequisites

- **Node.js** 18 or higher
- **npm** 8+
- **Google Cloud Project** with Sheets API enabled (for data pipeline)
- **Firebase Project** with Realtime Database (for dashboard sync)
- **Git**

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Mixta-Africa/Commercial-Strategy-News-Analyst.git
   cd Commercial-Strategy-News-Analyst
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Verify installation:**
   ```bash
   node --version  # Should be v18+
   npm --version   # Should be 8+
   ```

### Configuration

#### Step 1: Google Sheets API Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Google Sheets API** and **Google Drive API**
3. Create a **Service Account** and download the JSON key file
4. Store the key in a secure location (e.g., `~/.gcp/credentials.json`)

#### Step 2: Firebase Configuration

1. Create a Firebase project at [firebase.google.com](https://firebase.google.com)
2. Enable **Realtime Database**
3. Download your Firebase config object (Project Settings > General)
4. Add to `src/config.js`:
   ```javascript
   export const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "your-project.firebaseapp.com",
     databaseURL: "https://your-project.firebaseio.com",
     projectId: "your-project",
     storageBucket: "your-project.appspot.com",
     messagingSenderId: "YOUR_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```

#### Step 3: Environment Variables

Create a `.env` file in the root directory:

```env
# Google Sheets
GOOGLE_SHEETS_ID=your_sheet_id_here
GOOGLE_CREDENTIALS_PATH=~/.gcp/credentials.json

# Firebase
FIREBASE_DB_URL=https://your-project.firebaseio.com
FIREBASE_API_KEY=your_api_key_here

# News Sources (comma-separated URLs)
NEWS_SOURCES=https://source1.com,https://source2.com,https://source3.com

# Scraping Config
HEADLESS_BROWSER=true
PUPPETEER_TIMEOUT=30000

# Pipeline
LOG_LEVEL=info
DATA_OUTPUT_DIR=./data
```

### Running the Pipeline

#### Full Daily Pipeline (Production)

```bash
npm run pipeline
```

This executes the complete workflow:
1. Scrapes configured news sources
2. Parses and normalizes article data
3. Applies sentiment analysis
4. Syncs to Firebase & Google Sheets
5. Generates briefing artifacts

**Expected output:**
```
[INFO] Pipeline started at 2026-07-15T11:56:45Z
[INFO] Scraped 42 articles from 5 sources
[INFO] Sentiment analysis complete: 18 bullish, 12 bearish, 12 neutral
[INFO] Firebase sync: 42 articles updated
[INFO] Google Sheets sync: Daily briefing generated
[INFO] Pipeline complete in 3m 24s
```

#### Test Mode (Development)

```bash
npm run test
```

Runs the pipeline with:
- Reduced article limits (5 articles per source)
- No database writes
- Verbose logging
- Useful for debugging scraper issues

#### Manual Scraping (Diagnostics)

```bash
node src/scrapers/news-aggregator.js
node src/scrapers/property-listings.js  # (via apify-actor/)
```

---

## Project Structure

```
Commercial-Strategy-News-Analyst/
│
├── README.md                          # This file
├── package.json                       # Dependencies & scripts
├── .gitignore                         # Git ignore rules
│
├── src/
│   ├── index.js                       # Pipeline entry point
│   ├── config.js                      # Configuration loader
│   │
│   ├── scrapers/
│   │   ├── news-aggregator.js         # Multi-source web scraper
│   │   ├── property-listings.js       # Property data ingestion
│   │   └── sources.json               # Configured news sources
│   │
│   ├── processors/
│   │   ├── sentiment-analyzer.js      # Bullish/bearish classification
│   │   ├── thematic-grouper.js        # Narrative categorization
│   │   └── geo-tagger.js              # Location extraction
│   │
│   ├── integrations/
│   │   ├── firebase-sync.js           # Realtime DB writer
│   │   ├── google-sheets-sync.js      # Sheets API integration
│   │   └── storage.js                 # Local file storage
│   │
│   └── utils/
│       ├── logger.js                  # Logging utility
│       ├── http-client.js             # Axios wrapper
│       └── normalization.js           # Data normalization
│
├── apify-actor/
│   ├── package.json                   # Apify-specific dependencies
│   ├── Dockerfile                     # Docker image for Apify
│   └── src/
│       └── main.js                    # Lagos property scraper
│
├── index.html                         # Interactive dashboard (286 KB)
│   ├── <head>
│   │   ├── Meta tags & SEO
│   │   ├── Google Fonts (Poppins, Inter, IBM Plex)
│   │   ├── Leaflet CSS & JS
│   │   └── Firebase SDK
│   │
│   └── <body>
│       ├── .site-header (sticky nav + status)
│       ├── .nav (view switcher)
│       └── .shell (main content)
│           ├── #briefing (hero + signals + feed)
│           ├── #markets (geospatial + cross-sector)
│           ├── #themes (momentum + volume charts)
│           ├── #competition (pricing + positioning)
│           ├── #outreach (calendar + events)
│           ├── #innovation-hub (PropTech tracking)
│           ├── #library (archive search)
│           ├── #health (status, admin only)
│           └── #config (settings, admin only)
│
├── public/
│   ├── favicon.ico
│   └── [static assets loaded by dashboard]
│
├── assets/
│   ├── logo-header.png                # Mixta Africa brand logo
│   ├── logos/                         # Competitor/source logos
│   └── icons/                         # UI iconography
│
├── data/
│   ├── articles/                      # Cached article JSON
│   ├── briefings/                     # Daily briefing artifacts
│   ├── sentiment-history/             # Sentiment trends CSV
│   └── exports/                       # CSV/Excel exports
│
└── .github/
    └── workflows/
        ├── daily-pipeline.yml         # Scheduled runs
        └── ci-tests.yml               # Test automation
```

---

## Usage

### Data Pipeline

#### How to Trigger a Manual Run

From the dashboard (UI):
1. Click the **"Refresh Data"** button (top-right, next to status indicator)
2. Monitor the **status pill** for progress:
   - 🔵 Blue: Loading
   - 🟢 Green: Healthy (latest data loaded)
   - 🔴 Red: Error (check browser console)

From the command line:
```bash
npm run pipeline
```

#### Understanding Pipeline Output

After a successful run, check:

**Google Sheets:**
- New rows added to the configured sheet with parsed articles
- Columns: `date`, `source`, `title`, `summary`, `sentiment`, `location`, `themes`

**Firebase Realtime DB:**
```json
{
  "articles": {
    "article_id_1": {
      "title": "Lagos Real Estate Boom Continues",
      "source": "Property Report",
      "sentiment": "bullish",
      "date": "2026-07-15",
      "location": ["lagos"],
      "themes": ["market-growth", "investment"]
    }
  },
  "signals": { ... },
  "lastUpdated": "2026-07-15T11:56:45Z"
}
```

**Local Data Directory:**
- `data/articles/2026-07-15.json` – Today's scraped articles
- `data/sentiment-history/2026-07-15.csv` – Daily sentiment metrics

### Dashboard Navigation

#### Briefing (Homepage)

- **Top Signal** – Most impactful article of the day
- **Strategic Signals** – 4-card grid showing market indicators (e.g., "Housing Starts Up 12%", "Sentiment Bullish")
- **Markets Under Observation** – Quick-access cards for key regions
- **Intelligence Feed** – Masonry grid of all articles with:
  - Source label
  - Title (linked to original)
  - Summary excerpt
  - Sentiment pill (bullish/bearish/neutral)
  - Theme tags

**Actions:**
- Filter by theme (dropdown)
- Click article title to open original source in new tab
- Click sentiment pill to see similar articles

#### Markets

- **Regional Focus Selector** – Choose between Pan-Africa, West Africa, or North Africa macro views
- **Specific Market Selector** – Drill down to Nigeria, Lagos, Senegal, Morocco, Côte d'Ivoire, or Ghana
- **Interactive Map** – Leaflet-based visualization showing:
  - Active articles by region
  - Competitor activity clusters
  - Strategic hotspots (color intensity = signal strength)
- **Cross-Sector Market Intelligence** – Below the map:
  - Sectors ranked by impact on real estate
  - Bullish/bearish indicator
  - Representative articles with source attribution

#### Themes & Trends

- **Narrative Momentum** – Recurring themes tracked daily:
  - Card shows theme title, article count, trend direction (📈 rising / → stable / 📉 declining)
  - Click to see evolution and related articles
  
- **Topic Volume Over Time** – Historical heatmap:
  - X-axis: Weeks over past year
  - Y-axis: Theme topics
  - Color intensity: Mention frequency
  - Filters by date range

#### Competition

- **Pricing Analysis** – Scatter plot of competitor pricing vs. market average
  - X-axis: Property type / location
  - Y-axis: Price per sqm
  - Mixta marker overlaid for benchmarking
  - Hover for details

- **Market Overview Stats** – Inline stat bars:
  - Avg. Market Price
  - Mixta Positioning
  - YoY Change
  - Active Listings

#### Outreach

- **Macro Status** – Bullish/bearish/neutral overall market signal
- **Event-Triggered Signals** – High-impact signals with:
  - Signal label & description
  - Relevant companies affected
  - Suggested outreach contacts (staff names if available)
  - Entry routing (email, call, in-person visit)

- **Sales Calendar** – Consolidated table of upcoming events:
  - Event date
  - Sector
  - Reachable decision-makers
  - Sentiment for the day range

#### Innovation Hub

- **PropTech Tracking** – Innovations in property technology
- **Category Filters** – PropTech, Sustainable Development, Design, Finance, AI, Construction, Policy
- **Innovation Cards** – Show:
  - Category badge
  - Title (linked to source)
  - Description
  - "Why this matters" callout
  - Source & date

#### Library

- **Full-Text Search** – Search by keyword across all articles
- **Segment Filters** – Browse by:
  - **This Week** – Articles from last 7 days
  - **This Month** – Articles from last 30 days
  - **Archive** – All articles (1-year history)
- **Results** – Chronological list with source, summary, and sentiment

#### System (Admin Only)

- **Pipeline Health** – Last run timestamp, article count, error log
- **Data Sync Status** – Firebase & Google Sheets connection status
- **Configuration Panel** – Edit news sources, sentiment weights, location tags

---

## Key Components

### Sentiment Analyzer (`src/processors/sentiment-analyzer.js`)

Classifies articles as **Bullish** (positive outlook), **Bearish** (negative outlook), or **Neutral**:

```javascript
const sentiment = await analyzeSentiment(articleText);
// Returns: { label: 'bullish' | 'bearish' | 'neutral', score: 0.0–1.0 }
```

**Signals:**
- **Bullish:** Growth, expansion, investment, price increases, optimism
- **Bearish:** Decline, slowdown, challenges, price decreases, caution
- **Neutral:** Factual reporting, mixed outlook, announcements

### Thematic Grouper (`src/processors/thematic-grouper.js`)

Groups articles into recurring themes (e.g., "market-growth", "policy-reform", "sustainability"):

```javascript
const themes = await categorizeThemes(articleCollection);
// Returns: { theme: 'market-growth', articles: [...], momentum: 'rising' }
```

**Momentum Calculation:** Tracks consecutive days a theme appears; rising/stable/declining trend.

### Geo-Tagger (`src/processors/geo-tagger.js`)

Extracts and standardizes location mentions:

```javascript
const locations = await extractLocations(articleText);
// Returns: ['lagos', 'abuja', 'nigeria']
```

**Recognized Regions:** Nigeria (national + micro: Lagos, Abuja), Senegal, Morocco, Côte d'Ivoire, Ghana

### Firebase Sync (`src/integrations/firebase-sync.js`)

Writes processed articles and signals to Firebase Realtime Database in real-time:

```javascript
await syncToFirebase({
  articles: parsedArticles,
  signals: calculatedSignals,
  lastUpdated: new Date().toISOString()
});
```

### Google Sheets Sync (`src/integrations/google-sheets-sync.js`)

Appends article rows to a configured Google Sheet for archival & reporting:

```javascript
await syncToGoogleSheets(articleRows, { sheetId: 'configured', tab: 'daily-articles' });
```

---

## Data Sources & Integration

### News Sources

Configure in `src/scrapers/sources.json`:

```json
{
  "sources": [
    {
      "name": "Property Report",
      "url": "https://propertyreport.ng",
      "selector": ".article-item",
      "frequency": "daily"
    },
    {
      "name": "Business News",
      "url": "https://businessnews.ng",
      "selector": "article.main",
      "frequency": "daily"
    }
  ]
}
```

**Scraping Method:** Puppeteer + Cheerio (server-side DOM parsing)

### Property Listings (Apify Actor)

The `apify-actor/` subdirectory contains a separate scraper for Lagos property listings:

```bash
cd apify-actor
npm start
```

This runs a Crawlee-based actor that feeds property data into the main dashboard's competitive positioning view.

### External Integrations

| Service | Endpoint | Purpose | Authentication |
|---------|----------|---------|-----------------|
| **Google Sheets API** | `/sheets/v4/spreadsheets` | Data archival | Service Account JWT |
| **Firebase Realtime DB** | `.firebaseio.com` | Live sync | API Key |
| **Apify** | `https://api.apify.com` | Distributed scraping | API Token (optional) |

---

## Development

### Project Setup for Contributors

1. **Clone & install:**
   ```bash
   git clone https://github.com/Mixta-Africa/Commercial-Strategy-News-Analyst.git
   cd Commercial-Strategy-News-Analyst
   npm install
   ```

2. **Run in development mode:**
   ```bash
   npm run test  # Lightweight test pipeline
   ```

3. **Open dashboard locally:**
   ```bash
   # Serve index.html with a local server
   python3 -m http.server 8000
   # Visit http://localhost:8000
   ```

### Making Changes

- **Adding a new news source:** Edit `src/scrapers/sources.json` and update scraper selectors
- **Adjusting sentiment weights:** Modify `src/processors/sentiment-analyzer.js`
- **Changing dashboard layout:** Edit CSS in `index.html` (search for `/* ════ SECTION NAME ════ */`)
- **Adding a new view/tab:** Add nav button in `index.html`, create a new `.view` section, and implement view logic in embedded `<script>`

### Testing

```bash
npm run test
```

Runs a non-destructive test pipeline that validates:
- ✅ Scraper connectivity
- ✅ Article parsing
- ✅ Sentiment analysis
- ✅ Geolocation tagging
- ✅ Dashboard rendering (local HTML validation)

### Code Style

- **JavaScript:** ES6+, async/await preferred
- **Comments:** JSDoc for functions, inline for complex logic
- **Naming:** camelCase for variables/functions, UPPER_CASE for constants
- **Files:** One concern per file, utilities in `src/utils/`

---

## Troubleshooting

### Common Issues

#### 1. **Puppeteer Fails to Launch**
```
Error: Failed to launch the browser process
```

**Solution:**
```bash
npm install -g puppeteer
# Or install missing system libraries:
sudo apt-get install -y libgconf-2-4 libatk1.0-0 libx11-xcb1 libxcb-dri3-0
```

#### 2. **Google Sheets API Unauthorized**
```
Error: UNAUTHENTICATED. Failed to read Google Sheets.
```

**Solution:**
1. Verify `GOOGLE_CREDENTIALS_PATH` in `.env` points to valid JSON key
2. Re-download service account key from Google Cloud Console
3. Ensure Sheets API is enabled in the project

#### 3. **Firebase Connection Timeout**
```
Error: PERMISSION_DENIED. Firebase sync failed.
```

**Solution:**
1. Check Firebase Realtime DB security rules:
   ```json
   {
     "rules": {
       ".read": true,
       ".write": "auth != null"
     }
   }
   ```
2. Verify `FIREBASE_DB_URL` is reachable (not behind corporate firewall)

#### 4. **Dashboard Shows "Loading..." Indefinitely**
- Open browser DevTools (F12) → Console
- Check for CORS errors or 404s on `/data` or Firebase URLs
- Verify `index.html` is served over HTTP (not `file://`)

#### 5. **Articles Not Appearing in Dashboard**
1. Check that pipeline ran successfully: `npm run pipeline`
2. Verify data was written to `data/articles/YYYY-MM-DD.json`
3. Check Firebase console → Realtime Database → articles node populated
4. Reload dashboard (`Ctrl+F5` to hard refresh cache)

### Debug Logs

Enable verbose logging:

```bash
LOG_LEVEL=debug npm run pipeline
```

This outputs detailed logs for each step:
- HTTP requests and responses
- DOM parsing details
- Sentiment analysis scores
- Sync operations to Firebase/Sheets

### Getting Help

- Check GitHub Issues for similar problems
- Review logs in `data/logs/YYYY-MM-DD.log`
- Test individual scrapers: `node src/scrapers/news-aggregator.js --debug`

---

## Contributing

Contributions are welcome! Please follow these steps:

1. **Fork the repository**
2. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** with clear commit messages
4. **Test thoroughly:**
   ```bash
   npm run test
   ```
5. **Submit a Pull Request** with:
   - Description of changes
   - Any new dependencies listed
   - Screenshots if UI changes

### Contribution Ideas

- [ ] Add more news sources (Nigeria, West Africa, Africa-wide)
- [ ] Implement NLP-based topic modeling (vs. keyword matching)
- [ ] Build a mobile-first dashboard variant
- [ ] Create predictive sentiment models
- [ ] Add Slack/Teams webhook integration for alerts
- [ ] Implement full-text search indexing (Elasticsearch)
- [ ] Expand geospatial coverage to more African cities

---

## License

MIT License – See LICENSE file for details.

---

## Contact & Support

**Maintained by:** Mixta Africa Commercial Strategy Team  
**Repository:** https://github.com/Mixta-Africa/Commercial-Strategy-News-Analyst  
**Issues & Feedback:** Open a GitHub Issue

---

## Changelog

### v1.0.0 (Current Development)
- ✅ Core pipeline infrastructure (scraping, sentiment analysis, thematic grouping)
- ✅ Interactive dashboard with 8 main views
- ✅ Firebase & Google Sheets integration
- ✅ Geospatial market mapping (Lagos, Abuja, Accra, Dakar, Casablanca)
- ✅ Competitive positioning & pricing analysis
- ✅ Outreach calendar and B2B intelligence
- ✅ PropTech innovation tracking
- 🚀 Scheduled daily runs via GitHub Actions (coming soon)
- 🚀 Mobile app variant (planned)

---

**Last Updated:** July 15, 2026  
**Created by:** Mixta Africa  
**Repository:** [Commercial-Strategy-News-Analyst](https://github.com/Mixta-Africa/Commercial-Strategy-News-Analyst)
