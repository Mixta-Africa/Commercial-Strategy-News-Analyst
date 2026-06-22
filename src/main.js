/**
 * Mixta Africa - Local Competitive Property Price Scraper
 * ===========================================================
 * Runs entirely on your machine via Docker. No Apify, no cloud proxy costs.
 * Uses your own residential internet connection, which these sites don't block.
 *
 * Philosophy: pull EVERYTHING raw. No price-band filtering at collection time.
 * Banding happens downstream (Sheets formulas / dashboard sliders), since
 * bands may be biased or need to evolve as you see real data distribution.
 *
 * Covers 4 sites via seed-and-crawl: category/search pages on all 4 sites are
 * JavaScript-rendered and invisible to this scraper (Cheerio reads static
 * HTML only). Single listing pages are static HTML and link to related
 * listings - that's how we discover more URLs without ever touching a
 * search page.
 *
 * OUTPUT:
 *   output/listings.json       - raw deduplicated listings, full detail
 *   output/dashboard-data.json - same data, dashboard-ready shape
 *   Plus: writes directly to Google Sheets if credentials are configured
 *         (see GOOGLE_SHEETS_CREDENTIALS_PATH and SPREADSHEET_ID below)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, 'output');
const TIMEOUT = 20000;
const REQUEST_DELAY_MS = 1500; // polite delay between requests, same site

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// NigerianPropertyCentre needs a relaxed SSL check (confirmed via diagnostic).
const https = require('https');
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// ─── CORRIDOR LOCATIONS ───────────────────────────────────────────────────────
// The Ibeju-Lekki corridor and surrounding areas Mixta actively tracks.
const CORRIDOR_LOCATIONS = [
  'Lekki', 'Ikoyi', 'Lakowe', 'Awoyaya', 'Ibeju-Lekki', 'Sangotedo', 'Ajah',
];

// Sub-locations / neighbourhoods within the corridor, confirmed real from
// actual site browsing (not guessed). These resolve to their PARENT corridor
// location for grouping purposes, but are recognised specifically so listings
// in e.g. "Ikate" or "Osapa" correctly map to "Lekki" instead of falling
// through to "Other Lagos".
const SUB_LOCATION_TO_CORRIDOR = {
  'ikate': 'Lekki', 'ologolo': 'Lekki', 'osapa': 'Lekki', 'agungi': 'Lekki',
  'chevron': 'Lekki', 'jakande': 'Lekki', 'idado': 'Lekki', 'abijo': 'Lekki',
  'vgc': 'Lekki', 'victoria-garden-city': 'Lekki', 'lekki-phase-1': 'Lekki',
  'lekki-phase-2': 'Lekki', 'lekki phase 1': 'Lekki', 'lekki phase 2': 'Lekki',
  'pinnock': 'Lekki', 'bogije': 'Awoyaya', 'epe': 'Ibeju-Lekki',
};

function normaliseLocationLabel(rawText) {
  if (!rawText) return 'Unspecified';
  const text = rawText.toLowerCase();

  // Check sub-locations first (more specific), mapping to their parent corridor.
  for (const [sub, parent] of Object.entries(SUB_LOCATION_TO_CORRIDOR)) {
    if (text.includes(sub)) return parent;
  }

  // Then check corridor locations directly.
  const matches = CORRIDOR_LOCATIONS.filter(loc => text.includes(loc.toLowerCase()));
  if (matches.length) {
    return matches.sort((a, b) => b.length - a.length)[0];
  }
  return 'Other Lagos';
}

function isCorridorLocation(locationLabel) {
  return CORRIDOR_LOCATIONS.includes(locationLabel);
}

// ─── SEED URLS ────────────────────────────────────────────────────────────────
// All URLs below were confirmed by direct browsing (not guessed patterns),
// covering PropertyPro's newer /in/{state}/{location}/{sub-area}/{bedrooms}
// URL scheme, NPC's location + estate-filtered search, and real Jiji listing
// pages across multiple corridor neighbourhoods.
const SEED_LISTINGS = [
  // --- PropertyPro: confirmed real bedroom + sub-area filtered URLs ---
  { site: 'PropertyPro', location: 'Lekki', url: 'https://propertypro.ng/property-for-sale/flat-apartment/in/lagos/lekki/ikate/1-bedroom' },
  { site: 'PropertyPro', location: 'Lekki', url: 'https://propertypro.ng/property-for-sale/flat-apartment/in/lagos/lekki/ologolo/1-bedroom' },
  { site: 'PropertyPro', location: 'Lekki', url: 'https://propertypro.ng/property-for-sale/in/lagos/lekki?e=Pinnock+Beach+Estate' },
  { site: 'PropertyPro', location: 'Lekki', url: 'https://propertypro.ng/property-for-sale/in/lagos/lekki?e=Chevy+View+Estate' },
  { site: 'PropertyPro', location: 'Ajah', url: 'https://propertypro.ng/property-for-sale/flat-apartment/mini-flat/in/lagos/ajah/1-bedroom' },
  { site: 'PropertyPro', location: 'Sangotedo', url: 'https://propertypro.ng/property-for-sale/flat-apartment/mini-flat/in/lagos/sangotedo/1-bedroom' },
  { site: 'PropertyPro', location: 'Lekki', url: 'https://propertypro.ng/property/1-bedroom-flat-apartment-for-sale-lekki-phase-1-lekki-lagos-8PTCR' }, // original confirmed seed
  { site: 'PropertyPro', location: 'Ikoyi', url: 'https://propertypro.ng/property/1-bedroom-flat-apartment-for-sale-parkview-estate-ikoyi-lagos-3NGXJ' },
  { site: 'PropertyPro', location: 'Ajah', url: 'https://propertypro.ng/property/1-bedroom-flat-apartment-for-sale-mobil-road-ilaje-ajah-lagos-7PMBT' },
  { site: 'PropertyPro', location: 'Sangotedo', url: 'https://propertypro.ng/property/1-bedroom-house-for-sale-sangotedo-ajah-lagos-1PDLV' },

  // --- PrivateProperty ---
  { site: 'PrivateProperty', location: 'Lekki', url: 'https://privateproperty.ng/listings/2-bedroom-terraced-duplex-for-sale-ajah-lekki-phase-2-lagos-6PDGXZ' },

  // --- NigerianPropertyCentre: confirmed real listing + mini-flats search URLs ---
  { site: 'NigerianPropertyCentre', location: 'Lekki', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki/showtype?bedrooms=1', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Lekki', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki/ologolo/3533771-luxury-spacious-brand-new-built-with-excellent-facilities', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Ibeju-Lekki', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki-ibeju/3274793-solid-uncompleted-mini-flat', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Awoyaya', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki-ibeju/bogije/3525242-15-units-of-a-room-and-parlour-flats', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Awoyaya', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki-ibeju/awoyaya/3509243-one-bedroom-apartments-off-plan', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Ibeju-Lekki', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/lekki-ibeju/3461053-massive-1-bedroom-in-a-serene-secured-environment', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Ibeju-Lekki', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/epe/3509759-newly-built-6-units-of-mini-flats', insecure: true },
  // NOTE: previous "Ikoyi" seed here was actually a Lekki Phase 1 listing
  // (mislabeled) - it was inflating Lekki's count under an Ikoyi tag-along
  // crawl. Replaced with a real, confirmed Ikoyi listing below.
  { site: 'NigerianPropertyCentre', location: 'Ikoyi', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/lagos/ikoyi/parkview/3533981-premium-mini-flat-apartment-room-parlour', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Ajah', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/lagos/ajah/ogombo/3386886-brand-new-1-bedroom-apartment', insecure: true },
  { site: 'NigerianPropertyCentre', location: 'Sangotedo', url: 'https://nigeriapropertycentre.com/for-sale/flats-apartments/mini-flats/lagos/ajah/sangotedo/3504605-lovely-1-bedroom-apartment-upstairs-in-a-serene-location', insecure: true },

  // --- Jiji: confirmed real listing pages across multiple sub-areas ---
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/ikate-elegushi/houses-apartments-for-sale/1bdrm-apartment-in-ikate-for-sale-uS9tbnlm9ULQGSZSQcGUPCt9.html' },
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/chevron/houses-apartments-for-sale/2bdrm-apartment-in-chevron-for-sale-pULgzy94yXJc4tzldKe8xgQj.html' },
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/lekki-phase/houses-apartments-for-sale/3bdrm-maisonette-in-lekki-phase-1-for-sale-uJO7gXtwHDJY7GQPXuD9b0Ut.html' },
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/lekki-phase-2/houses-apartments-for-sale/2bdrm-duplex-in-lekki-phase-2-for-sale-6cNs3YR0nJnBLIJmhiVt8ioH.html' },
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/ologolo/houses-apartments-for-sale/1bdrm-apartment-in-ologolo-for-sale-ljJAOfbb1gwkWwiDzgB1oXko.html' },
  { site: 'Jiji', location: 'Lekki', url: 'https://jiji.ng/lekki/houses-apartments-for-sale/2bdrm-block-of-flats-in-ikate-elegushi-lekki-for-sale-x2kTyqtKRTKbP7pXza5cqKSh.html' },
  { site: 'Jiji', location: 'Ikoyi', url: 'https://jiji.ng/parkview-estate/houses-apartments-for-sale/mini-flat-in-parkview-estate-for-sale-3xfKdNXSNf0LTE78lFeJ7tbL.html' },
  { site: 'Jiji', location: 'Ajah', url: 'https://jiji.ng/off-lekki-epe-expressway/houses-apartments-for-sale/1bdrm-apartment-in-ajah-off-lekki-epe-expressway-for-sale-2to9tvJ13nFtRWA5MsCS73Hj.html' },
  { site: 'Jiji', location: 'Sangotedo', url: 'https://jiji.ng/sangotedo/houses-apartments-for-sale/1bdrm-apartment-in-sangotedo-for-sale-BeeWMSgpNMzwlg6hgzlMAlYX.html' },
];

const MAX_LISTINGS_PER_SEED = 20;
const MAX_LISTINGS_PER_SITE = 80; // reserved for future per-site overall cap

// ─── AMENITY TAXONOMY ─────────────────────────────────────────────────────────
const AMENITY_PATTERNS = [
  { label: '24/7 Electricity',    patterns: ['24/7 electricity', '24hr electricity', 'constant electricity', 'prepaid meter', '24hrs light'] },
  { label: 'Standby Generator',   patterns: ['generator', 'power backup', 'diesel generator'] },
  { label: 'Solar Power',         patterns: ['solar'] },
  { label: 'Street Lights',       patterns: ['street light', 'streetlight'] },
  { label: 'Good Roads',          patterns: ['tarred road', 'good road', 'paved road', 'motorable', 'interlocked'] },
  { label: 'Drainage System',     patterns: ['drainage'] },
  { label: 'Borehole / Water',    patterns: ['borehole', 'water supply', 'treated water', 'running water'] },
  { label: 'Swimming Pool',       patterns: ['swimming pool', 'pool'] },
  { label: 'Gym / Fitness',       patterns: ['gym', 'fitness'] },
  { label: '24hr Security',       patterns: ['security', 'gated', 'guarded', 'cctv'] },
  { label: 'Parking',             patterns: ['parking', 'garage', 'car park'] },
  { label: 'Serviced',            patterns: ['serviced', 'fully serviced'] },
  { label: 'Estate',              patterns: ['estate', 'gated community'] },
  { label: "Boys' Quarters",      patterns: ["boys' quarters", "boy's quarter", "bq"] },
  { label: 'Smart Home',          patterns: ['smart home', 'automated'] },
  { label: 'Air Conditioning',    patterns: ['air condition', 'a/c'] },
  { label: 'Fitted Kitchen',      patterns: ['fitted kitchen', 'modern kitchen'] },
  { label: 'Balcony',             patterns: ['balcony'] },
  { label: 'Garden / Green Area', patterns: ['garden', 'green area', 'lawn'] },
  { label: 'Furnished',           patterns: ['fully furnished', 'furnished'] },
];

// NOTE: PRIORITY_LOCATIONS / isPriorityLocation replaced by
// normaliseLocationLabel() and isCorridorLocation() above, which give each
// listing its actual specific location instead of a binary priority flag.

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractPrice(text) {
  if (!text) return null;
  const t = text.replace(/,/g, '').trim();
  const m = t.match(/(\d{6,})/);
  if (m) {
    const val = parseFloat(m[1]);
    if (val >= 500000) return val;
  }
  return null;
}

function formatPrice(num) {
  if (!num) return 'N/A';
  if (num >= 1e9) return `NGN ${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `NGN ${(num / 1e6).toFixed(1)}M`;
  return `NGN ${num.toLocaleString()}`;
}

function extractBedrooms(text) {
  if (!text) return null;
  const patterns = [/(\d+)\s*bed(?:room)?s?/i, /(\d+)\s*br\b/i, /(\d+)-bed/i, /(\d+)Bed/, /Bedrooms:\s*(\d+)/i];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 10) return n;
    }
  }
  return null;
}

function bedroomLabel(n) {
  if (!n) return 'Unspecified';
  if (n >= 5) return '5+ Bedrooms';
  return `${n} Bedroom${n > 1 ? 's' : ''}`;
}

function extractAmenities(text) {
  const lower = (text || '').toLowerCase();
  return AMENITY_PATTERNS.filter(a => a.patterns.some(p => lower.includes(p))).map(a => a.label);
}

function resolvePropertyType(title) {
  const text = (title || '').toLowerCase();
  if (text.includes('flat') || text.includes('apartment')) return 'Apartment / Flat';
  if (text.includes('duplex') || text.includes('maisonette')) return 'Duplex';
  if (text.includes('bungalow')) return 'Bungalow';
  if (text.includes('terrace')) return 'Terraced House';
  if (text.includes('land') || text.includes('plot')) return 'Land / Plot';
  if (text.includes('house') || text.includes('detached')) return 'Detached House';
  return 'Residential';
}

/**
 * Returns true if a listing is for SALE (not rent/lease/shortlet).
 * Sites mix sale and rental listings in their "related properties" sections,
 * so this filter is applied to every extracted listing before it's accepted,
 * regardless of which site it came from.
 */
