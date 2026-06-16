/**
 * Content Enricher v2 — Fixed Edition
 *
 * FIXES APPLIED:
 * 1. Zero-Network Google News Base64 Decoder
 * → Decodes Base64 payloads locally without network calls
 * → Falls back to axios only if decode fails
 * * 2. True Cheerio DOM Parsing
 * → Ripped out custom regex HTML cleaner
 * → Uses cheerio.load() for proper DOM manipulation
 * → Targets semantic tags (article, .entry-content, <p>)
 * * 3. Exposed Silent Errors
 * → Every catch block now logs errors explicitly
 * → 403/429/Timeout errors printed to console
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

function cleanContent(raw) {
  if (!raw) return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\[(\+\d+\s*chars?)\]/g, '') // strip NewsAPI truncation markers
    .replace(/\s+/g, ' ')
    .trim();
}

function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

/**
 * Zero-Network Google News Decoder
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

function isGoogleNewsUrl(url) {
  return url && (url.includes('news.google.com/rss/articles') || url.includes('news.google.com/articles'));
}

async function resolveGoogleNewsUrl(url) {
  console.log(`[Enricher] Resolving Google News URL: ${url.substring(0, 80)}`);

  const decodedUrl = decodeGoogleNewsBase64(url);
  if (decodedUrl) return decodedUrl;

  console.log('[Enricher] Base64 decode failed or no URL found, attempting network redirect...');
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: s => s < 400,
    });

    const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || url;
    if (finalUrl && !finalUrl.includes('news.google.com')) {
      console.log(`[Enricher] Got real publisher URL → ${finalUrl.substring(0, 80)}`);
      return finalUrl;
    }

    const htmlBody = response.data || '';
    const linkMatch = htmlBody.match(/href=["']([^"']+news\.google\.com[^"']*url=([^&"']+))/i);
    if (linkMatch && linkMatch[2]) {
      const encodedUrl = decodeURIComponent(linkMatch[2]);
      if (encodedUrl && !encodedUrl.includes('google.com')) return encodedUrl;
    }

    const canonical = htmlBody.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonical && canonical[1] && !canonical[1].includes('google.com')) return canonical[1];

    return null;
  } catch (networkError) {
    console.error('[Enricher] HTTP redirect FAILED:', {
      status: networkError.response?.status,
      message: networkError.message,
      url: url.substring(0, 80),
    });
    return null;
  }
}

/**
 * Extract article body using Cheerio DOM parsing
 */
function extractBodyText(html) {
  if (!html || typeof html !== 'string') return null;

  try {
    const $ = cheerio.load(html);

    $('script, style, nav, header, footer, aside, iframe, noscript, form, .nav, .sidebar, .comments, .advertisement, .ad').remove();
    $('').remove(); 

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
      if (paragraphs.length > 0) bodyText = paragraphs.join(' ');
    }

    if (!bodyText) bodyText = $('body').text();

    if (bodyText) {
      const cleaned = cleanContent(bodyText);
      if (cleaned.length > 100) return cleaned.substring(0, MAX_EXTRACT);
    }

    console.log('[Enricher] extractBodyText: could not extract meaningful content from HTML');
    return null;
  } catch (parseError) {
    console.error('[Enricher] Cheerio parsing failed:', parseError.message);
    return null;
  }
}

async function fetchArticleBody(url) {
  console.log(`[Enricher] Fetching article body: ${url.substring(0, 80)}`);
  try {
    const response = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
      maxRedirects: 10,
      validateStatus: s => s < 400,
    });

    if (typeof response.data !== 'string') return null;

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
      message: fetchError.message,
    });
    return null;
  }
}

async function enrichArticles(articles) {
  const thin = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) return articles;

  console.log(`[Enricher] ${already.length} articles OK, ${thin.length} need enrichment`);

  const BATCH_SIZE = 3;
  const enrichedMap = new Map(); 

  for (let i = 0; i < thin.length; i += BATCH_SIZE) {
    const batch = thin.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (article) => {
      let targetUrl = article.url;

      if (isGoogleNewsUrl(targetUrl)) {
        const resolved = await resolveGoogleNewsUrl(targetUrl);
        if (resolved) targetUrl = resolved;
      }

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
    if (i + BATCH_SIZE < thin.length) await new Promise(r => setTimeout(r, 2000));
  }

  const successCount = [...enrichedMap.values()].filter(a => a.contentEnriched).length;
  console.log(`[Enricher] Done. ${successCount}/${thin.length} articles enriched`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
