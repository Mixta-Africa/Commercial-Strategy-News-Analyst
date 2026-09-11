/**
 * AI Agents Module — self-healing provider chain
 *
 * Integrates with model-registry.js so known-dead models are skipped
 * immediately without wasting a live API call. When a model returns a
 * deprecation signal (404 / "does not exist"), it is written to
 * data/model-status.json as DEAD and skipped on all future runs until
 * the 7-day re-probe window expires.
 *
 * Provider priority (all free tiers):
 *  Articles:  Groq-20b → SambaNova → Gemini → Mistral → Together → OpenRouter
 *  Synthesis: Groq-120b → Gemini → SambaNova → Together → Mistral → OpenRouter → Groq-20b
 */

const axios = require('axios');
const { loadStatus, getBestModel, makeKey } = require('./model-registry');

const TIMEOUT = 20000;

class Agents {
  constructor() {
    this.groqKey       = process.env.GROQ_API_KEY;
    this.geminiKey     = process.env.GEMINI_API_KEY;
    this.sambanovaKey  = process.env.SAMBANOVA_API_KEY;
    this.mistralKey    = process.env.MISTRAL_API_KEY;
    this.openrouterKey = process.env.OPENROUTER_API_KEY;
    this.togetherKey   = process.env.TOGETHER_API_KEY;

    // Load persisted model status so dead models are skipped at call time
    this._modelStatus = loadStatus();
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  async analyzeArticle(article) {
    const hasContent =
      (article.title && article.title.trim()) ||
      (article.description && article.description.trim()) ||
      (article.content && article.content.trim());

    if (!hasContent) {
      console.warn('[Agents] Skipping article with no content (source: ' + (article.source || 'unknown') + ')');
      return this.defaultAnalysis();
    }

    const prompt = this.buildAnalysisPrompt(article);
    const result = await this._complete(prompt, 'Analyzing: ' + (article.title || 'untitled').substring(0, 60));
    return this.parseAnalysis(result);
  }

  async generateCompletion(prompt, label) {
    return this._complete(prompt, label || 'Synthesis');
  }

  // ─── CORE ENGINE ─────────────────────────────────────────────────────────────

  async _complete(prompt, label) {
    if (!prompt || !prompt.trim()) {
      console.error('[Agents] Refusing to send empty prompt for: ' + label);
      return null;
    }

    const isSynthesis = !label.startsWith('Analyzing:');
    const providers = isSynthesis
      ? this._synthesisProviders(prompt)
      : this._articleProviders(prompt);

    for (const provider of providers) {
      if (!provider.key) continue;
      if (provider.modelDead) continue; // known dead — skip silently

      try {
        console.log('[' + provider.name + '] ' + label + '...');
        const result = await provider.fn();
        if (result && result.trim()) return result;
        throw new Error('Empty response');
      } catch (err) {
        const status = err.response && err.response.status;
        const msg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message || '';
        console.warn('[' + provider.name + '] Failed (' + (status || 'ERR') + '): ' + msg.substring(0, 120));

        // Mark model dead in-memory if we see a deprecation signal
        if (this._isDeprecationError(status, msg) && provider.model) {
          const k = makeKey(provider.providerName, provider.model);
          if (this._modelStatus[k]) {
            this._modelStatus[k].status = 'DEAD';
            this._modelStatus[k].error = status + ': ' + msg.substring(0, 80);
          }
          console.warn('[' + provider.name + '] Deprecation signal — model skipped for remainder of run');
        }

        if (status === 429) await this._sleep(2000);
      }
    }

    console.error('[Agents] All providers failed for: ' + label);
    return null;
  }

  _isDeprecationError(status, msg) {
    if (status === 404) return true;
    if (status === 400 && (msg.includes('decommissioned') || msg.includes('does not exist'))) return true;
    if (status === 402 && msg.includes('unavailable for free')) return true;
    return false;
  }

  _resolve(providerName, models) {
    return getBestModel(providerName, models, this._modelStatus);
  }

  // ─── PROVIDER CHAINS ─────────────────────────────────────────────────────────

  _buildChain(specs) {
    return specs.map(function(spec) {
      const bestModel = getBestModel(spec.pname, spec.models, this._modelStatus);
      return {
        name: spec.name,
        providerName: spec.pname,
        model: bestModel,
        key: spec.key,
        modelDead: !bestModel,
        fn: spec.fn.bind(null, bestModel),
      };
    }.bind(this));
  }

  _articleProviders(prompt) {
    const self = this;
    return this._buildChain([
      { name: 'Groq-20b',   pname: 'Groq',       models: ['openai/gpt-oss-20b'],                            key: self.groqKey,       fn: (m) => self._groqModel(m, prompt) },
      { name: 'SambaNova',  pname: 'SambaNova',  models: ['Meta-Llama-3.3-70B-Instruct'],                   key: self.sambanovaKey,  fn: ()  => self._sambanova(prompt) },
      { name: 'Gemini',     pname: 'Gemini',     models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],     key: self.geminiKey,     fn: ()  => self._gemini(prompt) },
      { name: 'Mistral',    pname: 'Mistral',    models: ['mistral-small-latest'],                          key: self.mistralKey,    fn: ()  => self._mistral(prompt) },
      { name: 'Together',   pname: 'Together',   models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'],  key: self.togetherKey,   fn: ()  => self._together(prompt) },
      { name: 'OpenRouter', pname: 'OpenRouter', models: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-20b:free', 'google/gemma-3-27b-it:free'], key: self.openrouterKey, fn: () => self._openrouter(prompt) },
    ]);
  }

  _synthesisProviders(prompt) {
    const self = this;
    return this._buildChain([
      { name: 'Groq-120b',  pname: 'Groq',       models: ['openai/gpt-oss-120b'],                           key: self.groqKey,       fn: (m) => self._groqModel(m, prompt) },
      { name: 'Gemini',     pname: 'Gemini',     models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],     key: self.geminiKey,     fn: ()  => self._gemini(prompt) },
      { name: 'SambaNova',  pname: 'SambaNova',  models: ['Meta-Llama-3.3-70B-Instruct'],                   key: self.sambanovaKey,  fn: ()  => self._sambanova(prompt) },
      { name: 'Together',   pname: 'Together',   models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'],  key: self.togetherKey,   fn: ()  => self._together(prompt) },
      { name: 'Mistral',    pname: 'Mistral',    models: ['mistral-small-latest'],                          key: self.mistralKey,    fn: ()  => self._mistral(prompt) },
      { name: 'OpenRouter', pname: 'OpenRouter', models: ['meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-20b:free'], key: self.openrouterKey, fn: () => self._openrouter(prompt) },
      { name: 'Groq-20b',   pname: 'Groq',       models: ['openai/gpt-oss-20b'],                            key: self.groqKey,       fn: (m) => self._groqModel(m, prompt) },
    ]);
  }

  // ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────

  async _groqModel(model, prompt) {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: 'Bearer ' + this.groqKey, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
    return res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content || '';
  }

  async _gemini(prompt) {
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
    let lastErr;
    for (const model of models) {
      try {
        const res = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
          { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1000 } },
          { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiKey }, timeout: TIMEOUT });
        return res.data && res.data.candidates && res.data.candidates[0] && res.data.candidates[0].content && res.data.candidates[0].content.parts && res.data.candidates[0].content.parts[0] && res.data.candidates[0].content.parts[0].text || '';
      } catch (err) {
        lastErr = err;
        if (!err.response || err.response.status !== 404) throw err;
        console.warn('[Gemini] ' + model + ' not found, trying next...');
      }
    }
    throw lastErr;
  }

  async _sambanova(prompt) {
    const res = await axios.post('https://api.sambanova.ai/v1/chat/completions',
      { model: 'Meta-Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: 'Bearer ' + this.sambanovaKey, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
    return res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content || '';
  }

  async _mistral(prompt) {
    const res = await axios.post('https://api.mistral.ai/v1/chat/completions',
      { model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: 'Bearer ' + this.mistralKey, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
    return res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content || '';
  }

  async _together(prompt) {
    const res = await axios.post('https://api.together.xyz/v1/chat/completions',
      { model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
      { headers: { Authorization: 'Bearer ' + this.togetherKey, 'Content-Type': 'application/json' }, timeout: TIMEOUT });
    return res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content || '';
  }

  async _openrouter(prompt) {
    const freeModels = [
      'meta-llama/llama-3.3-70b-instruct:free',
      'openai/gpt-oss-20b:free',
      'google/gemma-3-27b-it:free',
    ];
    let lastErr;
    for (const model of freeModels) {
      try {
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions',
          { model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 1000 },
          { headers: { Authorization: 'Bearer ' + this.openrouterKey, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/mixta-africa', 'X-Title': 'Mixta News Pipeline' }, timeout: TIMEOUT });
        return res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content || '';
      } catch (err) {
        lastErr = err;
        const status = err.response && err.response.status;
        if (status && [400, 402, 404, 422].indexOf(status) === -1) throw err;
        console.warn('[OpenRouter] ' + model + ' unavailable (' + status + '), trying next...');
      }
    }
    throw lastErr;
  }

  _sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  buildAnalysisPrompt(article) {
    const title   = (article.title   || '').trim() || 'Untitled';
    const source  = (article.source  || '').trim() || 'Unknown source';
    const url     = (article.url     || '').trim() || 'No URL';
    const content = (article.content || article.description || article.title || '').trim().substring(0, 1000);
    return 'You are a professional real estate analyst for a major Lagos-based developer (Mixta Africa).\nAnalyze this article with intellectual rigor and business acumen.\n\nARTICLE:\nTitle: ' + title + '\nSource: ' + source + '\nURL: ' + url + '\nContent: ' + content + '\n\nANALYSIS REQUIREMENTS:\n\n1. PROFESSIONAL SUMMARY (2-3 sentences, analyst tone):\n   - Write as a market analyst would brief an executive\n   - Focus on what this MEANS for Lagos real estate market\n\n2. MARKET IMPACT:\n   - Severity: critical | high | medium | low | negligible\n   - Affected segments: affordable housing | mid-market | premium | commercial | industrial\n   - Timeframe: immediate | near-term | medium-term | long-term\n\n3. MIXTA AFRICA RELEVANCE:\n   - Direct impact: Does this affect Lakowe Crossings, Lakowe Annexe, or Lagos New Town?\n   - Indirect impact: Does this affect pricing, costs, regulatory environment?\n   - Strategic opportunity: Does this create advantage?\n   - Risk flag: Does this threaten execution?\n\n4. SENTIMENT: bullish | bearish | neutral\n5. LOCATION TAGS: Lagos, Lekki, Ibeju-Lekki, etc.\n6. CATEGORY: property-market | policy | developer-news | investment | infrastructure\n7. TRENDING TOPICS: Comma-separated tags\n\nRESPOND ONLY IN THIS JSON FORMAT (no markdown, no explanation):\n{\n  "summary": "Professional 2-3 sentence summary",\n  "sentiment": "bullish|bearish|neutral",\n  "location_tags": "Lagos,Lekki,Ibeju-Lekki",\n  "category": "property-market,infrastructure",\n  "trending_topics": "prices,infrastructure",\n  "market_impact_severity": "critical|high|medium|low|negligible",\n  "affected_segments": "affordable housing,premium",\n  "market_impact_timeframe": "immediate|near-term|medium-term|long-term",\n  "mixta_relevance": {\n    "direct_impact": "Description or None",\n    "indirect_impact": "Description or None",\n    "strategic_opportunity": "Description or None",\n    "risk_flag": "Description or None"\n  }\n}';
  }

  parseAnalysis(responseText) {
    if (!responseText) return this.defaultAnalysis();
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary:                 parsed.summary                  || '',
        sentiment:               this.normalizeSentiment(parsed.sentiment),
        category:                parsed.category                 || 'untagged',
        location_tags:           parsed.location_tags            || '',
        trending_topics:         parsed.trending_topics          || '',
        market_impact_severity:  parsed.market_impact_severity   || 'low',
        affected_segments:       parsed.affected_segments        || '',
        market_impact_timeframe: parsed.market_impact_timeframe  || 'medium-term',
        mixta_relevance: parsed.mixta_relevance || { direct_impact: 'None', indirect_impact: 'None', strategic_opportunity: 'None', risk_flag: 'None' },
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
      summary: 'Unable to generate summary — all AI providers unavailable.',
      sentiment: 'neutral', category: 'untagged', location_tags: '', trending_topics: '',
      market_impact_severity: 'unknown', affected_segments: '', market_impact_timeframe: 'unknown',
      mixta_relevance: { direct_impact: 'Unable to determine', indirect_impact: 'Unable to determine', strategic_opportunity: 'Unable to determine', risk_flag: 'Unable to determine' },
    };
  }
}

module.exports = Agents;
