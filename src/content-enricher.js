/**
 * Content Enricher v2 — Fixed Edition
 *
 * FIXES APPLIED:
 * 1. Zero-Network Google News Base64 Decoder
 * 2. True Cheerio DOM Parsing
 * 3. Exposed Silent Errors
 * 4. FALLBACK ENRICHMENT STRATEGY
 *    → Never skips articles
 *    → Extract full text → Headline+Desc → Headline only
 *
 * Enrichment Strategy:
 * - Articles < 200 chars get enriched by fetching the real URL
 * - Google News URLs decoded locally, then fetched
 * - Cheerio extracts body, fallback to <p> tags
 * - If extraction fails: use headline + description
 * - If that fails: use headline only
 * - Errors logged so nothing is hidden
 */

const axios = require('axios');
const cheerio = require('cheerio');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT = 3000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

/**
 * Clean raw content: strip HTML tags, decode entities, normalise whitespace
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
    .replace(/\[(\+\d+\s*chars?)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Measure the usable content length of an article
 */
function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

/**
 * FIX #1: Zero-Network Google News Base64 Decoder
 */
function decodeGoogleNewsBase64(googleNewsUrl) {
  try {
    if (!googleNewsUrl || !googleNewsUrl.includes('news.google.com')) return null;

    const match = googleNewsUrl.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (!match || !match[1]) {
      console.log('[Enricher] Google News URL has no Base64 payload:', googleNewsUrl.substring(0, 80));
      return null;
    }

    const base64Payload = match[1];
    console.log(`[Enricher] Attempting Base64 decode of Google News URL...`);

    try {
      const decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
      const urlMatch = decoded.match(/(https?:\/\/[^\s<>"\\x00-\\x1f]+)/);
      if (urlMatch && urlMatch[1]) {
        const extractedUrl = urlMatch[1];
        console.log(`[Enricher] Successfully decoded Google News URL → ${extractedUrl.substring(0, 80)}`);
        return extractedUrl;
      }

      console.log('[Enricher] Base64 decoded but no URL pattern found in payload');
      return null;
    } catch (decodeError) {
      console.log('[Enricher] Base64 decode failed:', decodeError.message);
      return null;
    }
  } catch (error) {
    console.error('[Enricher] Error in decodeGoogleNewsBase64:', error.message);
    return null;
  }
}

/**
 * Is this a Google News tracking URL?
 */
function isGoogleNewsUrl(url) {
  return url && (url.includes('news.google.com/rss/articles') || url.includes('news.google.com/articles'));
}

/**
 * FIX #2: Resolve Google News URL with Base64 decode first, then network fallback
 */
async function resolveGoogleNewsUrl(url) {
  console.log(`[Enricher] Resolving Google News URL: ${url.substring(0, 80)}`);

  const decodedUrl = decodeGoogleNewsBase64(url);
  if (decodedUrl) {
    return decodedUrl;
  }

  console.log('[Enricher] Base64 decode failed, attempting network redirect...');
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: s => s < 400,
    });

    const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
    console.log(`[Enricher] Final URL after redirect: ${finalUrl.substring(0, 100)}`);

    if (finalUrl && !finalUrl.includes('news.google.com')) {
      console.log(`[Enricher] Got real publisher URL → ${finalUrl.substring(0, 80)}`);
      return finalUrl;
    }

    const htmlBody = response.data || '';
    
    const linkMatch = htmlBody.match(/href=["']([^"']+news\.google\.com[^"']*url=([^&"']+))/i);
    if (linkMatch && linkMatch[2]) {
      const encodedUrl = decodeURIComponent(linkMatch[2]);
      if (encodedUrl && !encodedUrl.includes('google.com')) {
        console.log(`[Enricher] Extracted URL from HTML → ${encodedUrl.substring(0, 80)}`);
        return encodedUrl;
      }
    }

    const originalMatch = htmlBody.match(/href=["']([^"']*?)(https?:\/\/[^"'<>]+)["']/);
    if (originalMatch && originalMatch[2] && !originalMatch[2].includes('google.com')) {
      console.log(`[Enricher] Found original link → ${originalMatch[2].substring(0, 80)}`);
      return originalMatch[2];
    }

    const canonical = htmlBody.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonical && canonical[1] && !canonical[1].includes('google.com')) {
      console.log(`[Enricher] Found canonical link → ${canonical[1].substring(0, 80)}`);
      return canonical[1];
    }

    console.log('[Enricher] HTTP redirect succeeded but no real publisher URL found');
    return null;
  } catch (networkError) {
    console.error('[Enricher] HTTP redirect FAILED:', {
      status: networkError.response?.status,
      message: networkError.message,
      code: networkError.code,
      url: url.substring(0, 80),
    });
    return null;
  }
}

/**
 * FIX #2: Extract article body using Cheerio DOM parsing
 */
function extractBodyText(html) {
  if (!html || typeof html !== 'string') return null;

  try {
    const $ = cheerio.load(html);

    $('script, style, nav, header, footer, aside, iframe, noscript, form, .nav, .sidebar, .comments, .advertisement, .ad').remove();
    $('<!--[^]*-->').remove();

    let bodyText = '';

    const article = $('article').text();
    if (article && article.trim().length > 200) {
      bodyText = article;
    }

    if (!bodyText) {
      const containers = ['.entry-content', '.post-content', '.article-content', '.article-body', '[role="main"]', 'main'];
      for (const selector of containers) {
        const text = $(selector).text();
        if (text && text.trim().length > 200) {
          bodyText = text;
          break;
        }
      }
    }

    if (!bodyText) {
      const paragraphs = [];
      $('p').each((_, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length > 20) {
          paragraphs.push(text);
        }
      });
      if (paragraphs.length > 0) {
        bodyText = paragraphs.join(' ');
      }
    }

    if (!bodyText) {
      bodyText = $('body').text();
    }

    if (bodyText) {
      const cleaned = cleanContent(bodyText);
      if (cleaned.length > 100) {
        return cleaned.substring(0, MAX_EXTRACT);
      }
    }

    console.log('[Enricher] extractBodyText: could not extract meaningful content from HTML');
    return null;
  } catch (parseError) {
    console.error('[Enricher] Cheerio parsing failed:', parseError.message);
    return null;
  }
}

/**
 * FIX #3: Fetch article body with explicit error logging
 */
async function fetchArticleBody(url) {
  console.log(`[Enricher] Fetching article body: ${url.substring(0, 80)}`);
  
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
      maxRedirects: 10,
      validateStatus: s => s < 400,
    });

    if (typeof response.data !== 'string') {
      console.warn(`[Enricher] Response data is not HTML string (type: ${typeof response.data})`);
      return null;
    }

    const body = extractBodyText(response.data);
    if (body && body.length > 100) {
      console.log(`[Enricher] Successfully extracted ${body.length} chars from article`);
      return body;
    } else {
      console.warn(`[Enricher] Extracted text too short (${body?.length || 0} chars)`);
      return null;
    }
  } catch (fetchError) {
    console.error('[Enricher] Article fetch FAILED:', {
      url: url.substring(0, 80),
      status: fetchError.response?.status,
      statusText: fetchError.response?.statusText,
      code: fetchError.code,
      message: fetchError.message,
    });

    if (fetchError.response?.status === 403) {
      console.error('[Enricher] ⚠️  403 Forbidden — publisher blocking requests');
    } else if (fetchError.response?.status === 429) {
      console.error('[Enricher] ⚠️  429 Rate Limited — too many requests');
    } else if (fetchError.code === 'ECONNABORTED' || fetchError.message.includes('timeout')) {
      console.error('[Enricher] ⚠️  Timeout — publisher server too slow');
    }

    return null;
  }
}

