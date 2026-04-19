const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Chrome 136 headers ────────────────────────────────────────────────────────
const CHROME_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
  'Sec-CH-UA':            '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
  'Sec-CH-UA-Mobile':     '?0',
  'Sec-CH-UA-Platform':   '"Windows"',
  'Sec-Fetch-Dest':       'document',
  'Sec-Fetch-Mode':       'navigate',
  'Sec-Fetch-Site':       'none',
  'Sec-Fetch-User':       '?1',
  'Upgrade-Insecure-Requests': '1',
  'DNT': '1',
};

// Headers to strip from the response so the iframe won't be blocked
const BLOCKED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'x-content-type-options',
  'strict-transport-security',
  'permissions-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
  'transfer-encoding', // axios already decoded; sending it confuses clients
]);

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Normalise bare hostnames and force google.com → www.google.com so
 * logo/asset URLs (which live on www) resolve correctly.
 */
function normaliseUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const u = new URL(url);
  if (u.hostname === 'google.com') u.hostname = 'www.google.com';
  return u.toString();
}

/** Turn any URL into a full proxy link.
 *  Uses BACKEND_URL env var, or falls back to the origin of the current request.
 */
function proxyHref(absUrl, reqOrigin) {
  const base = (process.env.BACKEND_URL || reqOrigin || '').replace(/\/+$/, '');
  return `${base}/fetch?url=${encodeURIComponent(absUrl)}`;
}

/** Resolve a possibly-relative URL against the page base */
function resolve(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────
function rewriteHtml(html, pageUrl, reqOrigin) {
  // 1. Rewrite src / href / action / data-src attributes
  html = html.replace(
    /(\s(?:src|href|action|data-src)\s*=\s*)(['"])((?!data:|javascript:|#|blob:|about:)[^'"]+)\2/gi,
    (m, attr, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `${attr}${q}${proxyHref(abs, reqOrigin)}${q}`;
    }
  );

  // 2. Rewrite CSS url(...)
  html = html.replace(
    /url\((['"]?)((?!data:|#|blob:)[^)'"\s]+)\1\)/gi,
    (m, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `url(${q}${proxyHref(abs, reqOrigin)}${q})`;
    }
  );

  // 3. Rewrite srcset="url 1x, url2 2x"
  html = html.replace(
    /(\ssrcset\s*=\s*)(['"])((?!data:)[^'"]+)\2/gi,
    (m, attr, q, val) => {
      const rewritten = val.replace(/(https?:\/\/[^\s,]+)/gi, u => proxyHref(u, reqOrigin));
      return `${attr}${q}${rewritten}${q}`;
    }
  );

  // 4. Inject <base> + intercept shim right after <head>
  const shim = `<base href="${pageUrl}">
<script>
(function(){
  var _BASE = ${JSON.stringify(pageUrl)};
  var _PROXY_PREFIX = '${(process.env.BACKEND_URL || reqOrigin || '').replace(/\/+$/, '')}/fetch?url=';

  function abs(u){
    try{ return new URL(u, _BASE).href; }catch(e){ return u; }
  }
  function proxyUrl(u){
    return _PROXY_PREFIX + encodeURIComponent(abs(u));
  }
  function nav(u){
    var a = abs(u);
    window.parent.postMessage({ type: 'EP_NAV', url: a }, '*');
  }

  // ── Clicks on <a> tags ──────────────────────────────────────────────────────
  document.addEventListener('click', function(e){
    var a = e.target.closest('a');
    if(!a) return;
    var href = a.getAttribute('href');
    if(!href || href.charAt(0)==='#' || /^javascript:/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    nav(href);
  }, true);

  // ── All form submits (Google search, etc.) ─────────────────────────────────
  document.addEventListener('submit', function(e){
    e.preventDefault();
    e.stopPropagation();
    var f      = e.target;
    var action = abs(f.getAttribute('action') || _BASE);
    var params = new URLSearchParams(new FormData(f)).toString();
    nav(action + (params ? '?' + params : ''));
  }, true);

  // ── Google keyboard search (Enter on the q input) ─────────────────────────
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Enter') return;
    var inp  = e.target;
    if(inp.tagName !== 'INPUT') return;
    var name = (inp.getAttribute('name') || '').toLowerCase();
    if(name !== 'q' && name !== 'search' && name !== 'query') return;
    e.preventDefault();
    e.stopPropagation();
    var q = encodeURIComponent(inp.value.trim());
    if(!q) return;
    var host = (function(){ try{ return new URL(_BASE).hostname; }catch(){ return ''; } })();
    var base = /google/i.test(host)   ? 'https://www.google.com/search?q='
             : /bing/i.test(host)     ? 'https://www.bing.com/search?q='
             : /yahoo/i.test(host)    ? 'https://search.yahoo.com/search?p='
             : /ddg|duck/i.test(host) ? 'https://duckduckgo.com/?q='
             : 'https://www.google.com/search?q=';
    nav(base + q);
  }, true);

  // ── Intercept setAttribute so JS-set image src goes through proxy ──────────
  var _origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if((name === 'src' || name === 'data-src') && this.tagName === 'IMG'){
      var a = abs(value);
      if(/^https?:\/\//i.test(a)){
        return _origSetAttr.call(this, name, proxyUrl(a));
      }
    }
    return _origSetAttr.call(this, name, value);
  };

  // ── window.open → nav ──────────────────────────────────────────────────────
  var _origOpen = window.open;
  window.open = function(url, target, features){
    if(url && url !== 'about:blank' && !/^javascript:/i.test(url)){
      nav(url); return null;
    }
    return _origOpen ? _origOpen.call(window, url, target, features) : null;
  };

  // ── location.assign / replace ──────────────────────────────────────────────
  try{
    var _origAssign  = window.location.assign.bind(window.location);
    var _origReplace = window.location.replace.bind(window.location);
    window.location.assign  = function(u){ nav(u); };
    window.location.replace = function(u){ nav(u); };
  }catch(e){}

})();
<\/script>`;

  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, '$1\n' + shim);
  } else {
    html = shim + '\n' + html;
  }

  return html;
}

// ── Express middleware ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.0' }));

// ── Proxy endpoint ────────────────────────────────────────────────────────────
app.get('/fetch', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  let targetUrl;
  try {
    targetUrl = normaliseUrl(rawUrl);
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https URLs allowed' });
  }

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        ...CHROME_HEADERS,
        'Referer': parsed.origin + '/',
        'Origin':  parsed.origin,
        'Host':    parsed.host,
      },
      responseType:   'arraybuffer',
      timeout:        20000,
      maxRedirects:   10,
      decompress:     true,         // auto gunzip/brotli
      validateStatus: () => true,   // never throw on HTTP status
    });

    // Forward non-blocked response headers
    for (const [key, value] of Object.entries(response.headers)) {
      if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    const contentType = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (/text\/html/i.test(contentType)) {
      const htmlText = response.data.toString('utf-8');
      const reqOrigin = req.headers['x-forwarded-proto']
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host'] || req.headers.host}`
        : `${req.protocol}://${req.headers.host}`;
      const rewritten = rewriteHtml(htmlText, targetUrl, reqOrigin);
      return res.status(response.status).send(rewritten);
    }

    return res.status(response.status).send(response.data);

  } catch (err) {
    console.error('[proxy] error:', err.message);
    return res.status(502).json({ error: 'Proxy fetch failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EP Proxy server running on http://localhost:${PORT}`);
});
