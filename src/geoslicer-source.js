/**
 * Geoslicer Source Module — ISOLATED DASHBOARD-EXCLUSIVE LANE
 * =============================================================
 * This module is DELIBERATELY SEPARATE from the main Nigerian briefing pipeline.
 *
 * Hard isolation guarantees (do not break these):
 *   - Does NOT write to Google Sheets.
 *   - Does NOT send email.
 *   - Does NOT touch articles.json / themes.json / briefing.json.
 *   - Does NOT consume the GROQ_API_KEY 8b/70b buckets used by agents.js.
 *   - Writes EXACTLY ONE artifact: data/geoslicer.json (read only by the map).
 *   - Uses its own optional GEOSLICER_AI_KEY for light sentiment. If unset or
 *     rate-limited, articles still plot as 'neutral' — the lane degrades, it
 *     never fails the main run.
 *
 * Purpose: feed the dashboard's Geoslicer map with multi-granularity real
 * estate news (Global / Africa / Nigeria / Lagos), which the Nigeria-only
 * main pipeline structurally cannot supply.
 */

const axios = require('axios');
const xml2js = require('xml2js');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const TIMEOUT = 12000;

/**
 * Geo-tagged query buckets. Each query carries the geoScope it should stamp.
 * The Google News RSS endpoint is used exclusively here: no API key, no
 * 429 quota shared with the main pipeline's GNews/NewsAPI usage.
 *
 * `gl`/`ceid` are tuned per bucket so Google returns region-appropriate press.
 */
const GEO_QUERY_BUCKETS = [
  // --- GLOBAL (macro commercial real estate) ---
  { scope: 'global', q: 'global real estate market', gl: 'US', ceid: 'US:en' },
  { scope: 'global', q: 'commercial property investment trends', gl: 'US', ceid: 'US:en' },
  { scope: 'global', q: 'REIT housing market outlook', gl: 'US', ceid: 'US:en' },
  { scope: 'global', q: 'global property prices interest rates', gl: 'GB', ceid: 'GB:en' },

  // --- AFRICA (pan-continental) ---
  { scope: 'africa', q: 'Africa real estate investment', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'African property market development', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'Kenya Nairobi real estate', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'South Africa property market', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'Ghana Accra real estate', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'Egypt Cairo real estate development', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'Morocco Casablanca property', gl: 'US', ceid: 'US:en' },
  { scope: 'africa', q: 'Rwanda Kigali housing development', gl: 'US', ceid: 'US:en' },

  // --- NIGERIA (national, non-Lagos framing welcome) ---
  { scope: 'nigeria', q: 'Nigeria real estate', gl: 'NG', ceid: 'NG:en' },
  { scope: 'nigeria', q: 'Nigeria property market housing', gl: 'NG', ceid: 'NG:en' },
  { scope: 'nigeria', q: 'Abuja real estate development', gl: 'NG', ceid: 'NG:en' },
  { scope: 'nigeria', q: 'Port Harcourt property', gl: 'NG', ceid: 'NG:en' },

  // --- LAGOS (regional focus) ---
  { scope: 'lagos', q: 'Lagos real estate', gl: 'NG', ceid: 'NG:en' },
  { scope: 'lagos', q: 'Lekki Ibeju-Lekki property development', gl: 'NG', ceid: 'NG:en' },
  { scope: 'lagos', q: 'Lagos land prices investment', gl: 'NG', ceid: 'NG:en' },
];

const MAX_PER_QUERY = 6;
const MAX_TOTAL = 120; // generous — this lane is decoupled from the 25-item main cap

// Lightweight real-estate gate so query bleed-through doesn't pollute the map.
const RE_KEYWORDS = [
  'real estate', 'property', 'properties', 'housing', 'home', 'homes', 'land',
  'developer', 'apartment', 'residential', 'commercial', 'construction',
  'building', 'mortgage', 'rent', 'rental', 'reit', 'realty', 'estate',
  'plot', 'duplex', 'shortlet', 'tenancy', 'landlord',
];

function looksRealEstate(title, desc) {
  const hay = `${title || ''} ${desc || ''}`.toLowerCase();
  return RE_KEYWORDS.some(k => hay.includes(k));
}

class GeoslicerSource {
  constructor() {
    this.parser = new xml2js.Parser();
    this.aiKey = process.env.GEOSLICER_AI_KEY || null;
    this.health = { ok: false, total: 0, byScope: {}, error: null, aiUsed: false };
  }