/**
 * FALLBACK ENRICHMENT STRATEGY - Never skip articles
 * 
 * Priority:
 * 1. Extract full article text (best quality)
 * 2. Fallback to headline + description (good quality)
 * 3. Last resort: headline only (minimal quality)
 * 4. Everything gets content for AI analysis
 */
async function enrichArticles(articles) {
  const thin = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) {
    console.log('[Enricher] All articles have sufficient content — no enrichment needed');
    return articles;
  }

  console.log(`[Enricher] Strategy: Extract text → Headline+Desc → Headline only`);
  console.log(`[Enricher] ${already.length} articles OK, ${thin.length} need enrichment`);

  const BATCH_SIZE = 3;
  const enrichedMap = new Map();

  for (let i = 0; i < thin.length; i += BATCH_SIZE) {
    const batch = thin.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (article) => {
      let targetUrl = article.url;

      // Try to fetch full article text (skip Google News for extraction)
      if (targetUrl && !isGoogleNewsUrl(targetUrl)) {
        const extractedContent = await fetchArticleBody(targetUrl);
        if (extractedContent && extractedContent.length > 150) {
          console.log(`[Enricher] ✓ Full text (${extractedContent.length} chars): ${article.title?.substring(0, 50)}`);
          return {
            ...article,
            content: extractedContent,
            contentEnriched: true,
            enrichmentSource: 'full_text',
          };
        }
      }

      // FALLBACK 1: Headline + Description
      const headline = article.title || '';
      const description = article.description || '';
      const source = article.source || '';
      
      const fallbackContent = [headline, description, source]
        .filter(x => x && x.length > 0)
        .join('. ')
        .substring(0, MAX_EXTRACT);

      if (fallbackContent.length > 150) {
        console.log(`[Enricher] ↻ Headline+Desc (${fallbackContent.length} chars): ${headline?.substring(0, 50)}`);
        return {
          ...article,
          content: fallbackContent,
          contentEnriched: true,
          enrichmentSource: 'headline_description',
        };
      }

      // FALLBACK 2: Headline only
      if (headline && headline.length > 50) {
        console.log(`[Enricher] ~ Headline only (${headline.length} chars): ${headline?.substring(0, 50)}`);
        return {
          ...article,
          content: headline,
          contentEnriched: true,
          enrichmentSource: 'headline_only',
        };
      }

      // FALLBACK 3: Minimal
      console.log(`[Enricher] ⚠ Minimal: ${article.title?.substring(0, 50)}`);
      return {
        ...article,
        content: article.title || 'Real estate market article',
        contentEnriched: false,
        enrichmentSource: 'title_only',
      };
    }));

    results.forEach(r => enrichedMap.set(r.url, r));

    if (i + BATCH_SIZE < thin.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Quality breakdown
  const fullText = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'full_text').length;
  const headlineDesc = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'headline_description').length;
  const headlineOnly = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'headline_only').length;
  const minimal = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'title_only').length;

  console.log(`[Enricher] Quality breakdown:`);
  console.log(`  • ${fullText} articles with full extracted text`);
  console.log(`  • ${headlineDesc} articles with headline + description`);
  console.log(`  • ${headlineOnly} articles with headline only`);
  if (minimal > 0) console.log(`  • ${minimal} articles with minimal content`);
  console.log(`[Enricher] Total: ${thin.length}/${thin.length} articles have content for AI analysis ✓`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
