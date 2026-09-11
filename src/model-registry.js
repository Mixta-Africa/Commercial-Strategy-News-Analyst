/**
 * Model Registry & Auto-Detection System
 *
 * Solves the core problem: model names get deprecated without warning and the
 * pipeline breaks silently until someone notices "all AI providers unavailable".
 *
 * HOW IT WORKS:
 *
 * 1. REGISTRY — a structured list of every provider's models, ordered by preference.
 *    Each entry has: the model ID, a "verify" function that sends a minimal test call,
 *    and a "dead signal" — the error pattern that means "this model is gone", vs
 *    transient errors like rate limits that should not mark a model dead.
 *
 * 2. PROBE — on pipeline startup, each model gets a lightweight test call (5 tokens).
 *    Results are written to data/model-status.json with timestamps.
 *
 * 3. PERSISTENCE — model-status.json is committed back to the repo by GitHub Actions.
 *    The next run reads it first. A model marked DEAD is skipped immediately without
 *    wasting a real API call. A model marked WORKING is used. UNKNOWN means it hasn't
 *    been tested yet (first run, or new entry).
 *
 * 4. STALENESS — a model's WORKING status is trusted for 24 hours. After that it
 *    gets re-probed. A model's DEAD status is trusted for 7 days, then re-probed
 *    (providers sometimes re-enable deprecated models or launch replacements under
 *    the same name).
 *
 * 5. OPERATOR ALERT — if the total number of WORKING models drops below MIN_WORKING,
 *    the health system sends an operator alert BEFORE the pipeline tries to run
 *    article analysis, not after it fails.
 *
 * 6. OPENROUTER LIVE DISCOVERY — OpenRouter's /models endpoint is queried at probe
 *    time to discover which :free models are currently live. This replaces the
 *    hardcoded list that breaks whenever they rotate their free tier.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(process.cwd(), 'data', 'model-status.json');
const WORKING_TTL_MS = 24 * 60 * 60 * 1000;   // re-probe WORKING after 24h
const DEAD_TTL_MS   =  7 * 24 * 60 * 60 * 1000; // re-probe DEAD after 7 days
const PROBE_TIMEOUT = 10000;
const MIN_WORKING   = 2; // alert if fewer than this many providers are healthy

// ─── PROVIDER DEFINITIONS ────────────────────────────────────────────────────
// Each provider is an object with:
//   name: display name
//   envKey: environment variable that holds the API key
//   models: ordered list of models to try (first = preferred)
//   probe(model, key): function that tests one model, throws on failure
//   isDeadError(status, message): returns true if this error means the model is gone
//     (as opposed to a transient error like rate limiting)

function makeOpenAICompatibleProbe(url, extraHeaders = {}) {
  return async (model, key) => {
    const res = await axios.post(url,
      { model, messages: [{ role: 'user', content: 'Reply with the single word OK' }], max_tokens: 5 },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extraHeaders }, timeout: PROBE_TIMEOUT }
    );
    const text = res.data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) throw new Error('Empty response from model');
    return text.trim();
  };
}

const PROVIDERS = [
  {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
    probe: makeOpenAICompatibleProbe('https://api.groq.com/openai/v1/chat/completions'),
    isDeadError: (status, msg) =>
      status === 404 ||
      (status === 400 && (msg.includes('decommissioned') || msg.includes('does not exist'))),
  },
  {
    name: 'Gemini',
    envKey: 'GEMINI_API_KEY',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    probe: async (model, key) => {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { contents: [{ parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 5 } },
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, timeout: PROBE_TIMEOUT }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text || !text.trim()) throw new Error('Empty response from model');
      return text.trim();
    },
    isDeadError: (status) => status === 404,
  },
  {
    name: 'SambaNova',
    envKey: 'SAMBANOVA_API_KEY',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-405B-Instruct'],
    probe: makeOpenAICompatibleProbe('https://api.sambanova.ai/v1/chat/completions'),
    isDeadError: (status, msg) => status === 404 || (status === 400 && msg.includes('does not exist')),
  },
  {
    name: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    models: ['mistral-small-latest', 'open-mistral-nemo'],
    probe: makeOpenAICompatibleProbe('https://api.mistral.ai/v1/chat/completions'),
    isDeadError: (status, msg) => status === 404 || (status === 400 && msg.includes('not found')),
  },
  {
    name: 'Together',
    envKey: 'TOGETHER_API_KEY',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo'],
    probe: makeOpenAICompatibleProbe('https://api.together.xyz/v1/chat/completions'),
    isDeadError: (status, msg) => status === 404 || (status === 400 && msg.includes('not found')),
  },
  {
    name: 'Cloudflare',
    envKey: 'CLOUDFLARE_API_KEY',
    // Cloudflare URL includes account ID — stored as CLOUDFLARE_ACCOUNT_ID env var
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'],
    probe: async (model, key) => {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID not set');
      const res = await axios.post(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
        { messages: [{ role: 'user', content: 'Reply with the single word OK' }], max_tokens: 5 },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: PROBE_TIMEOUT }
      );
      const text = res.data?.result?.response;
      if (!text || !text.trim()) throw new Error('Empty response from model');
      return text.trim();
    },
    isDeadError: (status, msg) => status === 404 || msg.includes('not found'),
  },
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    // Models populated dynamically from OpenRouter's /models endpoint at probe time
    models: [], // filled by discoverOpenRouterModels()
    probe: makeOpenAICompatibleProbe('https://openrouter.ai/api/v1/chat/completions', {
      'HTTP-Referer': 'https://github.com/mixta-africa',
      'X-Title': 'Mixta News Pipeline',
    }),
    isDeadError: (status, msg) =>
      status === 404 ||
      (status === 400 && (msg.includes('unavailable for free') || msg.includes('not found'))) ||
      status === 402,
  },
];

// ─── OPENROUTER LIVE DISCOVERY ────────────────────────────────────────────────

async function discoverOpenRouterModels(key) {
  try {
    const res = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: PROBE_TIMEOUT,
    });
    const models = (res.data?.data || [])
      .filter(m => m.id && m.id.endsWith(':free'))
      .map(m => m.id);
    console.log(`[ModelRegistry] OpenRouter live discovery: ${models.length} free models found`);
    return models.slice(0, 10); // top 10 free models
  } catch (e) {
    console.warn(`[ModelRegistry] OpenRouter discovery failed: ${e.message} — using cached list`);
    return [
      'meta-llama/llama-3.3-70b-instruct:free',
      'openai/gpt-oss-20b:free',
      'google/gemma-3-27b-it:free',
    ];
  }
}

// ─── STATUS PERSISTENCE ───────────────────────────────────────────────────────

function loadStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveStatus(status) {
  try {
    const dir = path.dirname(STATUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    console.warn(`[ModelRegistry] Could not save status: ${e.message}`);
  }
}

function makeKey(providerName, model) {
  return `${providerName}::${model}`;
}

function needsProbe(entry) {
  if (!entry) return true;
  const age = Date.now() - new Date(entry.lastProbed).getTime();
  if (entry.status === 'DEAD')    return age > DEAD_TTL_MS;
  if (entry.status === 'WORKING') return age > WORKING_TTL_MS;
  return true; // UNKNOWN
}

// ─── PROBE ENGINE ─────────────────────────────────────────────────────────────

async function probeModel(provider, model, key) {
  try {
    const response = await provider.probe(model, key);
    return { status: 'WORKING', response: response?.substring(0, 50), error: null };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message || '';
    const isDead = provider.isDeadError(status, msg);
    return {
      status: isDead ? 'DEAD' : 'DEGRADED',
      response: null,
      error: `${status || 'ERR'}: ${msg.substring(0, 80)}`,
    };
  }
}

// ─── MAIN PROBE PASS ──────────────────────────────────────────────────────────

async function runProbes() {
  console.log('[ModelRegistry] Starting provider probe pass...');
  const status = loadStatus();
  const results = { probed: 0, working: 0, dead: 0, skipped: 0 };

  for (const provider of PROVIDERS) {
    const key = process.env[provider.envKey];
    if (!key) {
      console.log(`[ModelRegistry] ${provider.name}: no key (${provider.envKey}) — skipping`);
      continue;
    }

    // Populate OpenRouter models dynamically
    if (provider.name === 'OpenRouter' && provider.models.length === 0) {
      provider.models = await discoverOpenRouterModels(key);
    }

    for (const model of provider.models) {
      const k = makeKey(provider.name, model);
      const existing = status[k];

      if (!needsProbe(existing)) {
        console.log(`[ModelRegistry] ${provider.name} / ${model}: ${existing.status} (cached, ${Math.round((Date.now() - new Date(existing.lastProbed).getTime()) / 3600000)}h old)`);
        if (existing.status === 'WORKING') results.working++;
        else results.dead++;
        results.skipped++;
        continue;
      }

      const result = await probeModel(provider, model, key);
      status[k] = {
        provider: provider.name,
        model,
        status: result.status,
        lastProbed: new Date().toISOString(),
        error: result.error,
        response: result.response,
      };

      const icon = result.status === 'WORKING' ? '✅' : result.status === 'DEAD' ? '❌' : '⚠️';
      console.log(`[ModelRegistry] ${icon} ${provider.name} / ${model}: ${result.status}${result.error ? ' — ' + result.error : ''}`);

      if (result.status === 'WORKING') results.working++;
      else if (result.status === 'DEAD') results.dead++;
      results.probed++;

      // Small delay between probes to avoid hammering providers
      await new Promise(r => setTimeout(r, 800));
    }
  }

  saveStatus(status);
  console.log(`[ModelRegistry] Probe complete: ${results.working} working, ${results.dead} dead, ${results.skipped} cached`);

  if (results.working < MIN_WORKING) {
    console.error(`[ModelRegistry] ⚠️  CRITICAL: Only ${results.working} working providers (min ${MIN_WORKING}). Operator alert needed.`);
  }

  return { status, results };
}

// ─── RUNTIME MODEL RESOLVER ───────────────────────────────────────────────────
// Called by agents.js to get the best available model for a provider,
// skipping anything known to be DEAD.

function getBestModel(providerName, models, statusMap) {
  for (const model of models) {
    const k = makeKey(providerName, model);
    const entry = statusMap[k];
    // Use if: explicitly WORKING, or unknown (never probed — give it a chance)
    if (!entry || entry.status !== 'DEAD') {
      return model;
    }
  }
  return null; // all models for this provider are known dead
}

function getWorkingProviders(statusMap) {
  const working = new Set();
  for (const [key, entry] of Object.entries(statusMap)) {
    if (entry.status === 'WORKING') working.add(entry.provider);
  }
  return working;
}

// ─── SUMMARY FOR HEALTH EMAIL ─────────────────────────────────────────────────

function buildStatusSummary(statusMap) {
  const rows = Object.values(statusMap);
  const working = rows.filter(r => r.status === 'WORKING');
  const dead    = rows.filter(r => r.status === 'DEAD');
  const degrad  = rows.filter(r => r.status === 'DEGRADED');

  return {
    totalWorking:  working.length,
    totalDead:     dead.length,
    totalDegraded: degrad.length,
    workingModels: working.map(r => `${r.provider}/${r.model}`),
    deadModels:    dead.map(r => `${r.provider}/${r.model} (${r.error || 'unknown'})`),
    alert:         working.length < MIN_WORKING,
  };
}

module.exports = { runProbes, loadStatus, getBestModel, getWorkingProviders, buildStatusSummary, makeKey, PROVIDERS };
