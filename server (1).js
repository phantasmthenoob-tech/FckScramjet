const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Per-type Accept headers so servers return the right format ────────────────
function acceptHeader(hint) {
  if (!hint) return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  if (hint === 'image')      return 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
  if (hint === 'css')        return 'text/css,*/*;q=0.1';
  if (hint === 'javascript') return '*/*';
  if (hint === 'font')       return '*/*';
  return '*/*';
}

function makeHeaders(parsed, hint) {
  return {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept':          acceptHeader(hint),
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Referer':         parsed.origin + '/',
    'Origin':          parsed.origin,
    'Host':            parsed.host,
    'Sec-CH-UA':            '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    'Sec-CH-UA-Mobile':     '?0',
    'Sec-CH-UA-Platform':   '"Windows"',
    'Sec-Fetch-Dest':       hint === 'image' ? 'image' : hint === 'css' ? 'style' : hint === 'javascript' ? 'script' : hint === 'font' ? 'font' : 'document',
    'Sec-Fetch-Mode':       (hint && hint !== 'document') ? 'no-cors' : 'navigate',
    'Sec-Fetch-Site':       'cross-site',
    'DNT': '1',
  };
}

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
  'content-encoding',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseUrl(raw) {
  let url = (raw || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const u = new URL(url);
  if (u.hostname === 'google.com') u.hostname = 'www.google.com';
  return u.toString();
}

function getBackendBase(req) {
  if (process.env.BACKEND_URL) return process.env.BACKEND_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function proxyHref(absUrl, backendBase) {
  return `${backendBase}/fetch?url=${encodeURIComponent(absUrl)}`;
}

function resolve(url, base) {
  try { return new URL(url, base).href; } catch { return null; }
}

function guessMime(ext) {
  const map = {
    html:'text/html', htm:'text/html',
    css:'text/css',
    js:'application/javascript', mjs:'application/javascript',
    json:'application/json',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
    gif:'image/gif', webp:'image/webp', svg:'image/svg+xml',
    ico:'image/x-icon', avif:'image/avif', bmp:'image/bmp',
    woff:'font/woff', woff2:'font/woff2',
    ttf:'font/ttf', otf:'font/otf', eot:'application/vnd.ms-fontobject',
    mp4:'video/mp4', webm:'video/webm', ogg:'video/ogg',
    mp3:'audio/mpeg', wav:'audio/wav', flac:'audio/flac',
    pdf:'application/pdf', zip:'application/zip',
    xml:'application/xml', txt:'text/plain',
  };
  return map[(ext||'').toLowerCase()] || null;
}

// ── CSS rewriter ──────────────────────────────────────────────────────────────
function rewriteCss(css, pageUrl, backendBase) {
  // url('...') url("...") url(...)
  css = css.replace(
    /url\(\s*(['"]?)((?!data:|#|blob:)[^)'"\\s]+)\1\s*\)/gi,
    (m, q, url) => {
      const abs = resolve(url.trim(), pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `url(${q}${proxyHref(abs, backendBase)}${q})`;
    }
  );
  // @import "url"
  css = css.replace(
    /@import\s+(['"])((?!data:)[^'"]+)\1/gi,
    (m, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `@import ${q}${proxyHref(abs, backendBase)}${q}`;
    }
  );
  return css;
}

// ── JS fetch/XHR shim ────────────────────────────────────────────────────────
function rewriteJs(js, pageUrl, backendBase) {
  const shim = `
(function(){
  var _PFX=${JSON.stringify(backendBase+'/fetch?url=')};
  var _BASE=${JSON.stringify(pageUrl)};
  function _abs(u){try{return new URL(u,_BASE).href;}catch(e){return u;}}
  function _w(u){
    if(!u||typeof u!=='string')return u;
    if(/^(data:|blob:|javascript:|#)/i.test(u))return u;
    var a=_abs(u);
    if(!/^https?:\\/\\//i.test(a))return u;
    if(a.indexOf(_PFX)===0)return u;
    return _PFX+encodeURIComponent(a);
  }
  var _oF=window.fetch;
  if(_oF)window.fetch=function(i,o){try{if(typeof i==='string')i=_w(i);else if(i&&i.url)i=new Request(_w(i.url),i);}catch(e){}return _oF.call(this,i,o);};
  var _oX=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);try{a[1]=_w(u);}catch(e){}return _oX.apply(this,a);};
})();
`;
  return shim + js;
}

// ── HTML rewriter ─────────────────────────────────────────────────────────────
function rewriteHtml(html, pageUrl, backendBase) {

  // 1. src / href / data-src / action and lazy-load variants
  html = html.replace(
    /(\s(?:src|href|data-src|data-href|data-lazy|data-original|data-url|action)\s*=\s*)(['"])((?!data:|javascript:|#|blob:|about:|mailto:|tel:)[^'"]+)\2/gi,
    (m, attr, q, url) => {
      const abs = resolve(url, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `${attr}${q}${proxyHref(abs, backendBase)}${q}`;
    }
  );

  // 2. CSS url() inside style attrs and <style> blocks
  html = html.replace(
    /url\(\s*(['"]?)((?!data:|#|blob:)[^)'"\\s]+)\1\s*\)/gi,
    (m, q, url) => {
      const abs = resolve(url.trim(), pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return m;
      return `url(${q}${proxyHref(abs, backendBase)}${q})`;
    }
  );

  // 3. srcset
  html = html.replace(
    /(\ssrcset\s*=\s*)(['"])((?!data:)[^'"]+)\2/gi,
    (m, attr, q, val) => {
      const rewritten = val.replace(/(https?:\/\/[^\s,]+)/gi, u => proxyHref(u, backendBase));
      return `${attr}${q}${rewritten}${q}`;
    }
  );

  // 4. Rewrite @import inside <style> blocks
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, open, css, close) => open + rewriteCss(css, pageUrl, backendBase) + close
  );

  // 5. Inject full shim before </head> (or at top)
  const shimBase  = JSON.stringify(pageUrl);
  const shimProxy = JSON.stringify(backendBase + '/fetch?url=');

  const shim = `<base href="${pageUrl}">
<script>
(function(){
  var _BASE         = ${shimBase};
  var _PROXY_PREFIX = ${shimProxy};

  function abs(u){ try{ return new URL(u,_BASE).href; }catch(e){ return u; } }
  function wrap(u){
    if(!u||typeof u!=='string') return u;
    if(/^(data:|blob:|javascript:|#)/i.test(u)) return u;
    var a=abs(u);
    if(!/^https?:\\/\\//i.test(a)) return u;
    if(a.indexOf(_PROXY_PREFIX)===0) return u;
    return _PROXY_PREFIX+encodeURIComponent(a);
  }
  function nav(u){ window.parent.postMessage({type:'EP_NAV',url:abs(u)},'*'); }

  /* fetch */
  var _oF=window.fetch;
  if(_oF) window.fetch=function(i,o){
    try{ if(typeof i==='string') i=wrap(i); else if(i&&i.url) i=new Request(wrap(i.url),i); }catch(e){}
    return _oF.call(this,i,o);
  };

  /* XHR */
  var _oX=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    var a=Array.prototype.slice.call(arguments);
    try{a[1]=wrap(u);}catch(e){}
    return _oX.apply(this,a);
  };

  /* Image src property */
  try{
    var _iD=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    if(_iD&&_iD.set) Object.defineProperty(HTMLImageElement.prototype,'src',{
      set:function(v){_iD.set.call(this,wrap(v));},
      get:function(){return _iD.get.call(this);},
      configurable:true
    });
  }catch(e){}

  /* setAttribute */
  var _oSA=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    var n=(name||'').toLowerCase();
    if(typeof value==='string'&&(n==='src'||n==='href'||n==='data-src'||n==='data-lazy'||n==='data-original')){
      try{ var w=wrap(value); if(w!==value) return _oSA.call(this,name,w); }catch(e){}
    }
    return _oSA.call(this,name,value);
  };

  /* <a> clicks */
  document.addEventListener('click',function(e){
    var a=e.target.closest('a'); if(!a) return;
    var href=a.getAttribute('href');
    if(!href||href.charAt(0)==='#'||/^javascript:/i.test(href)) return;
    e.preventDefault(); e.stopPropagation(); nav(href);
  },true);

  /* form submit */
  document.addEventListener('submit',function(e){
    e.preventDefault(); e.stopPropagation();
    var f=e.target, action=abs(f.getAttribute('action')||_BASE);
    var params=new URLSearchParams(new FormData(f)).toString();
    nav(action+(params?'?'+params:''));
  },true);
  HTMLFormElement.prototype.submit=function(){
    var action=abs(this.getAttribute('action')||_BASE);
    var params=new URLSearchParams(new FormData(this)).toString();
    nav(action+(params?'?'+params:''));
  };

  /* keyboard search */
  document.addEventListener('keydown',function(e){
    if(e.key!=='Enter') return;
    var inp=e.target; if(inp.tagName!=='INPUT') return;
    var n=(inp.getAttribute('name')||'').toLowerCase();
    if(n!=='q'&&n!=='search'&&n!=='query') return;
    e.preventDefault(); e.stopPropagation();
    var q=encodeURIComponent(inp.value.trim()); if(!q) return;
    var host=(function(){try{return new URL(_BASE).hostname;}catch(e){return '';}})();
    var sb=/google/i.test(host)?'https://www.google.com/search?q='
          :/bing/i.test(host)?'https://www.bing.com/search?q='
          :/yahoo/i.test(host)?'https://search.yahoo.com/search?p='
          :/ddg|duck/i.test(host)?'https://duckduckgo.com/?q='
          :'https://www.google.com/search?q=';
    nav(sb+q);
  },true);

  /* SPA nav */
  history.pushState=function(s,t,u){if(u)nav(u);};
  history.replaceState=function(s,t,u){if(u)nav(u);};

  /* window.open */
  var _oO=window.open;
  window.open=function(url,target,features){
    if(url&&url!=='about:blank'&&!/^javascript:/i.test(url)){nav(url);return null;}
    return _oO?_oO.call(window,url,target,features):null;
  };

  /* location */
  try{window.location.assign=function(u){nav(u);};}catch(e){}
  try{window.location.replace=function(u){nav(u);};}catch(e){}

  /* MutationObserver: fix dynamically added images */
  new MutationObserver(function(muts){
    muts.forEach(function(mut){
      mut.addedNodes.forEach(function(node){
        if(!node||node.nodeType!==1) return;
        var imgs=[];
        if(node.tagName==='IMG') imgs.push(node);
        if(node.querySelectorAll) [].push.apply(imgs,node.querySelectorAll('img[src]'));
        imgs.forEach(function(img){
          if(img.src&&img.src.indexOf(_PROXY_PREFIX)<0){
            try{img.src=wrap(img.src);}catch(e){}
          }
        });
      });
    });
  }).observe(document.documentElement,{childList:true,subtree:true});

  window.parent.postMessage({type:'EP_READY'},'*');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', version: '2.3', ts: Date.now() }));

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

  const backendBase = getBackendBase(req);

  // Guess content type from extension for smarter headers
  const ext = (parsed.pathname.split('.').pop() || '').toLowerCase().split('?')[0];
  const extHint = {
    png:'image', jpg:'image', jpeg:'image', gif:'image', webp:'image',
    svg:'image', ico:'image', avif:'image', bmp:'image',
    css:'css', js:'javascript', mjs:'javascript',
    woff:'font', woff2:'font', ttf:'font', eot:'font', otf:'font',
  }[ext] || null;

  try {
    const response = await axios.get(targetUrl, {
      headers: makeHeaders(parsed, extHint),
      responseType:   'arraybuffer',
      timeout:        25000,
      maxRedirects:   10,
      decompress:     true,
      validateStatus: () => true,
    });

    // Forward safe headers
    for (const [key, value] of Object.entries(response.headers)) {
      if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    const rawCT      = response.headers['content-type'] || '';
    const contentType = rawCT.split(';')[0].trim() || guessMime(ext) || 'application/octet-stream';

    res.setHeader('Content-Type', contentType + (contentType.startsWith('text') ? '; charset=utf-8' : ''));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.removeHeader('content-length');

    const isHtml = /text\/html/i.test(contentType);
    const isCss  = /text\/css/i.test(contentType) || ext === 'css';
    const isJs   = /javascript/i.test(contentType) || ext === 'js' || ext === 'mjs';

    if (isHtml) {
      const text = response.data.toString('utf-8');
      return res.status(response.status).send(rewriteHtml(text, targetUrl, backendBase));
    }
    if (isCss) {
      const text = response.data.toString('utf-8');
      return res.status(response.status).send(rewriteCss(text, targetUrl, backendBase));
    }
    if (isJs) {
      const text = response.data.toString('utf-8');
      return res.status(response.status).send(rewriteJs(text, targetUrl, backendBase));
    }

    // Images, fonts, audio, video, etc. — pass binary through unchanged
    return res.status(response.status).send(response.data);

  } catch (err) {
    console.error('[proxy] error fetching', targetUrl, ':', err.message);
    return res.status(502).json({ error: 'Proxy fetch failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EP Proxy server v2.3 running on http://localhost:${PORT}`);
});
