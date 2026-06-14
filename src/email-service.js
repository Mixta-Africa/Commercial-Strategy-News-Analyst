/**
 * Email Service Module - Google Apps Script Edition
 *
 * Sends emails via Google Apps Script (NOT OAuth2).
 *
 * CHANGES:
 * - Removed emojis (they were corrupting into "??????" through the Apps Script JSON hop).
 *   Replaced with clean styled text labels for a minimal, light aesthetic.
 * - Added source-diversified article selection so the digest isn't dominated by one outlet.
 * - Added charset=utf-8 to the POST Content-Type for good measure.
 */

const axios = require('axios');

/**
 * Select a diverse, high-quality set of articles for the digest.
 *
 * Priority:
 *  1. Spread across distinct sources (round-robin) so no single outlet dominates.
 *  2. Within each source, prefer articles that received a real AI summary
 *     (not the "Unable to generate..." fallback).
 */
function selectTopArticles(articles, limit = 6) {
  const FALLBACK = 'Unable to generate professional summary';

  const hasRealSummary = (a) =>
    a.summary && !a.summary.startsWith(FALLBACK) && a.summary.trim().length > 0;

  // Group articles by source
  const bySource = {};
  for (const a of articles) {
    const src = a.source || 'Unknown';
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push(a);
  }

  // Within each source, articles with real summaries come first
  for (const src of Object.keys(bySource)) {
    bySource[src].sort((x, y) => (hasRealSummary(y) ? 1 : 0) - (hasRealSummary(x) ? 1 : 0));
  }

  // Round-robin across sources: one from each source per pass
  const sources = Object.keys(bySource);
  const selected = [];
  let pass = 0;
  while (selected.length < limit) {
    let addedThisPass = false;
    for (const src of sources) {
      if (bySource[src][pass]) {
        selected.push(bySource[src][pass]);
        addedThisPass = true;
        if (selected.length >= limit) break;
      }
    }
    if (!addedThisPass) break; // no more articles anywhere
    pass++;
  }

  return selected;
}

/**
 * Render the executive briefing block (the intelligence layer output).
 * This leads the email; the article list below becomes supporting detail.
 */
function renderBriefing(briefing) {
  if (!briefing || !briefing.themes || briefing.themes.length === 0) return '';

  const noveltyStyle = {
    new: { bg: '#e8f5e9', fg: '#1b5e20', label: 'NEW' },
    building: { bg: '#fff8e1', fg: '#8a6d00', label: 'BUILDING' },
    established: { bg: '#eceff1', fg: '#455a64', label: 'ESTABLISHED' },
  };
  const recColor = (rec = '') => {
    const r = rec.toLowerCase();
    if (r.startsWith('act')) return '#c41e3a';
    if (r.startsWith('monitor')) return '#b8860b';
    if (r.startsWith('watch')) return '#5b8db5';
    return '#666';
  };
  const confColor = { high: '#155724', medium: '#8a6d00', low: '#721c24' };

  const themes = briefing.themes.map(t => {
    const nv = noveltyStyle[(t.novelty || 'established').toLowerCase()] || noveltyStyle.established;
    const seen = t.timesSeen && t.timesSeen > 1 ? ` &bull; week ${t.timesSeen}` : '';
    const srcLinks = (t.sourceArticles || [])
      .map(s => `<a href="${s.url || '#'}" target="_blank" style="color:#888;text-decoration:underline;">${s.source || 'source'}</a>`)
      .join(', ');
    const conf = (t.confidence || 'medium').toLowerCase();

    return `
      <div style="background:#ffffff;border:1px solid #eee;border-left:4px solid ${recColor(t.recommendation)};border-radius:4px;padding:16px;margin-bottom:14px;">
        <div style="margin-bottom:8px;">
          <span style="font-size:15px;font-weight:700;color:#1a1a1a;">${t.label || 'Theme'}</span>
          <span style="display:inline-block;background:${nv.bg};color:${nv.fg};font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:8px;">${nv.label}${seen}</span>
        </div>
        <p style="margin:6px 0;font-size:13px;color:#444;"><strong>What happened:</strong> ${t.what_happened || ''}</p>
        <p style="margin:6px 0;font-size:13px;color:#0c5460;background:#eef6fb;border-radius:4px;padding:8px;"><strong>Why it matters to Mixta:</strong> ${t.why_it_matters_to_mixta || ''}</p>
        <p style="margin:6px 0;font-size:13px;color:#1a1a1a;"><strong style="color:${recColor(t.recommendation)};">Recommendation:</strong> ${t.recommendation || ''}</p>
        <div style="font-size:11px;color:#999;margin-top:8px;">
          Confidence: <strong style="color:${confColor[conf] || '#666'};">${(t.confidence || 'medium').toUpperCase()}</strong>
          ${srcLinks ? ` &bull; Sources: ${srcLinks}` : ''}
        </div>
      </div>`;
  }).join('');

  const watchHits = (briefing.watch_list_hits && briefing.watch_list_hits.length)
    ? `<div style="margin-top:14px;padding:12px;background:#fbf7ef;border:1px solid #f0e6d2;border-radius:6px;font-size:12px;color:#7a5c1e;">
         <strong>Watch-list activity today:</strong> ${briefing.watch_list_hits.join(' &bull; ')}
       </div>`
    : '';

  return `
    <div style="background:#fbfbfb;border:1px solid #e8e8e8;border-radius:8px;padding:20px;margin-bottom:25px;">
      <div style="font-size:11px;letter-spacing:1px;color:#c41e3a;font-weight:700;text-transform:uppercase;margin-bottom:8px;">Executive Briefing</div>
      <p style="font-size:15px;line-height:1.6;color:#1a1a1a;margin:0 0 18px 0;font-weight:500;">${briefing.executive_summary || ''}</p>
      ${themes}
      ${watchHits}
    </div>`;
}

