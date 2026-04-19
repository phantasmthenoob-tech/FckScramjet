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
  'transfer-encoding',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const u = new URL(url);
  // Force www.google.com so logo/assets resolve correctly
  if (u.hostname === 'google.com') u.hostname = 'www.google.com';
  return u.toString();
}

function getBackendBase(reqOrigin) {
  return (process.env.BACKEND_URL || reqOrigin || '').replace(/\/+$/, '');
}

function proxyHref(absUrl, backendBase) {
  return `${backendBase}/fetch?url=${encodeURIComponent(absUrl)}`;
}

function resolve(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────
function rewriteHtml(html, pageUrl, backendBase) {

  // 1. Rewrite src / href / data-src (NOT action — forms handled by shim)
  html = html.replace(
    /(\s(?:src|href|data-src)\s*=\s*)(['"])((?!data:|javascript:|#|blob:|about:)[^'"]+)\2/gi,
    (m, attr, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `${attr}${q}${proxyHref(abs, backendBase)}${q}`;
    }
  );

  // 2. Rewrite CSS url(...)
  html = html.replace(
    /url\((['"]?)((?!data:|#|blob:)[^)'"\s]+)\1\)/gi,
    (m, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `url(${q}${proxyHref(abs, backendBase)}${q})`;
    }
  );

  // 3. Rewrite srcset
  html = html.replace(
    /(\ssrcset\s*=\s*)(['"])((?!data:)[^'"]+)\2/gi,
    (m, attr, q, val) => {
      const rewritten = val.replace(/(https?:\/\/[^\s,]+)/gi, u => proxyHref(u, backendBase));
      return `${attr}${q}${rewritten}${q}`;
    }
  );

  // 4. Inject shim
  const shimBase = JSON.stringify(pageUrl);
  const shimProxy = JSON.stringify(backendBase + '/fetch?url=');

  const shim = `<base href="${pageUrl}">
<script>
(function(){
  var _BASE         = ${shimBase};
  var _PROXY_PREFIX = ${shimProxy};

  function abs(u){
    try{ return new URL(u, _BASE).href; }catch(e){ return u; }
  }
  function nav(u){
    window.parent.postMessage({ type: 'EP_NAV', url: abs(u) }, '*');
  }

  /* ── <a> clicks ─────────────────────────────────────────────────────────── */
  document.addEventListener('click', function(e){
    var a = e.target.closest('a');
    if(!a) return;
    var href = a.getAttribute('href');
    if(!href || href.charAt(0)==='#' || /^javascript:/i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    nav(href);
  }, true);

  /* ── Form submit event (catches most cases) ─────────────────────────────── */
  document.addEventListener('submit', function(e){
    e.preventDefault();
    e.stopPropagation();
    var f      = e.target;
    var action = abs(f.getAttribute('action') || _BASE);
    var params = new URLSearchParams(new FormData(f)).toString();
    nav(action + (params ? '?' + params : ''));
  }, true);

  /* ── HTMLFormElement.prototype.submit override ───────────────────────────
     Google (and many sites) call form.submit() programmatically which does
     NOT fire the 'submit' event — so we must override the method itself.    */
  var _origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function(){
    var action = abs(this.getAttribute('action') || _BASE);
    var params = new URLSearchParams(new FormData(this)).toString();
    nav(action + (params ? '?' + params : ''));
  };

  /* ── Google keyboard search: Enter on name="q" ──────────────────────────── */
  document.addEventListener('keydown', function(e){
    if(e.key !== 'Enter') return;
    var inp = e.target;
    if(inp.tagName !== 'INPUT') return;
    var name = (inp.getAttribute('name') || '').toLowerCase();
    if(name !== 'q' && name !== 'search' && name !== 'query') return;
    e.preventDefault();
    e.stopPropagation();
    var q = encodeURIComponent(inp.value.trim());
    if(!q) return;
    var host = (function(){ try{ return new URL(_BASE).hostname; }catch(e){ return ''; } })();
    var searchBase = /google/i.test(host)   ? 'https://www.google.com/search?q='
                   : /bing/i.test(host)     ? 'https://www.bing.com/search?q='
                   : /yahoo/i.test(host)    ? 'https://search.yahoo.com/search?p='
                   : /ddg|duck/i.test(host) ? 'https://duckduckgo.com/?q='
                   : 'https://www.google.com/search?q=';
    nav(searchBase + q);
  }, true);

  /* ── Intercept JS-driven image src (Google lazy-loads logos etc.) ────────── */
  var _origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    if((name === 'src' || name === 'data-src') && this.tagName === 'IMG'){
      try{
        var a = abs(value);
        if(/^https?:\/\//i.test(a) && a.indexOf(_PROXY_PREFIX) !== 0){
          return _origSetAttr.call(this, name, _PROXY_PREFIX + encodeURIComponent(a));
        }
      }catch(e){}
    }
    return _origSetAttr.call(this, name, value);
  };

  /* ── pushState / replaceState (YouTube SPA navigation) ─────────────────── */
  var _origPush    = history.pushState.bind(history);
  var _origReplace = history.replaceState.bind(history);
  history.pushState = function(state, title, url){
    if(url) nav(url);
  };
  history.replaceState = function(state, title, url){
    if(url) nav(url);
  };

  /* ── window.open ────────────────────────────────────────────────────────── */
  var _origOpen = window.open;
  window.open = function(url, target, features){
    if(url && url !== 'about:blank' && !/^javascript:/i.test(url)){
      nav(url); return null;
    }
    return _origOpen ? _origOpen.call(window, url, target, features) : null;
  };

  /* ── location.assign / replace ──────────────────────────────────────────── */
  try{
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
app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.1' }));

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

  // Derive the backend base for injecting into rewritten HTML
  const reqOrigin = req.headers['x-forwarded-proto']
    ? `${req.headers['x-forwarded-proto'].split(',')[0].trim()}://${req.headers['x-forwarded-host'] || req.headers.host}`
    : `${req.protocol}://${req.headers.host}`;
  const backendBase = getBackendBase(reqOrigin);

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
      decompress:     true,
      validateStatus: () => true,
    });

    // Forward safe response headers
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
      const rewritten = rewriteHtml(htmlText, targetUrl, backendBase);
      return res.status(response.status).send(rewritten);
    }

    return res.status(response.status).send(response.data);

  } catch (err) {
    console.error('[proxy] error:', err.message);
    return res.status(502).json({ error: 'Proxy fetch failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EP Proxy server v2.1 running on http://localhost:${PORT}`);
});