function isForSale(title, url) {
  const text = `${title || ''} ${url || ''}`.toLowerCase();

  // Explicit rental signals - reject these outright.
  const rentalSignals = [
    'for rent', 'for-rent', 'to let', 'to-let', 'shortlet', 'short let',
    'short-let', '/rent/', 'rental', '/year', '/yr', 'per annum', 'p.a.',
    '/month', 'monthly rent',
  ];
  if (rentalSignals.some(s => text.includes(s))) return false;

  // Explicit sale signals - accept these.
  const saleSignals = ['for sale', 'for-sale', '/sale/'];
  if (saleSignals.some(s => text.includes(s))) return true;

  // Ambiguous (neither signal present, e.g. some NPC/Jiji titles): accept by
  // default rather than silently dropping data, since most of our seed
  // categories are sale-only to begin with.
  return true;
}

function resolveAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try {
    const base = new URL(baseUrl);
    return href.startsWith('/') ? `${base.protocol}//${base.host}${href}` : `${base.protocol}//${base.host}/${href}`;
  } catch (e) {
    return null;
  }
}

/**
 * Extracts the realtor/agent/agency name from a listing page using several
 * common patterns seen across Nigerian real estate sites, tried in order.
 *
 * IMPORTANT CAVEAT: these selectors are best-guess patterns based on common
 * real-estate listing page conventions (agent name near "Posted by",
 * "Listed by", a profile/agent card, or a structured class name) - NOT
 * confirmed against live HTML from each of the 4 target sites the way the
 * price/bedroom selectors were. Run with DEBUG_EXTRACTORS=true and check
 * actual output before trusting this data in the dashboard; the selector
 * list will likely need real adjustment per site once you see what each
 * one actually returns (the same process used to fix price/location
 * extraction earlier).
 */
