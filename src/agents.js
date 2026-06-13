/**
 * AI Agents Module
 * 
 * Implements 3-provider fallback chain:
 * 1. Groq (fastest, ideal for real-time)
 * 2. Cerebras (generous free tier)
 * 3. Gemini (most reliable)
 * 
 * Professional analysis prompts emphasize:
 * - Market impact on Lagos/Southwest Nigeria real estate
 * - Relevance to Mixta Africa's strategic positions
 * - Competitive intelligence
 * - Sector trends & infrastructure context
 */

const axios = require('axios');

class Agents {
  constructor() {
    this.groqApiKey = process.env.GROQ_API_KEY;
    this.cerebrasApiKey = process.env.CEREBRAS_API_KEY;
    this.geminiApiKey = process.env.GEMINI_API_KEY;
    this.retryAttempts = 3;
    this.retryDelay = 1000; // ms
  }

  /**
   * Main analysis method: delegates to AI provider with fallback
   */
  async analyzeArticle(article) {
    const prompt = this.buildAnalysisPrompt(article);

    // Try Groq first (fastest)
    try {
      console.log(`[Groq] Analyzing: ${article.title.substring(0, 60)}...`);
      const result = await this.callGroqAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Groq] Failed: ${error.message}. Falling back to Cerebras.`);
    }

    // Fall back to Cerebras
    try {
      console.log(`[Cerebras] Analyzing: ${article.title.substring(0, 60)}...`);
      const result = await this.callCerebasAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.warn(`[Cerebras] Failed: ${error.message}. Falling back to Gemini.`);
    }

    // Fall back to Gemini
    try {
      console.log(`[Gemini] Analyzing: ${article.title.substring(0, 60)}...`);
      const result = await this.callGeminiAPI(prompt);
      return this.parseAnalysis(result);
    } catch (error) {
      console.error(`[Gemini] Failed: ${error.message}. Returning defaults.`);
      return this.defaultAnalysis();
    }
  }

  /**
   * Enterprise-level analysis prompt
   * Emphasizes professional context, market impact, and Mixta Africa relevance
   */
  buildAnalysisPrompt(article) {
    return `
You are a professional real estate analyst for a major Lagos-based developer.
Analyze the following article with intellectual rigor and business acumen.

ARTICLE:
Title: ${article.title}
Source: ${article.source}
URL: ${article.url}
Content: ${(article.content || article.description || '').substring(0, 1000)}

ANALYSIS REQUIREMENTS:

1. PROFESSIONAL SUMMARY (2-3 sentences, intellectual tone):
   - Avoid AI-sounding language ("This article discusses..." or "The article highlights...")
   - Write as a market analyst would brief an executive
   - Focus on what this MEANS for the Lagos real estate market, not what it says
   - Example: "Infrastructure delays in Lekki corridor threaten Q3 occupancy rates, pressuring new project launches in competing micro-markets." (NOT: "The article discusses delays in infrastructure.")

2. MARKET IMPACT ANALYSIS:
   - Rate severity: critical | high | medium | low | negligible
   - Identify affected segments: affordable housing | mid-market | premium | commercial | industrial
   - Geographic radius: Lagos | Southwest Nigeria | National | Continental
   - Timeframe: immediate (0-3 months) | near-term (3-6 months) | medium-term (6-12 months) | long-term (12+ months)

3. MIXTA AFRICA RELEVANCE FLAGS (be specific):
   - Direct impact: Does this affect Lakowe Crossings, Lakowe Annexe, Lagos New Town (LNT), or competitor projects?
   - Indirect impact: Does this affect pricing, cost of capital, supply chain, or regulatory environment?
   - Strategic opportunity: Does this create advantage (e.g., policy tailwind, competitor weakness)?
   - Risk flag: Does this threaten execution (e.g., material shortage, permit delays)?

4. SENTIMENT CLASSIFICATION:
   - bullish (positive catalyst for sector/Mixta), bearish (headwind), or neutral
   - Justify in 1 sentence

5. LOCATION TAGS:
   - List specific areas: Lagos, Lekki, Ibeju-Lekki, Victoria Island, Mainland, Ibadan, etc.

6. CATEGORY CLASSIFICATION (pick 1-2 primary):
   - property-market (pricing, transactions, supply/demand)
   - policy (government, regulation, incentives)
   - developer-news (company announcements, launches, performance)
   - investment (capital flows, funding, DFI activity)
   - infrastructure (roads, power, water, metro, ports)
   - economy (macro, FX, inflation, employment)
   - competitive-intelligence (competitor moves, market share shifts)

7. TRENDING TOPICS:
   - Comma-separated tags: e.g., "prices, inflation, Green Line Metro, affordable housing, diaspora investment"

RESPOND IN THIS JSON FORMAT ONLY (no markdown, no explanation):
{
  "summary": "Professional 2-3 sentence summary written as analyst briefing, not article description",
  "sentiment": "bullish|bearish|neutral",
  "location_tags": "Lagos,Lekki,Ibeju-Lekki",
  "category": "property-market,infrastructure",
  "trending_topics": "prices,Green Line Metro,infrastructure",
  "market_impact_severity": "critical|high|medium|low|negligible",
  "affected_segments": "affordable housing,premium,commercial",
  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",
  "mixta_relevance": {
    "direct_impact": "Affects Lakowe Annexe construction timeline due to supplier cost increases" | "None",
    "indirect_impact": "May increase borrowing costs via regional capital tightening" | "None",
    "strategic_opportunity": "Positions Mixta to capture diaspora buyers if currency stabilizes" | "None",
    "risk_flag": "Potential permit delays in LNT due to new government transition" | "None"
  }
}
`;
  }

  /**
   * Groq API call (fastest, primary choice)
   */
  async callGroqAPI(prompt) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    
    const response = await axios.post(url, {
      model: 'mixtral-8x7b-32768',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3, // Lower for consistency
      max_tokens: 1000,
    }, {
      headers: { 'Authorization': `Bearer ${this.groqApiKey}` },
      timeout: 15000,
    });

    return response.data.choices[0]?.message?.content || '';
  }

  /**
   * Cerebras API call (generous free tier, fallback 1)
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
   * Gemini API call (most reliable, fallback 2)
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
      // Extract JSON from response (AI sometimes adds preamble)
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
   * Normalize sentiment to valid values
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

  /**
   * Batch analysis for multiple articles
   */
  async analyzeMultiple(articles) {
    const results = [];
    for (const article of articles) {
      try {
        const analysis = await this.analyzeArticle(article);
        results.push({ ...article, ...analysis });
      } catch (error) {
        console.error(`Batch analysis error for "${article.title}":`, error.message);
        results.push({ ...article, ...this.defaultAnalysis() });
      }
    }
    return results;
  }
}

module.exports = Agents;
