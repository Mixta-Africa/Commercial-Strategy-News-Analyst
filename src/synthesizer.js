/**
 * Synthesis Engine — the intelligence layer.
 *
 * Turns a list of analyzed articles into an executive briefing by:
 *  1. Loading Mixta's proprietary context (mixta-context.json)
 *  2. Loading theme memory (data/themes.json) for temporal tracking
 *  3. Asking the model to cluster today's articles into themes and write a
 *     decision-grade briefing connected to Mixta's actual position
 *  4. Updating theme memory so recurring themes can be flagged ("week 3", "new")
 *
 * Output is a structured briefing object consumed by the email + dashboard.
 */

const fs = require('fs');
const path = require('path');

class Synthesizer {
  constructor(agents) {
    this.agents = agents;
    this.contextPath = path.join(__dirname, 'mixta-context.json');
    this.memoryPath = path.join(process.cwd(), 'data', 'themes.json');
  }

  loadContext() {
    try {
      const raw = fs.readFileSync(this.contextPath, 'utf-8');
      const context = JSON.parse(raw);
      // Dashboard-edited watch-list overrides the file, if present
      if (Array.isArray(this.watchListOverride) && this.watchListOverride.length) {
        context.watch_list = this.watchListOverride;
      }
      return context;
    } catch (e) {
      console.warn('[Synthesis] Could not load mixta-context.json:', e.message);
      return null;
    }
  }

  loadMemory() {
    try {
      const raw = fs.readFileSync(this.memoryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.themes) ? parsed : { themes: [] };
    } catch (e) {
      return { themes: [] };
    }
  }

  /**
   * Build a compact, history-aware view of recurring themes for the prompt.
   * Returns lines like: "Government layout-approval fees — seen 3 prior runs, last 2026-06-12".
   */
  summarizeMemory(memory) {
    if (!memory.themes.length) return 'No prior theme history (first intelligent run).';
    return memory.themes
      .slice(-25)
      .map(t => `- "${t.label}" — seen ${t.count} prior run(s), last ${t.lastSeen}`)
      .join('\n');
  }

  /**
   * Compact the day's articles for the prompt. Index them so the model can cite sources.
   */
  formatArticles(articles) {
    return articles.map((a, i) => {
      const summary = (a.summary && !a.summary.startsWith('Unable to generate'))
        ? a.summary
        : (a.description || a.title || '').substring(0, 200);
      return `[${i}] (${a.source || 'Unknown'}) ${a.title}
    Sentiment: ${a.sentiment || 'neutral'} | Severity: ${a.market_impact_severity || 'n/a'} | Topics: ${a.trending_topics || 'n/a'}
    Note: ${summary}
    URL: ${a.url || ''}`;
    }).join('\n\n');
  }

  buildPrompt(articles, context, memory) {
    const contextBlock = context
      ? JSON.stringify(context, null, 2)
      : 'No company context available.';

    return `You are the head of market intelligence for Mixta Africa, a Nigerian real estate developer. You are writing the daily intelligence briefing read by the CEO, the strategy team, and occasionally shared in substance with DFIs (EBRD, IFC). Your job is NOT to summarize the news. Your job is to tell leadership what matters, why it matters TO MIXTA SPECIFICALLY, what has changed, and what to do.

=== MIXTA CONTEXT (proprietary — use it to connect news to our actual position) ===
${contextBlock}

=== RECURRING THEME HISTORY (use to judge whether something is NEW, BUILDING, or ESTABLISHED) ===
${this.summarizeMemory(memory)}

=== TODAY'S ARTICLES (cite by [index]) ===
${this.formatArticles(articles)}

=== YOUR TASK ===
Identify the 3 to 5 themes that genuinely matter to Mixta today. Cluster related articles. For each theme, connect it explicitly to Mixta's projects (Lakowe Crossings, Lakowe Annexe, Lagos New Town), pricing, receivables, competitors, or watch-list. Judge novelty against the theme history. Give a clear recommendation. Be specific and commercial; avoid generic commentary. If something in the news directly intersects a watch-list item or a project's open issues, say so plainly.

TRUST RULES (critical — leadership relies on this):
- Every theme MUST cite at least one real article [index] from the list above. Never invent a source or cite an index that is not listed.
- In "what_happened", state ONLY what the sources actually report. In "why_it_matters_to_mixta", clearly mark your reasoning as inference about Mixta — never present an implication as established fact.
- If a theme rests on a single source, its confidence CANNOT be "high".
- If you are unsure or the evidence is thin, say so and use lower confidence. It is better to under-claim than to mislead leadership.

Also write a 2-3 sentence EXECUTIVE SUMMARY at the top: the single most important takeaway for leadership today.

Respond ONLY with valid JSON in EXACTLY this shape (no markdown, no commentary outside the JSON):
{
  "executive_summary": "2-3 sentences: the most important thing leadership should know today and why.",
  "themes": [
    {
      "label": "Short theme name (e.g. 'Affordable-band public supply')",
      "novelty": "new | building | established",
      "what_happened": "1-2 sentences on what the news actually says.",
      "why_it_matters_to_mixta": "Specific connection to our projects/pricing/receivables/competitors/watch-list.",
      "recommendation": "One concrete action framed as: Act now | Monitor | Watch | No action — plus a short why.",
      "confidence": "high | medium | low",
      "sources": [list of article index numbers, e.g. [0, 3]]
    }
  ],
  "watch_list_hits": ["Short note for each watch-list topic that appeared today, or empty array"]
}`;
  }

