/**
 * AI Agents Module - CURRENT MODELS (June 2026)
 *
 * Verified current models:
 * - Groq:     llama-3.3-70b-versatile  (mixtral fully removed from Groq)
 * - Cerebras: llama-3.3-70b            (llama-3.1-8b deprecated)
 * - Gemini:   gemini-3.5-flash via v1beta  (2.0/1.5 returned 404 after June 1 2026 shutdown)
 */

const axios = require('axios');

class Agents {
  constructor() {
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.cerebrasApiKey = process.env.CEREBRAS_API_KEY;
    this.geminiApiKey = process.env.GEMINI_API_KEY;
  }

  async analyzeArticle(article) {
    const prompt = this.buildAnalysisPrompt(article);

    try {
      console.log(`[Groq] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callGroqAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Groq] Failed: ${error.message}. Trying Cerebras.`);
    }

    try {
      console.log(`[Cerebras] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callCerebasAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Cerebras] Failed: ${error.message}. Trying Gemini.`);
    }

    try {
      console.log(`[Gemini] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callGeminiAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.error(`[Gemini] Failed: ${error.message}. Using defaults.`);
      return this.defaultAnalysis();
    }
  }

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

  /**
   * Groq API call - llama-3.3-70b-versatile (current production model)
   */
  async callGroqAPI(prompt) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    if (!this.groqApiKey) throw new Error('GROQ_API_KEY not set in environment');

    const response = await axios.post(url, {
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    }, {
      headers: {
        'Authorization': `Bearer ${this.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    return response.data.choices[0]?.message?.content || '';
  }

  /**
   * Cerebras API call - llama-3.3-70b (current model)
   */
  async callCerebasAPI(prompt) {
    const url = 'https://api.cerebras.ai/v1/chat/completions';
    if (!this.cerebrasApiKey) throw new Error('CEREBRAS_API_KEY not set in environment');

    const response = await axios.post(url, {
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    }, {
      headers: {
        'Authorization': `Bearer ${this.cerebrasApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    return response.data.choices[0]?.message?.content || '';
  }

  /**
   * Gemini API call - gemini-3.5-flash via v1beta
   * (gemini-1.5 and 2.0 were shut down June 1 2026, returning 404)
   * Tries current models in order, falling through on 404.
   */
  async callGeminiAPI(prompt) {
    if (!this.geminiApiKey) throw new Error('GEMINI_API_KEY not set in environment');

    const models = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const response = await axios.post(url, {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.geminiApiKey,
          },
          timeout: 15000,
        });

        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      } catch (error) {
        const status = error.response?.status;
        console.warn(`[Gemini] ${model} failed (${status || error.message}).`);
        // Only fall through to next model on 404 (model not found); rethrow otherwise
        if (status && status !== 404) throw error;
      }
    }

    throw new Error('No available Gemini models');
  }

  parseAnalysis(responseText) {
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
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
          direct_impact: 'None',
          indirect_impact: 'None',
          strategic_opportunity: 'None',
          risk_flag: 'None',
        },
      };
    } catch (error) {
      console.error('Parse error:', error.message);
      return this.defaultAnalysis();
    }
  }

  normalizeSentiment(value) {
    const normalized = (value || '').toLowerCase().trim();
    if (normalized.includes('bull')) return 'bullish';
    if (normalized.includes('bear')) return 'bearish';
    return 'neutral';
  }

  defaultAnalysis() {
    return {
      summary: 'Unable to generate professional summary due to AI provider unavailability.',
      sentiment: 'neutral',
      category: 'untagged',
      location_tags: '',
      trending_topics: '',
      market_impact_severity: 'unknown',
      affected_segments: '',
      market_impact_timeframe: 'unknown',
      mixta_relevance: {
        direct_impact: 'Unable to determine',
        indirect_impact: 'Unable to determine',
        strategic_opportunity: 'Unable to determine',
        risk_flag: 'Unable to determine',
      },
    };
  }
}

module.exports = Agents;