  async fetchBucket(bucket) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(bucket.q)}&hl=en&gl=${bucket.gl}&ceid=${bucket.ceid}`;
    const out = [];
    try {
      const response = await axios.get(url, { timeout: TIMEOUT, headers: BROWSER_HEADERS });
      const parsed = await this.parser.parseStringPromise(response.data);
      const items = parsed?.rss?.channel?.[0]?.item || [];

      let added = 0;
      for (const item of items) {
        if (added >= MAX_PER_QUERY) break;

        const rawTitle = item.title?.[0] || '';
        const sourceTag = item.source?.[0];
        const publisher = (typeof sourceTag === 'object' ? sourceTag._ : sourceTag)
          || (rawTitle.includes(' - ') ? rawTitle.split(' - ').pop() : 'Google News');
        const title = rawTitle.includes(' - ')
          ? rawTitle.substring(0, rawTitle.lastIndexOf(' - ')).trim()
          : rawTitle;

        const description = (item.description?.[0] || '').replace(/<[^>]+>/g, '').substring(0, 400);

        if (!title) continue;
        if (!looksRealEstate(title, description)) continue;

        out.push({
          title,
          description,
          url: item.link?.[0] || '',
          source: publisher,
          publishedAt: item.pubDate?.[0] || new Date().toISOString(),
          geoScope: bucket.scope,   // <-- stamped from the bucket, not hardcoded
          sentiment: 'neutral',     // default; may be upgraded by light AI pass
        });
        added++;
      }
      console.log(`[Geoslicer] ${bucket.scope} :: "${bucket.q}" → ${out.length}`);
    } catch (error) {
      const code = error.response?.status ? `HTTP ${error.response.status}` : error.message;
      console.warn(`[Geoslicer] FAIL "${bucket.q}": ${code}`);
      this.health.error = code;
    }
    return out;
  }

  /**
   * Optional light sentiment pass on a SEPARATE key. One batched call, capped.
   * Failure is swallowed — the map shows neutral markers instead of breaking.
   */
  async lightSentiment(articles) {
    if (!this.aiKey || !articles.length) return articles;

    // Cap how many we classify to keep the single call cheap and fast.
    const subset = articles.slice(0, 60);
    const list = subset.map((a, i) => `${i}. ${a.title}`).join('\n');

    const prompt = `Classify each real estate headline's market sentiment as exactly one of: bullish, bearish, neutral. Return ONLY a JSON array of objects {"i": <index>, "s": "<sentiment>"}. No prose, no markdown.\n\n${list}`;

    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1500,
          temperature: 0,
        },
        {
          headers: { Authorization: `Bearer ${this.aiKey}`, 'Content-Type': 'application/json' },
          timeout: 25000,
        }
      );

      let text = (r.data?.choices?.[0]?.message?.content || '').trim();
      text = text.replace(/```json|```/g, '').trim();
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start !== -1 && end !== -1) text = text.slice(start, end + 1);

      const parsed = JSON.parse(text);
      const valid = new Set(['bullish', 'bearish', 'neutral']);
      for (const row of parsed) {
        const idx = Number(row.i);
        const s = String(row.s || '').toLowerCase().trim();
        if (Number.isInteger(idx) && subset[idx] && valid.has(s)) {
          subset[idx].sentiment = s;
        }
      }
      this.health.aiUsed = true;
      console.log(`[Geoslicer] Light sentiment applied to ${subset.length} items`);
    } catch (error) {
      const code = error.response?.status || error.message;
      console.warn(`[Geoslicer] Sentiment skipped (${code}) — markers stay neutral`);
    }
    return articles;
  }

  dedupe(articles) {
    const seen = new Set();
    const out = [];
    for (const a of articles) {
      const key = (a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }

  async run() {
    console.log('\n[Geoslicer] === Isolated multi-granularity fetch START ===');

    const settled = await Promise.allSettled(GEO_QUERY_BUCKETS.map(b => this.fetchBucket(b)));
    let articles = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') articles.push(...s.value);
    }

    articles = this.dedupe(articles).slice(0, MAX_TOTAL);
    articles = await this.lightSentiment(articles);

    // Tally per-scope health for the dashboard.
    const byScope = {};
    for (const a of articles) byScope[a.geoScope] = (byScope[a.geoScope] || 0) + 1;

    this.health.ok = articles.length > 0;
    this.health.total = articles.length;
    this.health.byScope = byScope;

    const payload = {
      generatedAt: new Date().toISOString(),
      total: articles.length,
      byScope,
      aiSentimentApplied: this.health.aiUsed,
      articles,
    };

    console.log(`[Geoslicer] Total ${articles.length} articles | byScope=${JSON.stringify(byScope)}`);
    console.log('[Geoslicer] === END ===\n');
    return payload;
  }
}

module.exports = GeoslicerSource;

// Allow standalone execution: `node src/geoslicer-source.js`
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  (async () => {
    try {
      const payload = await new GeoslicerSource().run();
      const dir = path.join(process.cwd(), 'data');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'geoslicer.json'), JSON.stringify(payload, null, 2));
      console.log('[Geoslicer] Wrote data/geoslicer.json');
    } catch (e) {
      // Never hard-fail: this lane must not break the main pipeline run.
      console.error('[Geoslicer] Non-fatal error:', e.message);
      process.exit(0);
    }
  })();
}
