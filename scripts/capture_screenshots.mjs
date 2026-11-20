#!/usr/bin/env node
/**
 * Optional Playwright real-browser screenshot capture script for AGY Lens.
 *
 * Launches `scripts/demo_server.mjs` (synthetic, anonymized telemetry only)
 * and captures live Chromium screenshots at 2x deviceScaleFactor.
 *
 * Usage (on a machine with Playwright + Chromium installed):
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/capture_screenshots.mjs [--port 4319] [--out assets/screenshots/live]
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

function parseArgs(argv) {
  let port = 4319;
  let outDir = join(ROOT_DIR, 'assets', 'screenshots', 'live');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) {
      const p = Number(argv[++i]);
      if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
    } else if (a.startsWith('--port=')) {
      const p = Number(a.slice(7));
      if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
    } else if (a === '--out' && argv[i + 1]) {
      outDir = resolve(argv[++i]);
    } else if (a.startsWith('--out=')) {
      outDir = resolve(a.slice(6));
    }
  }
  return { port, outDir };
}

async function waitForServer(baseUrl, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      if (res.ok) return;
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for demo_server at ${baseUrl}`);
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    console.error(
      '[capture] Playwright is not installed.\n' +
        'Install it in a scratch dir or devDependencies:\n' +
        '  npm install --no-save playwright && npx playwright install chromium\n' +
        'Or run `python3 scripts/render_previews.py` for zero-browser 2x Retina previews.'
    );
    process.exit(1);
  }
}

async function capturePage(browser, url, viewport, outPath, afterLoad) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#app:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(350);
    if (typeof afterLoad === 'function') {
      await afterLoad(page);
    }
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`[captured] ${outPath}`);
  } finally {
    await context.close();
  }
}

async function main() {
  const { port, outDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverProc = spawn('node', [join(__dirname, 'demo_server.mjs'), '--port', String(port)], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });

    // 1. Narrow Aux Pane Dark & Light
    await capturePage(
      browser,
      `${baseUrl}/?theme=dark&lang=en&expand=live-context,cache-diagnostics`,
      { width: 460, height: 780 },
      join(outDir, 'aux-dark.png')
    );
    await capturePage(
      browser,
      `${baseUrl}/?theme=light&lang=en&expand=live-context,cache-diagnostics`,
      { width: 460, height: 780 },
      join(outDir, 'aux-light.png')
    );

    // 2. Global Cache Observatory (wide view)
    await capturePage(
      browser,
      `${baseUrl}/?theme=dark&lang=en&only=cache-observatory&expand=cache-observatory&hideHeader=1`,
      { width: 1080, height: 740 },
      join(outDir, 'cache-observatory.png')
    );

    // 3. Cost & Calendar Heatmap (wide 2-column view)
    await capturePage(
      browser,
      `${baseUrl}/?theme=dark&lang=en&only=model-cost,calendar-trends&expand=model-cost,calendar-trends&hideHeader=1`,
      { width: 1120, height: 680 },
      join(outDir, 'cost-calendar.png')
    );

    // 4. Quota & Cycle Budget
    await capturePage(
      browser,
      `${baseUrl}/?theme=dark&lang=en&only=quota-budget&expand=quota-budget&hideHeader=1`,
      { width: 880, height: 640 },
      join(outDir, 'quota-budget.png')
    );

    // 5. Settings Drawer
    await capturePage(
      browser,
      `${baseUrl}/?theme=dark&lang=en&openSettings=1`,
      { width: 920, height: 700 },
      join(outDir, 'settings-drawer.png')
    );
  } finally {
    if (browser) await browser.close();
    serverProc.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('[capture] failed:', err);
  process.exit(1);
});
