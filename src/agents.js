/**
 * AI Agents Module — 5-provider free fallback chain
 *
 * Priority order (all free tiers):
 *  1. Groq        — fastest, 30 RPM / 100K TPD
 *  2. Gemini      — most generous RPD (1,500/day), v1beta endpoint
 *  3. SambaNova   — persistent free tier, Llama 3.3 70B on RDU
 *  4. Mistral     — 1B tokens/month free, Mistral Small
 *  5. OpenRouter  — 28+ free models via :free suffix, last resort
 *
 * Fix log:
 *  - analyzeArticle: guard against articles with no usable content (caused 400s)
 *  - buildAnalysisPrompt: null-safe fallbacks on all article fields
 *  - _complete: validate prompt is non-empty string before calling any provider
 *  - _gemini: rethrow on 400 (bad request) not just non-404, to surface prompt issues clearly
 */

const axios = require('axios');

// Timeout for all provider calls
const TIMEOUT = 20000;

class Agents {
  constructor() {
    this.groqKey       = process.env.GROQ_API_KEY;
    this.geminiKey     = process.env.GEMINI_API_KEY;
    this.sambanovaKey  = process.env.SAMBANOVA_API_KEY;
    this.mistralKey    = process.env.MISTRAL_API_KEY;
    this.openrouterKey = process.env.OPENROUTER_API_KEY;
    this.cerebrasKey   = process.env.CEREBRAS_API_KEY;
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async analyzeArticle(article) {
    // Guard: skip articles with no usable content — these produce empty prompts
    // which every provider rejects with 400. Log and return default instead.
    const hasContent =
      (article.title && article.title.trim()) ||
      (article.description && article.description.trim()) ||
      (article.content && article.content.trim());

    if (!hasContent) {
      console.warn(`[Agents] Skipping article with no content (source: ${article.source || 'unknown'})`);
      return this.defaultAnalysis();
    }

    const prompt = this.buildAnalysisPrompt(article);
    const result = await this._complete(prompt, `Analyzing: ${(article.title || 'untitled').substring(0, 60)}`);
    return this.parseAnalysis(result);
  }

  async generateCompletion(prompt, label = 'Synthesis') {
    return this._complete(prompt, label);
  }

  // ─── CORE FALLBACK ENGINE ────────────────────────────────────────────────────

  /**
   * Per-article analysis: uses llama-3.1-8b-instant on Groq.
   * This is a SEPARATE Groq rate-limit bucket from the synthesis call:
   *   8b:  14,400 RPD / 30,000 TPM
   *   70b:  1,000 RPD / 12,000 TPM
   * Keeping them on different models means 25 article calls cannot exhaust
   * the budget for the single synthesis call that produces the briefing.
   */
  async _complete(prompt, label) {
    if (!prompt || !prompt.trim()) {
      console.error(`[Agents] Refusing to send empty prompt for: ${label}`);
      return null;
    }

    const isArticle = label.startsWith('Analyzing:');
    const providers = isArticle ? this._articleProviders(prompt) : this._synthesisProviders(prompt);

    for (const provider of providers) {
      if (!provider.key) {
        console.log(`[${provider.name}] Skipped — API key not set`);
        continue;
      }
      try {
        console.log(`[${provider.name}] ${label}...`);
        const result = await provider.fn();
        if (result && result.trim()) return result;
        throw new Error('Empty response');
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
        console.warn(`[${provider.name}] Failed (${status || 'ERR'}): ${msg.substring(0, 120)}`);
        if (status === 429) await this._sleep(2000);
      }
    }

    console.error(`[Agents] All providers failed for: ${label}`);
    return null;
  }

  /**
   * Provider chain for per-article analysis.
   * Groq 8b leads — fast, generous daily limit, adequate quality for summaries.
   * Synthesis-quality models (70b) are preserved for the briefing.
   */
  _articleProviders(prompt) {
    return [
      { name: 'Groq-8b',     fn: () => this._groqFast(prompt),    key: this.groqKey },
      { name: 'SambaNova',   fn: () => this._sambanova(prompt),   key: this.sambanovaKey },
      { name: 'Cerebras',    fn: () => this._cerebras(prompt),    key: this.cerebrasKey },
      { name: 'Mistral',     fn: () => this._mistral(prompt),     key: this.mistralKey },
      { name: 'OpenRouter',  fn: () => this._openrouter(prompt),  key: this.openrouterKey },
      { name: 'Gemini',      fn: () => this._gemini(prompt),      key: this.geminiKey },
    ];
  }

  /**
   * Provider chain for synthesis (executive briefing).
   * 70b leads for reasoning depth. Groq 8b is fallback — better than nothing.
   */
  _synthesisProviders(prompt) {
    return [
      { name: 'Groq-70b',    fn: () => this._groq70b(prompt),    key: this.groqKey },
      { name: 'Cerebras',    fn: () => this._cerebras(prompt),   key: this.cerebrasKey },
      { name: 'SambaNova',   fn: () => this._sambanova(prompt),  key: this.sambanovaKey },
      { name: 'Gemini',      fn: () => this._gemini(prompt),     key: this.geminiKey },
      { name: 'Mistral',     fn: () => this._mistral(prompt),    key: this.mistralKey },
      { name: 'OpenRouter',  fn: () => this._openrouter(prompt), key: this.openrouterKey },
      { name: 'Groq-8b',    fn: () => this._groqFast(prompt),   key: this.groqKey },
    ];
  }

  // ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────

  /** Groq fast (llama-3.1-8b-instant) — 14,400 RPD / 30K TPM. Used for per-article analysis. */
  async _groqFast(prompt) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${this.groqKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  /** Groq 70b (llama-3.3-70b-versatile) — 1,000 RPD / 12K TPM. Reserved for synthesis. */
  async _groq70b(prompt) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${this.groqKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _gemini(prompt) {
    // Try models in order; fall through only on 404 (model retired).
    // All other errors (429 rate limit, 400 bad request, 401 auth) are rethrown
    // so the fallback chain can handle them correctly.
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
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': this.geminiKey,
            },
            timeout: TIMEOUT,
          }
        );
        return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status !== 404) throw err; // only fall through on 404 (model not found)
        console.warn(`[Gemini] ${model} not found, trying next model...`);
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
        headers: {
          Authorization: `Bearer ${this.sambanovaKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _cerebras(prompt) {
    // gpt-oss-120b is the current Cerebras flagship (llama-3.3-70b was deprecated).
    // Falls through to llama3.1-8b if gpt-oss-120b is unavailable (404).
    const models = ['gpt-oss-120b', 'llama3.1-8b'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          'https://api.cerebras.ai/v1/chat/completions',
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 1000,
          },
          {
            headers: {
              Authorization: `Bearer ${this.cerebrasKey}`,
              'Content-Type': 'application/json',
            },
            timeout: TIMEOUT,
          }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status !== 404) throw err; // only fall through on 404
        console.warn(`[Cerebras] ${model} not found (404), trying next...`);
      }
    }
    throw lastErr;
  }

  async _mistral(prompt) {
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions',
      {
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      },
      {
        headers: {
          Authorization: `Bearer ${this.mistralKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT,
      }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _openrouter(prompt) {
    // Free model list changes frequently on OpenRouter. We try two proven free models
    // in order, falling through on 404 (model no longer free/available).
    // deepseek/deepseek-r1:free was deprecated from free tier June 2026.
    const models = [
      'meta-llama/llama-3.3-70b:free',
      'openai/gpt-oss-20b:free',
    ];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 1000,
          },
          {
            headers: {
              Authorization: `Bearer ${this.openrouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/mixta-africa',
              'X-Title': 'Mixta News Pipeline',
            },
            timeout: TIMEOUT,
          }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        // Fall through on 404 (model unavailable) or 400/422 (model no longer free — OpenRouter
        // returns 400 with "This model is unavailable for free" for paywalled models).
        if (status !== 404 && status !== 400 && status !== 422) throw err;
        console.warn(`[OpenRouter] ${model} unavailable (${status}), trying next...`);
      }
    }
    throw lastErr;
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── PROMPT BUILDER ──────────────────────────────────────────────────────────

  buildAnalysisPrompt(article) {
    // Null-safe field extraction — empty fields produce valid prompt sections,
    // not undefined interpolations that make the content field blank.
    const title   = (article.title   || '').trim() || 'Untitled';
    const source  = (article.source  || '').trim() || 'Unknown source';
    const url     = (article.url     || '').trim() || 'No URL';
    const content = (article.content || article.description || article.title || '').trim().substring(0, 1000);

    return `You are a professional real estate analyst for a major Lagos-based developer (Mixta Africa).
Analyze this article with intellectual rigor and business acumen.

ARTICLE:
Title: ${title}
Source: ${source}
URL: ${url}
Content: ${content}

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

  // ─── RESPONSE PARSING ────────────────────────────────────────────────────────

  parseAnalysis(responseText) {
    if (!responseText) return this.defaultAnalysis();
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary:                  parsed.summary                  || '',
        sentiment:                this.normalizeSentiment(parsed.sentiment),
        category:                 parsed.category                 || 'untagged',
        location_tags:            parsed.location_tags            || '',
        trending_topics:          parsed.trending_topics          || '',
        market_impact_severity:   parsed.market_impact_severity   || 'low',
        affected_segments:        parsed.affected_segments        || '',
        market_impact_timeframe:  parsed.market_impact_timeframe  || 'medium-term',
        mixta_relevance: parsed.mixta_relevance || {
          direct_impact:        'None',
          indirect_impact:      'None',
          strategic_opportunity:'None',
          risk_flag:            'None',
        },
      };
    } catch (err) {
      console.error('[Agents] Parse error:', err.message);
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
      summary:                 'Unable to generate summary — all AI providers unavailable.',
      sentiment:               'neutral',
      category:                'untagged',
      location_tags:           '',
      trending_topics:         '',
      market_impact_severity:  'unknown',
      affected_segments:       '',
      market_impact_timeframe: 'unknown',
      mixta_relevance: {
        direct_impact:         'Unable to determine',
        indirect_impact:       'Unable to determine',
        strategic_opportunity: 'Unable to determine',
        risk_flag:             'Unable to determine',
      },
    };
  }
}

module.exports = Agents;
