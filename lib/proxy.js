// Reverse-proxy plumbing for /m/<name>/ machine routes.
// Pure helpers are exported for unit tests; proxyHttp/proxyUpgrade do the I/O.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

// Basic-auth header value for a backend that requires it (Kasm media desktops).
// The panel satisfies the backend's auth server-side so the browser never sees a
// login prompt inside the embedded screen.
function basicAuth(auth) { return auth ? `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}` : null; }

// Name grammar mirrors core.js NAME_RE. Parsing the RAW path means %-encoded
// traversal (/m/..%2f) simply fails the match -> 404.
const PROXY_RE = /^\/m\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})(\/[^\s]*)?$/;

export function parseProxyPath(rawPath) {
  const q = rawPath.indexOf('?');
  const pathOnly = q === -1 ? rawPath : rawPath.slice(0, q);
  const m = pathOnly.match(PROXY_RE);
  if (!m) return null;
  return { name: m[1], rest: m[2] ?? null, query: q === -1 ? '' : rawPath.slice(q) };
}

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Headers for the backend HTTP request: drop hop-by-hop (+ anything named in
// Connection), drop the panel session cookie, rewrite host, add X-Forwarded-*.
export function filterRequestHeaders(headers, { port, remoteAddr }) {
  const out = {};
  const alsoDrop = new Set();
  if (headers.connection) {
    for (const token of String(headers.connection).split(',')) alsoDrop.add(token.trim().toLowerCase());
  }
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || alsoDrop.has(k) || k === 'cookie' || k === 'host') continue;
    // referer: the SSO redeem URL carries a single-use token in its query string
    // (/sso?t=...). Forwarding Referer handed that token to the container, which
    // is untrusted. Nothing in a machine backend needs it.
    if (k === 'referer') continue;
    // authorization: always dropped here; proxyHttp/buildUpgradeHead inject the
    // panel's own backend credential afterwards when the template has one. Left
    // in place it would let a client speak to backends that have no auth of
    // their own (the Selenium nodes) with attacker-chosen credentials.
    if (k === 'authorization') continue;
    out[key] = value;
  }
  out.host = `127.0.0.1:${port}`;
  const prior = headers['x-forwarded-for'];
  out['x-forwarded-for'] = prior ? `${prior}, ${remoteAddr}` : String(remoteAddr || '');
  out['x-forwarded-proto'] = 'http';
  if (headers.host) out['x-forwarded-host'] = headers.host;
  return out;
}

// Response headers a machine's backend must NEVER be able to dictate. The
// container is inside the panel's security boundary (its screen is framed by the
// panel and reached with the viewer's cookie), and a user can replace the
// listener on their own machine's port, so anything it sets here would act on
// other users' browsers:
//   set-cookie / set-cookie2  — cookies ignore ports, so a machine could
//     overwrite the viewer's vmp_session and pin them into an attacker session
//     (session fixation). Path=/api sorts ahead of the real cookie.
//   access-control-*          — would opt the machine origin into cross-origin
//     reads by any site the attacker controls.
//   the security headers below — the panel sets its own; a backend value must
//     not be able to weaken or (because Node merges same-name headers) take
//     precedence over the panel's.
const STRIP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'set-cookie2',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods',
  'access-control-expose-headers', 'access-control-max-age',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options', 'referrer-policy',
  'strict-transport-security', 'permissions-policy',
]);

export function filterResponseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || STRIP_RESPONSE_HEADERS.has(k)) continue;
    out[key] = value;
  }
  return out;
}

// Rebuild the raw HTTP/1.1 upgrade head for the backend socket. Iterates
// rawHeaders pairwise (preserves case and duplicates); rewrites host+origin;
// drops cookie; keeps connection/upgrade/sec-websocket-* verbatim.
export function buildUpgradeHead({ method, target, rawHeaders, port, scheme = 'http', auth = null }) {
  let head = `${method} ${target} HTTP/1.1\r\n`;
  let sawAuth = false;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === 'cookie') continue;
    if (lower === 'authorization') { if (!auth) { sawAuth = true; } else continue; } // panel injects its own
    let value = rawHeaders[i + 1];
    if (lower === 'host') value = `127.0.0.1:${port}`;
    else if (lower === 'origin') value = `${scheme}://127.0.0.1:${port}`;
    head += `${name}: ${value}\r\n`;
    if (lower === 'authorization') sawAuth = true;
  }
  const injected = basicAuth(auth);
  if (injected && !sawAuth) head += `Authorization: ${injected}\r\n`;
  head += '\r\n';
  return head;
}

