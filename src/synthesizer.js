/**
 * Synthesis Engine — the intelligence layer.
 *
 * Turns a list of analyzed articles into an executive briefing by:
 * 1. Loading Mixta's proprietary context (mixta-context.json)
 * 2. Loading theme memory (data/themes.json) for temporal tracking
 * 3. Asking the model to cluster today's articles into themes and write a
 * decision-grade briefing connected to Mixta's actual position
 * 4. Updating theme memory so recurring themes can be flagged ("week 3", "new")
 *
 * Output is a structured briefing object consumed by the email + dashboard.
 */

const fs = require('fs');
const path = require('path');
const mixtaContext = require('./mixta-context.json');

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

  summarizeMemory(memory) {
    if (!memory.themes.length) return 'No prior theme history (first intelligent run).';
    return memory.themes
      .slice(-25)
      .map(t => `- "${t.label}" — seen ${t.count} prior run(s), last ${t.lastSeen}`)
      .join('\n');
  }

  formatArticles(articles) {
    const { cleanContent } = require('./content-enricher');
    return articles.map((a, i) => {
      const rawContent = a.content || a.description || '';
      const cleaned = cleanContent(rawContent).trim();
      const hasBody = cleaned.length > 200;

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
    const watchList = context?.watch_list || [];
    const cleanWatchList = watchList.map(w => `- ${w.topic}: ${w.why}`).join('\n');

    return `You are a market intelligence synthesis engine producing an objective daily executive briefing on the Nigerian real estate market.

VOICE AND STYLE:
- Write with ultimate business acumen: declarative, specific, highly analytical.
- Never use passive or tentative phrasing ("may potentially affect"). State exactly HOW and HOW MUCH a market shift matters, using the numbers present in the source articles.
- The executive_summary MUST consist of exactly 4 clean, sequential paragraphs of prose.
  CRITICAL RULES FOR THE EXECUTIVE SUMMARY:
  1. Be purely objective and factual. Summarize only what the market is doing, based strictly on what is in TODAY'S ARTICLES DATA below.
  2. DO NOT mention "Mixta Africa", "Mixta", "Lakowe", any named Mixta project, or any internal company position under any circumstances.
  3. DO NOT prescribe strategic actions, commercial imperatives, or business advice.
  4. Provide a high-level journalistic synthesis of the market itself, not a consulting report.
  5. Base every claim only on the article data provided below. Do not introduce outside facts, figures, or context not present in the source articles.

======================================================================
NIGERIA CORE MARKET CHANNELS (for thematic framing only — DO NOT name Mixta or
any company position when discussing these in the executive summary)
======================================================================
Relevant market channels to recognise when present in the data: CBN policy
rate shifts, FMBN/NHF structural modifications, infrastructure arbitrage
loops (Green Line Metro, Lekki-Epe Coastal Highway, Lekki Deep Seaport,
Dangote Refinery), land-banking dynamics, mortgage allocation programmes,
and diaspora investment channels.

=== TRACKED DOMAINS & WATCHLIST (market topics of interest, not company strategy) ===
${cleanWatchList}

=== RECURRING THEME HISTORY (Temporal Memory) ===
${this.summarizeMemory(memory)}

=== TODAY'S ARTICLES DATA (Cite sources using [index] tokens) ===
${this.formatArticles(articles)}

=== EDITORIAL TASK ===
Isolate 3 to 5 high-impact themes in today's Nigerian real estate market, grounded strictly in the article data above. Group correlated articles. Each theme's "why_it_matters_to_mixta" and "recommendation" fields (used internally, not shown in the public executive summary) may reference Mixta's commercial position using the context below — but the executive_summary text itself must stay free of any company reference per the rules above.

=== MIXTA INTERNAL CONTEXT (for theme-level why_it_matters_to_mixta / recommendation fields ONLY — never for executive_summary) ===
${this._buildInternalContextBlock(context)}

Respond ONLY with a valid JSON block matching this structural layout exactly (no markdown formatting, no preambles):
{
  "executive_summary": "Paragraph 1 prose here.\\n\\nParagraph 2 prose here.\\n\\nParagraph 3 prose here.\\n\\nParagraph 4 prose here.",
  "themes": [
    {
      "label": "Sharp, specific theme name highlighting the structural shift",
      "market": "Nigeria",
      "novelty": "new | building | established",
      "what_happened": "One sentence reporting the hard empirical facts from the sources, including explicit metrics or figures.",
      "why_it_matters_to_mixta": "Clear commercial calculation of exposure or opportunity regarding asset allocation, receivables, or named projects.",
      "recommendation": "A clean, actionable commercial decision or direct trade-off proposal addressed to the CCO.",
      "confidence": "high | medium | low",
      "sources": [0, 1]
    }
  ],
  "watch_list_hits": ["Short note for each watch-list topic that surfaced today, or empty array"]
}`;
  }

  /**
   * Mixta's internal strategic context, scoped to ONLY the theme-level
   * why_it_matters_to_mixta / recommendation fields - never the executive
   * summary. Kept as a separate block (rather than mixed into the main
   * prompt body, which is where it lived before this fix) specifically so
   * it's easy to verify it stays out of the executive_summary instructions.
   */
  _buildInternalContextBlock(context) {
    const priorities = context?.company?.strategic_priorities_2026 || [];
    const activeProjects = context?.active_projects || [];
    const pricingView = context?.internal_pricing_strategy_view || {};

    const cleanPriorities = priorities.map(p => `- ${p}`).join('\n');

    // Lagos corridor projects
    const lagosProjects = activeProjects
      .filter(p => {
        const loc = (p.location || '').toLowerCase();
        return loc.includes('lagos') || loc.includes('lekki') || loc.includes('ibeju');
      })
      .map(p => `- ${p.name} (Lagos): ${p.segment}. Open issues: ${(p.open_issues || []).join(', ') || 'None'}`).join('\n');

    // Port Harcourt projects
    const phProjects = activeProjects
      .filter(p => {
        const loc = (p.location || '').toLowerCase();
        return loc.includes('port harcourt') || loc.includes('harcourt') || loc.includes('rivers');
      })
      .map(p => {
        const ph = p;
        const priceRange = ph.gross_pricing_naira_millions
          ? `Pricing: ₦${ph.gross_pricing_naira_millions['2bed_detached_bungalow']}M–₦${ph.gross_pricing_naira_millions['3bed_semi_detached_duplex_golf_view']}M`
          : '';
        const econ = ph.unit_economics_scenario_2_phase_1_only
          ? `Phase 1 economics: revenue ₦${ph.unit_economics_scenario_2_phase_1_only.projected_revenue_naira}, margin ${ph.unit_economics_scenario_2_phase_1_only.net_profit_margin_pct}`
          : '';
        const issues = (ph.open_issues || []).join(', ') || 'None';
        return `- ${ph.name}: ${ph.segment}. ${priceRange}. ${econ}. Open issues: ${issues}`;
      }).join('\n');

    return `LAGOS CORRIDOR ACTIVE PROJECTS:\n${lagosProjects || 'None'}\n\nPORT HARCOURT ACTIVE PROJECTS:\n${phProjects || 'None'}\n\nStrategic priorities:\n${cleanPriorities}\n\nInternal pricing strategy: ${pricingView.headline_argument || 'N/A'}`;
  }

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
   * Defensive guard: even with prompt instructions, models can drift. Flags
   * (rather than silently rewrites — that could garble the prose) any stray
   * company/project mentions in the executive_summary, since this rule is
   * explicit and non-negotiable per the requirement that articulated it.
   */
  sanitizeExecutiveSummary(text) {
    if (!text) return text;
    const bannedTerms = ['Mixta Africa', 'Mixta', 'Lakowe Crossings', 'Lakowe Annexe', 'Lakowe', 'Lagos New Town', 'Garden City Golf Annexe', 'Garden City Golf'];
    for (const term of bannedTerms) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (re.test(text)) {
        console.warn(`[Synthesis] Executive summary contained banned term "${term}" despite prompt rules - flagging for review.`);
      }
    }
    return text;
  }

  updateMemory(memory, briefing, dateStr) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const existing = memory.themes;

    for (const theme of briefing.themes) {
      const label = theme.label || 'Untitled';
      const key = norm(label);

      const prior = existing.find(t => {
        const tk = norm(t.label);
        return tk === key || tk.includes(key) || key.includes(tk);
      });

      if (prior) {
        if (prior.lastSeen !== dateStr) {
          prior.count += 1;
          prior.lastSeen = dateStr;
        }
        prior.label = label;
      } else {
        existing.push({ label, count: 1, firstSeen: dateStr, lastSeen: dateStr });
      }
    }

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

  async synthesize(articles) {
    console.log('[PHASE 4.5] Synthesizing executive briefing...');

    if (!articles || articles.length === 0) {
      console.warn('[Synthesis] No articles to synthesize.');
      return null;
    }

    const context = this.loadContext();
    const memory = this.loadMemory();
    const prompt = this.buildPrompt(articles, context, memory);

    console.log('[Synthesis] Cooling down before synthesis call...');
    await new Promise(r => setTimeout(r, 60000));

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

    briefing.executive_summary = this.sanitizeExecutiveSummary(briefing.executive_summary);

    let invalidCitations = 0;
    const validThemes = [];
    for (const theme of briefing.themes) {
      const rawSources = Array.isArray(theme.sources) ? theme.sources : [];
      const validIdx = rawSources.filter(i => Number.isInteger(i) && i >= 0 && i < articles.length);
      invalidCitations += (rawSources.length - validIdx.length);

      if (validIdx.length === 0) {
        console.warn(`[Synthesis] Dropping unsupported theme: "${theme.label}"`);
        continue;
      }

      theme.sources = validIdx;
      theme.sourceArticles = validIdx
        .map(idx => articles[idx])
        .filter(Boolean)
        .map(a => ({ title: a.title, url: a.url, source: a.source }));

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
