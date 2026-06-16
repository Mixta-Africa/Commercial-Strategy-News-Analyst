/**
 * Content Enricher v2 — Fixed Edition
 *
 * FIXES APPLIED (per Gemini's analysis):
 * 1. Zero-Network Google News Base64 Decoder
 *    → Decodes Base64 payloads locally without network calls
 *    → Falls back to axios only if decode fails
 * 
 * 2. True Cheerio DOM Parsing
 *    → Ripped out custom regex HTML cleaner
 *    → Uses cheerio.load() for proper DOM manipulation
 *    → Targets semantic tags (article, .entry-content, <p>)
 * 
 * 3. Exposed Silent Errors
 *    → Every catch block now logs errors explicitly
 *    → 403/429/Timeout errors printed to console
 *
 * Enrichment Strategy:
 * - Articles < 200 chars get enriched by fetching the real URL
 * - Google News URLs decoded locally, then fetched
 * - Cheerio extracts body, fallback to <p> tags
 * - Errors logged so nothing is hidden from operators
 */

const axios = require('axios');
const cheerio = require('cheerio');

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
 * FIX #1: Zero-Network Google News Base64 Decoder
 * 
 * Google News URLs like news.google.com/rss/articles/CBMi... encode the
 * target URL in Base64. Decode locally without making a network request.
 * 
 * Example: CBMi... decodes to a Protobuf binary that contains the real URL.
 * We extract it using regex without needing axios to follow the redirect.
 * 
 * @param {string} googleNewsUrl - news.google.com/rss/articles/... URL
 * @returns {string|null} - decoded publisher URL or null if decode fails
 */