// Host-header guard: hostname must be localhost or an IP literal (DNS names
// cannot be rebound to us if we never accept DNS names other than localhost),
// and the port must match. Handles bracketed IPv6.
// extraHosts: additional hostnames to allow (e.g. the configured mDNS name
// "mymac.local"). mDNS names are link-local (resolved by multicast on the LAN,
// never by public DNS), so allowing a specific one does not open a DNS-rebinding
// hole the way an arbitrary public DNS name would.
export function isAllowedHost(hostHeader, expectedPort, extraHosts = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let hostname; let portStr;
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    if (end === -1) return false;
    hostname = hostHeader.slice(1, end);
    const rest = hostHeader.slice(end + 1);
    if (rest === '') portStr = null;
    else if (rest.startsWith(':')) portStr = rest.slice(1);
    else return false;
  } else {
    const colon = hostHeader.lastIndexOf(':');
    if (colon === -1) { hostname = hostHeader; portStr = null; }
    else { hostname = hostHeader.slice(0, colon); portStr = hostHeader.slice(colon + 1); }
  }
  const port = portStr === null ? 80 : parseInt(portStr, 10);
  if (port !== expectedPort) return false;
  if (hostname === 'localhost') return true;
  if (net.isIP(hostname) !== 0) return true;
  return extraHosts.includes(hostname.toLowerCase());
}

export function isAllowedOrigin(origin, expectedPort, extraHosts = []) {
  if (typeof origin !== 'string') return false;
  if (!origin.startsWith('http://')) return false;
  return isAllowedHost(origin.slice('http://'.length), expectedPort, extraHosts);
}

