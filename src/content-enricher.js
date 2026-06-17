/**
 * Content Enricher v3.1 — Headless Browser Edition with Aggressive Retry & Session Recovery
 *
 * Following your brilliant intuition, this acts as the "extra step".
 * Instead of a dumb HTTP request, this opens a literal, invisible Chrome browser.
 * It automatically executes Google's JS redirects and waits out Cloudflare's
 * "Checking your browser" human-verification screens before scraping the text.
 *
 * PATCH v3.1: Adds per-article retry logic with exponential backoff and session recovery
 * to handle ProtocolError: Session with given id not found crashes mid-batch.
 */

const puppeteer = require('puppeteer');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT = 3000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

/**
 * Exponential backoff: 2s, 4s, 8s
 */
function getBackoffMs(attemptNumber) {
  return BASE_BACKOFF_MS * Math.pow(2, attemptNumber - 1);
}

/**
 * Safely close a page without throwing if session is already dead.
 */
async function safeClosePage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (err) {
    // Session might be dead; that's OK, we're moving on.
  }
}

/**
 * Check if browser is still connected before reusing it.
 * If disconnected, return true to signal restart needed.
 */
async function isBrowserDead(browser) {
  try {
    const version = await browser.version();
    return !version; // If no version, browser is dead
  } catch (err) {
    return true; // Any error means the browser session is gone
  }
}

/**
 * Single article enrichment with built-in retries and session recovery.
 */
async function enrichSingleArticle(browser, article, attemptNumber = 1) {
  if (attemptNumber > MAX_RETRIES) {
    console.log(`[Enricher] MAX_RETRIES (${MAX_RETRIES}) exceeded for ${article.title.substring(0, 40)}`);
    return { ...article, contentEnriched: false };
  }

  let page;
  try {
    // Check if browser session is still alive
    if (await isBrowserDead(browser)) {
      throw new Error('Browser session is dead');
    }

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[Enricher] Attempt ${attemptNumber}/${MAX_RETRIES}: ${article.url.substring(0, 80)}...`);
    
    // Load the page with aggressive timeout
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    
    // Wait 3.5 seconds unconditionally for JS redirects and Cloudflare checks
    await new Promise(r => setTimeout(r, 3500));

    const finalUrl = page.url();
    
    const extractedText = await page.evaluate(() => {
      if (!document.body) return '';

      document.querySelectorAll('script, style, nav, header, footer, aside, iframe, noscript, form, .ad, .sidebar, .comments').forEach(el => el.remove());

      const articleTag = document.querySelector('article');
      if (articleTag && articleTag.innerText.trim().length > 200) return articleTag.innerText.trim();

      const containers = ['.entry-content', '.post-content', '.article-body', '.article-content', 'main', '#main'];
      for (let selector of containers) {
        const el = document.querySelector(selector);
        if (el && el.innerText.trim().length > 200) return el.innerText.trim();
      }

      const pTags = Array.from(document.querySelectorAll('p')).map(p => p.innerText.trim()).filter(text => text.length > 20);
      if (pTags.length > 0) return pTags.join(' ');

      return document.body.innerText.trim();
    });

    const cleanText = cleanContent(extractedText).substring(0, MAX_EXTRACT);

    if (cleanText.length > 150) {
      console.log(`[Enricher] SUCCESS (Attempt ${attemptNumber}): Grabbed ${cleanText.length} chars from ${finalUrl.substring(0, 60)}`);
      return {
        ...article,
        content: cleanText,
        resolvedUrl: finalUrl,
        contentEnriched: true
      };
    } else {
      console.log(`[Enricher] RETRY (Attempt ${attemptNumber}): Page rendered but no text found for ${article.title.substring(0, 40)}`);
      await safeClosePage(page);
      
      const backoffMs = getBackoffMs(attemptNumber);
      console.log(`[Enricher] Backing off ${backoffMs}ms before retry...`);
      await new Promise(r => setTimeout(r, backoffMs));
      
      return enrichSingleArticle(browser, article, attemptNumber + 1);
    }
  } catch (err) {
    console.error(`[Enricher] ERROR (Attempt ${attemptNumber}/${MAX_RETRIES}): ${article.title.substring(0, 40)} - ${err.message}`);
    
    // Clean up this page attempt
    await safeClosePage(page);

    // If it's a ProtocolError or session error, apply backoff and retry
    if (err.message && (err.message.includes('ProtocolError') || err.message.includes('Session') || err.message.includes('Browser session'))) {
      const backoffMs = getBackoffMs(attemptNumber);
      console.log(`[Enricher] Session recovery: Backing off ${backoffMs}ms before retry...`);
      await new Promise(r => setTimeout(r, backoffMs));
      return enrichSingleArticle(browser, article, attemptNumber + 1);
    }

    // For other errors, mark as failed immediately
    return { ...article, contentEnriched: false };
  }
}

async function enrichArticles(articles) {
  const thin = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) return articles;

  console.log(`[Enricher] ${already.length} articles OK, ${thin.length} need enrichment via Headless Browser`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const enrichedMap = new Map();

  // Process each article sequentially with retry logic
  for (const article of thin) {
    const enriched = await enrichSingleArticle(browser, article);
    enrichedMap.set(article.url, enriched);
  }

  try {
    await browser.close();
  } catch (err) {
    console.error(`[Enricher] Warning: Browser close error (non-fatal): ${err.message}`);
  }
  
  console.log(`[Enricher] Browser closed. Done.`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
