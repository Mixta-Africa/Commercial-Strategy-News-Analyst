/**
 * Macro Indicators Fetcher  —  src/macro-fetcher.js
 *
 * Writes data/macro-indicators.json, which the dashboard's Reports tab
 * ("Live Macro Indicators") reads on load.
 *
 * Why this exists: the dashboard has long said "pipeline will update Monday",
 * but no script in the pipeline ever wrote this file, so the panel always fell
 * back to the hardcoded baseline.
 *
 * Sources (all free, no API key):
 *   - World Bank API   : real GDP growth, diaspora remittances
 *   - IMF DataMapper   : real GDP growth forecast, inflation forecast
 *   - FX               : USD/NGN mid-market rate (open.er-api.com, fallback jsDelivr currency-api)
 *   - Firebase RTDB    : NBS figures entered by hand in the dashboard Config tab (optional,
 *                        needs FIREBASE_DB_URL; skipped silently if unreadable)
 *
 * Not automatable from a free, stable API (these stay on the dashboard baseline
 * or the manual NBS form): CBN MPR, prime/mortgage lending rates, NBS monthly CPI.
 *
 * Design rules:
 *   1. A failing source NEVER wipes the last good value — it is kept and flagged.
 *   2. World Bank / IMF move slowly, so they refresh at most every SLOW_REFRESH_DAYS.
 *      FX and the Firebase NBS read refresh on every run.
 *   3. This script never throws out of main() and always exits 0, so it can never
 *      fail the daily workflow. Outcomes are recorded under `status` in the file.
 *
 * Run:  node src/macro-fetcher.js          (add --force to ignore the refresh interval)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TIMEOUT = 20000;
const SLOW_REFRESH_DAYS = 6;

// Only indicators the dashboard actually displays. (Annual WB CPI / modelled
// unemployment are deliberately NOT pulled: the dashboard shows fresher NBS
// survey figures for those, and an older modelled number would be a downgrade.)
const WORLD_BANK_INDICATORS = {
  gdp_growth:     'NY.GDP.MKTP.KD.ZG',   // GDP growth (annual %)
  remittances:    'BX.TRF.PWKR.CD.DT',   // Personal remittances, received (current US$)
};

const IMF_INDICATORS = {
  gdp_growth: 'NGDP_RPCH',   // Real GDP growth (annual %)
  inflation:  'PCPIPCH',     // Inflation, average consumer prices (annual %)
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function ageInDays(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / 86400000;
}

function round(n, dp = 2) {
  return Math.round(n * Math.pow(10, dp)) / Math.pow(10, dp);
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { return null; }
}

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function errMsg(e) {
  const status = e.response?.status;
  return `${status ? status + ': ' : ''}${(e.message || String(e)).substring(0, 160)}`;
}

// ─── source fetchers ──────────────────────────────────────────────────────────

/** Most recent non-empty World Bank value for Nigeria. */
async function fetchWorldBankIndicator(http, code) {
  const url = `https://api.worldbank.org/v2/country/NGA/indicator/${code}?format=json&mrnev=1`;
  const res = await http.get(url, { timeout: TIMEOUT });
  const rows = Array.isArray(res.data) ? res.data[1] : null;
  const row = Array.isArray(rows)
    ? rows.find(r => r && r.value !== null && r.value !== undefined && !Number.isNaN(Number(r.value)))
    : null;
  if (!row) throw new Error(`World Bank returned no value for ${code}`);
  return { value: Number(row.value), year: Number(row.date) };
}

async function fetchWorldBank(http) {
  const out = {};
  const errors = [];
  for (const [key, code] of Object.entries(WORLD_BANK_INDICATORS)) {
    try {
      const r = await fetchWorldBankIndicator(http, code);
      if (key === 'remittances') {
        out.remittances_usd_bn = { value: round(r.value / 1e9, 1), year: r.year };
      } else {
        out[key] = { value: round(r.value, 2), year: r.year };
      }
    } catch (e) {
      errors.push(`${key}: ${errMsg(e)}`);
    }
  }
  return { data: out, errors };
}

/** IMF DataMapper series → { current:{year,value}, next:{year,value} } */
async function fetchImfSeries(http, code, now) {
  const url = `https://www.imf.org/external/datamapper/api/v1/${code}/NGA`;
  const res = await http.get(url, { timeout: TIMEOUT });
  const series = res.data?.values?.[code]?.NGA;
  if (!series || typeof series !== 'object') throw new Error(`IMF returned no series for ${code}`);
  const y = now.getUTCFullYear();
  const pick = (year) => {
    const v = series[String(year)];
    return (v === null || v === undefined || Number.isNaN(Number(v))) ? null : { year, value: round(Number(v), 2) };
  };
  const current = pick(y);
  const next = pick(y + 1);
  if (!current && !next) throw new Error(`IMF series ${code} has no ${y}/${y + 1} values`);
  return { current, next };
}

async function fetchImf(http, now) {
  const out = {};
  const errors = [];
  for (const [key, code] of Object.entries(IMF_INDICATORS)) {
    try {
      out[key] = await fetchImfSeries(http, code, now);
    } catch (e) {
      errors.push(`${key}: ${errMsg(e)}`);
    }
  }
  return { data: out, errors };
}

