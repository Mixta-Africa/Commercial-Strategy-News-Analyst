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

  // Launch the invisible Chrome browser
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const enrichedMap = new Map();

  for (const article of thin) {
    const page = await browser.newPage();
    
    // Disguise the browser as a normal human on a laptop
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    try {
      console.log(`[Enricher] Browser navigating to: ${article.url.substring(0, 80)}...`);
      
      // 'networkidle2' tells the browser to wait until the page fully stops loading resources.
      // This is the magic key that bypasses JS redirects and Cloudflare waiting screens!
      await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 25000 });

      const finalUrl = page.url();
      
      // Inject code directly into the browser to scrape the text off the screen
      const extractedText = await page.evaluate(() => {
        // Nuke ads, popups, and menus
        document.querySelectorAll('script, style, nav, header, footer, aside, iframe, noscript, form, .ad, .sidebar, .comments').forEach(el => el.remove());

        // Try to find the main article block
        const articleTag = document.querySelector('article');
        if (articleTag && articleTag.innerText.trim().length > 200) return articleTag.innerText.trim();

        // Try standard publisher containers
        const containers = ['.entry-content', '.post-content', '.article-body', '.article-content', 'main', '#main'];
        for (let selector of containers) {
          const el = document.querySelector(selector);
          if (el && el.innerText.trim().length > 200) return el.innerText.trim();
        }

        // Fallback: grab all paragraphs
        const pTags = Array.from(document.querySelectorAll('p')).map(p => p.innerText.trim()).filter(text => text.length > 20);
        if (pTags.length > 0) return pTags.join(' ');

        // Absolute fallback
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
