/**
 * Content Enricher
 *
 * The core problem: NewsAPI truncates content to ~200 chars, Google News RSS
 * has no body at all (just title + publisher). The AI analysing these articles
 * is making things up based on headlines — it has nothing else to work with.
 *
 * This module enriches articles where content is thin by fetching the actual
 * article page. Only articles below the THIN_THRESHOLD are fetched — typically
 * 6-8 per run rather than all 25, keeping the pipeline fast.
 *
 * Extraction approach: fetch HTML with browser headers, strip scripts/styles/nav/
 * footer boilerplate, extract the largest text block (the article body). No
 * third-party extraction service required — works on GitHub Actions runners
 * which have full outbound internet access.
 *
 * Google News URLs: these are tracking redirects (news.google.com/rss/articles/...)
 * that redirect to the real publisher URL. We follow the redirect chain first,
 * then fetch the resolved URL.
 *
 * Rate limiting: 1.5s between fetches to avoid hammering publishers.
 * Timeout: 12s per article — if slow, skip it rather than blocking the pipeline.
 */

const axios = require('axios');

// Articles with content shorter than this (chars, after cleaning) get enriched.
// 200 chars is the right threshold — below this is genuinely a title restatement
// (Google News RSS, truncated NewsAPI snippets). Articles with 200+ chars have at
// least a real paragraph and give the AI something to work with.
const THIN_THRESHOLD = 200;

// Max chars of body text to extract and pass to AI — enough for real analysis
// without blowing the prompt budget
const MAX_EXTRACT = 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/**
 * Clean raw content: strip HTML tags, decode common entities, normalise whitespace.
 */
function cleanContent(raw) {
  if (!raw) return '';
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\[(\+\d+\s*chars?)\]/g, '') // strip NewsAPI truncation markers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Measure the usable content length of an article.
 */
function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

/**
 * Is this a Google News tracking URL?
 */
function isGoogleNewsUrl(url) {
  return url && (url.includes('news.google.com/rss/articles') || url.includes('news.google.com/articles'));
}

/**
 * Resolve a Google News redirect to the actual publisher URL.
 * Follows HTTP redirects; returns the final URL or null on failure.
 */
async function resolveGoogleNewsUrl(url) {
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 10,
      validateStatus: s => s < 400,
    });
    // After following redirects, the final URL is in response.request.res.responseUrl
    // or response.config.url — axios populates response.request?.res?.responseUrl
    const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
    if (finalUrl && finalUrl !== url && !finalUrl.includes('news.google.com')) {
      return finalUrl;
    }
    // Fallback: look for a canonical link in the HTML
    const canonical = (response.data || '').match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonical) return canonical[1];
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract article body text from raw HTML.
 * Strategy: find the largest continuous text block, excluding nav/header/footer/aside.
 */
function extractBodyText(html) {
  // Remove likely non-article blocks
  const cleaned = html
    .replace(/<(script|style|nav|header|footer|aside|iframe|figure|noscript|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Split on block tags and find the largest text chunks
  const chunks = cleaned
    .split(/<\/?(p|div|section|article|blockquote|li|h[1-6])[^>]*>/gi)
    .map(chunk => cleanContent(chunk))
    .filter(chunk => chunk.length > 60); // skip tiny fragments

  if (!chunks.length) {
    // Fallback: just clean the whole thing
    return cleanContent(html).substring(0, MAX_EXTRACT);
  }

  // Sort by length descending, take top chunks until we hit MAX_EXTRACT
  chunks.sort((a, b) => b.length - a.length);
  let body = '';
  for (const chunk of chunks) {
    if (body.length >= MAX_EXTRACT) break;
    // Skip chunks that look like nav/sidebar (short repeated phrases, dates, etc.)
    if (chunk.split(' ').length < 15) continue;
    body += ' ' + chunk;
  }

  return body.trim().substring(0, MAX_EXTRACT);
}

/**
 * Fetch and extract article body for a single URL.
 * Returns extracted text or null on failure.
 */
async function fetchArticleBody(url) {
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
      maxRedirects: 10,
      validateStatus: s => s < 400,
    });

    if (typeof response.data !== 'string') return null;

    const body = extractBodyText(response.data);
    return body.length > 100 ? body : null;
  } catch (e) {
    return null;
  }
}

/**
 * Enrich a batch of articles by fetching full content for thin ones.
 * Runs in small parallel batches (3 at a time) to balance speed vs politeness.
 *
 * @param {Array} articles — all articles from Phase 2 filter
 * @returns {Array} — same articles, with `content` field enriched where possible
 */
async function enrichArticles(articles) {
  const thin = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) {
    console.log('[Enricher] All articles have sufficient content — no enrichment needed');
    return articles;
  }

  console.log(`[Enricher] ${already.length} articles OK, ${thin.length} need enrichment`);

  // Process in batches of 3 to avoid hammering publishers
  const BATCH_SIZE = 3;
  const enrichedMap = new Map(); // url -> enriched article

  for (let i = 0; i < thin.length; i += BATCH_SIZE) {
    const batch = thin.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (article) => {
      let targetUrl = article.url;

      // Resolve Google News redirect to real publisher URL
      if (isGoogleNewsUrl(targetUrl)) {
        const resolved = await resolveGoogleNewsUrl(targetUrl);
        if (resolved) {
          targetUrl = resolved;
        }
      }

      // Fetch article body
      const bodyText = targetUrl ? await fetchArticleBody(targetUrl) : null;

      if (bodyText && bodyText.length > 150) {
        console.log(`[Enricher] OK (${bodyText.length} chars): ${article.title?.substring(0, 55)}`);
        return {
          ...article,
          content: bodyText,
          resolvedUrl: targetUrl !== article.url ? targetUrl : undefined,
          contentEnriched: true,
        };
      } else {
        console.warn(`[Enricher] Could not enrich: ${article.title?.substring(0, 55)}`);
        return { ...article, contentEnriched: false };
      }
    }));

    results.forEach(r => enrichedMap.set(r.url, r));

    // Pause between batches
    if (i + BATCH_SIZE < thin.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const successCount = [...enrichedMap.values()].filter(a => a.contentEnriched).length;
  console.log(`[Enricher] Done. ${successCount}/${thin.length} articles enriched`);

  // Return articles in original order with enriched content substituted
  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
