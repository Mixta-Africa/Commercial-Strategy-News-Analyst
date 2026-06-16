/**
 * Content Enricher v3 — Headless Browser Edition
 *
 * Following your brilliant intuition, this acts as the "extra step".
 * Instead of a dumb HTTP request, this opens a literal, invisible Chrome browser.
 * It automatically executes Google's JS redirects and waits out Cloudflare's
 * "Checking your browser" human-verification screens before scraping the text.
 */

const puppeteer = require('puppeteer');

const THIN_THRESHOLD = 200;
const MAX_EXTRACT = 3000;

function cleanContent(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

function usableLength(article) {
  const raw = article.content || article.description || '';
  return cleanContent(raw).length;
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

  for (const article of thin) {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
      console.log(`[Enricher] Browser navigating to: ${article.url.substring(0, 80)}...`);
      
      // Load the page
      await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      
      // FIX 2: Wait 3.5 seconds unconditionally to allow Google News JS redirects 
      // and Cloudflare checks to finish executing before we scrape.
      await new Promise(r => setTimeout(r, 3500));

      const finalUrl = page.url();
      
      const extractedText = await page.evaluate(() => {
        // FIX 1: Safety check in case the publisher returns a broken page with no body
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
        console.log(`[Enricher] SUCCESS: Grabbed ${cleanText.length} chars from ${finalUrl.substring(0, 60)}`);
        enrichedMap.set(article.url, {
          ...article,
          content: cleanText,
          resolvedUrl: finalUrl,
          contentEnriched: true
        });
      } else {
        console.log(`[Enricher] FAILED: Page rendered but no text found for ${article.title.substring(0, 40)}`);
        enrichedMap.set(article.url, { ...article, contentEnriched: false });
      }
    } catch (err) {
      console.error(`[Enricher] FAILED: Browser error on ${article.title.substring(0, 40)} - ${err.message}`);
      enrichedMap.set(article.url, { ...article, contentEnriched: false });
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log(`[Enricher] Browser closed. Done.`);

  return articles.map(a => enrichedMap.has(a.url) ? enrichedMap.get(a.url) : a);
}

module.exports = { enrichArticles, usableLength, cleanContent };
