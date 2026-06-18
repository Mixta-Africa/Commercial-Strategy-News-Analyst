/**
 * Competitive Intelligence Config
 * ================================
 * Two layers:
 *   1. HARDCODED DEFAULTS — always active, maintained here in code.
 *   2. USER_EXTENSIONS    — edit the bottom of this file freely without
 *                           touching any pipeline logic.
 *
 * To add a competitor: push to USER_EXTENSIONS.competitors
 * To add a listing site: push to USER_EXTENSIONS.listingSites
 * To add a watchlist term: push to USER_EXTENSIONS.watchlist
 */

// ─── LAYER 1: HARDCODED DEFAULTS ─────────────────────────────────────────────

const DEFAULTS = {

  /**
   * Competitor definitions.
   * news: Google News RSS queries to monitor press coverage.
   * domain: used to filter/label scraped results.
   * listingUrl: their property listings page (null if not applicable).
   */
  competitors: [
    {
      name: 'Adron Homes',
      domain: 'adronhomesproperties.com',
      newsQuery: 'Adron Homes Nigeria real estate',
      listingUrl: 'https://adronhomesproperties.com/properties',
    },
    {
      name: 'Propertymart',
      domain: 'propertymart.ng',
      newsQuery: 'Propertymart Nigeria Lagos real estate',
      listingUrl: 'https://propertymart.ng/properties',
    },
    {
      name: 'Revolutionplus',
      domain: 'revolutionplus.ng',
      newsQuery: 'Revolutionplus Property Nigeria',
      listingUrl: 'https://revolutionplus.ng/buy',
    },
    {
      name: 'Pwan Group',
      domain: 'pwangroup.com',
      newsQuery: 'Pwan Group Nigeria real estate',
      listingUrl: 'https://pwangroup.com/properties',
    },
    {
      name: 'Landwey Investment',
      domain: 'landwey.com',
      newsQuery: 'Landwey Investment Lagos property',
      listingUrl: 'https://landwey.com/properties',
    },
    {
      name: 'Jide Taiwo & Co',
      domain: 'jide-taiwo.com',
      newsQuery: 'Jide Taiwo Co Lagos real estate',
      listingUrl: null,
    },
    {
      name: 'Finelib',
      domain: 'finelib.com',
      newsQuery: 'Finelib Nigeria property',
      listingUrl: null,
    },
  ],

  /**
   * Property listing marketplaces, ranked by data authenticity/reliability.
   * Rank 1 = most authentic (agent-verified, high listing volume, price accuracy).
   *
   * priceSelector: CSS selector for price elements on search results pages.
   * titleSelector: CSS selector for listing title/name.
   * locationSelector: CSS selector for location text.
   * searchUrl: URL template — {TYPE} replaced with property type slug.
   * propertyTypes: the types to cycle through on each run.
   */
  listingSites: [
    {
      rank: 1,
      name: 'PropertyPro',
      domain: 'propertypro.ng',
      authenticity: 'highest — largest verified Nigerian listing database, agent-certified',
      searchUrl: 'https://www.propertypro.ng/property-for-sale/lagos?type={TYPE}',
      propertyTypes: ['flat', 'house', 'land', 'duplex', 'bungalow', 'terraced-house', 'semi-detached'],
      titleSelector: '.listings-property-title, h3.price-title',
      priceSelector: '.listings-property-price, h3.price-title + div',
      locationSelector: '.listings-property-location, .lp-location',
    },
    {
      rank: 2,
      name: 'Nigerian Property Centre',
      domain: 'nigerianpropertycenter.com',
      authenticity: 'high — long-established, wide Lagos coverage, direct-owner + agent mix',
      searchUrl: 'https://nigerianpropertycenter.com/for-sale/in-lagos/?type={TYPE}',
      propertyTypes: ['flat', 'house', 'land', 'duplex', 'bungalow', 'terraced-house'],
      titleSelector: '.property-name, h2.listing-title',
      priceSelector: '.price, .listing-price',
      locationSelector: '.listing-location, .property-location',
    },
    {
      rank: 3,
      name: 'Private Property Nigeria',
      domain: 'privateproperty.com.ng',
      authenticity: 'high — South African-backed platform, strong verification standards',
      searchUrl: 'https://www.privateproperty.com.ng/for-sale?state=Lagos&propertyType={TYPE}',
      propertyTypes: ['apartment', 'house', 'land', 'duplex', 'bungalow'],
      titleSelector: '.listing-title, h2.property-title',
      priceSelector: '.listing-price, .price-display',
      locationSelector: '.listing-location',
    },
    {
      rank: 4,
      name: 'Tolet Nigeria',
      domain: 'tolet.com.ng',
      authenticity: 'medium-high — strong Lagos agent network, pricing can lag market by 30-60 days',
      searchUrl: 'https://tolet.com.ng/property/Lagos/{TYPE}/buy',
      propertyTypes: ['flat', 'house', 'land', 'duplex', 'bungalow'],
      titleSelector: '.property-name, .listing-name',
      priceSelector: '.property-price, .price',
      locationSelector: '.property-location',
    },
    {
      rank: 5,
      name: 'Realtor.ng',
      domain: 'realtor.ng',
      authenticity: 'medium — growing platform, useful for cross-reference, some unverified listings',
      searchUrl: 'https://www.realtor.ng/buy/{TYPE}/lagos',
      propertyTypes: ['flat', 'duplex', 'bungalow', 'terraced', 'land'],
      titleSelector: '.property-title, h3.listing-title',
      priceSelector: '.price, .property-price',
      locationSelector: '.location, .property-location',
    },
    {
      rank: 6,
      name: 'Jumia House',
      domain: 'jumia.com.ng',
      authenticity: 'medium — broad reach, variable listing quality, useful for volume benchmarking',
      searchUrl: 'https://www.jumia.com.ng/real-estate/lagos/{TYPE}/',
      propertyTypes: ['apartment', 'house', 'land', 'duplex'],
      titleSelector: '.card-title, .property-name',
      priceSelector: '.price, .property-price',
      locationSelector: '.location',
    },
  ],

  /**
   * Watchlist: these terms trigger a FLAGGED status in the output sheet
   * and are highlighted in the AI narrative. Think of them as strategic
   * radar — pricing thresholds, competitor moves, or policy signals.
   */
  watchlist: [
    // Competitor activity signals
    'launch', 'new development', 'new phase', 'phase 2', 'expansion',
    'acquired', 'acquisition', 'partnership', 'joint venture',
    // Pricing signals
    'price reduction', 'discount', 'promo', 'payment plan',
    'off-plan', 'flexible payment',
    // Market signals
    'sold out', 'fully subscribed', 'oversubscribed',
    'infrastructure', 'road', 'bridge', 'light rail',
    // Lagos-specific geographic triggers
    'Ibeju-Lekki', 'Epe', 'Lekki Free Zone', 'Lagos New Town',
    'Lakowe', 'Eleko', 'LaCampaign Tropicana',
  ],

  /**
   * Property type taxonomy — used to normalise scraped type labels
   * into a standard set for the Excel output and AI analysis.
   */
  propertyTypeMap: {
    'flat': 'Apartment / Flat',
    'apartment': 'Apartment / Flat',
    'studio': 'Apartment / Flat',
    'house': 'Detached House',
    'detached': 'Detached House',
    'semi-detached': 'Semi-Detached',
    'semi_detached': 'Semi-Detached',
    'duplex': 'Duplex',
    'maisonette': 'Duplex',
    'bungalow': 'Bungalow',
    'terrace': 'Terraced House',
    'terraced': 'Terraced House',
    'terraced-house': 'Terraced House',
    'land': 'Land / Plot',
    'plot': 'Land / Plot',
    'commercial': 'Commercial',
    'office': 'Commercial',
  },

  /**
   * Lagos neighbourhoods to prioritise in scraping and analysis.
   * Listings from these areas are flagged as HIGH_RELEVANCE.
   */
  priorityLocations: [
    'Lekki', 'Ibeju-Lekki', 'Epe', 'Ajah', 'Sangotedo', 'Lakowe',
    'Eleko', 'Abraham Adesanya', 'Bogije', 'Ibeju', 'Lagos New Town',
    'Victoria Island', 'Ikoyi', 'Banana Island', 'Oniru',
    'Chevron', 'Jakande', 'Ikota', 'VGC', 'Lafiaji',
  ],
};