/** USD/NGN mid-market rate. Primary + fallback; plausibility-checked. */
async function fetchFx(http) {
  const plausible = (r) => typeof r === 'number' && r > 300 && r < 5000;
  const attempts = [
    {
      source: 'open.er-api.com (mid-market)',
      run: async () => {
        const res = await http.get('https://open.er-api.com/v6/latest/USD', { timeout: TIMEOUT });
        if (res.data?.result && res.data.result !== 'success') throw new Error(`result=${res.data.result}`);
        return { rate: Number(res.data?.rates?.NGN), asOf: res.data?.time_last_update_utc || null };
      },
    },
    {
      source: 'currency-api via jsDelivr (mid-market)',
      run: async () => {
        const res = await http.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { timeout: TIMEOUT });
        return { rate: Number(res.data?.usd?.ngn), asOf: res.data?.date || null };
      },
    },
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const r = await a.run();
      if (!plausible(r.rate)) throw new Error(`implausible NGN rate: ${r.rate}`);
      return { data: { rate: round(r.rate, 2), source: a.source, asOf: r.asOf }, errors };
    } catch (e) {
      errors.push(`${a.source}: ${errMsg(e)}`);
    }
  }
  return { data: null, errors };
}

/** NBS figures typed into the dashboard Config tab (stored in Firebase RTDB). */
async function fetchNbsManual(http, env) {
  const base = (env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
  if (!base) return { data: null, errors: ['FIREBASE_DB_URL not set'], skipped: true };
  try {
    const res = await http.get(`${base}/macro/nbs_manual.json`, { timeout: TIMEOUT });
    const d = res.data;
    if (d && typeof d === 'object' && !Array.isArray(d)) return { data: d, errors: [] };
    return { data: null, errors: [], empty: true };
  } catch (e) {
    return { data: null, errors: [errMsg(e)] };
  }
}

// ─── orchestration ────────────────────────────────────────────────────────────

async function run({
  http = axios,
  dataDir = path.join(process.cwd(), 'data'),
  now = new Date(),
  force = false,
  env = process.env,
} = {}) {
  const file = path.join(dataDir, 'macro-indicators.json');
  const prev = readJSON(file) || {};
  const nowIso = now.toISOString();
  const next = {
    schema: 1,
    fetchedAt: prev.fetchedAt || null,          // last successful World Bank / IMF refresh
    lastRunAt: nowIso,
    world_bank: prev.world_bank || {},
    imf_gdp_forecast: prev.imf_gdp_forecast || {},
    cbn_exchange_rate: prev.cbn_exchange_rate || {},
    nbs_manual: prev.nbs_manual || null,
    status: {},
  };
  const summary = [];

  // 1) World Bank + IMF — slow-moving, refresh at most every SLOW_REFRESH_DAYS
  const slowDue = force || !prev.fetchedAt || ageInDays(prev.fetchedAt, now) >= SLOW_REFRESH_DAYS;
  if (slowDue) {
    const [wb, imf] = [await fetchWorldBank(http), await fetchImf(http, now)];

    if (Object.keys(wb.data).length) {
      next.world_bank = { ...next.world_bank, ...wb.data, fetchedAt: nowIso };
    }
    next.status.world_bank = { ok: wb.errors.length === 0, at: nowIso, indicators: Object.keys(wb.data).length, errors: wb.errors };
    summary.push(`World Bank ${Object.keys(wb.data).length}/${Object.keys(WORLD_BANK_INDICATORS).length}`);

    if (Object.keys(imf.data).length) {
      next.imf_gdp_forecast = { ...next.imf_gdp_forecast, ...imf.data, fetchedAt: nowIso };
    }
    next.status.imf = { ok: imf.errors.length === 0, at: nowIso, indicators: Object.keys(imf.data).length, errors: imf.errors };
    summary.push(`IMF ${Object.keys(imf.data).length}/${Object.keys(IMF_INDICATORS).length}`);

    if (Object.keys(wb.data).length || Object.keys(imf.data).length) next.fetchedAt = nowIso;
  } else {
    next.status.world_bank = prev.status?.world_bank || { ok: true, skipped: true };
    next.status.imf = prev.status?.imf || { ok: true, skipped: true };
    summary.push(`World Bank/IMF fresh (${Math.floor(ageInDays(prev.fetchedAt, now))}d old, skipped)`);
  }

  // 2) FX — every run
  const fx = await fetchFx(http);
  if (fx.data) {
    next.cbn_exchange_rate = { ...fx.data, fetchedAt: nowIso };
    summary.push(`FX ₦${fx.data.rate}/$`);
  } else {
    summary.push('FX failed (kept last value)');
  }
  next.status.fx = { ok: !!fx.data, at: nowIso, errors: fx.errors };

  // 3) NBS manual figures from Firebase — every run, optional
  const nbs = await fetchNbsManual(http, env);
  if (nbs.data) {
    next.nbs_manual = nbs.data;
    summary.push('NBS manual pulled');
  } else if (nbs.skipped) {
    summary.push('NBS manual skipped (no FIREBASE_DB_URL)');
  } else {
    summary.push(nbs.empty ? 'NBS manual: none entered' : 'NBS manual unreadable (kept last)');
  }
  next.status.nbs_manual = { ok: !!nbs.data || !!nbs.skipped || !!nbs.empty, at: nowIso, errors: nbs.skipped ? [] : nbs.errors };

  writeJSONAtomic(file, next);
  console.log(`[MACRO] ${summary.join(' | ')}`);
  for (const [k, s] of Object.entries(next.status)) {
    (s.errors || []).forEach(e => console.warn(`[MACRO] ${k}: ${e}`));
  }
  return next;
}

async function main() {
  try {
    await run({ force: process.argv.includes('--force') });
  } catch (e) {
    // Never fail the daily workflow because of macro data.
    console.error('[MACRO] Unexpected error (non-fatal):', e.message);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { run, fetchWorldBankIndicator, fetchWorldBank, fetchImf, fetchFx, fetchNbsManual, WORLD_BANK_INDICATORS, IMF_INDICATORS };
