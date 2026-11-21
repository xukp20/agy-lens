/**
 * AGY Lens Antigravity Sidecar entrypoint.
 * Thin adapter wrapping shared `server_core.mjs` inside `SidecarApp`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response as SidecarResponse, SidecarApp } from 'sidecar_sdk';
import { loadPricingState } from './lib/pricing.mjs';
import { createLensRuntime } from './lib/server_core.mjs';
import { hasPendingAutoApplyOnIdle, markHealthy } from './lib/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');

let app = null;
let serverHandle = null;
let lastActivityMs = Date.now();
let restartScheduled = false;

const runtime = createLensRuntime({
  pluginRoot: PLUGIN_ROOT,
  mode: 'sidecar',
  readOnly: false,
  basePath: '/',
  getDefaultConversationId: () => app?.config?.conversationId || '',
  onActivity: () => {
    lastActivityMs = Date.now();
  },
  onRestartRequested: (exitCode) => scheduleGracefulRestart(exitCode),
});

// Isolated smoke-test mode used by the self-updater before staging an update.
if (process.env.AGY_LENS_SMOKE === '1') {
  const cfg = runtime.loadConfig();
  loadPricingState(runtime.dataDir);
  runtime.buildConfigPayload(cfg);
  runtime.registerRoutes(() => {});
  runtime.close();
  process.stdout.write('AGY_LENS_SMOKE_OK\n');
  process.exit(0);
}

app = new SidecarApp();

function scheduleGracefulRestart(exitCode = 1) {
  if (restartScheduled) return;
  restartScheduled = true;
  const finish = () => {
    runtime.close();
    process.exit(exitCode);
  };
  const hardTimer = setTimeout(finish, 1200);
  hardTimer.unref?.();
  setTimeout(() => {
    try {
      if (serverHandle) {
        serverHandle.close(() => {
          clearTimeout(hardTimer);
          finish();
        });
        serverHandle.closeIdleConnections?.();
      } else {
        clearTimeout(hardTimer);
        finish();
      }
    } catch {
      clearTimeout(hardTimer);
      finish();
    }
  }, 150);
}

function toSidecarResponse(result) {
  if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
    return new SidecarResponse(result.body, {
      contentType: result.contentType,
      status: result.status || 200,
      headers: result.headers,
    });
  }
  return result;
}

runtime.registerRoutes((method, path, handler) => {
  if (method === 'GET' && path === '/') {
    app.page('/', async () => toSidecarResponse(await handler()));
  } else {
    app.api(path, async (data) => toSidecarResponse(await handler(data)), method);
  }
});

serverHandle = await app.run();

// Mark any recently applied update as healthy after 10 seconds of stable operation.
const healthTimer = setTimeout(() => {
  try {
    markHealthy(runtime.dataDir, runtime.runningVersion);
  } catch {
    // ignore
  }
}, 10000);
healthTimer.unref?.();

// Backend-driven idle auto-apply: if auto mode has a staged update ready and
// zero requests have arrived for 10 minutes across all clients, exit cleanly
// so `boot.mjs` applies it automatically on next launch.
const IDLE_AUTO_APPLY_MS = 10 * 60 * 1000;
const idleCheckTimer = setInterval(() => {
  try {
    if (restartScheduled) return;
    if (Date.now() - lastActivityMs < IDLE_AUTO_APPLY_MS) return;
    const config = runtime.loadConfig();
    if (hasPendingAutoApplyOnIdle(runtime.dataDir, runtime.runningVersion, config)) {
      scheduleGracefulRestart(1);
    }
  } catch {
    // ignore
  }
}, 60000);
idleCheckTimer.unref?.();