function extractRealtorName($) {
  const candidateSelectors = [
    '.agent-name', '.realtor-name', '.lister-name', '.poster-name',
    '.agency-name', '.seller-name', '.advertiser-name',
    '[class*="agent"] [class*="name"]',
    '[class*="poster"] [class*="name"]',
    '.profile-name', '.listing-agent', '.contact-name',
  ];

  for (const sel of candidateSelectors) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 1 && text.length < 100) return text;
  }

  // Pattern: text containing "Posted by" / "Listed by" / "By" followed by a name,
  // common on PropertyPro/PrivateProperty/NPC style sites.
  const bodyText = $('body').text();
  const byMatch = bodyText.match(/(?:Posted by|Listed by|Advertiser:|Agent:)\s*[:\-]?\s*([A-Z][a-zA-Z.&\s]{2,40}?)(?:\n|\||·|,|\s{2,})/);
  if (byMatch) return byMatch[1].trim();

  return null;
}

// ─── SITE-SPECIFIC EXTRACTORS (confirmed against real diagnostic HTML) ───────

function extractPropertyPro($, url) {
  const title = $('h1.page-heading').first().text().trim();
  if (!title) return null;

  const priceText = $('div.pricing').first().text() || $('h2').first().text();
  const priceValue = extractPrice(priceText);
  const prosText = $('div.property-pros').first().text();
  const bedrooms = extractBedrooms(prosText) || extractBedrooms(title);
  const bodyText = $('body').text();
  const amenities = extractAmenities(`${title} ${bodyText.substring(0, 5000)}`);

  const relatedLinks = [];
  const popularBlocks = $('div.popular-block');
  if (process.env.DEBUG_EXTRACTORS) {
    console.log(`    [DEBUG PropertyPro] found ${popularBlocks.length} div.popular-block elements`);
  }
  popularBlocks.each((i, el) => {
    const block = $(el);
    // Try multiple strategies: <a> wrapping the block, <a> inside the block,
    // or an <a> on a parent/ancestor element.
    let href = block.find('a[href*="/property/"]').first().attr('href');
    if (!href) href = block.closest('a[href*="/property/"]').attr('href');
    if (!href) href = block.parent().find('a[href*="/property/"]').first().attr('href');
    if (!href) href = block.find('a').first().attr('href');

    if (process.env.DEBUG_EXTRACTORS) {
      console.log(`    [DEBUG PropertyPro] block ${i}: href=${href || 'NONE FOUND'}`);
    }

    const absUrl = resolveAbsoluteUrl(href, url);
    if (absUrl && absUrl.includes('/property/')) relatedLinks.push(absUrl);
  });

  // Fallback: if popular-block strategy found nothing, scan the whole page
  // for any link matching the /property/...-slug-CODE pattern (PropertyPro's
  // listing URL format), excluding the current page's own URL.
  if (relatedLinks.length === 0) {
    if (process.env.DEBUG_EXTRACTORS) {
      console.log(`    [DEBUG PropertyPro] popular-block strategy found 0 links, trying page-wide fallback`);
    }
    $('a[href*="/property/"]').each((_, el) => {
      const href = $(el).attr('href');
      const absUrl = resolveAbsoluteUrl(href, url);
      if (absUrl && absUrl !== url && /\/property\/.+-[A-Z0-9]{4,8}$/i.test(absUrl)) {
        relatedLinks.push(absUrl);
      }
    });
  }

  // Location: the h1 is often generic ("1 Bedroom Apartment"), but the full
  // page <title> tag reliably carries the location (e.g. "Buy 1 Bedroom
  // Apartment in Lekki Phase 1, Lekki Lagos (8PTCR) | PropertyPro Nigeria").
  // Check title tag first, then h1 text, then fall back to scanning the
  // page body for any corridor location name as a last resort.
  const pageTitleTag = $('title').first().text().trim();
  let location = '';
  const titleLocMatch = pageTitleTag.match(/\bin\s+([A-Za-z0-9\s,]+?)\s*(?:\(|\||$)/);
  if (titleLocMatch) location = titleLocMatch[1].trim();
  if (!location) {
    const h1LocMatch = title.match(/in\s+([A-Za-z\s,]+?)(?:\s*\(|$)/);
    if (h1LocMatch) location = h1LocMatch[1].trim();
  }
  if (!location) {
    // Last resort: breadcrumb or address-style element, if present.
    const breadcrumbText = $('.breadcrumb, nav[aria-label="breadcrumb"]').first().text().trim();
    if (breadcrumbText) location = breadcrumbText;
  }

  return { title, priceValue, priceText: priceText.trim().substring(0, 60), bedrooms, amenities, location, realtorName: extractRealtorName($), relatedLinks: [...new Set(relatedLinks)] };
}

function extractPrivateProperty($, url) {
  const title = ($('h1').first().text() || $('h2').first().text()).trim();
  if (!title) return null;

  const priceText = $('p.price').first().text();
  const priceValue = extractPrice(priceText);
  const bedrooms = extractBedrooms(title);
  const bodyText = $('body').text();
  const amenities = extractAmenities(`${title} ${bodyText.substring(0, 5000)}`);

  const relatedLinks = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/listings/')) {
      const absUrl = resolveAbsoluteUrl(href, url);
      if (absUrl && absUrl !== url) relatedLinks.push(absUrl);
    }
  });

  const locationMatch = title.match(/(?:For sale|For rent):?\s*.*?\s+([A-Za-z]+(?:\s[A-Za-z]+)*)\s*$/i);
  const location = locationMatch ? locationMatch[1].trim() : '';

  return { title, priceValue, priceText: priceText.trim().substring(0, 60), bedrooms, amenities, location, realtorName: extractRealtorName($), relatedLinks: [...new Set(relatedLinks)] };
}