/**
 * Generate the email HTML digest
 */
function generateEmailHTML(articles, trends, alerts, briefing) {
  const topArticles = selectTopArticles(articles, 6);

  const sentimentColor = {
    bullish: { bg: '#d4edda', fg: '#155724' },
    bearish: { bg: '#f8d7da', fg: '#721c24' },
    neutral: { bg: '#e2e3e5', fg: '#383d41' },
  };

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          color: #1a1a1a;
          background-color: #f9f9f9;
          line-height: 1.6;
          margin: 0;
          padding: 0;
        }
        .container {
          max-width: 700px;
          margin: 0 auto;
          padding: 20px;
          background-color: #ffffff;
        }
        .header {
          background: linear-gradient(135deg, #c41e3a 0%, #a01829 100%);
          color: #ffffff;
          padding: 25px;
          border-radius: 8px;
          margin-bottom: 25px;
          text-align: center;
        }
        .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
        .header p { margin: 8px 0 0 0; font-size: 12px; opacity: 0.92; }
        .section-title {
          color: #1a1a1a;
          margin: 20px 0 15px 0;
          border-bottom: 2px solid #c41e3a;
          padding-bottom: 10px;
          font-size: 18px;
        }
        .article {
          background-color: #ffffff;
          padding: 15px;
          margin-bottom: 12px;
          border: 1px solid #eee;
          border-left: 4px solid #c41e3a;
          border-radius: 4px;
        }
        .article h3 { margin: 0 0 8px 0; font-size: 16px; line-height: 1.4; }
        .article a { color: #c41e3a; text-decoration: none; font-weight: 600; }
        .article-meta { font-size: 12px; color: #888; margin-bottom: 10px; }
        .article-summary { font-size: 13px; color: #555; margin: 8px 0; line-height: 1.5; }
        .source-badge {
          display: inline-block;
          background-color: #f0f0f0;
          color: #444;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 600;
          font-size: 11px;
        }
        .sentiment-tag {
          display: inline-block;
          padding: 3px 10px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
        }
        .trends-section {
          background-color: #f7f7f7;
          padding: 15px;
          border-radius: 6px;
          margin: 20px 0;
          border: 1px solid #eee;
        }
        .trends-section h3 { margin-top: 0; }
        .mixta-impact {
          background-color: #eef6fb;
          padding: 8px 10px;
          border-radius: 4px;
          margin-top: 8px;
          font-size: 12px;
          color: #0c5460;
          border-left: 3px solid #5b8db5;
        }
        .alert-box {
          background-color: #fff3cd;
          border-left: 4px solid #ffc107;
          padding: 12px;
          margin: 10px 0;
          border-radius: 4px;
          font-size: 13px;
        }
        .footer {
          text-align: center;
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid #e0e0e0;
          font-size: 12px;
          color: #999;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Nigerian Real Estate News Intelligence</h1>
          <p>Daily Market Analysis &bull; Competitive Intelligence</p>
          <p>${new Date().toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
          })}</p>
        </div>

        ${renderBriefing(briefing)}

        <h2 class="section-title">Supporting Stories (${topArticles.length})</h2>

        ${topArticles.map(a => {
          const s = (a.sentiment || 'neutral').toLowerCase();
          const c = sentimentColor[s] || sentimentColor.neutral;
          return `
          <div class="article">
            <h3><a href="${a.url || '#'}" target="_blank">${a.title || 'Untitled'}</a></h3>
            <div class="article-meta">
              <span class="source-badge">${a.source || 'Unknown'}</span> &bull;
              ${new Date(a.addedAt || new Date()).toLocaleDateString()} &bull;
              <span class="sentiment-tag" style="background-color:${c.bg};color:${c.fg};">${s.toUpperCase()}</span>
            </div>
            <div class="article-summary">
              <strong>Analysis:</strong> ${a.summary || 'Summary unavailable.'}
            </div>
            ${a.mixta_relevance?.direct_impact && a.mixta_relevance.direct_impact !== 'None' && a.mixta_relevance.direct_impact !== 'Unable to determine' ? `
              <div class="mixta-impact">
                <strong>Mixta Impact:</strong> ${a.mixta_relevance.direct_impact}
              </div>
            ` : ''}
          </div>`;
        }).join('')}

        <div class="trends-section">
          <h3>7-Day Trends</h3>
          <p><strong>Sentiment:</strong> ${trends['7day']?.averageSentiment?.toUpperCase() || 'NEUTRAL'}</p>
          <p><strong>Articles:</strong> ${trends['7day']?.articleCount || 0}</p>
          <p><strong>Top Topics:</strong> ${trends['7day']?.topTopics?.slice(0, 3).map(t => t.topic).join(', ') || 'N/A'}</p>
        </div>

        ${alerts && alerts.length > 0 ? `
          <h3 class="section-title">Alerts &amp; Anomalies</h3>
          ${alerts.map(a => `
            <div class="alert-box">
              <strong>${a.type.toUpperCase()}:</strong> ${a.message}
            </div>
          `).join('')}
        ` : ''}

        <div class="footer">
          <p>Nigerian Real Estate News System &bull; Autonomous Daily Pipeline</p>
          <p style="margin-top: 12px; font-size: 11px; color: #ccc;">
            Powered by Groq AI &bull; Deployed on GitHub Actions &bull; Dashboard on GitHub Pages
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send email via Google Apps Script
 */
async function sendEmail({ to, subject, html }) {
  const appsScriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const appsScriptSecret = process.env.APPS_SCRIPT_SECRET;

  if (!appsScriptUrl || !appsScriptSecret) {
    console.error('[Email] Missing GOOGLE_APPS_SCRIPT_URL or APPS_SCRIPT_SECRET in environment');
    throw new Error('Apps Script credentials missing');
  }

  try {
    console.log(`[Email] Sending to ${to} via Google Apps Script...`);

    const response = await axios.post(
      appsScriptUrl,
      {
        recipients: to,
        subject: subject,
        htmlBody: html,
        secret: appsScriptSecret,
      },
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      }
    );

    if (response.data && response.data.success) {
      console.log(`[Email] Sent successfully`);
      return { success: true, message: 'Email sent via Google Apps Script' };
    } else {
      throw new Error(response.data?.error || 'Unknown error from Apps Script');
    }
  } catch (error) {
    console.error(`[Email] Send failed: ${error.message}`);
    throw error;
  }
}

module.exports = { generateEmailHTML, sendEmail };