// `back: false` drops the "Back to panel" link — machine-origin pages are shown
// inside PRISM's desktop frame, where "/" is only the machine origin's 404.
// `refreshSec` reloads the page on its own (a desktop that is still booting).
export function errorPage(status, title, message, { back = true, refreshSec = 0 } = {}) {
  const refresh = refreshSec > 0 ? `<meta http-equiv="refresh" content="${Math.floor(refreshSec)}">` : '';
  const link = back ? '<a href="/">&larr; Back to PRISM Virtual Desktop</a>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${title}</title><style>
body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f1115;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.box{max-width:420px;padding:32px;text-align:center}h1{font-size:18px;margin:0 0 10px}p{color:#8b93a3;margin:0 0 18px;line-height:1.5}a{color:#4f8cff;text-decoration:none}
</style></head><body><div class="box"><h1>${title}</h1><p>${message}</p>${link}</div></body></html>`;
}

const PROXY_BODY_LIMIT = 10 * 1024 * 1024;

// HTTP request proxying: stream both directions, friendly 502/504 pages.
export function proxyHttp({ req, res, port, target, name, frameAncestors = "'self'", backendTls = false, backendAuth = null }) {
  const headers = filterRequestHeaders(req.headers, { port, remoteAddr: req.socket.remoteAddress });
  const auth = basicAuth(backendAuth);
  if (auth) {
    // Never let a client-sent Authorization reach the backend; inject ours.
    // The header name MUST be capitalised "Authorization": KasmVNC's HTTP server
    // rejects a lowercase "authorization" with 401 (verified against the live
    // image). buildUpgradeHead already emits the capitalised form for WS.
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
    headers.Authorization = auth;
  }
  const transport = backendTls ? https : http;
  const backendReq = transport.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: target,
    headers,
    ...(backendTls ? { rejectUnauthorized: false, servername: 'localhost' } : {}),
  });
  backendReq.setTimeout(10_000, () => {
    backendReq.destroy(new Error('backend timeout'));
  });

  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > PROXY_BODY_LIMIT) {
    res.writeHead(413, { 'Content-Type': 'text/plain' });
    res.end('Payload too large');
    backendReq.destroy();
    return;
  }
  let bodyBytes = 0;
  req.on('data', (chunk) => {
    bodyBytes += chunk.length;
    if (bodyBytes > PROXY_BODY_LIMIT) { req.destroy(); backendReq.destroy(); }
  });
  req.pipe(backendReq);

  backendReq.on('response', (backendRes) => {
    if (res.destroyed) { backendRes.destroy(); return; }
    res.writeHead(backendRes.statusCode, {
      ...filterResponseHeaders(backendRes.headers),
      // Screens are served from the machine origin (panelPort+1) and framed by
      // the panel origin, so X-Frame-Options SAMEORIGIN would block them. Use a
      // CSP frame-ancestors allow-list scoped to exactly the panel origin — this
      // still blocks any third-party site from framing a container screen.
      'Content-Security-Policy': `frame-ancestors ${frameAncestors}`,
      'X-Content-Type-Options': 'nosniff',
      // noVNC's static server sends no cache-control; without this the browser
      // heuristically caches vnc.html and would replay stale security headers.
      'Cache-Control': 'no-store',
    });
    backendRes.pipe(res);
    // P1-7: if the backend response dies mid-stream, tear down the client
    // response instead of leaving it hanging until requestTimeout (120s).
    backendRes.on('error', () => res.destroy());
  });
  backendReq.on('error', (err) => {
    if (res.headersSent) { res.destroy(); return; }
    const timeout = /timeout/i.test(err.message);
    const status = timeout ? 504 : 502;
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `frame-ancestors ${frameAncestors}`, 'X-Content-Type-Options': 'nosniff' });
    // Usually a desktop that is still booting: retry on its own instead of
    // leaving the user to guess that Reload is the fix.
    res.end(errorPage(status, timeout ? 'Desktop timed out' : 'Desktop is starting',
      `“${name}” is not answering yet. This page retries every few seconds.`, { back: false, refreshSec: 4 }));
  });
  res.on('close', () => backendReq.destroy());
}

// WebSocket proxying: raw TCP splice, no frame or handshake parsing.
export function proxyUpgrade({ req, socket, head, port, target, upgradedSockets, maxSockets, backendTls = false, backendAuth = null }) {
  if (upgradedSockets.size >= maxSockets * 2) { // set holds both ends
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  // Reserve the slot SYNCHRONOUSLY, before the async connect. Membership used to
  // be added inside the connect callback, so every upgrade arriving in one
  // event-loop turn observed size 0, passed the check, and connected — the
  // ceiling was bypassable by any concurrent burst, and each admitted upgrade
  // holds two file descriptors. Reserving here also means killTunnelsForUser can
  // see (and tear down) a tunnel that is still connecting.
  //
  // Accounting note: a reserved-but-not-yet-spliced connection contributes one
  // entry and a spliced one contributes two, so a burst can transiently admit
  // more than `maxSockets` connections before settling. server.maxConnections
  // provides the hard per-origin bound; this check bounds steady state.
  upgradedSockets.add(socket);
  let spliced = false;
  // TLS to the backend (Kasm media desktops) or a plain TCP splice (noVNC).
  const backend = backendTls
    ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, servername: 'localhost' })
    : net.connect(port, '127.0.0.1');
  const connectEvent = backendTls ? 'secureConnect' : 'connect';

  const cleanup = () => {
    upgradedSockets.delete(socket);
    upgradedSockets.delete(backend);
    socket.destroy();
    backend.destroy();
  };

  backend.on(connectEvent, () => {
    spliced = true;
    upgradedSockets.add(socket);   // already reserved; idempotent
    upgradedSockets.add(backend);
    for (const s of [socket, backend]) {
      s.setNoDelay(true);
      s.setKeepAlive(true, 30_000);
      s.setTimeout(0);
    }
    backend.write(buildUpgradeHead({ method: req.method, target, rawHeaders: req.rawHeaders, port, scheme: backendTls ? 'https' : 'http', auth: backendAuth }));
    if (head && head.length) backend.write(head);
    backend.pipe(socket);
    socket.pipe(backend);
  });

  backend.on('error', () => {
    // `spliced` rather than set membership: the socket is now in the set from the
    // moment it is reserved, so membership no longer distinguishes "handshake not
    // yet completed" (a 502 is still writable) from "already relaying bytes".
    if (!socket.destroyed && socket.writable && !spliced) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    cleanup();
  });
  socket.on('error', cleanup);
  backend.on('close', cleanup);
  socket.on('close', cleanup);
}
