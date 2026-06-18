/**
 * Competitive Intelligence Analyst
 * ==================================
 * Uses the same multi-key, multi-provider fallback pattern as agents.js
 * but runs on SEPARATE environment variables (COMPETITIVE_GROQ_KEY, etc.)
 * to preserve the main pipeline's Groq 8b/70b RPD bucket isolation.
 *
 * Produces two AI outputs:
 *   1. priceTrendNarrative — market pricing analysis across property types
 *   2. competitorIntelBriefing — strategic summary of competitor activity
 *
 * If all AI providers fail, both outputs degrade gracefully to
 * data-only summaries rather than crashing the pipeline.
 */

const axios = require('axios');
const config = require('./competitive-config');

const TIMEOUT = 25000;

class CompetitiveAnalyst {
  constructor() {
    // SEPARATE keys from the main pipeline — do not share with agents.js.
    // Fall back to the main pipeline keys ONLY if competitive-specific
    // keys are not set (better than no analysis at all).
    this.groqKeys    = this._parseKeys(process.env.COMPETITIVE_GROQ_KEY    || process.env.GROQ_API_KEY);
    this.geminiKeys  = this._parseKeys(process.env.COMPETITIVE_GEMINI_KEY  || process.env.GEMINI_API_KEY);
    this.mistralKeys = this._parseKeys(process.env.COMPETITIVE_MISTRAL_KEY || process.env.MISTRAL_API_KEY);
  }

