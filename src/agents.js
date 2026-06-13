/**
 * AI Agents Module
 * 
 * 3-provider fallback chain:
 * 1. Groq (fastest, primary)
 * 2. Cerebras (generous free tier)
 * 3. Gemini (most reliable)
 * 
 * Professional analysis with:
 * - Market impact assessment
 * - Mixta Africa relevance flags
 * - Sentiment classification
 */

const axios = require('axios');

class Agents {
  constructor() {
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.cerebrasApiKey = process.env.CEREBRAS_API_KEY;
    this.geminiApiKey = process.env.GEMINI_API_KEY;
  }

  /**
   * Main analysis method with fallback
   */
  async analyzeArticle(article) {
    const prompt = this.buildAnalysisPrompt(article);

    // Try Groq first
    try {
      console.log(`[Groq] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callGroqAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Groq] Failed: ${error.message}. Trying Cerebras.`);
    }

    // Try Cerebras
    try {
      console.log(`[Cerebras] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callCerebasAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Cerebras] Failed: ${error.message}. Trying Gemini.`);
    }

    // Try Gemini
    try {
      console.log(`[Gemini] Analyzing: ${article.title?.substring(0, 60)}...`);
      const result = await this.callGeminiAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.error(`[Gemini] Failed: ${error.message}. Using defaults.`);
      return this.defaultAnalysis();
    }
  }

  /**
   * Enterprise-level analysis prompt
   */
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
   * Groq API call
   */
  async callGroqAPI(prompt) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    
    const response = await axios.post(url, {
      model: 'mixtral-8x7b-32768',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    }, {
      headers: { 'Authorization': `Bearer ${this.groqApiKey}` },
      timeout: 15000,
    });

    return response.data.choices[0]?.message?.content || '';
  }

  /**
   * Cerebras API call
   */
  async callCerebasAPI(prompt) {
    const url = 'https://api.cerebras.ai/v1/chat/completions';
    
    const response = await axios.post(url, {
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    }, {
      headers: { 'Authorization': `Bearer ${this.cerebrasApiKey}` },
      timeout: 15000,
    });

    return response.data.choices[0]?.message?.content || '';
  }

  /**
   * Gemini API call
   */
  async callGeminiAPI(prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.geminiApiKey}`;
    
    const response = await axios.post(url, {
      contents: [{
        parts: [{ text: prompt }],
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
      },
    }, {
      timeout: 15000,
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return text;
  }

  /**
   * Parse AI response into structured analysis
   */
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

  /**
   * Normalize sentiment
   */
  normalizeSentiment(value) {
    const normalized = (value || '').toLowerCase().trim();
    if (normalized.includes('bull')) return 'bullish';
    if (normalized.includes('bear')) return 'bearish';
    return 'neutral';
  }

  /**
   * Default analysis fallback
   */
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