function extractNigerianPropertyCentre($, url) {
  const title = $('h1.page-title').first().text().trim();
  if (!title) return null;

  // NPC's "related listings" links sometimes lead to landing/category pages
  // (e.g. "Flats for Sale in Lekki, Lagos") rather than individual listings.
  // Real listing URLs carry a numeric ID segment (e.g. /3533351-1-bedroom...);
  // landing pages don't. Reject non-listing pages here so they don't get
  // counted as data, though their related links are still worth following.
  const isRealListing = /\/\d{5,}-/.test(url);

  const priceText = $('span.price').first().text();
  const priceValue = extractPrice(priceText);

  let bedrooms = null;
  $('tr, td, li').each((_, el) => {
    if (bedrooms) return;
    const text = $(el).text();
    if (/Bedrooms:\s*\d+/i.test(text)) bedrooms = extractBedrooms(text);
  });
  if (!bedrooms) bedrooms = extractBedrooms(title);

  const bodyText = $('body').text();
  const amenities = extractAmenities(`${title} ${bodyText.substring(0, 5000)}`);

  const relatedLinks = [];
  const contentTitles = $('h4.content-title');
  if (process.env.DEBUG_EXTRACTORS) {
    console.log(`    [DEBUG NPC] found ${contentTitles.length} h4.content-title elements`);
  }
  contentTitles.each((i, el) => {
    const heading = $(el);
    let link = heading.closest('a');
    if (!link.length) link = heading.parent().find('a').first();
    if (!link.length) link = heading.find('a').first();
    if (!link.length) link = heading.parent().parent().find('a').first(); // try grandparent too
    const href = link.attr('href');

    if (process.env.DEBUG_EXTRACTORS) {
      console.log(`    [DEBUG NPC] heading ${i}: href=${href || 'NONE FOUND'}`);
    }

    const absUrl = resolveAbsoluteUrl(href, url);
    if (absUrl && absUrl.includes('nigeriapropertycentre.com') && /\/\d{5,}-/.test(absUrl)) {
      relatedLinks.push(absUrl);
    }
  });

  // Fallback: page-wide scan for NPC's listing URL pattern (numeric ID + slug),
  // in case the targeted h4.content-title strategy isn't matching the real structure.
  if (relatedLinks.length === 0) {
    if (process.env.DEBUG_EXTRACTORS) {
      console.log(`    [DEBUG NPC] content-title strategy found 0 links, trying page-wide fallback`);
    }
    $('a[href*="nigeriapropertycentre.com"], a[href^="/for-sale/"]').each((_, el) => {
      const href = $(el).attr('href');
      const absUrl = resolveAbsoluteUrl(href, url);
      if (absUrl && absUrl !== url && /\/\d{5,}-/.test(absUrl)) {
        relatedLinks.push(absUrl);
      }
    });
  }

  const locParts = title.split(',').map(s => s.trim());
  const location = locParts.length > 1 ? locParts.slice(1, 3).join(', ').split('|')[0].trim() : '';

  return { title, priceValue, priceText: priceText.trim().substring(0, 60), bedrooms, amenities, location, realtorName: extractRealtorName($), relatedLinks: [...new Set(relatedLinks)], isRealListing };
}

