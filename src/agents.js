/**
 * AI Agents Module — Multi-Key Fallback Chain
 *
 * Priority order:
 * 1. Groq        — fastest, adequate for summaries
 * 2. SambaNova   — persistent free tier, excellent reasoning
 * 3. Cerebras    — rapid generation
 * 4. Mistral     — generous monthly limits
 * 5. OpenRouter  — massive free model rotation
 * 6. Gemini      — generous daily limits
 *
 * Multi-Key Support: pass multiple API keys comma-separated in env vars.
 * E.g., GROQ_API_KEY="key1,key2". Tries Key 1, falls back to Key 2 on 429
 * before moving to the next provider.
 */

const axios = require('axios');

const TIMEOUT = 20000;

class Agents {
  constructor() {
    this.groqKeys       = this._parseKeys(process.env.GROQ_API_KEY);
    this.geminiKeys     = this._parseKeys(process.env.GEMINI_API_KEY);
    this.sambanovaKeys  = this._parseKeys(process.env.SAMBANOVA_API_KEY);
    this.mistralKeys    = this._parseKeys(process.env.MISTRAL_API_KEY);
    this.openrouterKeys = this._parseKeys(process.env.OPENROUTER_API_KEY);
    this.cerebrasKeys   = this._parseKeys(process.env.CEREBRAS_API_KEY);
  }