  /**
   * Parse the model JSON defensively.
   */
  parseBriefing(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      const parsed = JSON.parse(match[0]);
      if (!parsed.themes) parsed.themes = [];
      if (!parsed.executive_summary) parsed.executive_summary = '';
      if (!parsed.watch_list_hits) parsed.watch_list_hits = [];
      return parsed;
    } catch (e) {
      console.error('[Synthesis] Failed to parse briefing JSON:', e.message);
      return null;
    }
  }

  /**
   * Update theme memory: increment count for themes seen before (fuzzy label match),
   * add new ones. Keeps a rolling window so the file does not grow unbounded.
   */
  updateMemory(memory, briefing, dateStr) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const existing = memory.themes;

    for (const theme of briefing.themes) {
      const label = theme.label || 'Untitled';
      const key = norm(label);
      // fuzzy match: same key, or one contains the other (handles slight rewording)
      const prior = existing.find(t => {
        const tk = norm(t.label);
        return tk === key || tk.includes(key) || key.includes(tk);
      });
      if (prior) {
        prior.count += 1;
        prior.lastSeen = dateStr;
        prior.label = label; // keep latest phrasing
      } else {
        existing.push({ label, count: 1, firstSeen: dateStr, lastSeen: dateStr });
      }
    }

    // Roll the window: keep most recently seen 60 themes
    existing.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    memory.themes = existing.slice(0, 60);
    return memory;
  }

  saveMemory(memory) {
    try {
      const dataDir = path.dirname(this.memoryPath);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(this.memoryPath, JSON.stringify(memory, null, 2));
      console.log('[Synthesis] Theme memory updated');
    } catch (e) {
      console.warn('[Synthesis] Could not save theme memory:', e.message);
    }
  }

  /**
   * Main entry: produce the briefing and persist theme memory.
   * Returns the briefing object (or null on failure — caller should degrade gracefully).
   */
  async synthesize(articles) {
    console.log('[PHASE 4.5] Synthesizing executive briefing...');

    if (!articles || articles.length === 0) {
      console.warn('[Synthesis] No articles to synthesize.');
      return null;
    }

    const context = this.loadContext();
    const memory = this.loadMemory();
    const prompt = this.buildPrompt(articles, context, memory);

    // Cooldown: the synthesis call follows many rapid article calls.
    // Give the rate-limit window time to reset before the big call.
    console.log('[Synthesis] Cooling down before synthesis call...');
    await new Promise(r => setTimeout(r, 60000));

    // Try up to 3 times; on a rate-limit (429) wait longer and retry.
    let briefing = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const raw = await this.agents.generateCompletion(prompt, `Executive briefing (attempt ${attempt})`);
        briefing = this.parseBriefing(raw);
        if (briefing) break;
        console.warn(`[Synthesis] Attempt ${attempt}: empty/unparseable response.`);
      } catch (e) {
        const is429 = /429/.test(e.message || '');
        console.warn(`[Synthesis] Attempt ${attempt} failed: ${e.message}`);
        if (attempt < maxAttempts) {
          const wait = is429 ? 30000 : 8000;
          console.log(`[Synthesis] Waiting ${wait / 1000}s before retry...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    if (!briefing) {
      console.error('[Synthesis] Could not produce briefing after retries.');
      return null;
    }

    // Hallucination guard: keep only citations that point to real articles.
    // Drop themes with no valid source; cap confidence for single-source themes.
    let invalidCitations = 0;
    const validThemes = [];
    for (const theme of briefing.themes) {
      const rawSources = Array.isArray(theme.sources) ? theme.sources : [];
      const validIdx = rawSources.filter(i => Number.isInteger(i) && i >= 0 && i < articles.length);
      invalidCitations += (rawSources.length - validIdx.length);

      if (validIdx.length === 0) {
        // No real source backs this theme — do not show it to leadership.
        console.warn(`[Synthesis] Dropping unsupported theme: "${theme.label}"`);
        continue;
      }

      theme.sources = validIdx;
      theme.sourceArticles = validIdx
        .map(idx => articles[idx])
        .filter(Boolean)
        .map(a => ({ title: a.title, url: a.url, source: a.source }));

      // Trust rule: a single-source theme cannot be "high" confidence.
      if (theme.sourceArticles.length < 2 && (theme.confidence || '').toLowerCase() === 'high') {
        theme.confidence = 'medium';
      }
      theme.singleSource = theme.sourceArticles.length < 2;

      validThemes.push(theme);
    }
    briefing.themes = validThemes;

    if (invalidCitations > 0) {
      console.warn(`[Synthesis] Removed ${invalidCitations} invalid source citation(s).`);
    }
    if (briefing.themes.length === 0) {
      console.error('[Synthesis] No themes survived citation validation.');
      return null;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const updated = this.updateMemory(memory, briefing, dateStr);
    this.saveMemory(updated);

    // Decorate themes with their tracked age for the email ("week 3")
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    for (const theme of briefing.themes) {
      const tracked = updated.themes.find(t => norm(t.label) === norm(theme.label));
      theme.timesSeen = tracked ? tracked.count : 1;
    }

    console.log(`[PHASE 4.5] Briefing ready: ${briefing.themes.length} themes`);
    return briefing;
  }
}

module.exports = Synthesizer;