function extractJiji($, url) {
  const pageTitle = $('title').first().text().trim();
  const descTitle = $('div.b-advert-icon-attribute').first().text().trim();
  const title = pageTitle.split(' - ')[0].trim() || descTitle;
  if (!title) return null;

  const priceText = $('span.qa-advert-price-view-value').first().text();
  const priceValue = extractPrice(priceText);

  let bedrooms = null;
  $('div.b-advert-icon-attribute').each((_, el) => {
    if (bedrooms) return;
    bedrooms = extractBedrooms($(el).text());
  });
  if (!bedrooms) bedrooms = extractBedrooms(title);

  const descText = $('div.qa-advert-description').first().text();
  const amenities = extractAmenities(`${title} ${descText}`);

  const relatedLinks = [];
  $('a[href*=".html"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    // Exclude social share buttons, mailto, and external utility links -
    // these technically contain ".html" in tracking params but aren't listings.
    if (href.includes('facebook.com') || href.includes('twitter.com') ||
        href.includes('whatsapp.com') || href.startsWith('mailto:') ||
        href.includes('wa.me')) {
      return;
    }
    const absUrl = resolveAbsoluteUrl(href, url);
    if (absUrl && absUrl !== url && absUrl.includes('jiji.ng') && absUrl.includes('-for-sale')) {
      relatedLinks.push(absUrl.split('?')[0]);
    }
  });

  const breadcrumb = $('li.b-breadcrumb-inner').last().text().trim();
  const location = breadcrumb && !breadcrumb.toLowerCase().includes('bedroom') ? breadcrumb : '';

  return { title, priceValue, priceText: priceText.trim().substring(0, 60), bedrooms, amenities, location, realtorName: extractRealtorName($), relatedLinks: [...new Set(relatedLinks)].slice(0, 10) };
}

const SITE_EXTRACTORS = {
  PropertyPro: extractPropertyPro,
  PrivateProperty: extractPrivateProperty,
  NigerianPropertyCentre: extractNigerianPropertyCentre,
  Jiji: extractJiji,
};

// ─── CRAWL ENGINE (plain Node, manual queue, no Apify SDK) ───────────────────

/**
 * FIX (confirmed against documented axios behaviour, not a guess): axios's
 * own `timeout` option only bounds the time to receive the FIRST byte of a
 * response. If a server accepts the connection, sends a few bytes, then
 * goes idle without closing the socket, axios will wait forever - the
 * configured timeout never fires. This is exactly the failure mode behind
 * the crawl going silent for a long stretch despite a 20s timeout being
 * set: most failures (500s, real socket hang-ups) were already being
 * caught correctly, but one request stalling mid-stream on a flaky
 * Nigerian property site blocked the whole crawl loop indefinitely on a
 * single `await`.
 *
 * The fix wraps the fetch in a Promise.race against an independent
 * wall-clock timer that doesn't depend on axios's socket-level timeout at
 * all - if the real fetch hasn't resolved within FETCH_HARD_TIMEOUT_MS,
 * the race rejects on its own and the crawl moves on regardless of what
 * the underlying socket is doing.
 */
const FETCH_HARD_TIMEOUT_MS = 25000; // slightly above axios's own TIMEOUT, so axios gets first chance to fail cleanly with a real error message; this is the backstop for when it can't.

function fetchWithHardTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Hard timeout after ${ms / 1000}s (stalled mid-response, not a clean HTTP error) - ${label}`)), ms)
    ),
  ]);
}

async function fetchPage(url, insecure) {
  const fetchPromise = axios.get(url, {
    headers: HEADERS,
    timeout: TIMEOUT,
    httpsAgent: insecure ? insecureAgent : undefined,
    validateStatus: (status) => status < 500, // let us see 403s etc rather than throwing
  });

  const res = await fetchWithHardTimeout(fetchPromise, FETCH_HARD_TIMEOUT_MS, url);
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return res.data;
}

// Per-location cap, SHARED across all seeds/sites in a single run. Without
// this, Lekki's much richer related-link networks let it keep growing while
// thinner locations (Ikoyi, Ajah, Sangotedo) stall after their seed's direct
// links run out - the result is a Lekki-dominated dataset even with deliberate
// per-location seeding. This caps total listings per resolved location across
// the whole run, so once a location is "full" further finds are skipped
// (their related links are still followed, in case they lead to a DIFFERENT
// under-represented location).
const MAX_LISTINGS_PER_LOCATION_TOTAL = 15;

// Safety-net backstop, independent of the location cap above. Without this,
// a seed whose related-link network is large and self-referential (e.g. a
// dense Lekki listing network) can keep the crawl loop alive for many
// minutes even after its location has long since hit MAX_LISTINGS_PER_LOCATION_TOTAL,
// because relatedLinks were being queued unconditionally regardless of
// whether the location had room left. Confirmed in a real run: Lekki hit
// 35/35 (the old cap) at the 1-minute mark, then queued lekki-adjacent
// related links non-stop for 7+ more minutes, never accepting another
// listing, just churning fetches. The fix below stops queuing related links
// once a listing's resolved location is already full (the real root cause),
// and this constant is the hard backstop underneath that fix, in case some
// other combination of seed/location produces similar runaway growth.
const MAX_FETCHES_PER_SEED = 40;

async function crawlSite(seed, allListings, visitedUrls, locationCounts) {
  const { site, insecure, location: seedLocationHint } = seed;
  const queue = [seed.url];
  let count = 0;
  let fetchCount = 0;

  console.log(`\n[${site} / ${seedLocationHint}] Starting crawl from seed: ${seed.url}`);

  // If the seed URL itself 404s (unverified location-search URL pattern),
  // log it plainly and bail out of this seed gracefully rather than crashing
  // the whole site's crawl - the other seeds for this site still run.
  try {
    await fetchPage(seed.url, insecure);
  } catch (err) {
    console.log(`  [${site} / ${seedLocationHint}] SEED UNREACHABLE (${err.message}) - skipping this location for this site.`);
    return;
  }

  while (queue.length > 0 && count < MAX_LISTINGS_PER_SEED && fetchCount < MAX_FETCHES_PER_SEED) {
    const url = queue.shift();
    if (visitedUrls.has(url)) continue;
    visitedUrls.add(url);
    fetchCount++;

    try {
      console.log(`  [${site} / ${seedLocationHint}] fetching: ${url}`);
      const html = await fetchPage(url, insecure);
      const $ = cheerio.load(html);
      const extractor = SITE_EXTRACTORS[site];
      const data = extractor($, url);

      if (!data || !data.title) {
        console.log(`  [${site} / ${seedLocationHint}] No listing data at ${url} (skip)`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      // Determine the listing's actual location up front (moved earlier than
      // before): prefer text extracted from the page itself (title/breadcrumb),
      // fall back to the seed's location hint if extraction came up empty or
      // unrecognised. This now runs BEFORE related-link queuing so we know
      // whether this location still has room before deciding how much further
      // to explore from this page.
      const extractedLocation = normaliseLocationLabel(data.title) !== 'Other Lagos'
        ? normaliseLocationLabel(data.title)
        : normaliseLocationLabel(data.location);
      const finalLocation = extractedLocation !== 'Other Lagos' ? extractedLocation : seedLocationHint;
      const corridor = isCorridorLocation(finalLocation);
      const locationHasRoom = (locationCounts[finalLocation] || 0) < MAX_LISTINGS_PER_LOCATION_TOTAL;

      // Queue related links ONLY if this location still has room. This is the
      // actual fix for the runaway-crawl bug: previously links were queued
      // unconditionally, so once a location filled up, every further page
      // resolving to that (now-full) location kept re-feeding the queue with
      // more of the same location's related links, and the while loop never
      // ran dry - confirmed in a real run where Lekki sat frozen at its cap
      // for 7+ minutes while fetches never stopped. A capped location's
      // related links are dropped here; an UNCAPPED location's links are
      // still queued as before, since those may lead to other locations.
      if (locationHasRoom) {
        for (const link of data.relatedLinks.slice(0, 8)) {
          if (!visitedUrls.has(link) && !queue.includes(link)) queue.push(link);
        }
      }

      // Some sites (NPC) flag landing/category pages discovered via the
      // crawl as not-a-real-listing. Their related links were already queued
      // above (if the location had room), but the page itself isn't counted
      // as data - this is what was causing generic titles like "Flats for
      // Sale in Lekki, Lagos" to pollute results with empty prices and no
      // location.
      if (data.isRealListing === false) {
        console.log(`  [${site} / ${seedLocationHint}] Landing page, not a listing (following its links): "${data.title.substring(0, 50)}"`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      if (!isForSale(data.title, url)) {
        console.log(`  [${site} / ${seedLocationHint}] Skipping (for rent, not sale): "${data.title.substring(0, 50)}"`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const propertyType = resolvePropertyType(data.title);

      // Shared per-location cap: once a location has enough listings across
      // the WHOLE run (not just this seed), stop counting more for it. Its
      // related links are no longer queued either (see above), so a full
      // location now genuinely stops generating further work for itself.
      const currentLocationCount = locationCounts[finalLocation] || 0;
      if (currentLocationCount >= MAX_LISTINGS_PER_LOCATION_TOTAL) {
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      count++;
      locationCounts[finalLocation] = currentLocationCount + 1;

      allListings.push({
        source: site,
        propertyType,
        bedrooms: data.bedrooms,
        bedroomLabel: bedroomLabel(data.bedrooms),
        location: finalLocation,
        corridorBucket: corridor ? 'Ibeju-Lekki Corridor' : 'Other Lagos',
        rawLocationText: data.location || '',
        title: data.title,
        priceValue: data.priceValue,
        priceFormatted: formatPrice(data.priceValue),
        amenities: data.amenities,
        amenitiesText: data.amenities.join(', '),
        realtorName: data.realtorName || 'Not listed',
        listingUrl: url,
        scrapedAt: new Date().toISOString(),
      });

      if (process.env.DEBUG_EXTRACTORS && !data.realtorName) {
        console.log(`    [DEBUG] No realtor name found for ${site} listing: ${url}`);
      }

      console.log(`  [${site} / ${finalLocation}] [${count}/${MAX_LISTINGS_PER_SEED}] (loc total: ${locationCounts[finalLocation]}/${MAX_LISTINGS_PER_LOCATION_TOTAL}) "${data.title.substring(0, 50)}" | ${formatPrice(data.priceValue)} | ${data.bedrooms || '?'} bed`);
    } catch (err) {
      console.log(`  [${site} / ${seedLocationHint}] FAILED ${url}: ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[${site} / ${seedLocationHint}] Done. ${count} listings collected.`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

/**
 * HEARTBEAT: prints a status line every HEARTBEAT_INTERVAL_MS regardless of
 * what any individual site/request is doing. This exists because a single
 * slow location (e.g. a run of 500s or near-timeout requests on one site)
 * can produce several minutes of silence on screen even though the crawl is
 * still alive - the previous output gave no way to distinguish "still
 * working, just on a slow stretch" from "actually stuck", short of staring
 * at the screen and judging whether the last line looks "fresh". This makes
 * that distinction explicit and automatic: if the heartbeat line itself
 * stops appearing, THAT is the real "it's frozen" signal, not silence
 * between scrape log lines.
 */
const HEARTBEAT_INTERVAL_MS = 30000;

function startHeartbeat(allListings, locationCounts, startTime) {
  return setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const elapsedLabel = elapsedSec >= 60
      ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
      : `${elapsedSec}s`;
    const locSummary = Object.entries(locationCounts)
      .map(([loc, n]) => `${loc}:${n}`)
      .join(', ') || 'none yet';
    console.log(`[heartbeat] alive @ ${elapsedLabel} - ${allListings.length} listings collected so far - by location: ${locSummary}`);
  }, HEARTBEAT_INTERVAL_MS);
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log('=== Mixta Africa Local Property Scraper ===');
  console.log(`Output folder: ${OUTPUT_DIR}\n`);

  const allListings = [];
  const visitedUrls = new Set();
  const locationCounts = {}; // shared across all seeds/sites - enforces the per-location cap

  const startTime = Date.now();
  const heartbeatTimer = startHeartbeat(allListings, locationCounts, startTime);

  // Run seeds with light concurrency (3 at a time) to avoid overwhelming any
  // single site. With 15 location-specific seeds now (vs 4 site-level seeds
  // before), this keeps total runtime reasonable while staying polite.
  const SEED_CONCURRENCY = 3;
  for (let i = 0; i < SEED_LISTINGS.length; i += SEED_CONCURRENCY) {
    const batch = SEED_LISTINGS.slice(i, i + SEED_CONCURRENCY);
    await Promise.all(batch.map(seed => crawlSite(seed, allListings, visitedUrls, locationCounts)));
  }

  clearInterval(heartbeatTimer);
  const totalElapsedSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[heartbeat] crawl phase finished after ${Math.floor(totalElapsedSec / 60)}m ${totalElapsedSec % 60}s.`);

  // Deduplicate by URL.
  const seen = new Set();
  const deduped = allListings.filter(l => {
    if (seen.has(l.listingUrl)) return false;
    seen.add(l.listingUrl);
    return true;
  });

  const bySite = {};
  const byLocation = {};
  const byCorridor = {};
  for (const l of deduped) {
    bySite[l.source] = (bySite[l.source] || 0) + 1;
    byLocation[l.location] = (byLocation[l.location] || 0) + 1;
    byCorridor[l.corridorBucket] = (byCorridor[l.corridorBucket] || 0) + 1;
  }

  console.log(`\n=== SCRAPE COMPLETE ===`);
  console.log(`Total unique listings: ${deduped.length}`);
  console.log(`Per-site breakdown: ${JSON.stringify(bySite, null, 2)}`);
  console.log(`Per-location breakdown: ${JSON.stringify(byLocation, null, 2)}`);
  console.log(`Corridor vs Other: ${JSON.stringify(byCorridor, null, 2)}`);

  // Write raw listings JSON.
  const listingsPath = path.join(OUTPUT_DIR, 'listings.json');
  fs.writeFileSync(listingsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { total: deduped.length, bySite, byLocation, byCorridor },
    listings: deduped,
  }, null, 2));
  console.log(`\nWrote: output/listings.json`);

  // Write dashboard-ready JSON (same data, dashboard-friendly top-level shape).
  const dashboardPath = path.join(OUTPUT_DIR, 'dashboard-data.json');
  fs.writeFileSync(dashboardPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { total: deduped.length, bySite, byLocation, byCorridor },
    listings: deduped,
  }, null, 2));
  console.log(`Wrote: output/dashboard-data.json`);

  // ─── AUTO-COMMIT TO GITHUB ──────────────────────────────────────────────────
  await commitToGitHub();

  console.log('\nNext step: run write-to-sheets.js to push this data to Google Sheets.');
}

