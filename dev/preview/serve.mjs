// Dev-only preview server for the web export (dev/preview/preview.sh): static files from ROOT (SPA fallback to index.html)
// and a same-origin proxy for /api/* and /__mock/* to the mock server, so the browser needs no
// CORS. Never point UPSTREAM at the owner's real server (5000/8765).
//   ROOT=<export dir> PORT=5097 UPSTREAM=http://127.0.0.1:5099 node serve.mjs
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join, normalize } from 'node:path'

const ROOT = process.env.ROOT
const PORT = Number(process.env.PORT ?? 5097)
const UPSTREAM = new URL(process.env.UPSTREAM ?? 'http://127.0.0.1:5099')
if (!ROOT) throw new Error('ROOT is required')
if (['5000', '8765'].includes(UPSTREAM.port)) throw new Error('refusing the real server ports')

// The app refuses loopback servers in a release bundle (urlRules: dev_host_in_release), and a
// dev export cannot load its route chunks statically. So the onboarding uses an alias host,
// "oa-preview.local" (a home host, http allowed), and this shim, injected into index.html only by
// this preview server, sends the alias to 127.0.0.1: fetch and XHR stay same-origin (no CORS) and
// the WebSocket reaches the mock's WS port.
const ALIAS = 'oa-preview.local'
const SHIM = `<script>(function(){
var A=${JSON.stringify(ALIAS)};
function fix(u){return typeof u==='string'?u.split('//'+A).join('//127.0.0.1'):u}
var F=window.fetch;window.fetch=function(i,o){
 if(typeof i==='string')i=fix(i);else if(i&&i.url&&i.url.indexOf('//'+A)>=0)i=new Request(fix(i.url),i);
 return F.call(this,i,o)};
var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){
 arguments[1]=fix(String(u));return O.apply(this,arguments)};
var W=window.WebSocket;function S(u,p){return p===undefined?new W(fix(String(u))):new W(fix(String(u)),p)}
S.prototype=W.prototype;S.CONNECTING=0;S.OPEN=1;S.CLOSING=2;S.CLOSED=3;window.WebSocket=S;
var P='oa-preview-secure:';function g(k){try{return sessionStorage.getItem(P+k)}catch(e){return null}}
window.__oaPreviewSecure={
 getValueWithKeyAsync:function(k){return Promise.resolve(g(k))},
 getValueWithKeySync:function(k){return g(k)},
 setValueWithKeyAsync:function(v,k){sessionStorage.setItem(P+k,v);return Promise.resolve()},
 setValueWithKeySync:function(v,k){sessionStorage.setItem(P+k,v)},
 deleteValueWithKeyAsync:function(k){sessionStorage.removeItem(P+k);return Promise.resolve()}};
})();</script>`

// expo-secure-store has no web implementation (its web module is {}), so the onboarding cannot
// save the key. Preview only: the bundle's calls into that module fall through to
// window.__oaPreviewSecure (sessionStorage, the mock's fake key). Applied as the file is served;
// the export on disk stays as Metro wrote it.
const SECURE_CALL = /\b(\w+)\.default\.(\w*ValueWithKey\w*)\b/g
const patchJs = (js) => js.replace(SECURE_CALL, '(window.__oaPreviewSecure||$1.default).$2')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function proxy(req, res) {
  const up = http.request(
    {
      host: UPSTREAM.hostname,
      port: UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    },
  )
  up.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'error', message: `proxy: ${e.message}` }))
  })
  req.pipe(up)
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mock/')) {
      return proxy(req, res)
    }
    let file = normalize(join(ROOT, decodeURIComponent(url.pathname)))
    if (!file.startsWith(normalize(ROOT))) {
      res.writeHead(403)
      return res.end()
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const html = `${file.replace(/\/$/, '')}.html`
      file = existsSync(html) ? html : join(ROOT, 'index.html')
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    if (file === join(ROOT, 'index.html')) {
      return res.end(readFileSync(file, 'utf8').replace('<head>', `<head>${SHIM}`))
    }
    if (extname(file) === '.js' && !file.includes('/www.bundle/')) {
      return res.end(patchJs(readFileSync(file, 'utf8')))
    }
    createReadStream(file).pipe(res)
  })
  .listen(PORT, '127.0.0.1', () => console.log(`PREVIEW_READY http://127.0.0.1:${PORT}`))
