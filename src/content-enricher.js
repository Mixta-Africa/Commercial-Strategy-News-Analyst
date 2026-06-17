/**
 * Content Enricher v4.0 — One Browser Per Article
 *
 * ROOT CAUSE FIX: The GitHub Actions Chromium child process is killed by the
 * OS mid-batch (memory pressure, OOM killer, resource limits). Retrying on
 * the same dead browser instance never works. The only reliable fix is to
 * spawn a fresh browser for EVERY article. If one browser dies, only that
 * article is affected — the batch continues.
 *
 * Architecture change from v3.x:
 *   BEFORE: 1 browser → N pages (cascade failure when browser dies)
 *   AFTER:  N browsers → 1 page each (isolated, disposable, crash-safe)
 */

const puppeteer = require('puppeteer');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT = 3000;
const PAGE_TIMEOUT = 25000;
const CLOUDFLARE_WAIT = 3500;
const BETWEEN_ARTICLES_DELAY = 1500; // Give OS time to reclaim memory between launches

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
}

/**
 * Safely close browser without throwing if already dead.
 */
async function safeBrowserClose(browser) {
  try {
    if (browser) await browser.close();
  } catch (_) {
    // Already dead — that's fine, we're isolating anyway
  }
}

/**
 * Extract article text using a fully isolated browser instance.
 * Returns enriched article object on success, original article on failure.
 */
async function enrichSingleArticle(article) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',           // Key: prevents child process spawning that OOM-kills
        '--memory-pressure-off',
        '--max_old_space_size=256'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Block heavyweight assets — we only need text, not images/fonts/video
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet', 'websocket', 'manifest'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`[Enricher] Navigating: ${article.url.substring(0, 80)}...`);
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, CLOUDFLARE_WAIT));

    const finalUrl = page.url();

    const extractedText = await page.evaluate(() => {
      if (!document.body) return '';

      document.querySelectorAll('script, style, nav, header, footer, aside, iframe, noscript, form, .ad, .sidebar, .comments').forEach(el => el.remove());

      const articleTag = document.querySelector('article');
      if (articleTag && articleTag.innerText.trim().length > 200) return articleTag.innerText.trim();

      const containers = ['.entry-content', '.post-content', '.article-body', '.article-content', 'main', '#main'];
      for (const selector of containers) {
        const el = document.querySelector(selector);
        if (el && el.innerText.trim().length > 200) return el.innerText.trim();
      }

      const pTags = Array.from(document.querySelectorAll('p'))
        .map(p => p.innerText.trim())
        .filter(text => text.length > 20);
      if (pTags.length > 0) return pTags.join(' ');

      return document.body.innerText.trim();
    });

    const cleanText = cleanContent(extractedText).substring(0, MAX_EXTRACT);

    if (cleanText.length > 150) {
      console.log(`[Enricher] SUCCESS: ${cleanText.length} chars from ${finalUrl.substring(0, 60)}`);
      await safeBrowserClose(browser);
      return { ...article, content: cleanText, resolvedUrl: finalUrl, contentEnriched: true };
    } else {
      console.log(`[Enricher] THIN: No usable text found for "${article.title.substring(0, 40)}"`);
      await safeBrowserClose(browser);
      return { ...article, contentEnriched: false };
    }

  } catch (err) {
    console.error(`[Enricher] FAILED: "${article.title.substring(0, 40)}" — ${err.message.split('\n')[0]}`);
    await safeBrowserClose(browser);
    return { ...article, contentEnriched: false };
  }
}

async function enrichArticles(articles) {
  const thin = articles.filter(a => usableLength(a) < THIN_THRESHOLD);
  const already = articles.filter(a => usableLength(a) >= THIN_THRESHOLD);

  if (thin.length === 0) return articles;

  console.log(`[Enricher] ${already.length} articles OK, ${thin.length} need enrichment`);

  const enrichedMap = new Map();

  for (let i = 0; i < thin.length; i++) {
    const article = thin[i];
    const result = await enrichSingleArticle(article);
    enrichedMap.set(article.url, result);

    // Give the OS time to reclaim memory before next browser launch
    if (i < thin.length - 1) {
      await new Promise(r => setTimeout(r, BETWEEN_ARTICLES_DELAY));
    }
  }

  console.log(`[Enricher] Done. ${[...enrichedMap.values()].filter(a => a.contentEnriched).length}/${thin.length} enriched.`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