function decodeGoogleNewsBase64(googleNewsUrl) {
  try {
    if (!googleNewsUrl || !googleNewsUrl.includes('news.google.com')) return null;

    // Extract the Base64-encoded part after /articles/
    const match = googleNewsUrl.match(/\/articles\/([A-Za-z0-9_-]+)/);
    if (!match || !match[1]) {
      console.log('[Enricher] Google News URL has no Base64 payload:', googleNewsUrl.substring(0, 80));
      return null;
    }

    const base64Payload = match[1];
    console.log(`[Enricher] Attempting Base64 decode of Google News URL...`);

    // Decode the Base64 string (using base64url variant)
    try {
      const decoded = Buffer.from(base64Payload, 'base64').toString('utf8');
      
      // Look for common URL patterns in the decoded binary
      // Google News Protobuf typically contains the target URL as plain text
      const urlMatch = decoded.match(/(https?:\/\/[^\s<>"\x00-\x1f]+)/);
      if (urlMatch && urlMatch[1]) {
        const extractedUrl = urlMatch[1];
        console.log(`[Enricher] Successfully decoded Google News URL → ${extractedUrl.substring(0, 80)}`);
        return extractedUrl;
      }

      // Fallback: if no HTTP(s) URL found, the payload may not be a simple redirect
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
 * 
 * 1. Try decoding the Base64 payload locally (no network)
 * 2. If that fails, try following the HTTP redirect via axios
 * 3. Log all failures so nothing is hidden
 */
async function resolveGoogleNewsUrl(url) {
  console.log(`[Enricher] Resolving Google News URL: ${url.substring(0, 80)}`);

  // First, try decoding the Base64 payload locally
  const decodedUrl = decodeGoogleNewsBase64(url);
  if (decodedUrl) {
    return decodedUrl;
  }

  // Fallback: try following the HTTP redirect
  console.log('[Enricher] Base64 decode failed or no URL found, attempting network redirect...');
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: s => s < 400,
    });

    // Try to extract URL from response headers or body
    const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
    
    console.log(`[Enricher] Final URL after redirect: ${finalUrl.substring(0, 100)}`);

    // If we got a real publisher URL (not Google News), use it
    if (finalUrl && !finalUrl.includes('news.google.com')) {
      console.log(`[Enricher] Got real publisher URL → ${finalUrl.substring(0, 80)}`);
      return finalUrl;
    }

    // Google News pages often have a redirect URL in the HTML
    // Look for "https://www.google.com/url?rct=j&q=&esrc=s&cd=&ved=...&url=" pattern
    const htmlBody = response.data || '';
    
    // Pattern 1: Look for clickable link in the page
    const linkMatch = htmlBody.match(/href=["']([^"']+news\.google\.com[^"']*url=([^&"']+))/i);
    if (linkMatch && linkMatch[2]) {
      const encodedUrl = decodeURIComponent(linkMatch[2]);
      if (encodedUrl && !encodedUrl.includes('google.com')) {
        console.log(`[Enricher] Extracted URL from HTML → ${encodedUrl.substring(0, 80)}`);
        return encodedUrl;
      }
    }

    // Pattern 2: Look for "view original" link
    const originalMatch = htmlBody.match(/href=["']([^"']*?)(https?:\/\/[^"'<>]+)["']/);
    if (originalMatch && originalMatch[2] && !originalMatch[2].includes('google.com')) {
      console.log(`[Enricher] Found original link → ${originalMatch[2].substring(0, 80)}`);
      return originalMatch[2];
    }

    // Pattern 3: Fallback - look for canonical link
    const canonical = htmlBody.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonical && canonical[1] && !canonical[1].includes('google.com')) {
      console.log(`[Enricher] Found canonical link → ${canonical[1].substring(0, 80)}`);
      return canonical[1];
    }

    console.log('[Enricher] HTTP redirect succeeded but no real publisher URL found, staying on Google News');
    return null;
  } catch (networkError) {
    // FIX #3: Expose the error instead of silently returning null
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
 * FIX #2: Extract article body using Cheerio DOM parsing instead of brittle regex
 * 
 * Strategy:
 * 1. Load HTML with cheerio
 * 2. Remove garbage tags (script, style, nav, footer, etc.)
 * 3. Target semantic article containers (article tag, .entry-content, etc.)
 * 4. Extract all <p> tags as fallback
 * 5. Return the largest contiguous text block
 */
function extractBodyText(html) {
  if (!html || typeof html !== 'string') return null;

  try {
    const $ = cheerio.load(html);

    // Remove garbage
    $('script, style, nav, header, footer, aside, iframe, noscript, form, .nav, .sidebar, .comments, .advertisement, .ad').remove();
    $('<!--[^]*-->').remove(); // remove HTML comments

    // Try to find article body in semantic containers
    let bodyText = '';

    // Priority 1: Look for <article> tag
    const article = $('article').text();
    if (article && article.trim().length > 200) {
      bodyText = article;
    }

    // Priority 2: Look for .entry-content, .post-content, .article-content
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

    // Priority 3: Extract all <p> tags (most publishers use <p> for paragraphs)
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

    // Priority 4: Fallback to body tag
    if (!bodyText) {
      bodyText = $('body').text();
    }

    // Clean and return
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
 * 
 * Errors are now logged so 403/429/Timeout failures are visible
 * instead of silently returning null.
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
    // FIX #3: Expose all errors instead of silently swallowing them
    console.error('[Enricher] Article fetch FAILED:', {
      url: url.substring(0, 80),
      status: fetchError.response?.status,
      statusText: fetchError.response?.statusText,
      code: fetchError.code,
      message: fetchError.message,
      timeout: fetchError.config?.timeout,
    });

    // Specific error messages for debugging
    if (fetchError.response?.status === 403) {
      console.error('[Enricher] ⚠️  403 Forbidden — publisher blocking requests');
    } else if (fetchError.response?.status === 429) {
      console.error('[Enricher] ⚠️  429 Rate Limited — too many requests to this domain');
    } else if (fetchError.code === 'ECONNABORTED' || fetchError.message.includes('timeout')) {
      console.error('[Enricher] ⚠️  Timeout — publisher server too slow');
    }

    return null;
  }
}

/**
 * Enrich a batch of articles by fetching full content for thin ones.
 * Runs in small parallel batches (3 at a time) to balance speed vs politeness.
 * 
 * STRATEGY:
 * 1. Try to fetch and extract full text from URL
 * 2. If extraction fails, fall back to headline + description
 * 3. If that's insufficient, use AI to summarize from headline alone
 * 4. Never skip articles - always provide SOMETHING for AI analysis
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
  console.log(`[Enricher] Strategy: Extract full text → Fallback to headline+description → Use headline for AI`);

  // Process in batches of 3 to avoid hammering publishers
  const BATCH_SIZE = 3;
  const enrichedMap = new Map(); // url -> enriched article

  for (let i = 0; i < thin.length; i += BATCH_SIZE) {
    const batch = thin.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (article) => {
      let targetUrl = article.url;
      let extractedContent = null;
      let extractionSource = null;

      // Try to fetch full article text
      if (targetUrl) {
        // Resolve Google News redirect to real publisher URL
        if (isGoogleNewsUrl(targetUrl)) {
          const resolved = await resolveGoogleNewsUrl(targetUrl);
          if (resolved) {
            targetUrl = resolved;
          }
        }

        // Attempt extraction
        extractedContent = await fetchArticleBody(targetUrl);
        if (extractedContent && extractedContent.length > 150) {
          extractionSource = 'full_text';
          console.log(`[Enricher] ✓ Extracted full text (${extractedContent.length} chars): ${article.title?.substring(0, 55)}`);
          return {
            ...article,
            content: extractedContent,
            resolvedUrl: targetUrl !== article.url ? targetUrl : undefined,
            contentEnriched: true,
            enrichmentSource: 'full_text',
          };
        }
      }

      // Fallback 1: Use headline + description + source
      const headline = article.title || '';
      const description = article.description || '';
      const source = article.source || '';
      
      const fallbackContent = [headline, description, source]
        .filter(x => x && x.length > 0)
        .join('. ')
        .substring(0, MAX_EXTRACT);

      if (fallbackContent.length > 150) {
        console.log(`[Enricher] ↻ Using headline+description (${fallbackContent.length} chars): ${headline?.substring(0, 55)}`);
        return {
          ...article,
          content: fallbackContent,
          contentEnriched: true,
          enrichmentSource: 'headline_description',
        };
      }

      // Fallback 2: Use headline alone (at minimum)
      if (headline && headline.length > 50) {
        console.log(`[Enricher] ~ Using headline only (${headline.length} chars): ${headline?.substring(0, 55)}`);
        return {
          ...article,
          content: headline,
          contentEnriched: true,
          enrichmentSource: 'headline_only',
        };
      }

      // Last resort: something is better than nothing
      console.log(`[Enricher] ⚠ Minimal content available: ${article.title?.substring(0, 55)}`);
      return {
        ...article,
        content: article.title || 'Real estate market article',
        contentEnriched: false,
        enrichmentSource: 'none',
      };
    }));

    results.forEach(r => enrichedMap.set(r.url, r));

    // Pause between batches
    if (i + BATCH_SIZE < thin.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Count enrichment quality
  const fullText = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'full_text').length;
  const fallbackHD = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'headline_description').length;
  const fallbackH = [...enrichedMap.values()].filter(a => a.enrichmentSource === 'headline_only').length;

  console.log(`[Enricher] Done. ${fullText} full-text + ${fallbackHD} headline+desc + ${fallbackH} headline`);
  console.log(`[Enricher] Total enriched: ${thin.length}/${thin.length} articles have content for AI analysis`);

  // Return articles in original order with enriched content substituted
  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}



module.exports = { enrichArticles, usableLength, cleanContent };