// ─── LAYER 2: USER EXTENSIONS ─────────────────────────────────────────────────
// Edit this section freely. Changes here take effect on the next run.
// Do NOT modify anything above this line.

const USER_EXTENSIONS = {
  competitors: [
    // Example — uncomment and edit to add:
    // {
    //   name: 'Your Competitor',
    //   domain: 'competitor.com',
    //   newsQuery: 'Competitor Name Lagos real estate',
    //   listingUrl: 'https://competitor.com/buy',
    // },
  ],

  listingSites: [
    // Additional listing sites beyond the hardcoded defaults.
  ],

  watchlist: [
    // Additional watchlist terms.
    // e.g. 'Mixta Africa', 'Lakowe Crossings', 'Lakowe Annexe',
  ],

  priorityLocations: [
    // Additional neighbourhoods.
  ],
};

// ─── MERGE & EXPORT ───────────────────────────────────────────────────────────

module.exports = {
  competitors: [...DEFAULTS.competitors, ...USER_EXTENSIONS.competitors],
  listingSites: [...DEFAULTS.listingSites, ...USER_EXTENSIONS.listingSites]
    .sort((a, b) => (a.rank || 99) - (b.rank || 99)),
  watchlist: [...new Set([...DEFAULTS.watchlist, ...USER_EXTENSIONS.watchlist])],
  priorityLocations: [...new Set([...DEFAULTS.priorityLocations, ...USER_EXTENSIONS.priorityLocations])],
  propertyTypeMap: DEFAULTS.propertyTypeMap,
};