  _parseKeys(keyString) {
    if (!keyString) return [];
    return keyString.split(',').map(k => k.trim()).filter(Boolean);
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async analyzeArticle(article) {
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

  _tryExtractJSON(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      return null;
    }
  }

  async _complete(prompt, label) {
    if (!prompt || !prompt.trim()) {
      console.error(`[Agents] Refusing to send empty prompt for: ${label}`);
      return null;
    }

    const isArticle = label.startsWith('Analyzing:');
    const providers = isArticle ? this._articleProviders(prompt) : this._synthesisProviders(prompt);

    if (providers.length === 0) {
      console.error(`[Agents] No API keys configured for any provider!`);
      return null;
    }

    for (const provider of providers) {
      try {
        console.log(`[${provider.name}] ${label}...`);
        const result = await provider.fn();

        if (!result || !result.trim()) {
          throw new Error('Empty response');
        }

        if (!isArticle) {
          const parsed = this._tryExtractJSON(result);
          if (!parsed) {
            // FIX (2026-06-20, round 3): log a short snippet of the raw
            // response when JSON validation fails, so we can SEE what the
            // model actually returned (prose preamble? truncated mid-object?
            // markdown fences?) instead of just knowing it failed.
            const snippet = result.substring(0, 150).replace(/\n/g, ' ');
            throw new Error(`Response did not contain valid JSON. Snippet: "${snippet}..."`);
          }
        }

        return result;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
        console.warn(`[${provider.name}] Failed (${status || 'ERR'}): ${msg.substring(0, 200)}`);
        if (status === 429) await this._sleep(2000);
      }
    }

    console.error(`[Agents] All providers and keys failed for: ${label}`);
    return null;
  }

  _articleProviders(prompt) {
    const chain = [];
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-8b (#${i+1})`, fn: () => this._groqFast(prompt, key) }));
    this.sambanovaKeys.forEach((key, i) => chain.push({ name: `SambaNova (#${i+1})`, fn: () => this._sambanova(prompt, key) }));
    this.cerebrasKeys.forEach((key, i) => chain.push({ name: `Cerebras (#${i+1})`, fn: () => this._cerebras(prompt, key) }));
    this.mistralKeys.forEach((key, i) => chain.push({ name: `Mistral (#${i+1})`, fn: () => this._mistral(prompt, key) }));
    this.openrouterKeys.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`, fn: () => this._openrouter(prompt, key) }));
    this.geminiKeys.forEach((key, i) => chain.push({ name: `Gemini (#${i+1})`, fn: () => this._gemini(prompt, key) }));
    return chain;
  }

  /**
   * Synthesis provider chain.
   *
   * FIX (2026-06-20, round 3): the 2026-06-19 fixes (token limit + JSON-
   * validity gating) were necessary but not sufficient — a single run still
   * saw 6 of 7 providers fail with "did not contain valid JSON", including
   * normally-reliable providers (Gemini, Mistral x2). That pattern points to
   * task difficulty, not provider flakiness: the synthesis prompt is long,
   * heavily stylistic, and asks for a complex nested structure (3-5 themes x
   * 4 substantial text fields each). Two changes now:
   *   1. SYNTH_MAX_TOKENS raised 2500 -> 4000, giving real room to finish.
   *   2. response_format: json_object passed to every OpenAI-compatible
   *      provider (Groq, SambaNova, Cerebras, Mistral, OpenRouter) - this is
   *      a hard API-level decoding constraint, not a prompt suggestion, so
   *      it should eliminate prose-preamble failures outright wherever the
   *      provider honours it. Gemini gets the equivalent via
   *      responseMimeType in its own provider function.
   */
  _synthesisProviders(prompt) {
    const SYNTH_MAX_TOKENS = 4000;
    const chain = [];
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-70b (#${i+1})`, fn: () => this._groq70b(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.geminiKeys.forEach((key, i) => chain.push({ name: `Gemini (#${i+1})`, fn: () => this._gemini(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.mistralKeys.forEach((key, i) => chain.push({ name: `Mistral (#${i+1})`, fn: () => this._mistral(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.openrouterKeys.forEach((key, i) => chain.push({ name: `OpenRouter (#${i+1})`, fn: () => this._openrouter(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.cerebrasKeys.forEach((key, i) => chain.push({ name: `Cerebras (#${i+1})`, fn: () => this._cerebras(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.sambanovaKeys.forEach((key, i) => chain.push({ name: `SambaNova (#${i+1})`, fn: () => this._sambanova(prompt, key, SYNTH_MAX_TOKENS, true) }));
    this.groqKeys.forEach((key, i) => chain.push({ name: `Groq-8b-Fallback (#${i+1})`, fn: () => this._groqFast(prompt, key, SYNTH_MAX_TOKENS, true) }));
    return chain;
  }

  // ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────
  // Each accepts an optional `forceJSON` flag. When true, adds the
  // provider's native JSON-mode constraint (a hard decoding rule, not a
  // prompt instruction) so the API itself refuses to emit non-JSON text.

  async _groqFast(prompt, key, maxTokens = 1000, forceJSON = false) {
    const body = { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    if (forceJSON) body.response_format = { type: 'json_object' };
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions', body,
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _groq70b(prompt, key, maxTokens = 1000, forceJSON = false) {
    const body = { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    if (forceJSON) body.response_format = { type: 'json_object' };
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions', body,
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _gemini(prompt, key, maxTokens = 1000, forceJSON = false) {
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-flash'];
    let lastErr;
    for (const model of models) {
      try {
        const generationConfig = { temperature: 0.3, maxOutputTokens: maxTokens };
        if (forceJSON) generationConfig.responseMimeType = 'application/json';
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { contents: [{ parts: [{ text: prompt }] }], generationConfig },
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

  async _sambanova(prompt, key, maxTokens = 1000, forceJSON = false) {
    const body = { model: 'Meta-Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    if (forceJSON) body.response_format = { type: 'json_object' };
    const res = await axios.post(
      'https://api.sambanova.ai/v1/chat/completions', body,
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _cerebras(prompt, key, maxTokens = 1000, forceJSON = false) {
    const models = ['gpt-oss-120b', 'llama3.1-8b'];
    let lastErr;
    for (const model of models) {
      try {
        const body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
        if (forceJSON) body.response_format = { type: 'json_object' };
        const res = await axios.post(
          'https://api.cerebras.ai/v1/chat/completions', body,
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        if (err.response?.status !== 404) throw err;
      }
    }
    throw lastErr;
  }

  async _mistral(prompt, key, maxTokens = 1000, forceJSON = false) {
    const body = { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
    if (forceJSON) body.response_format = { type: 'json_object' };
    const res = await axios.post(
      'https://api.mistral.ai/v1/chat/completions', body,
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    return res.data.choices[0]?.message?.content || '';
  }

  async _openrouter(prompt, key, maxTokens = 1000, forceJSON = false) {
    const models = ['meta-llama/llama-3.3-70b:free', 'openai/gpt-oss-20b:free'];
    let lastErr;
    for (const model of models) {
      try {
        const body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: maxTokens };
        if (forceJSON) body.response_format = { type: 'json_object' };
        const res = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions', body,
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/mixta-africa', 'X-Title': 'Mixta News Pipeline' }, timeout: TIMEOUT }
        );
        return res.data.choices[0]?.message?.content || '';
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;
        if (status !== 404 && status !== 400 && status !== 422) throw err;
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
    const title   = (article.title   || '').trim() || 'Untitled';
    const source  = (article.source  || '').trim() || 'Unknown source';
    const url     = (article.url     || '').trim() || 'No URL';

    const rawContent = (article.content || article.description || article.title || '').trim();
    const content = rawContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[(\+\d+\s*chars?)\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 2000);

    const hasSubstantialContent = content.length > 200;
    const contentNote = hasSubstantialContent
      ? ''
      : '\nNOTE: This article has limited content — only the headline and a short snippet are available. Qualify any inferences clearly as speculative rather than stated fact.';

    return `You are a professional real estate analyst for Mixta Africa, a Lagos-based developer.
Analyse this article and extract actionable intelligence for leadership.${contentNote}

ARTICLE:
Title: ${title}
Source: ${source}
URL: ${url}
Content (${content.length} chars): ${content}

TASK:
Produce a structured analysis. Write as an analyst briefing a CEO — direct, specific, no padding.
- summary: 2-3 sentences. State what the article actually reports, then what it means for the Lagos market. Use numbers if they appear in the text.
- sentiment: bullish | bearish | neutral based on market implications, not just article tone.
- If content is thin (headline only), say so in the summary and keep confidence low.
- Connect to Mixta's live projects (Lakowe Crossings, Lakowe Annexe, Lagos New Town) where genuinely relevant — do not force a connection that isn't there.

RESPOND ONLY IN THIS JSON FORMAT (no markdown, no explanation):
{
  "summary": "What it reports + what it means for Lagos real estate. Use numbers from the text.",
  "sentiment": "bullish|bearish|neutral",
  "location_tags": "Lagos,Lekki,Ibeju-Lekki",
  "category": "property-market|policy|developer-news|investment|infrastructure",
  "trending_topics": "comma-separated tags",
  "market_impact_severity": "critical|high|medium|low|negligible",
  "affected_segments": "affordable housing|mid-market|premium|commercial|industrial",
  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",
  "mixta_relevance": {
    "direct_impact": "Specific named impact on Lakowe Crossings / Annexe / Lagos New Town, or None",
    "indirect_impact": "Broader market effect on Mixta's position, or None",
    "strategic_opportunity": "Specific opportunity created, or None",
    "risk_flag": "Specific risk to execution, or None"
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
