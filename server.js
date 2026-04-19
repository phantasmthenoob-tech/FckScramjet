const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS headers for all responses ──────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ── Serve frontend static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Main proxy endpoint: GET /fetch?url=https://example.com ─────────────────
app.get('/fetch', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        // Pretend to be a real browser so sites don't block us
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': parsedUrl.origin,
      },
      redirect: 'follow',
      timeout: 15000,
    });

    const contentType = response.headers.get('content-type') || 'text/html';

    // Strip security headers that would block rendering in an iframe
    const blockedHeaders = [
      'content-security-policy',
      'content-security-policy-report-only',
      'x-frame-options',
      'x-content-type-options',
      'strict-transport-security',
      'permissions-policy',
      'cross-origin-embedder-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
    ];

    // Forward safe headers
    response.headers.forEach((value, key) => {
      if (!blockedHeaders.includes(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(response.status);

    const buffer = await response.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('[proxy] fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EP Proxy server running on http://localhost:${PORT}`);
});
