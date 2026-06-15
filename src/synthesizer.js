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
   * Flags content quality so the model knows when it's working from real article text
   * vs a headline alone — this directly affects how it should qualify its analysis.
   */
  formatArticles(articles) {
    const { cleanContent } = require('./content-enricher');
    return articles.map((a, i) => {
      const rawContent = a.content || a.description || '';
      const cleaned = cleanContent(rawContent).trim();
      const hasBody = cleaned.length > 200;

      // Prefer enriched body; fall back to AI summary if it's real; finally use cleaned raw
      let bodyText;
      if (hasBody) {
        bodyText = cleaned.substring(0, 2000);
      } else if (a.summary && !a.summary.startsWith('Unable to generate')) {
        bodyText = a.summary;
      } else {
        bodyText = cleaned.substring(0, 300) || a.title || '';
      }

      const contentQuality = hasBody
        ? 'FULL TEXT'
        : (a.summary && !a.summary.startsWith('Unable to generate'))
          ? 'AI SUMMARY ONLY'
          : 'HEADLINE ONLY — treat all inferences as speculative';

      return `[${i}] (${a.source || 'Unknown'}) ${a.title}
  Content quality: ${contentQuality}
  Sentiment: ${a.sentiment || 'neutral'} | Severity: ${a.market_impact_severity || 'n/a'} | Topics: ${a.trending_topics || 'n/a'}
  Body: ${bodyText}
  URL: ${a.url || ''}`;
    }).join('\n\n');
  }

  buildPrompt(articles, context, memory) {
    const contextBlock = context
      ? JSON.stringify(context, null, 2)
      : 'No company context available.';

    return `You are Mixta Africa's head of market intelligence, writing the daily briefing that lands in the CEO's inbox at 8am. This is the most important document produced today. It has one job: tell leadership what is actually happening in the Lagos real estate market, what it means for Mixta's live projects, and what needs to happen. 

Your audience reads this before meetings. They are smart, time-poor, and intolerant of generic commentary. They will notice if you state the obvious. They will notice if you hedge everything. Write like a seasoned analyst who has earned the right to have a view.

VOICE AND STYLE — follow these precisely:
- Write declaratively, not tentatively. "Rental demand is compressing Annexe's addressable market" not "This trend may potentially impact..."
- Use specific names: Lakowe Crossings, Lakowe Annexe, Lagos New Town, BAFF, FMBN, Ibeju-Lekki, Lekki Deep Seaport. Generic references to "our projects" or "the company" are not acceptable.
- Use numbers when they exist in the sources. "Annual rents up 40%" beats "rents have risen significantly."
- The executive_summary should open with the sharpest fact from today, not a scene-setter. It should be the kind of thing a good analyst would say out loud in a meeting.
- theme labels should be sharp and specific. Not "Market Trends" or "Policy Update" — something like "Rental Surge Eroding Buyer Pool" or "FG Mortgage Push: Annexe Tailwind or Competitor Cover?"
- what_happened: one sentence of fact. Direct. Quote the source if there is a number worth quoting.
- why_it_matters_to_mixta: this is where your commercial judgment goes. Name the specific risk or opportunity. Connect to receivables, pricing, absorption pace, launch timing, competitor moves, or regulatory exposure. Do not say "this may affect Mixta" — say HOW and HOW MUCH if possible.
- recommendation: frame it as a decision, not a to-do list. "Push the Annexe pricing review to this week's exec meeting — waiting costs optionality" beats "Monitor pricing strategies."

=== MIXTA CONTEXT (proprietary — use it to connect news to our actual position) ===
${contextBlock}

=== RECURRING THEME HISTORY (use to judge whether something is NEW, BUILDING, or ESTABLISHED) ===
${this.summarizeMemory(memory)}

=== TODAY'S ARTICLES (cite by [index]) ===
${this.formatArticles(articles)}

=== YOUR TASK ===
Identify 3 to 5 themes that genuinely move the needle for Mixta. Cluster related articles. Every theme must be grounded in at least one article from the list above. Judge novelty against the theme history — if a theme has appeared 3+ times, say so and escalate the recommendation.

TRUST RULES (non-negotiable — leadership relies on accuracy):
- Cite only real article indices that exist in the list above. Never invent a source.
- In "what_happened", state only what the sources actually say. In "why_it_matters_to_mixta", you are making an inference — own it as analysis, not established fact.
- A single-source theme cannot claim "high" confidence.
- If evidence is thin, say so directly rather than inflating the claim.

Write the executive_summary LAST, after you have identified the themes — it should reflect the sharpest finding, not a generic intro.

Respond ONLY with valid JSON in EXACTLY this shape (no markdown, no text outside the JSON):
{
  "executive_summary": "The single sharpest takeaway for leadership today. Open with a specific fact or number, not a scene-setter. Max 2 sentences.",
  "themes": [
    {
      "label": "Sharp, specific theme name — not generic",
      "novelty": "new | building | established",
      "what_happened": "One sentence of fact from the sources. Include numbers if they exist.",
      "why_it_matters_to_mixta": "Specific commercial impact on named Mixta projects, pricing, receivables, or competitive position. This is your analysis — own it.",
      "recommendation": "A decision, not a task. Who should do what, by when, and why now.",
      "confidence": "high | medium | low",
      "sources": [list of article index numbers, e.g. [0, 3]]
    }
  ],
  "watch_list_hits": ["Short note for each watch-list topic that surfaced today, or empty array"]
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
