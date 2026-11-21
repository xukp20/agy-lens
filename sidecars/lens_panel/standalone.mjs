#!/usr/bin/env node
/**
 * AGY Lens Standalone Web Server (zero npm dependencies, no sidecar_sdk required).
 * Designed for Headless Linux / SSH port forwarding & reverse-proxy deployments.
 *
 * Usage:
 *   node sidecars/lens_panel/standalone.mjs [--host 127.0.0.1] [--port 4319]
 *     [--base-path /] [--token <secret> | --token-file <path>] [--trust-proxy]
 *     [--allowed-hosts <h1,h2>] [--read-only] [--sources cli,desktop] [--data-dir <dir>]
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLensRuntime } from './lib/server_core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HOSTNAME_RE = /^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)$/i;

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

export function isLoopbackPeerAddress(addr) {
  const s = String(addr || '').trim().toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

export function normalizeBasePath(raw) {
  let s = String(raw || '').trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  if (!s || s === '/') return '';
  if (s.includes('..') || /[\r\n\s]/.test(s)) {
    throw new Error(`Invalid --base-path: "${raw}"`);
  }
  return s;
}

function parseHostnameFromHostHeader(rawHost) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim();
  if (!trimmed || /[\r\n\s/@\\]/.test(trimmed)) return null;
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    const hostPart = trimmed.slice(0, closeIdx + 1).toLowerCase();
    const rest = trimmed.slice(closeIdx + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return HOSTNAME_RE.test(hostPart) ? hostPart : null;
  }
  const colonIdx = trimmed.indexOf(':');
  const hostPart = (colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx)).toLowerCase();
  const portPart = colonIdx === -1 ? '' : trimmed.slice(colonIdx + 1);
  if (portPart && !/^\d{1,5}$/.test(portPart)) return null;
  return HOSTNAME_RE.test(hostPart) ? hostPart : null;
}

function sha256Digest(text) {
  return createHash('sha256').update(String(text || ''), 'utf-8').digest();
}

export function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return timingSafeEqual(sha256Digest(a), sha256Digest(b));
}

export function deriveCookieValue(token) {
  return createHmac('sha256', String(token)).update('agy-lens-cookie-v1').digest('hex');
}

function parseCookies(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function readBodyLimited(req, limitBytes = MAX_BODY_BYTES) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        settled = true;
        const err = new Error(`Request body exceeds ${limitBytes} bytes`);
        err.statusCode = 413;
        rejectPromise(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    });
  });
}

function buildStandalonePreloadJs() {
  const varsDark = {
    '--background': '#18191c',
    '--card': '#202227',
    '--secondary': '#2a2d34',
    '--muted': '#24262c',
    '--foreground': '#eceef2',
    '--secondary-foreground': '#c8ccd4',
    '--muted-foreground': '#8f96a3',
    '--border': 'rgba(255,255,255,0.09)',
    '--card-border': 'rgba(255,255,255,0.11)',
    '--primary': '#5b9cf6',
    '--primary-foreground': '#ffffff',
    '--error': '#e05d5d',
  };
  const varsLight = {
    '--background': '#f7f7f8',
    '--card': '#ffffff',
    '--secondary': '#e6e7e9',
    '--muted': '#eff0f1',
    '--foreground': '#1d1f21',
    '--secondary-foreground': '#3d4348',
    '--muted-foreground': '#5d676f',
    '--border': 'rgba(0,0,0,0.08)',
    '--card-border': 'rgba(0,0,0,0.10)',
    '--primary': '#1a73e8',
    '--primary-foreground': '#ffffff',
    '--error': '#cb3d3d',
  };

  return `(function () {
  var VARS = {
    dark: ${JSON.stringify(varsDark)},
    light: ${JSON.stringify(varsLight)}
  };
  function detectInitialTheme() {
    try {
      var qp = new URLSearchParams(window.location.search).get('theme');
      if (qp === 'dark' || qp === 'light') return qp;
    } catch (_) {}
    try {
      var saved = window.localStorage.getItem('agy-lens-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (_) {}
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (_) {}
    return 'light';
  }
  function applyTheme(mode, persist) {
    var m = mode === 'dark' ? 'dark' : 'light';
    var vars = VARS[m];
    var root = document.documentElement;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        root.style.setProperty(k, vars[k]);
      }
    }
    root.dataset.theme = m;
    if (persist) {
      try { window.localStorage.setItem('agy-lens-theme', m); } catch (_) {}
    }
    return m;
  }
  window.__AGY_LENS_STANDALONE__ = true;
  window.__AGY_LENS_SET_THEME__ = function (mode) { return applyTheme(mode, true); };
  applyTheme(detectInitialTheme(), false);
})();
`;
}

function parseStrictPort(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`Invalid --port: ${raw}`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid --port: ${raw}`);
  }
  return n;
}

export function parseStrictSources(raw) {
  const tokens = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('Invalid --sources: expected cli, desktop, or cli,desktop');
  }
  const valid = [];
  for (const tok of tokens) {
    if (tok !== 'desktop' && tok !== 'cli') {
      throw new Error(`Invalid --sources entry: ${tok} (expected cli or desktop)`);
    }
    if (!valid.includes(tok)) valid.push(tok);
  }
  return valid;
}

function stripIpv6Brackets(h) {
  const s = String(h || '').trim();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

export function parseStandaloneArgs(argv = process.argv.slice(2)) {
  const opts = {
    host: '127.0.0.1',
    port: 4319,
    basePath: '',
    token: process.env.AGY_LENS_TOKEN || '',
    tokenFile: '',
    trustProxy: false,
    allowedHosts: [],
    readOnly: false,
    sources: null,
    dataDir: null,
    noAuth: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--host') opts.host = next();
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '-p' || a === '--port') opts.port = parseStrictPort(next());
    else if (a.startsWith('--port=')) opts.port = parseStrictPort(a.slice(7));
    else if (a === '--base-path') opts.basePath = next();
    else if (a.startsWith('--base-path=')) opts.basePath = a.slice(12);
    else if (a === '--token') opts.token = next();
    else if (a.startsWith('--token=')) opts.token = a.slice(8);
    else if (a === '--token-file') opts.tokenFile = next();
    else if (a.startsWith('--token-file=')) opts.tokenFile = a.slice(13);
    else if (a === '--trust-proxy') opts.trustProxy = true;
    else if (a === '--allowed-hosts') {
      opts.allowedHosts.push(
        ...next()
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
    } else if (a.startsWith('--allowed-hosts=')) {
      opts.allowedHosts.push(
        ...a
          .slice(16)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
    } else if (a === '--read-only') opts.readOnly = true;
    else if (a === '--no-auth') opts.noAuth = true;
    else if (a === '--sources') {
      opts.sources = parseStrictSources(next());
    } else if (a.startsWith('--sources=')) {
      opts.sources = parseStrictSources(a.slice(10));
    } else if (a === '--data-dir') opts.dataDir = next();
    else if (a.startsWith('--data-dir=')) opts.dataDir = a.slice(11);
    else throw new Error(`Unknown option: ${a}`);
  }

  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  opts.basePath = normalizeBasePath(opts.basePath);
  if (opts.tokenFile) {
    opts.token = readFileSync(opts.tokenFile, 'utf-8').trim();
  }
  return opts;
}

export async function startStandaloneServer(userOpts = {}) {
  const host = stripIpv6Brackets(userOpts.host || '127.0.0.1') || '127.0.0.1';
  const port = userOpts.port !== undefined ? parseStrictPort(userOpts.port) : 4319;
  const basePath = normalizeBasePath(userOpts.basePath || '');
  const trustProxy = Boolean(userOpts.trustProxy);
  const readOnly = Boolean(userOpts.readOnly);
  const noAuth = Boolean(userOpts.noAuth);
  const sourcesOverride = Array.isArray(userOpts.sources) && userOpts.sources.length > 0 ? userOpts.sources : null;
  const pluginRoot = userOpts.pluginRoot ? resolve(userOpts.pluginRoot) : PLUGIN_ROOT;
  const dataDir = userOpts.dataDir || null;

  const loopbackBind = isLoopbackHost(host);
  const requireAuth = Boolean(userOpts.token) || ((!loopbackBind || trustProxy) && !noAuth);
  let token = String(userOpts.token || '').trim();
  let autoGeneratedToken = false;
  if (requireAuth && !token) {
    token = randomBytes(24).toString('base64url');
    autoGeneratedToken = true;
  }
  const expectedCookie = requireAuth ? deriveCookieValue(token) : '';

  const allowedHostnames = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const bindHostNorm = host.toLowerCase();
  if (bindHostNorm !== '0.0.0.0' && bindHostNorm !== '::' && bindHostNorm !== '[::]') {
    allowedHostnames.add(bindHostNorm);
    if (bindHostNorm.includes(':') && !bindHostNorm.startsWith('[')) {
      allowedHostnames.add(`[${bindHostNorm}]`);
    }
  }
  for (const h of userOpts.allowedHosts || []) {
    const parsed = parseHostnameFromHostHeader(h);
    if (parsed) allowedHostnames.add(parsed);
  }

  const runtime = createLensRuntime({
    pluginRoot,
    dataDir,
    mode: 'standalone',
    readOnly,
    basePath: basePath || '/',
    sourcesOverride,
  });

  const routeMap = new Map();
  runtime.registerRoutes((method, path, handler) => {
    routeMap.set(`${method.toUpperCase()} ${path}`, handler);
  });

  const preloadBody = buildStandalonePreloadJs();
  routeMap.set('GET /preload.js', () => ({
    status: 200,
    contentType: 'application/javascript; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
    body: preloadBody,
  }));

  let actualPort = port;

  function baseSecurityHeaders(extra = {}) {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      ...extra,
    };
  }

  function sendJson(res, status, obj, extraHeaders = {}) {
    res.writeHead(
      status,
      baseSecurityHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      })
    );
    res.end(JSON.stringify(obj));
  }

  const server = createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const peerFromLoopback = isLoopbackPeerAddress(req.socket?.remoteAddress);
      const trustForwarded = trustProxy && peerFromLoopback;

      // 1. Strict Host validation on ALL requests (DNS Rebinding protection).
      const rawHostHeader = req.headers.host;
      const directHostname = parseHostnameFromHostHeader(rawHostHeader);
      if (!directHostname) {
        return sendJson(res, 400, { error: 'Invalid Host header' });
      }
      let effectiveHostname = directHostname;
      let isHttps = false;
      let hasValidXfHost = false;

      if (trustForwarded) {
        const xfHostRaw = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
        if (xfHostRaw) {
          const xfHostname = parseHostnameFromHostHeader(xfHostRaw);
          if (!xfHostname) {
            return sendJson(res, 400, { error: 'Invalid X-Forwarded-Host header' });
          }
          effectiveHostname = xfHostname;
          hasValidXfHost = true;
        }
        const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
        if (xfProto === 'https') isHttps = true;
      }

      const hostAllowed =
        allowedHostnames.has(effectiveHostname) ||
        (trustForwarded && hasValidXfHost && (userOpts.allowedHosts || []).length === 0);
      if (!hostAllowed) {
        return sendJson(res, 403, { error: `Forbidden Host: ${effectiveHostname}` });
      }

      // 2. Parse URL & strict --base-path stripping.
      let url;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        return sendJson(res, 400, { error: 'Invalid request URL' });
      }
      let routePath = url.pathname;
      if (basePath) {
        if (routePath === basePath) {
          // 302 to trailing slash while preserving full query string (?token=, ?theme=, etc.).
          res.writeHead(
            302,
            baseSecurityHeaders({
              Location: `${basePath}/${url.search}`,
              'Cache-Control': 'no-store',
            })
          );
          return res.end();
        }
        if (!routePath.startsWith(`${basePath}/`)) {
          return sendJson(res, 404, { error: 'Not found' });
        }
        routePath = routePath.slice(basePath.length);
      }

      // 3. Authentication (when enabled).
      const cookieName = `agy_lens_auth_${actualPort}`;
      const cookiePath = `${basePath}/`;
      let authenticated = !requireAuth;
      let authorizedByBearer = false;

      if (requireAuth) {
        // One-time ?token=... bootstrap on GET -> set HttpOnly HMAC cookie & 302 strip token param.
        if (method === 'GET' && url.searchParams.has('token')) {
          const qTok = url.searchParams.get('token') || '';
          if (!safeTokenEqual(qTok, token)) {
            return sendJson(res, 401, { error: 'Invalid access token' });
          }
          const cleanParams = new URLSearchParams(url.searchParams);
          cleanParams.delete('token');
          const qs = cleanParams.toString();
          const targetLoc = `${basePath}${routePath || '/'}${qs ? `?${qs}` : ''}`;
          const cookieAttr = [
            `${cookieName}=${expectedCookie}`,
            'HttpOnly',
            'SameSite=Lax',
            `Path=${cookiePath}`,
            ...(isHttps ? ['Secure'] : []),
          ].join('; ');
          res.writeHead(
            302,
            baseSecurityHeaders({
              'Set-Cookie': cookieAttr,
              Location: targetLoc,
              'Cache-Control': 'no-store',
            })
          );
          return res.end();
        }

        const authHeader = String(req.headers.authorization || '').trim();
        if (authHeader.toLowerCase().startsWith('bearer ')) {
          const bearer = authHeader.slice(7).trim();
          if (safeTokenEqual(bearer, token)) {
            authenticated = true;
            authorizedByBearer = true;
          }
        }
        if (!authenticated) {
          const cookies = parseCookies(req.headers.cookie);
          if (cookies[cookieName] && safeTokenEqual(cookies[cookieName], expectedCookie)) {
            authenticated = true;
          }
        }

        if (!authenticated) {
          // Desensitized health probe for reverse-proxy / container liveness checks.
          if (method === 'GET' && routePath === '/api/health') {
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 401, {
            error: 'Authentication required (open with ?token=... or send Authorization: Bearer <token>)',
          });
        }
      }

      // 4. Read-only mode guard: uniformly reject all non-GET/HEAD requests.
      if (readOnly && method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 403, { error: 'Read-only mode: write operations are disabled' });
      }

      // 5. CSRF / Origin protection on state-changing requests.
      if (method !== 'GET' && method !== 'HEAD' && !authorizedByBearer) {
        const origin = req.headers.origin;
        if (origin !== undefined) {
          if (origin === 'null') {
            return sendJson(res, 403, { error: 'Forbidden cross-origin request (Origin: null)' });
          }
          let originHost = null;
          try {
            const parsedOrigin = new URL(origin);
            originHost = parseHostnameFromHostHeader(parsedOrigin.host);
          } catch {
            return sendJson(res, 403, { error: 'Invalid Origin header' });
          }
          if (!originHost || originHost !== effectiveHostname) {
            return sendJson(res, 403, { error: `Forbidden cross-origin request (${originHost || 'invalid'})` });
          }
        }
        const sfs = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
        if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
          return sendJson(res, 403, { error: `Forbidden cross-site request (Sec-Fetch-Site: ${sfs})` });
        }
      }

      // 6. Dispatch to shared server_core route map.
      const lookupMethod = method === 'HEAD' ? 'GET' : method;
      const handler = routeMap.get(`${lookupMethod} ${routePath}`);
      if (!handler) {
        return sendJson(res, 404, { error: 'Not found' });
      }

      // Merge query params (filtering `token`) + JSON body into flat `data` matching SidecarApp contract.
      const data = {};
      for (const [k, v] of url.searchParams.entries()) {
        if (k === 'token') continue;
        data[k] = v;
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const rawBody = await readBodyLimited(req, MAX_BODY_BYTES);
        if (rawBody.trim()) {
          let parsed;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            return sendJson(res, 400, { error: 'Invalid JSON request body' });
          }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
              data[k] = v;
            }
          }
        }
      }

      const result = await handler(data, { req, method, routePath });
      if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
        const hdrs = baseSecurityHeaders({
          'Content-Type': result.contentType,
          ...(routePath.startsWith('/api/') ? { 'Cache-Control': 'no-store' } : {}),
          ...(result.headers || {}),
        });
        res.writeHead(result.status || 200, hdrs);
        return res.end(method === 'HEAD' ? undefined : result.body);
      }

      res.writeHead(
        200,
        baseSecurityHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
      );
      return res.end(method === 'HEAD' ? undefined : JSON.stringify(result ?? {}));
    } catch (err) {
      const code = Number(err?.statusCode) || 500;
      if (!res.headersSent) {
        sendJson(res, code, { error: err?.message || 'Internal server error' });
      }
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = 15_000;

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${displayHost}:${actualPort}${basePath}/`;

  let closingPromise = null;

  return {
    server,
    runtime,
    host,
    port: actualPort,
    basePath,
    url,
    authRequired: requireAuth,
    token: requireAuth ? token : null,
    autoGeneratedToken,
    readOnly,
    close: () => {
      if (!closingPromise) {
        closingPromise = (async () => {
          const closed = new Promise((r) => server.close(() => r()));
          server.closeIdleConnections?.();
          await closed;
          runtime.close();
        })();
      }
      return closingPromise;
    },
  };
}

export function printStandaloneHelp() {
  process.stdout.write(`AGY Lens Standalone Web Server (Node.js 24+, Zero Dependencies)

Usage:
  agy-lens serve [options]
  node sidecars/lens_panel/standalone.mjs [options]

Options:
  --host <addr>           Bind address (default: 127.0.0.1)
  -p, --port <num>        Bind port, 0 for ephemeral (default: 4319)
  --base-path <prefix>    Mount subpath for passthrough reverse proxy (default: /)
  --token <secret>        Access token (prefer AGY_LENS_TOKEN env or --token-file)
  --token-file <path>     Read access token from file
  --trust-proxy           Trust X-Forwarded-Proto/Host from loopback proxy (forces auth)
  --allowed-hosts <list>  Comma-separated allowed Hostnames for reverse proxy
  --read-only             Disable all write endpoints and background sync writes
  --sources <list>        Override sources in-memory: cli, desktop, or cli,desktop
  --data-dir <path>       Custom sidecar data/cache directory
  --no-auth               Disable mandatory token auth on non-loopback / proxy binds
  -h, --help              Show this help message

Examples:
  # Local / SSH port-forward (ssh -L 4319:127.0.0.1:4319 user@remote)
  agy-lens serve --port 4319

  # Reverse proxy with subpath + env token
  AGY_LENS_TOKEN=my-secret agy-lens serve --base-path /agy-lens --trust-proxy --allowed-hosts lens.example.com
`);
}

async function runCliIfMain() {
  const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  if (!isMain) return;
  try {
    const opts = parseStandaloneArgs(process.argv.slice(2));
    if (opts.help) {
      printStandaloneHelp();
      process.exit(0);
    }
    const handle = await startStandaloneServer(opts);
    process.stdout.write(`[agy-lens] v${handle.runtime.runningVersion} standalone server listening on ${handle.url}\n`);
    process.stdout.write(`[agy-lens] dataDir=${handle.runtime.dataDir} readOnly=${handle.readOnly}\n`);
    if (handle.authRequired) {
      if (handle.autoGeneratedToken) {
        process.stdout.write(`[agy-lens] auth enabled (auto-generated token)\n`);
        process.stdout.write(`[agy-lens] login URL: ${handle.url}?token=${encodeURIComponent(handle.token)}\n`);
      } else {
        process.stdout.write(`[agy-lens] auth enabled (using configured token; pass ?token=... or Authorization: Bearer)\n`);
      }
    } else if (isLoopbackHost(handle.host)) {
      process.stdout.write(`[agy-lens] SSH tunnel hint: ssh -L ${handle.port}:127.0.0.1:${handle.port} <user>@<host>\n`);
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    process.stderr.write(`[agy-lens] error: ${err?.message || err}\n`);
    process.exit(1);
  }
}

runCliIfMain();