/**
 * Commits output/listings.json and output/dashboard-data.json to the
 * configured GitHub repo, so the dashboard picks up fresh data automatically.
 * Requires GITHUB_REPO_PATH, GITHUB_TOKEN, GITHUB_REPO_URL env vars (see
 * the setup instructions in README / chat). Non-fatal: if git isn't
 * configured, this logs a warning and the script still exits successfully -
 * the local JSON files are still written either way.
 */
async function commitToGitHub() {
  const { execSync } = require('child_process');

  const repoPath = process.env.GITHUB_REPO_PATH;
  const token = process.env.GITHUB_TOKEN;
  const repoUrl = process.env.GITHUB_REPO_URL; // e.g. https://github.com/Mixta-Africa/Commercial-Strategy-News-Analyst.git

  if (!repoPath || !token || !repoUrl) {
    console.log('\n[GitHub] GITHUB_REPO_PATH / GITHUB_TOKEN / GITHUB_REPO_URL not set - skipping auto-commit.');
    console.log('[GitHub] Data is still saved locally in output/. See setup instructions to enable auto-push.');
    return;
  }

  // Defensive: trim any accidental whitespace/newlines picked up when the
  // token was copy-pasted into a .bat file or env var on Windows. A trailing
  // space here corrupts every git command that embeds the token.
  const cleanToken = token.trim();

  try {
    console.log('\n[GitHub] Committing scraped data...');

    const dataDir = path.join(repoPath, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    // FIX: the previous version just copyFileSync'd today's dashboard-data.json
    // directly over competitive-listings.json, replacing the entire file with
    // only today's scrape run. This meant the price trend chart in the dashboard
    // always had exactly one day of data regardless of how many days the scraper
    // had run - confirmed by the dashboard showing a single data point. The fix
    // mirrors the articles.json merge pattern in the news pipeline: read existing
    // history, merge today's new listings in (preserving their scrapedAt dates),
    // dedup within each calendar day by title+location+bedrooms (so the same
    // property scraped twice in one day only appears once, but the same property
    // appearing on different days is kept - that IS the trend signal), then write
    // the combined accumulated set. History is retained for 365 days.

    const historyPath = path.join(dataDir, 'competitive-listings.json');
    let existingListings = [];
    try {
      const raw = fs.readFileSync(historyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.listings)) {
        existingListings = parsed.listings;
        console.log(`[GitHub] Loaded ${existingListings.length} existing historical listings for merge.`);
      }
    } catch (e) {
      console.log('[GitHub] No existing competitive-listings.json found - starting fresh history.');
    }

    // Read today's fresh scraped data
    const todayData = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'dashboard-data.json'), 'utf-8'));
    const todayListings = todayData.listings || [];

    // Dedup key: title + location + bedrooms (same key used in write-to-sheets
    // price-change detection, and stable across scrape runs for the same home).
    // Within a calendar day, if we see the same property twice, keep only one.
    // Across different days, keep all occurrences - that's the trend data.
    const dedupKey = l =>
      `${(l.title || '').toLowerCase().trim()}||${(l.location || '').toLowerCase().trim()}||${(l.bedroomLabel || '').toLowerCase().trim()}`;

    const todayDateStr = new Date().toISOString().slice(0, 10);

    // Remove today's date from existing history (idempotent: a second scrape
    // run today replaces today's entries, not duplicates them)
    const priorHistory = existingListings.filter(l => {
      const d = l.scrapedAt ? l.scrapedAt.slice(0, 10) : '';
      return d !== todayDateStr;
    });

    // Dedup today's listings within the day
    const todayDedupMap = new Map();
    for (const l of todayListings) {
      const k = dedupKey(l);
      if (!todayDedupMap.has(k)) {
        todayDedupMap.set(k, { ...l, scrapedAt: l.scrapedAt || new Date().toISOString() });
      }
    }
    const todayDeduped = [...todayDedupMap.values()];

    // Merge and apply 365-day rolling window
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 365);
    const mergedListings = [...priorHistory, ...todayDeduped]
      .filter(l => !l.scrapedAt || new Date(l.scrapedAt) >= cutoff);

    console.log(`[GitHub] Merged: ${priorHistory.length} prior + ${todayDeduped.length} today = ${mergedListings.length} total (365-day window).`);

    // Build the accumulated file with updated summary reflecting full history
    const accumulated = {
      generatedAt: new Date().toISOString(),
      summary: {
        total: mergedListings.length,
        today: todayDeduped.length,
        historyDays: [...new Set(mergedListings.map(l => (l.scrapedAt || '').slice(0, 10)).filter(Boolean))].length,
        bySite: todayData.summary?.bySite || {},
        byLocation: todayData.summary?.byLocation || {},
        byCorridor: todayData.summary?.byCorridor || {},
      },
      listings: mergedListings,
    };

    fs.writeFileSync(historyPath, JSON.stringify(accumulated, null, 2));
    console.log(`[GitHub] Wrote accumulated competitive-listings.json (${mergedListings.length} listings across ${accumulated.summary.historyDays} days).`);

    const { execFileSync } = require('child_process');

    // execFileSync takes args as an ARRAY, not a single interpolated string -
    // this avoids all shell quoting/escaping issues with the token entirely,
    // which is what caused the malformed-URL error (a string-interpolated
    // command can pick up stray whitespace or get mis-split by the shell;
    // an argument array cannot).
    const git = (args) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' }).toString().trim();

    git(['config', '--local', 'user.email', 'local-scraper@mixtafrica.com']);
    git(['config', '--local', 'user.name', 'Local Property Scraper']);
    git(['add', 'data/competitive-listings.json']);

    const staged = git(['diff', '--staged', '--name-only']);
    if (!staged) {
      console.log('[GitHub] No changes to commit (data unchanged since last run).');
      return;
    }

    git(['commit', '-m', `Update competitive listings data [auto] ${new Date().toISOString()}`]);

    // Use a credential header instead of embedding the token in the remote
    // URL - one fewer place for the token to get mangled by string ops.
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${cleanToken}`).toString('base64')}`;

    let pushed = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        git(['-c', `http.extraheader=${authHeader}`, 'push', repoUrl, 'HEAD:main']);
        pushed = true;
        console.log(`[GitHub] Push succeeded on attempt ${attempt}.`);
        break;
      } catch (pushErr) {
        console.log(`[GitHub] Push rejected (attempt ${attempt}) - re-fetching and retrying...`);
        // Always show the real error - a silent "rejected" with no detail
        // across 5 attempts gives nothing to diagnose. execFileSync errors
        // carry stderr in .stderr (Buffer) as well as .message; show both.
        console.log(`[GitHub]   Reason: ${pushErr.message}`);
        if (pushErr.stderr) {
          console.log(`[GitHub]   stderr: ${pushErr.stderr.toString().trim()}`);
        }

        const snapshotPath = path.join(OUTPUT_DIR, '_temp_competitive-listings.json');
        fs.copyFileSync(path.join(dataDir, 'competitive-listings.json'), snapshotPath);

        git(['-c', `http.extraheader=${authHeader}`, 'fetch', repoUrl, 'main']);

        // Small settle delay before reset - on Windows (especially over a
        // Docker volume mount), a git process can hold the ref lock for a
        // few ms after returning, and an immediate next git call can hit
        // "cannot lock ref 'HEAD'" as a result. This isn't a logic race in
        // our retry loop - it's filesystem/lock-release latency.
        await sleep(500);

        // Retry the reset itself up to 3 times if it hits a lock error,
        // since that's the operation most likely to collide with a
        // still-releasing lock from the fetch that just completed.
        let resetOk = false;
        for (let lockAttempt = 1; lockAttempt <= 3; lockAttempt++) {
          try {
            git(['reset', '--hard', 'FETCH_HEAD']);
            resetOk = true;
            break;
          } catch (resetErr) {
            if (/cannot lock ref/i.test(resetErr.message) && lockAttempt < 3) {
              console.log(`[GitHub] Ref lock contention on reset (sub-attempt ${lockAttempt}) - waiting and retrying...`);
              await sleep(800);
              continue;
            }
            throw resetErr;
          }
        }
        if (!resetOk) throw new Error('Could not reset after repeated ref lock contention');

        fs.copyFileSync(snapshotPath, path.join(dataDir, 'competitive-listings.json'));
        fs.unlinkSync(snapshotPath);

        git(['add', 'data/competitive-listings.json']);
        const stillStaged = git(['diff', '--staged', '--name-only']);
        if (!stillStaged) {
          console.log('[GitHub] Data already matches remote after reset - nothing left to push.');
          pushed = true;
          break;
        }

        await sleep(300); // settle before commit, same rationale as above

        // Retry the commit itself if it hits a lock error too.
        let commitOk = false;
        for (let lockAttempt = 1; lockAttempt <= 3; lockAttempt++) {
          try {
            git(['commit', '-m', `Update competitive listings data [auto retry] ${new Date().toISOString()}`, '--allow-empty']);
            commitOk = true;
            break;
          } catch (commitErr) {
            if (/cannot lock ref/i.test(commitErr.message) && lockAttempt < 3) {
              console.log(`[GitHub] Ref lock contention on commit (sub-attempt ${lockAttempt}) - waiting and retrying...`);
              await sleep(800);
              continue;
            }
            throw commitErr;
          }
        }
        if (!commitOk) throw new Error('Could not commit after repeated ref lock contention');

        await sleep(300); // settle before the next push attempt
      }
    }

    if (!pushed) {
      console.error('[GitHub] Push failed after 5 attempts. Data is saved locally but not pushed.');
    }
  } catch (err) {
    console.error('[GitHub] Auto-commit failed:', err.message);
    if (err.stderr) {
      console.error('[GitHub] stderr:', err.stderr.toString().trim());
    }
    console.log('[GitHub] Data is still saved locally in output/ - this failure does not affect the scrape.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
