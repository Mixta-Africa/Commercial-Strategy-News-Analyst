/**
 * AI Agents Module — 5-provider free fallback chain
 *
 * Priority order (all free tiers):
 *  1. Groq        — fastest, 30 RPM / 100K TPD
 *  2. Gemini      — most generous RPD (1,500/day), v1beta endpoint
 *  3. SambaNova   — persistent free tier, Llama 3.3 70B on RDU
 *  4. Mistral     — 1B tokens/month free, Mistral Small
 *  5. OpenRouter  — 28+ free models via :free suffix, last resort
 */

const axios = require('axios');

// Timeout for all provider calls
const TIMEOUT = 20000;

class Agents {
  constructor() {
    this.groqKey      = process.env.GROQ_API_KEY;
    this.geminiKey    = process.env.GEMINI_API_KEY;
    this.sambanovaKey = process.env.SAMBANOVA_API_KEY;
    this.mistralKey   = process.env.MISTRAL_API_KEY;
    this.openrouterKey = process.env.OPENROUTER_API_KEY;
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async analyzeArticle(article) {
    const prompt = this.buildAnalysisPrompt(article);
    const result = await this._complete(prompt, 'Article analysis');
    return this.parseAnalysis(result);
  }

  async generateCompletion(prompt, label = 'Synthesis') {
    return this._complete(prompt, label);
  }

  // ─── CORE FALLBACK ENGINE ────────────────────────────────────────────────────

  async _complete(prompt, label) {
    const providers = [
      { name: 'Groq',        fn: () => this._groq(prompt),        key: this.groqKey },
      { name: 'Gemini',      fn: () => this._gemini(prompt),      key: this.geminiKey },
      { name: 'SambaNova',   fn: () => this._sambanova(prompt),   key: this.sambanovaKey },
      { name: 'Mistral',     fn: () => this._mistral(prompt),     key: this.mistralKey },
      { name: 'OpenRouter',  fn: () => this._openrouter(prompt),  key: this.openrouterKey },
    ];

    for (const provider of providers) {
      if (!provider.key) {
        console.log(`[${provider.name}] Skipped — API key not set`);
        continue;
      }
      try {
        console.log(`[${provider.name}] ${label}...`);
        const result = await provider.fn();
        if (result) return result;
        throw new Error('Empty response');
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
        console.warn(`[${provider.name}] Failed (${status || 'ERR'}): ${msg.substring(0, 80)}`);
        // On 429 add a small pause before trying next provider
        if (status === 429) await this._sleep(2000);
      }
    }

    console.error(`[Agents] All providers failed for: ${label}`);
    return null; // caller handles null
  }

  // ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────

  async _groq(prompt) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: { Authorization: `Bearer ${this.groqKey}`, 'Content-Type': 'application/json' },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _gemini(prompt) {
    // Try models in order; fall through on 404 (model retired), rethrow on 429
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
          },
          {
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiKey },
            timeout: TIMEOUT,
          }
        );
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) throw err; // rethrow 429, auth errors etc.
        console.warn(`[Gemini] ${model} not found, trying next...`);
      }
    }
    throw lastErr;
  }

  async _sambanova(prompt) {
    // SambaNova is OpenAI-compatible
    const res = await axios.post(
      'https://api.sambanova.ai/v1/chat/completions',
      {
        model: 'Meta-Llama-3.3-70B-Instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: { Authorization: `Bearer ${this.sambanovaKey}`, 'Content-Type': 'application/json' },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _mistral(prompt) {
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: 'mistral-small-latest', // free tier, good quality
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: { Authorization: `Bearer ${this.mistralKey}`, 'Content-Type': 'application/json' },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _openrouter(prompt) {
    // Use DeepSeek R1 free as last resort — strong reasoning, good JSON output
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'deepseek/deepseek-r1:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${this.openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/mixta-africa', // OpenRouter requires this
          'X-Title': 'Mixta News Pipeline',
        },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── ANALYSIS PARSING (unchanged from original) ──────────────────────────

  buildAnalysisPrompt(article) {
  return `You are a professional real estate analyst for a major Lagos-based developer (Mixta Africa).
Analyze this article with intellectual rigor and business acumen.

ARTICLE:
Title: ${article.title}
Source: ${article.source}
URL: ${article.url}
Content: ${(article.content || article.description || '').substring(0, 1000)}

ANALYSIS REQUIREMENTS:

1. PROFESSIONAL SUMMARY (2-3 sentences, analyst tone):
   - Write as a market analyst would brief an executive
   - Focus on what this MEANS for Lagos real estate market
   - Example: "Infrastructure delays in Lekki threaten Q3 occupancy, pressuring new launches."

2. MARKET IMPACT:
   - Severity: critical | high | medium | low | negligible
   - Affected segments: affordable housing | mid-market | premium | commercial | industrial
   - Geographic radius: Lagos | Southwest Nigeria | National
   - Timeframe: immediate | near-term | medium-term | long-term

3. MIXTA AFRICA RELEVANCE:
   - Direct impact: Does this affect Lakowe Crossings, Lakowe Annexe, or Lagos New Town?
   - Indirect impact: Does this affect pricing, costs, regulatory environment?
   - Strategic opportunity: Does this create advantage?
   - Risk flag: Does this threaten execution?

4. SENTIMENT: bullish | bearish | neutral (justify in 1 sentence)

5. LOCATION TAGS: Lagos, Lekki, Ibeju-Lekki, etc.

6. CATEGORY: property-market | policy | developer-news | investment | infrastructure

7. TRENDING TOPICS: Comma-separated tags (e.g., "prices, inflation, infrastructure")

RESPOND ONLY IN THIS JSON FORMAT (no markdown, no explanation):
{
  "summary": "Professional 2-3 sentence summary",
  "sentiment": "bullish|bearish|neutral",
  "location_tags": "Lagos,Lekki,Ibeju-Lekki",
  "category": "property-market,infrastructure",
  "trending_topics": "prices,infrastructure",
  "market_impact_severity": "critical|high|medium|low|negligible",
  "affected_segments": "affordable housing,premium",
  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",
  "mixta_relevance": {
    "direct_impact": "Description or None",
    "indirect_impact": "Description or None",
    "strategic_opportunity": "Description or None",
    "risk_flag": "Description or None"
  }
}`;
}

  parseAnalysis(responseText) {
    if (!responseText) return this.defaultAnalysis();
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || '',
        sentiment: this.normalizeSentiment(parsed.sentiment),
        category: parsed.category || 'untagged',
        location_tags: parsed.location_tags || '',
        trending_topics: parsed.trending_topics || '',
        market_impact_severity: parsed.market_impact_severity || 'low',
        affected_segments: parsed.affected_segments || '',
        market_impact_timeframe: parsed.market_impact_timeframe || 'medium-term',
        mixta_relevance: parsed.mixta_relevance || {
          direct_impact: 'None', indirect_impact: 'None',
          strategic_opportunity: 'None', risk_flag: 'None',
        },
      };
    } catch (err) {
      console.error('Parse error:', err.message);
      return this.defaultAnalysis();
    }
  }

  normalizeSentiment(value) {
    const v = (value || '').toLowerCase();
    if (v.includes('bull')) return 'bullish';
    if (v.includes('bear')) return 'bearish';
    return 'neutral';
  }

  defaultAnalysis() {
    return {
      summary: 'Unable to generate summary — all AI providers unavailable.',
      sentiment: 'neutral', category: 'untagged',
      location_tags: '', trending_topics: '',
      market_impact_severity: 'unknown', affected_segments: '',
      market_impact_timeframe: 'unknown',
      mixta_relevance: {
        direct_impact: 'Unable to determine', indirect_impact: 'Unable to determine',
        strategic_opportunity: 'Unable to determine', risk_flag: 'Unable to determine',
      },
    };
  }
}

module.exports = Agents;