  _parseKeys(str) {
    if (!str) return [];
    return str.split(',').map(k => k.trim()).filter(Boolean);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── PROVIDER CALLS ────────────────────────────────────────────────────────

  async _groq(prompt, key, model = 'llama-3.1-8b-instant') {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _gemini(prompt, key) {
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000 } },
          { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, timeout: TIMEOUT }
        );
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) throw err;
      }
    }
    throw lastErr;
  }

  async _mistral(prompt, key) {
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  // ─── FALLBACK ENGINE ────────────────────────────────────────────────────────

  async _complete(prompt, label) {
    const providers = [];
    this.groqKeys.forEach((k, i) => providers.push({ name: `Groq-8b (#${i+1})`, fn: () => this._groq(prompt, k) }));
    this.geminiKeys.forEach((k, i) => providers.push({ name: `Gemini (#${i+1})`, fn: () => this._gemini(prompt, k) }));
    this.mistralKeys.forEach((k, i) => providers.push({ name: `Mistral (#${i+1})`, fn: () => this._mistral(prompt, k) }));

    if (!providers.length) {
      console.warn(`[CompAnalyst] No API keys configured — skipping AI for: ${label}`);
      return null;
    }

    for (const p of providers) {
      try {
        console.log(`[CompAnalyst] ${p.name} → ${label}`);
        const result = await p.fn();
        if (result && result.trim()) return result;
        throw new Error('Empty response');
      } catch (err) {
        const status = err.response?.status;
        console.warn(`[CompAnalyst] ${p.name} failed (${status || 'ERR'}): ${err.message?.substring(0, 80)}`);
        if (status === 429) await this._sleep(3000);
      }
    }
    console.error(`[CompAnalyst] All providers failed for: ${label}`);
    return null;
  }

  // ─── PRICE TREND ANALYSIS ──────────────────────────────────────────────────

  buildPriceTrendPrompt(priceListings) {
    // Aggregate by property type for a clean summary the model can reason over.
    const byType = {};
    for (const l of priceListings) {
      const t = l.propertyType;
      if (!byType[t]) byType[t] = [];
      if (l.priceValue) byType[t].push(l.priceValue);
    }

    const typeStats = Object.entries(byType).map(([type, prices]) => {
      if (!prices.length) return null;
      const sorted = prices.slice().sort((a, b) => a - b);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
      return `${type}: min ₦${(min/1e6).toFixed(1)}M, max ₦${(max/1e6).toFixed(1)}M, avg ₦${(avg/1e6).toFixed(1)}M (${prices.length} listings)`;
    }).filter(Boolean).join('\n');

    const priorityListings = priceListings
      .filter(l => l.priorityLocation && l.priceValue)
      .slice(0, 20)
      .map(l => `${l.propertyType} | ${l.location} | ${l.priceFormatted} | ${l.source}`)
      .join('\n');

    return `You are a senior real estate market analyst for Mixta Africa, a Lagos-based residential developer with projects in Lakowe Crossings, Lakowe Annexe, and Lagos New Town (Ibeju-Lekki corridor).

Today's scrape from verified Lagos property listing sites produced the following market data:

PRICING BY PROPERTY TYPE (across ${priceListings.length} listings):
${typeStats || 'No price data available'}

PRIORITY LOCATION LISTINGS (Lekki, Ibeju-Lekki, Ajah, Epe corridor):
${priorityListings || 'None found in priority locations'}

TASK — Produce a structured competitive pricing briefing for Mixta Africa leadership:

1. MARKET PRICE SNAPSHOT: What are current Lagos sale prices per property type? Note which types are most active.

2. IBEJU-LEKKI / CORRIDOR ANALYSIS: What do the priority-location prices reveal about the corridor where Mixta operates? Are prices rising, falling, or stable?

3. PRICING POSITION: Based on these market prices, how should Mixta price its current inventory at Lakowe Crossings and Lakowe Annexe? Be specific — if bungalows are averaging ₦45M in Ajah, say so and advise accordingly.

4. RED FLAGS: Any pricing signals that suggest competitor pressure, a market slowdown, or an opportunity Mixta should move on immediately?

Write as a direct briefing to the CEO. Use specific numbers. Maximum 400 words.`;
  }

  // ─── COMPETITOR INTELLIGENCE BRIEFING ─────────────────────────────────────

  buildCompetitorBriefingPrompt(competitorNews) {
    const flagged = competitorNews.filter(n => n.flagged);
    const byCompetitor = {};
    for (const n of competitorNews) {
      if (!byCompetitor[n.competitor]) byCompetitor[n.competitor] = [];
      byCompetitor[n.competitor].push(n);
    }

    const newsDigest = Object.entries(byCompetitor).map(([name, items]) => {
      const headlines = items.slice(0, 4).map(n =>
        `  - [${n.flagged ? 'FLAGGED' : 'INFO'}] ${n.title} (${n.publisher})`
      ).join('\n');
      return `${name} (${items.length} articles):\n${headlines}`;
    }).join('\n\n');

    const flaggedSummary = flagged.length
      ? flagged.map(n => `  • ${n.competitor}: "${n.title}" — watchlist hits: ${n.watchlistHits.join(', ')}`).join('\n')
      : '  None today.';

    return `You are a competitive intelligence analyst for Mixta Africa.

Today's competitor monitoring sweep produced the following press coverage:

COMPETITOR COVERAGE:
${newsDigest || 'No competitor news found today.'}

WATCHLIST ALERTS (${flagged.length} items):
${flaggedSummary}

Mixta Africa's live projects: Lakowe Crossings, Lakowe Annexe, Lagos New Town (Ibeju-Lekki corridor).
Key competitors to watch: ${config.competitors.map(c => c.name).join(', ')}.

TASK — Produce a competitor intelligence briefing:

1. HEADLINE MOVES: What is each active competitor doing right now? New launches, pricing changes, expansions?

2. WATCHLIST ALERTS: For each flagged item, explain the strategic implication for Mixta. Be specific — a competitor launching in Ibeju-Lekki is a direct threat; a competitor launching in Abuja is not.

3. STRATEGIC RECOMMENDATION: One concrete action Mixta should take in the next 7 days in response to today's competitive landscape.

4. QUIET COMPETITORS: Note any monitored competitors with no recent coverage — silence can indicate a pause before a large move.

Maximum 350 words. Direct briefing tone. No hedging.`;
  }

  // ─── MAIN ENTRY POINT ──────────────────────────────────────────────────────

  async analyse(scrapedData) {
    console.log('\n[CompAnalyst] Starting AI analysis...');
    const { competitorNews, priceListings } = scrapedData;

    const [priceTrendRaw, competitorIntelRaw] = await Promise.all([
      priceListings.length
        ? this._complete(this.buildPriceTrendPrompt(priceListings), 'Price Trend Analysis')
        : Promise.resolve(null),
      competitorNews.length
        ? this._complete(this.buildCompetitorBriefingPrompt(competitorNews), 'Competitor Intelligence Briefing')
        : Promise.resolve(null),
    ]);

    // Graceful degradation: if AI fails, generate a data-only summary.
    const priceTrendNarrative = priceTrendRaw || this._fallbackPriceSummary(priceListings);
    const competitorBriefing  = competitorIntelRaw || this._fallbackCompetitorSummary(competitorNews);

    console.log('[CompAnalyst] Analysis complete');
    return { priceTrendNarrative, competitorBriefing };
  }

  _fallbackPriceSummary(listings) {
    if (!listings.length) return 'No property listings were collected in this run.';
    const byType = {};
    for (const l of listings) {
      if (!byType[l.propertyType]) byType[l.propertyType] = [];
      if (l.priceValue) byType[l.propertyType].push(l.priceValue);
    }
    const lines = Object.entries(byType).map(([t, prices]) => {
      if (!prices.length) return `${t}: no price data`;
      const avg = prices.reduce((s,v) => s+v, 0) / prices.length;
      return `${t}: avg ₦${(avg/1e6).toFixed(1)}M (${prices.length} listings)`;
    });
    return `AI narrative unavailable — raw summary:\n${lines.join('\n')}`;
  }

  _fallbackCompetitorSummary(news) {
    if (!news.length) return 'No competitor news collected in this run.';
    const flagged = news.filter(n => n.flagged);
    return `AI narrative unavailable.\nTotal items: ${news.length} | Flagged: ${flagged.length}\n` +
      flagged.map(n => `• ${n.competitor}: ${n.title}`).join('\n');
  }
}

module.exports = CompetitiveAnalyst;
