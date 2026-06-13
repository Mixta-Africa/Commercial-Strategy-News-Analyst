/**
 * Email Service Module - Google Apps Script Edition
 * 
 * Sends emails via Google Apps Script (NOT OAuth2)
 * 
 * Why Apps Script?
 * ✅ No Gmail tokens stored in GitHub
 * ✅ No external OAuth libraries
 * ✅ Google handles authentication on their servers
 * ✅ Complete audit trail (every email logged)
 * ✅ Instant revocation (delete deployment)
 */

const axios = require('axios');

/**
 * Generate the email HTML digest
 */
function generateEmailHTML(articles, trends, alerts) {
  const topArticles = articles.slice(0, 5);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          color: #1a1a1a;
          background-color: #f9f9f9;
          line-height: 1.6;
        }
        .container {
          max-width: 700px;
          margin: 0 auto;
          padding: 20px;
          background-color: #ffffff;
        }
        .header {
          background: linear-gradient(135deg, #c41e3a 0%, #a01829 100%);
          color: white;
          padding: 25px;
          border-radius: 8px;
          margin-bottom: 25px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 700;
        }
        .article {
          background-color: #f9f9f9;
          padding: 15px;
          margin-bottom: 12px;
          border-left: 4px solid #c41e3a;
          border-radius: 4px;
        }
        .article h3 {
          margin: 0 0 8px 0;
          font-size: 16px;
          line-height: 1.4;
        }
        .article a {
          color: #c41e3a;
          text-decoration: none;
          font-weight: 600;
        }
        .article-meta {
          font-size: 12px;
          color: #999;
          margin-bottom: 10px;
        }
        .article-summary {
          font-size: 13px;
          color: #555;
          margin: 8px 0;
          line-height: 1.5;
        }
        .sentiment-tag {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
          margin: 0 5px 0 0;
        }
        .sentiment-bullish {
          background-color: #d4edda;
          color: #155724;
        }
        .sentiment-bearish {
          background-color: #f8d7da;
          color: #721c24;
        }
        .sentiment-neutral {
          background-color: #e2e3e5;
          color: #383d41;
        }
        .trends-section {
          background-color: #f0f0f0;
          padding: 15px;
          border-radius: 6px;
          margin: 20px 0;
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
          <h1>🇳🇬 Nigerian Real Estate News Intelligence</h1>
          <p style="margin: 10px 0 0 0; font-size: 12px;">Daily Market Analysis • Competitive Intelligence</p>
          <p style="margin: 8px 0 0 0; font-size: 12px;">${new Date().toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })}</p>
        </div>

        <h2 style="color: #1a1a1a; margin: 20px 0 15px 0; border-bottom: 2px solid #c41e3a; padding-bottom: 10px;">📰 Today's Top Stories (${topArticles.length})</h2>
        
        ${topArticles.map(a => `
          <div class="article">
            <h3><a href="${a.url || '#'}" target="_blank">${a.title}</a></h3>
            <div class="article-meta">
              <strong>${a.source}</strong> • 
              ${new Date(a.addedAt || new Date()).toLocaleDateString()} •
              <span class="sentiment-tag sentiment-${a.sentiment}">${a.sentiment.toUpperCase()}</span>
            </div>
            <div class="article-summary">
              <strong>Analysis:</strong> ${a.summary || 'Unable to generate summary.'}
            </div>
            ${a.mixta_relevance?.direct_impact && a.mixta_relevance.direct_impact !== 'None' ? `
              <div style="background-color: #e8f4f8; padding: 8px; border-radius: 4px; margin-top: 8px; font-size: 12px; color: #0c5460;">
                <strong>🎯 Mixta Impact:</strong> ${a.mixta_relevance.direct_impact}
              </div>
            ` : ''}
          </div>
        `).join('')}

        <div class="trends-section">
          <h3 style="margin-top: 0;">📊 7-Day Trends</h3>
          <p><strong>Sentiment:</strong> ${trends['7day']?.averageSentiment?.toUpperCase() || 'NEUTRAL'}</p>
          <p><strong>Articles:</strong> ${trends['7day']?.articleCount || 0}</p>
          <p><strong>Top Topics:</strong> ${trends['7day']?.topTopics?.slice(0, 3).map(t => t.topic).join(', ') || 'N/A'}</p>
        </div>

        ${alerts && alerts.length > 0 ? `
          <h3>⚠️ Alerts & Anomalies</h3>
          ${alerts.map(a => `
            <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 10px 0; border-radius: 4px; font-size: 13px;">
              <strong>${a.type.toUpperCase()}:</strong> ${a.message}
            </div>
          `).join('')}
        ` : ''}

        <div class="footer">
          <p>Nigerian Real Estate News System • Autonomous Daily Pipeline</p>
          <p style="margin-top: 15px; font-size: 11px; color: #ccc;">
            Powered by Groq/Cerebras AI • Deployed on GitHub Actions • Dashboard on GitHub Pages
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Send email via Google Apps Script (SECURITY-FIRST APPROACH)
 * 
 * No Gmail tokens in GitHub
 * No external OAuth libraries
 * Google handles authentication on their servers
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
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data && response.data.success) {
      console.log(`[Email] Sent successfully`);
      return {
        success: true,
        message: 'Email sent via Google Apps Script',
      };
    } else {
      throw new Error(response.data?.error || 'Unknown error from Apps Script');
    }
  } catch (error) {
    console.error(`[Email] Send failed: ${error.message}`);
    throw error;
  }
}

module.exports = { generateEmailHTML, sendEmail };
