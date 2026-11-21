/**
 * Comprehensive tests for AGY Lens v1.7.0 Standalone Web Server, Security Model & CLI:
 * - Zero sidecar_sdk startup & core endpoints
 * - CWE-22 conversationId path traversal rejection
 * - DNS Rebinding Host whitelist (rejects evil host, allows SSH-forwarded loopback port)
 * - Mandatory auth on non-loopback / --trust-proxy, SHA-256 timing-safe check, HMAC Cookie,
 *   302 ?token= stripping while preserving ?theme=, Secure flag on HTTPS, desensitized /api/health
 * - --base-path subpath routing, trailing-slash 302 preserving query, no prefix collision
 * - POST CSRF protection (Origin: evil / null, Sec-Fetch-Site: cross-site, Bearer exemption)
 * - --read-only blocking all non-GET/HEAD writes + standalone blocking apply/rollback
 * - CLI `agy-lens status --json`
 * - boot.mjs <-> updater.mjs allowlist parity & plugin.json === package.json version parity
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  deriveCookieValue,
  parseStandaloneArgs,
  safeTokenEqual,
  startStandaloneServer,
} from '../sidecars/lens_panel/standalone.mjs';
import {
  ALLOWED_ROOT_DIRS as UPDATER_DIRS,
  ALLOWED_ROOT_FILES as UPDATER_FILES,
} from '../sidecars/lens_panel/lib/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

function rawHttp({ port, method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // non-json response
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('Standalone loopback server serves UI, APIs, blocks CWE-22 traversal & DNS rebinding, allows SSH port-forward', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agy-lens-st-1-'));
  const srv = await startStandaloneServer({ host: '127.0.0.1', port: 0, dataDir });
  try {
    // 1. Core static & API endpoints work without sidecar_sdk
    const idx = await rawHttp({ port: srv.port, path: '/' });
    assert.equal(idx.status, 200);
    assert.match(idx.text, /src="\.\/preload\.js"/);
    assert.equal(idx.headers['x-frame-options'], 'DENY');
    assert.equal(idx.headers['x-content-type-options'], 'nosniff');

    const preload = await rawHttp({ port: srv.port, path: '/preload.js' });
    assert.equal(preload.status, 200);
    assert.match(preload.text, /__AGY_LENS_STANDALONE__/);

    const cfg = await rawHttp({ port: srv.port, path: '/api/config' });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.runtime.mode, 'standalone');
    assert.equal(cfg.json.runtime.readOnly, false);

    const recent = await rawHttp({ port: srv.port, path: '/api/sessions/recent?limit=5' });
    assert.equal(recent.status, 200);
    assert.ok(Array.isArray(recent.json.sessions));

    // 2. SSH port-forward host with different local port (ssh -L 9999:127.0.0.1:PORT) -> ALLOWED
    const sshFwd = await rawHttp({
      port: srv.port,
      path: '/api/config',
      headers: { Host: '127.0.0.1:9999' },
    });
    assert.equal(sshFwd.status, 200);

    // 3. DNS Rebinding host -> BLOCKED on both GET and POST
    const rebindGet = await rawHttp({
      port: srv.port,
      path: '/api/config',
      headers: { Host: `attacker.evil:${srv.port}` },
    });
    assert.equal(rebindGet.status, 403);

    // 4. CWE-22 path traversal on conversationId -> 400
    const trav = await rawHttp({
      port: srv.port,
      path: '/api/session?conversationId=../../etc/passwd',
    });
    assert.equal(trav.status, 400);

    // 5. CSRF Origin checks on POST
    const csrfEvil = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ lang: 'en' }),
    });
    assert.equal(csrfEvil.status, 403);

    const csrfNull = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'null',
      },
      body: JSON.stringify({ lang: 'en' }),
    });
    assert.equal(csrfNull.status, 403);

    const csrfCrossSite = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/config',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ lang: 'en' }),
    });
    assert.equal(csrfCrossSite.status, 403);

    // 6. Standalone unconditionally blocks /api/update/apply and /api/update/rollback
    const applyRes = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/update/apply',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(applyRes.status, 403);

    const updStatus = await rawHttp({ port: srv.port, path: '/api/update/status' });
    assert.equal(updStatus.status, 200);
    assert.equal(updStatus.json.canAutoApply, false);
    assert.equal(updStatus.json.blockedReason, 'standalone_cli');
  } finally {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Reverse proxy --base-path + --trust-proxy forces auth, preserves query on 302, sets Secure HMAC cookie & prevents prefix collision', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agy-lens-st-2-'));
  const srv = await startStandaloneServer({
    host: '127.0.0.1',
    port: 0,
    basePath: '/agy-lens',
    trustProxy: true,
    allowedHosts: ['lens.example.com'],
    dataDir,
  });
  try {
    assert.equal(srv.authRequired, true, '--trust-proxy must force auth even on 127.0.0.1');
    assert.equal(srv.autoGeneratedToken, true);
    assert.ok(srv.token && srv.token.length >= 20);
    // Timing-safe comparison handles unequal lengths without throwing RangeError
    assert.equal(safeTokenEqual('short', srv.token), false);
    assert.equal(safeTokenEqual(srv.token, srv.token), true);

    const proxyHeaders = {
      Host: `127.0.0.1:${srv.port}`,
      'X-Forwarded-Host': 'lens.example.com',
      'X-Forwarded-Proto': 'https',
    };

    // Unauthenticated /api/config -> 401; /api/health -> desensitized { ok: true }
    const unauthCfg = await rawHttp({ port: srv.port, path: '/agy-lens/api/config', headers: proxyHeaders });
    assert.equal(unauthCfg.status, 401);

    const unauthHealth = await rawHttp({ port: srv.port, path: '/agy-lens/api/health', headers: proxyHeaders });
    assert.equal(unauthHealth.status, 200);
    assert.deepEqual(unauthHealth.json, { ok: true });

    // Prefix collision: /agy-lens2/ must 404
    const wrongPrefix = await rawHttp({ port: srv.port, path: '/agy-lens2/api/health', headers: proxyHeaders });
    assert.equal(wrongPrefix.status, 404);

    // No trailing slash /agy-lens?token=X&theme=dark -> 302 preserving full query string
    const slash302 = await rawHttp({
      port: srv.port,
      path: `/agy-lens?token=${encodeURIComponent(srv.token)}&theme=dark`,
      headers: proxyHeaders,
    });
    assert.equal(slash302.status, 302);
    assert.equal(slash302.headers.location, `/agy-lens/?token=${encodeURIComponent(srv.token)}&theme=dark`);

    // Valid ?token= bootstrap -> 302 stripping token, keeping theme=dark, setting HttpOnly+Secure HMAC cookie
    const login302 = await rawHttp({
      port: srv.port,
      path: `/agy-lens/?token=${encodeURIComponent(srv.token)}&theme=dark`,
      headers: proxyHeaders,
    });
    assert.equal(login302.status, 302);
    assert.equal(login302.headers.location, '/agy-lens/?theme=dark');
    const setCookie = String(login302.headers['set-cookie'] || '');
    assert.match(setCookie, new RegExp(`agy_lens_auth_${srv.port}=${deriveCookieValue(srv.token)}`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/agy-lens\//);
    assert.match(setCookie, /Secure/);
    assert.equal(setCookie.includes(srv.token), false, 'raw token must NOT be stored in cookie');

    // Follow up with Cookie -> 200
    const cookiePair = setCookie.split(';')[0];
    const authedCfg = await rawHttp({
      port: srv.port,
      path: '/agy-lens/api/config',
      headers: { ...proxyHeaders, Cookie: cookiePair },
    });
    assert.equal(authedCfg.status, 200);
    assert.equal(authedCfg.json.runtime.basePath, '/agy-lens');

    // Verified Bearer token on POST bypasses Origin check cleanly
    const bearerPost = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/agy-lens/api/config',
      headers: {
        ...proxyHeaders,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${srv.token}`,
      },
      body: JSON.stringify({ lang: 'en' }),
    });
    assert.equal(bearerPost.status, 200);
    assert.equal(bearerPost.json.config.lang, 'en');
  } finally {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('--read-only blocks all write endpoints uniformly, CLI status --json works, and allowlists/versions stay in sync', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agy-lens-st-3-'));
  const srv = await startStandaloneServer({
    host: '127.0.0.1',
    port: 0,
    readOnly: true,
    dataDir,
  });
  try {
    for (const p of ['/api/config', '/api/quota/anchors', '/api/update/check', '/api/pricing/sync', '/api/index/rebuild']) {
      const r = await rawHttp({
        port: srv.port,
        method: 'POST',
        path: p,
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 403, `POST ${p} must be blocked in --read-only mode`);
    }

    // CLI `agy-lens status --json`
    const statusOut = execFileSync(
      process.execPath,
      [join(ROOT_DIR, 'bin', 'agy-lens.mjs'), 'status', '--json', '--data-dir', dataDir],
      { encoding: 'utf-8' }
    );
    const statusJson = JSON.parse(statusOut);
    assert.equal(typeof statusJson.today.costUsd, 'number');
    assert.equal(typeof statusJson.last7d.costUsd, 'number');
    assert.ok(Array.isArray(statusJson.quota7d));

    // Version parity: plugin.json === package.json
    const pluginPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'plugin.json'), 'utf-8'));
    const npmPkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'));
    assert.equal(pluginPkg.version, npmPkg.version, 'plugin.json and package.json versions must match');

    // Allowlist parity: boot.mjs vs updater.mjs
    const bootSrc = readFileSync(join(ROOT_DIR, 'sidecars', 'lens_panel', 'boot.mjs'), 'utf-8');
    for (const f of UPDATER_FILES) {
      assert.ok(bootSrc.includes(`'${f}'`), `boot.mjs ALLOWED_ROOT_FILES missing ${f}`);
    }
    for (const d of UPDATER_DIRS) {
      assert.ok(bootSrc.includes(`'${d}'`), `boot.mjs ALLOWED_ROOT_DIRS missing ${d}`);
    }
  } finally {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Sidecar main.mjs adapter satisfies strict sidecar_sdk app.page()/app.api() Response contract', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'agy-lens-sidecar-sdk-'));
  const mockSdkPath = join(tmpDir, 'mock_sidecar_sdk.mjs');
  const hookPath = join(tmpDir, 'register_mock_sdk.mjs');

  // Replicates the exact response dispatch in Antigravity sidecar_sdk/index.mjs:
  // app.page() ONLY unwraps `instanceof Response`; a plain POJO throws ERR_INVALID_ARG_TYPE in res.end().
  writeFileSync(
    mockSdkPath,
    `
import { createServer } from 'node:http';

export class Response {
  constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

export class SidecarApp {
  #pages = new Map();
  #apis = new Map();
  get config() { return { projectId: '', conversationId: '' }; }
  page(path, handler) { this.#pages.set(path, handler); }
  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) this.#apis.set(path, new Map());
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }
  run() {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        const content = await this.#pages.get(url.pathname)();
        if (content instanceof Response) {
          res.writeHead(content.status || 200, { 'Content-Type': content.contentType, ...content.headers });
          res.end(content.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
        return;
      }
      if (this.#apis.has(url.pathname)) {
        const handler = this.#apis.get(url.pathname).get(req.method);
        if (!handler) { res.writeHead(405); res.end(); return; }
        const data = Object.fromEntries(url.searchParams.entries());
        const result = await handler(data);
        if (result instanceof Response || (result && typeof result === 'object' && result.contentType && result.body !== undefined)) {
          res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
          res.end(typeof result.body === 'string' ? result.body : Buffer.from(result.body));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        console.log('[sidecar] listening on 127.0.0.1:' + server.address().port);
        resolve(server);
      });
    });
  }
}
`
  );

  writeFileSync(
    hookPath,
    `
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const target = pathToFileURL(${JSON.stringify(mockSdkPath)}).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sidecar_sdk') return { url: target, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`
  );

  const child = spawn(process.execPath, ['--import', hookPath, join(ROOT_DIR, 'sidecars', 'lens_panel', 'main.mjs')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: tmpDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sidecar startup timeout: ${stdout} ${stderr}`)), 8000);
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        const m = stdout.match(/listening on 127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited early (${code}): ${stderr}`));
      });
    });

    const home = await rawHttp({ port, path: '/' });
    assert.equal(home.status, 200, `GET / failed: ${stderr}`);
    assert.match(home.headers['content-type'] || '', /text\/html/);
    assert.match(home.text, /<!DOCTYPE html>/);

    const css = await rawHttp({ port, path: '/styles.css' });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'] || '', /text\/css/);

    const js = await rawHttp({ port, path: '/app.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'] || '', /application\/javascript/);
    assert.match(js.text, /window\.__AGY_LENS_DISK_VERSION__=/);

    const logo = await rawHttp({ port, path: '/logo.svg' });
    assert.equal(logo.status, 200);

    const health = await rawHttp({ port, path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.mode, 'sidecar');

    const badSession = await rawHttp({ port, path: '/api/session?conversationId=../../etc/passwd' });
    assert.equal(badSession.status, 400);
    assert.equal(stderr.trim(), '', `unexpected stderr: ${stderr}`);
  } finally {
    child.kill('SIGTERM');
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Review hardening: --trust-proxy without X-Forwarded-Host blocks DNS rebinding, strict CLI args, blank override 400, and AGY_LENS_SMOKE=1', async () => {
  // Strict CLI arg validation
  assert.throws(() => parseStandaloneArgs(['--port=']), /Invalid --port/);
  assert.throws(() => parseStandaloneArgs(['--port', '']), /Invalid --port/);
  assert.throws(() => parseStandaloneArgs(['--port', 'abc']), /Invalid --port/);
  assert.throws(() => parseStandaloneArgs(['--sources=foo']), /Invalid --sources/);
  assert.throws(() => parseStandaloneArgs(['--sources=']), /Invalid --sources/);
  assert.deepEqual(parseStandaloneArgs(['--sources=cli,desktop']).sources, ['cli', 'desktop']);

  // --trust-proxy without --allowed-hosts: direct evil Host (no X-Forwarded-Host) must 403, valid X-Forwarded-Host passes
  const dataDir = mkdtempSync(join(tmpdir(), 'agy-lens-st-5-'));
  const srv = await startStandaloneServer({
    host: '127.0.0.1',
    port: 0,
    trustProxy: true,
    noAuth: true,
    dataDir,
  });
  try {
    const directRebind = await rawHttp({
      port: srv.port,
      path: '/api/health',
      headers: { Host: `attacker.rebind:${srv.port}` },
    });
    assert.equal(directRebind.status, 403, 'direct evil Host without X-Forwarded-Host must be rejected even under --trust-proxy');

    const viaProxy = await rawHttp({
      port: srv.port,
      path: '/api/health',
      headers: { Host: `127.0.0.1:${srv.port}`, 'X-Forwarded-Host': 'proxy.internal' },
    });
    assert.equal(viaProxy.status, 200);

    // /app.js injects __AGY_LENS_DISK_VERSION__ in standalone too
    const js = await rawHttp({ port: srv.port, path: '/app.js' });
    assert.equal(js.status, 200);
    assert.match(js.text, /window\.__AGY_LENS_DISK_VERSION__=/);

    // Blank canonicalId or array override returns 400
    const blankOv = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/pricing/overrides',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonicalId: '   ', override: null }),
    });
    assert.equal(blankOv.status, 400);

    const arrOv = await rawHttp({
      port: srv.port,
      method: 'POST',
      path: '/api/pricing/overrides',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonicalId: 'gemini-3-pro', override: [] }),
    });
    assert.equal(arrOv.status, 400);
  } finally {
    await srv.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // AGY_LENS_SMOKE=1 runs main.mjs without requiring ANTIGRAVITY_* env vars (with mock sidecar_sdk)
  const smokeDir = mkdtempSync(join(tmpdir(), 'agy-lens-smoke-'));
  const mockSdk = join(smokeDir, 'sdk.mjs');
  const hook = join(smokeDir, 'hook.mjs');
  writeFileSync(mockSdk, 'export class Response {} export class SidecarApp { constructor() { throw new Error("should not run in smoke"); } }\n');
  writeFileSync(
    hook,
    `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const u = pathToFileURL(${JSON.stringify(mockSdk)}).href;
registerHooks({ resolve(s, c, n) { return s === 'sidecar_sdk' ? { url: u, shortCircuit: true } : n(s, c); } });\n`
  );
  try {
    const out = execFileSync(
      process.execPath,
      ['--import', hook, join(ROOT_DIR, 'sidecars', 'lens_panel', 'main.mjs')],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, AGY_LENS_SMOKE: '1', ANTIGRAVITY_EXECUTABLE_DATA_DIR: smokeDir },
        encoding: 'utf-8',
      }
    );
    assert.match(out, /AGY_LENS_SMOKE_OK/);
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
  }
});
