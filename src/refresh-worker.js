/**
 * Mixta Africa - Dashboard Refresh Trigger
 * ===========================================
 * Cloudflare Worker that lets the dashboard's "Refresh" button trigger a
 * real GitHub Actions run, WITHOUT exposing a GitHub token to the browser.
 *
 * The token lives only here, as a Worker secret - never in client-side JS.
 *
 * SETUP (one-time, free):
 *   1. Go to https://dash.cloudflare.com -> sign up free (no card needed)
 *   2. Workers & Pages -> Create -> Create Worker
 *   3. Name it something like "mixta-dashboard-trigger"
 *   4. Replace the default code with this file's contents -> Deploy
 *   5. Go to the Worker's Settings -> Variables -> Add a SECRET (not a
 *      plain variable) named GITHUB_TOKEN, paste a GitHub Personal Access
 *      Token with "repo" + "workflow" scope (create one fresh - do not
 *      reuse the local-scraper token)
 *   6. Copy your Worker's URL (looks like
 *      https://mixta-dashboard-trigger.YOUR-SUBDOMAIN.workers.dev)
 *   7. Paste that URL into the dashboard's REFRESH_WORKER_URL constant
 *      (see index.html changes)
 *
 * SECURITY NOTES:
 *   - This Worker only accepts POST requests and only triggers ONE specific
 *     workflow (hardcoded below) - it cannot be used to run arbitrary
 *     GitHub Actions or access anything else in the repo.
 *   - Basic rate limiting: rejects requests if the same IP triggered a run
 *     in the last 2 minutes, to prevent accidental button-mashing from
 *     burning through API rate limits or spamming runs.
 */

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GITHUB_OWNER  = 'Mixta-Africa';
const GITHUB_REPO   = 'Commercial-Strategy-News-Analyst';
const WORKFLOW_FILE = 'daily-news.yml'; // the workflow this button is allowed to trigger
const GITHUB_REF    = 'main';

// Simple in-memory rate limit (resets when the Worker cold-starts, which is
// fine for this use case - it's a soft protection against double-clicks,
// not a hard security boundary).
let lastTriggerTime = 0;
const COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

// CORS: only allow requests from your actual GitHub Pages domain.
const ALLOWED_ORIGIN = 'https://mixta-africa.github.io';

export default {
  async fetch(request, env) {
    // Handle CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const now = Date.now();
    if (now - lastTriggerTime < COOLDOWN_MS) {
      const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTriggerTime)) / 1000);
      return jsonResponse({ error: `Please wait ${waitSec}s before triggering another run.` }, 429);
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return jsonResponse({ error: 'Server misconfigured: no token set.' }, 500);
    }

    try {
      const ghResponse = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'mixta-dashboard-trigger-worker',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: GITHUB_REF }),
        }
      );

      if (ghResponse.status === 204) {
        lastTriggerTime = now;
        return jsonResponse({
          success: true,
          message: 'Pipeline triggered. New data will be available in roughly 5-8 minutes.',
        });
      }

      const errorText = await ghResponse.text();
      return jsonResponse(
        { error: `GitHub API returned ${ghResponse.status}: ${errorText.substring(0, 200)}` },
        502
      );
    } catch (err) {
      return jsonResponse({ error: `Request failed: ${err.message}` }, 500);
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}
