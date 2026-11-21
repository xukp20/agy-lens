/**
 * Standalone anonymized demo server for AGY Lens.
 * Pure Node HTTP server (default 127.0.0.1:4318) with zero external dependencies
 * and zero personal data, paths, or real conversation history.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateTurnCost,
  calculateTurnCostBreakdown,
  inferPool,
  listPricingModels,
  loadDefaults,
} from '../sidecars/lens_panel/lib/pricing.mjs';
import {
  analyzeTurnsForObservatory,
} from '../sidecars/lens_panel/lib/cache_observatory.mjs';
import {
  computeSummaryForPair,
  detectPrecisionStep,
  normalizePool,
  normalizeResetPrecisionMs,
  normalizeWindowType,
  resolveInheritedResetAt,
  validateResetAtForWindow,
  VALID_POOLS,
  VALID_WINDOWS,
} from '../sidecars/lens_panel/lib/quota.mjs';
import {
  localDateKey,
  parseLocalDateRange,
  resolveTimeRange,
} from '../sidecars/lens_panel/lib/indexer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const WEB_DIR = join(ROOT_DIR, 'sidecars', 'lens_panel', 'web');
const LOGO_PATH = join(ROOT_DIR, 'assets', 'logo.svg');

function parseCliPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const p = Number(args[i + 1]);
      if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    } else if (args[i].startsWith('--port=')) {
      const p = Number(args[i].slice(7));
      if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    }
  }
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) return envPort;
  return 4318;
}

const PORT = parseCliPort();
const HOST = '127.0.0.1';

// Deterministic PRNG for reproducible synthetic demo telemetry.
function createRng(seed = 20261120) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_WORKSPACES = [
  '/workspace/acme-web',
  '/workspace/rust-engine',
  '/workspace/ml-pipeline',
];

const MODEL_DISPLAY = {
  'gemini-4-neon': 'Gemini 4 Neon (High)',
  'claude-opus-5-5': 'Claude Opus 5.5 (High)',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen (High)',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'gemini-4-carbon': 'Gemini 4 Carbon (Med)',
};

// In-memory mutable demo state
const demoConfig = {
  lang: 'zh-CN',
  modules: {
    'live-context': true,
    'cache-diagnostics': true,
    'io-flow': true,
    'model-cost': true,
    'calendar-trends': true,
    'cache-observatory': true,
    'quota-budget': true,
  },
  moduleOrder: [
    'live-context',
    'cache-diagnostics',
    'io-flow',
    'model-cost',
    'calendar-trends',
    'cache-observatory',
    'quota-budget',
  ],
  expanded: {
    'live-context': true,
    'cache-diagnostics': false,
    'io-flow': false,
    'model-cost': false,
    'calendar-trends': false,
    'cache-observatory': true,
    'quota-budget': true,
  },
  sources: { desktop: true, cli: true },
  refreshSec: 30,
  pricingAutoSync: false,
  quotaDisplayMode: 'remaining',
  quotaAnchorsByPool: {},
  quotaCalibMode: 'auto',
  quotaManualFactors: { M: false, C: false, O: false },
  obsMatrixPrimary: 'weightedHit',
  obsMatrixSubMetrics: ['keepRate', 'avgCost'],
  obsGapBreakpointsSec: [10, 60, 300, 600, 3600],
  updateMode: 'auto',
  dismissedUpdateVersion: '',
  defaultRange: '7d',
};

const pricingOverrides = {};

function getDemoPricingState() {
  const defaults = loadDefaults();
  return {
    defaults,
    defaultAnchors: defaults.defaultAnchors || {
      gemini: 'gemini-4-neon',
      argon: 'gemini-4-argon',
      '3p': 'claude-opus-5-5',
    },
    overrides: pricingOverrides,
    remote: { fetchedAt: null, models: {} },
  };
}

function buildSyntheticDataset(nowMs) {
  const rng = createRng(424242);
  const turns = [];
  const conversations = new Map();
  let reqSeq = 1000;

  function addConvMeta(conversationId, source, workspace, title) {
    conversations.set(conversationId, { conversationId, source, workspace, title });
  }

  function pushTurn(t) {
    turns.push(t);
  }

  function makeGapForBucket(bucketIdx) {
    const ranges = [
      [600, 1800],
      [2200, 4800],
      [5300, 9600],
      [10500, 19200],
      [21000, 56000],
      [65000, 260000],
      [320000, 620000],
    ];
    const [lo, hi] = ranges[bucketIdx] || [1200, 4000];
    return Math.round(lo + rng() * (hi - lo));
  }

  // 1. Active showcase session (`demo-session-001`) in the last 45 minutes
  const activeId = 'demo-session-001';
  addConvMeta(activeId, 'desktop', '/workspace/acme-web', 'Optimize prompt cache prefix alignment');
  const activeStart = nowMs - 48 * 60 * 1000;
  let cursor = activeStart;
  let ctx = 62000;
  for (let s = 1; s <= 26; s++) {
    const gap = s === 1 ? 0 : makeGapForBucket(s % 3 === 0 ? 2 : 0);
    const createdAt = cursor + gap;
    const ttft = Math.round(950 + rng() * 850);
    const gen = Math.round(2800 + rng() * 3400);
    const completedAt = createdAt + ttft + gen;
    cursor = completedAt;

    let cacheRead = 0;
    let uncachedIn = 0;
    if (s === 1) {
      uncachedIn = ctx;
    } else if (s === 14) {
      // Mid-session unexpected 0% miss followed by bounce-back at s=15
      uncachedIn = ctx;
      cacheRead = 0;
    } else {
      const hitRate = 0.92 + rng() * 0.06;
      cacheRead = Math.round(ctx * hitRate);
      uncachedIn = Math.max(1200, ctx - cacheRead);
    }

    const thinkingOut = Math.round(1400 + rng() * 1900);
    const visibleOut = Math.round(520 + rng() * 980);
    const totalOut = thinkingOut + visibleOut;
    ctx = Math.min(244000, ctx + 6800 + Math.round(rng() * 1800));

    pushTurn({
      conversation_id: activeId,
      step_idx: s * 2,
      source: 'desktop',
      workspace: '/workspace/acme-web',
      title: 'Optimize prompt cache prefix alignment',
      created_at_ms: createdAt,
      first_token_at_ms: createdAt + ttft,
      completed_at_ms: completedAt,
      ttft_ms: ttft,
      gen_ms: gen,
      canonical_model_id: 'gemini-4-neon',
      display_name: MODEL_DISPLAY['gemini-4-neon'],
      pool: 'gemini',
      uncached_in: uncachedIn,
      cache_read: cacheRead,
      cache_create: 0,
      thinking_out: thinkingOut,
      visible_out: visibleOut,
      total_out: totalOut,
      provider_request_id: `req_demo_${++reqSeq}`,
    });
  }

  // 2. Recent 5h Gemini turns aligned with 3 high-precision calibration anchors
  // Anchors will sit at: t0 = now - 105m (96.40%), t1 = now - 52m (84.15%), t2 = now - 16m (78.50%)
  const anchorT0 = nowMs - 105 * 60 * 1000;
  const anchorT1 = nowMs - 52 * 60 * 1000;
  const anchorT2 = nowMs - 16 * 60 * 1000;

  function addCalibrationCluster(convId, startMs, endMs, turnCount, workspace, title) {
    addConvMeta(convId, 'cli', workspace, title);
    const stepSpan = Math.floor((endMs - startMs) / (turnCount + 1));
    let promptSize = 185000;
    for (let i = 0; i < turnCount; i++) {
      const created = startMs + stepSpan * (i + 1) - 18000;
      const completed = startMs + stepSpan * (i + 1);
      const isMiss = i === 3 && turnCount >= 6;
      const cacheRead = isMiss ? 0 : Math.round(promptSize * 0.91);
      const uncachedIn = promptSize - cacheRead;
      const thinkingOut = 3200;
      const visibleOut = 1200;
      pushTurn({
        conversation_id: convId,
        step_idx: (i + 1) * 2,
        source: 'cli',
        workspace,
        title,
        created_at_ms: created,
        first_token_at_ms: created + 1100,
        completed_at_ms: completed,
        ttft_ms: 1100,
        gen_ms: completed - created - 1100,
        canonical_model_id: 'gemini-4-neon',
        display_name: MODEL_DISPLAY['gemini-4-neon'],
        pool: 'gemini',
        uncached_in: uncachedIn,
        cache_read: cacheRead,
        cache_create: 0,
        thinking_out: thinkingOut,
        visible_out: visibleOut,
        total_out: thinkingOut + visibleOut,
        provider_request_id: `req_demo_${++reqSeq}`,
      });
      promptSize += 9000;
    }
  }

  addCalibrationCluster('demo-cal-seg1', anchorT0 + 60_000, anchorT1 - 60_000, 8, '/workspace/rust-engine', 'SIMD parser benchmark');
  addCalibrationCluster('demo-cal-seg2', anchorT1 + 60_000, anchorT2 - 60_000, 6, '/workspace/ml-pipeline', 'Batch tokenizer profiling');

  // 3. Last 7 days: rich Global Cache Observatory conversations (#1533 signature)
  // - gemini-4-neon: high hit at <=2s (~92%), decaying at 5-20s (~66%), ~14 unexpected 0% misses + 2 boundary cuts
  // - claude-opus-5-5: 99%+ rock-solid hit rate across all idle gaps, 0 unexpected misses, >200k long-context
  // - gemini-4-hydrogen & gemini-3.8-flash: steady background usage
  const obsSpecs = [
    { model: 'gemini-4-neon', convs: 8, turnsPerConv: 18, missBias: 0.14, boundaryBias: 0.025, source: 'desktop', wsIdx: 0 },
    { model: 'claude-opus-5-5', convs: 5, turnsPerConv: 17, missBias: 0.0, boundaryBias: 0.0, source: 'cli', wsIdx: 1 },
    { model: 'gemini-4-hydrogen', convs: 4, turnsPerConv: 16, missBias: 0.03, boundaryBias: 0.01, source: 'cli', wsIdx: 2 },
    { model: 'gemini-3.8-flash', convs: 3, turnsPerConv: 16, missBias: 0.01, boundaryBias: 0.02, source: 'desktop', wsIdx: 0 },
  ];

  const titlesByWs = [
    'Implement incremental telemetry index',
    'Optimize async worker pool scheduling',
    'Tune quantized embedding retrieval',
    'Audit strict schema validation rules',
  ];

  let obsIdx = 0;
  for (const spec of obsSpecs) {
    for (let c = 0; c < spec.convs; c++) {
      obsIdx++;
      const cid = `demo-obs-${obsIdx}`;
      const ws = DEMO_WORKSPACES[(spec.wsIdx + c) % DEMO_WORKSPACES.length];
      const title = titlesByWs[(obsIdx + c) % titlesByWs.length];
      addConvMeta(cid, spec.source, ws, title);

      const dayOffset = (c % 6) + 0.3 + rng() * 0.5;
      let tCursor = nowMs - Math.round(dayOffset * 86400 * 1000);
      let prompt = spec.model === 'claude-opus-5-5' ? 148000 : 112000;

      let prevWasMiss = false;
      for (let s = 0; s < spec.turnsPerConv; s++) {
        // Distribute across all 7 gap buckets, weighting 5-20s slightly more for neon decay demo
        const bucketIdx =
          s === 0
            ? 0
            : Math.min(6, Math.floor(Math.pow(rng(), 1.15) * 7));
        const idleGap = s === 0 ? 0 : makeGapForBucket(bucketIdx);
        const ttft = Math.round(700 + rng() * 1100);
        const gen = Math.round(2200 + rng() * 4800);
        const created = tCursor + idleGap;
        const completed = created + ttft + gen;
        tCursor = completed;

        let cacheRead = 0;
        let uncachedIn = 0;

        if (s === 0) {
          uncachedIn = prompt;
        } else if (prevWasMiss) {
          // Bounce back cleanly on next turn!
          cacheRead = Math.round(prompt * (0.94 + rng() * 0.04));
          uncachedIn = prompt - cacheRead;
          prevWasMiss = false;
        } else {
          const gapPenalty = bucketIdx >= 2 && bucketIdx <= 4 ? 1.8 : bucketIdx >= 5 ? 1.4 : 0.45;
          const r = rng();
          if (r < spec.missBias * gapPenalty) {
            cacheRead = 0;
            uncachedIn = prompt;
            prevWasMiss = true;
          } else if (r < (spec.missBias + spec.boundaryBias) * gapPenalty && prompt > 90000) {
            cacheRead = Math.round(12000 + rng() * 11000);
            uncachedIn = prompt - cacheRead;
            prevWasMiss = true;
          } else {
            const baseHit = spec.model === 'claude-opus-5-5' ? 0.97 : 0.91;
            const hit = Math.min(0.992, baseHit + rng() * 0.025);
            cacheRead = Math.round(prompt * hit);
            uncachedIn = Math.max(800, prompt - cacheRead);
          }
        }

        const isClaude = spec.model.startsWith('claude');
        const thinkingOut = isClaude ? 0 : Math.round(1100 + rng() * 2100);
        const visibleOut = Math.round(650 + rng() * 1400);
        const totalOut = thinkingOut + visibleOut;
        const pool = inferPool(spec.model);

        pushTurn({
          conversation_id: cid,
          step_idx: (s + 1) * 2,
          source: spec.source,
          workspace: ws,
          title,
          created_at_ms: created,
          first_token_at_ms: created + ttft,
          completed_at_ms: completed,
          ttft_ms: ttft,
          gen_ms: gen,
          canonical_model_id: spec.model,
          display_name: MODEL_DISPLAY[spec.model] || spec.model,
          pool,
          uncached_in: uncachedIn,
          cache_read: cacheRead,
          cache_create: 0,
          thinking_out: thinkingOut,
          visible_out: visibleOut,
          total_out: totalOut,
          provider_request_id: `req_demo_${++reqSeq}`,
        });

        prompt = Math.min(265000, prompt + Math.round(5200 + rng() * 5600));
      }
    }
  }

  // 4. Historical 112-day daily conversations for rich Calendar & Hour×Day Heatmap
  const histModels = [
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gemini-3.8-flash',
    'gemini-4-carbon',
  ];
  for (let d = 7; d <= 112; d++) {
    // Keep a continuous 14-day recent streak, occasional light rest days earlier
    if (d > 14 && rng() < 0.14) continue;
    const convCount = 1 + Math.floor(rng() * 4);
    const dayBaseMs = nowMs - d * 86400 * 1000;
    for (let c = 0; c < convCount; c++) {
      const cid = `demo-hist-${d}-${c}`;
      const model = histModels[(d + c) % histModels.length];
      const ws = DEMO_WORKSPACES[(d + c) % DEMO_WORKSPACES.length];
      const source = (d + c) % 2 === 0 ? 'desktop' : 'cli';
      addConvMeta(cid, source, ws, 'Feature iteration & tests');

      // Bias activity toward realistic coding hours (9-22)
      const hour = 9 + Math.floor(rng() * 14);
      const dt = new Date(dayBaseMs);
      dt.setHours(hour, Math.floor(rng() * 55), 0, 0);
      let ts = dt.getTime();
      const turnCount = 5 + Math.floor(rng() * 10);
      let prompt = 42000 + Math.round(rng() * 80000);
      for (let s = 0; s < turnCount; s++) {
        const created = ts + 3000;
        const completed = created + 4500;
        ts = completed;
        const cacheRead = s === 0 ? 0 : Math.round(prompt * (0.86 + rng() * 0.11));
        const uncachedIn = prompt - cacheRead;
        const thinkingOut = model.startsWith('claude') ? 0 : Math.round(800 + rng() * 1200);
        const visibleOut = Math.round(450 + rng() * 950);
        pushTurn({
          conversation_id: cid,
          step_idx: (s + 1) * 2,
          source,
          workspace: ws,
          title: 'Feature iteration & tests',
          created_at_ms: created,
          first_token_at_ms: created + 900,
          completed_at_ms: completed,
          ttft_ms: 900,
          gen_ms: 3600,
          canonical_model_id: model,
          display_name: MODEL_DISPLAY[model] || model,
          pool: inferPool(model),
          uncached_in: uncachedIn,
          cache_read: cacheRead,
          cache_create: 0,
          thinking_out: thinkingOut,
          visible_out: visibleOut,
          total_out: thinkingOut + visibleOut,
          provider_request_id: `req_demo_${++reqSeq}`,
        });
        prompt += 4500;
      }
    }
  }

  // 4b. Dedicated 6-segment current 7d Gemini calibration clusters (varied model mix & cache hit rates)
  const dayMs = 86400 * 1000;
  const cal7dTimes = [
    nowMs - 5.6 * dayMs,
    nowMs - 4.7 * dayMs,
    nowMs - 3.8 * dayMs,
    nowMs - 2.8 * dayMs,
    nowMs - 1.7 * dayMs,
    nowMs - 0.7 * dayMs,
    anchorT2,
  ];
  const cal7dSpecs = [
    // seg 1: Neon heavy, low cache hit (~25%)
    { model: 'gemini-4-neon', turns: 22, hit: 0.25, prompt: 240000, outMult: 1.0, ws: '/workspace/rust-engine' },
    // seg 2: Hydrogen heavy, very high cache hit (~94%)
    { model: 'gemini-4-hydrogen', turns: 85, hit: 0.94, prompt: 230000, outMult: 0.8, ws: '/workspace/ml-pipeline' },
    // seg 3: Neon high cache hit (~92%)
    { model: 'gemini-4-neon', turns: 65, hit: 0.92, prompt: 245000, outMult: 0.7, ws: '/workspace/acme-web' },
    // seg 4: Hydrogen heavy, low cache hit (~20%)
    { model: 'gemini-4-hydrogen', turns: 48, hit: 0.20, prompt: 185000, outMult: 1.0, ws: '/workspace/rust-engine' },
    // seg 5: Neon moderate hit (~60%)
    { model: 'gemini-4-neon', turns: 32, hit: 0.60, prompt: 225000, outMult: 1.1, ws: '/workspace/acme-web' },
    // seg 6: Hydrogen high cache hit (~95%) + small Neon tail
    { model: 'gemini-4-hydrogen', turns: 95, hit: 0.95, prompt: 240000, outMult: 0.7, ws: '/workspace/ml-pipeline' },
  ];
  for (let idx = 0; idx < cal7dSpecs.length; idx++) {
    const spec = cal7dSpecs[idx];
    const segStart = cal7dTimes[idx] + 15 * 60 * 1000;
    const segEnd = cal7dTimes[idx + 1] - 25 * 60 * 1000;
    const cid = `demo-7d-cal-${idx + 1}`;
    addConvMeta(cid, 'cli', spec.ws, `Sprint segment #${idx + 1} calibration workload`);
    const stepSpan = Math.floor((segEnd - segStart) / (spec.turns + 1));
    for (let s = 0; s < spec.turns; s++) {
      const completed = segStart + stepSpan * (s + 1);
      const created = completed - 8000;
      const prompt = spec.prompt + (s % 12) * 2500;
      const cacheRead = Math.round(prompt * spec.hit);
      const uncachedIn = Math.max(500, prompt - cacheRead);
      const thinkingOut = Math.round(2400 * spec.outMult);
      const visibleOut = Math.round(900 * spec.outMult);
      pushTurn({
        conversation_id: cid,
        step_idx: (s + 1) * 2,
        source: 'cli',
        workspace: spec.ws,
        title: `Sprint segment #${idx + 1} calibration workload`,
        created_at_ms: created,
        first_token_at_ms: created + 950,
        completed_at_ms: completed,
        ttft_ms: 950,
        gen_ms: 7050,
        canonical_model_id: spec.model,
        display_name: MODEL_DISPLAY[spec.model] || spec.model,
        pool: 'gemini',
        uncached_in: uncachedIn,
        cache_read: cacheRead,
        cache_create: 0,
        thinking_out: thinkingOut,
        visible_out: visibleOut,
        total_out: thinkingOut + visibleOut,
        provider_request_id: `req_demo_${++reqSeq}`,
      });
    }
  }

  // Compute exact remaining_pct values for the 6-segment 7d cycle from true weights
  // (Q_anchor = 480, w_hydrogen = 0.72, alpha_cache = 0.30)
  const demoPricing = getDemoPricingState();
  const trueQ7d = 480;
  const trueW = { 'gemini-4-neon': 1.0, 'gemini-4-hydrogen': 0.72, 'gemini-4-carbon': 0.72, 'gemini-3.8-flash': 1.0 };
  const trueAlphaCache = 0.30;
  const weeklyResetAt = nowMs + 1.4 * dayMs;
  const weeklyNotes = [
    'Cycle start baseline',
    'After Rust parser refactor',
    'After ML pipeline tuning',
    'Mid-week Neon sprint',
    'Cache-miss investigation',
    'Long-context Neon review',
    'Pre-release check',
  ];
  const weeklyPcts = [96.80];
  for (let k = 1; k < cal7dTimes.length; k++) {
    const tStart = cal7dTimes[k - 1];
    const tEnd = cal7dTimes[k];
    let weightedSum = 0;
    for (const t of turns) {
      if (t.pool !== 'gemini') continue;
      if (t.completed_at_ms <= tStart || t.completed_at_ms > tEnd) continue;
      const b = calculateTurnCostBreakdown(t, demoPricing);
      if (b.unpriced) continue;
      const wm = trueW[b.canonicalId] ?? 1.0;
      weightedSum += wm * (b.inUsd + trueAlphaCache * b.cacheReadUsd + b.cacheWriteUsd + b.outUsd);
    }
    const dropPct = (weightedSum / trueQ7d) * 100;
    const nextPct = Math.max(5, Math.round((weeklyPcts[k - 1] - dropPct) * 100) / 100);
    weeklyPcts.push(nextPct);
  }

  // Initial quota anchors (2-decimal high-precision examples)
  let nextAnchorId = 1;
  const anchors = [
    {
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '5h',
      remaining_pct: 96.40,
      precision_step: 0.01,
      captured_at: anchorT0,
      reset_at: nowMs + 195 * 60 * 1000,
      note: 'Start of sprint session',
      created_at: anchorT0,
    },
    {
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '5h',
      remaining_pct: 84.15,
      precision_step: 0.01,
      captured_at: anchorT1,
      reset_at: nowMs + 195 * 60 * 1000,
      note: 'Mid-session checkpoint',
      created_at: anchorT1,
    },
    {
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '5h',
      remaining_pct: 78.50,
      precision_step: 0.01,
      captured_at: anchorT2,
      reset_at: nowMs + 195 * 60 * 1000,
      note: 'After benchmark run',
      created_at: anchorT2,
    },
    // Older 7d cycle (to demonstrate collapsed olderCycleAnchors)
    {
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '7d',
      remaining_pct: 91.20,
      precision_step: 0.01,
      captured_at: nowMs - 11.5 * dayMs,
      reset_at: nowMs - 6.2 * dayMs,
      note: 'Previous weekly start',
      created_at: nowMs - 11.5 * dayMs,
    },
    {
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '7d',
      remaining_pct: 42.85,
      precision_step: 0.01,
      captured_at: nowMs - 7.8 * dayMs,
      reset_at: nowMs - 6.2 * dayMs,
      note: 'Previous weekly end',
      created_at: nowMs - 7.8 * dayMs,
    },
    // Current 6-segment 7d cycle
    ...cal7dTimes.map((ts, idx) => ({
      id: nextAnchorId++,
      pool: 'gemini',
      window_type: '7d',
      remaining_pct: weeklyPcts[idx],
      precision_step: 0.01,
      captured_at: ts,
      reset_at: weeklyResetAt,
      note: weeklyNotes[idx] || `Weekly checkpoint ${idx + 1}`,
      created_at: ts,
    })),
    {
      id: nextAnchorId++,
      pool: '3p',
      window_type: '5h',
      remaining_pct: 94.50,
      precision_step: 0.01,
      captured_at: nowMs - 140 * 60 * 1000,
      reset_at: nowMs + 160 * 60 * 1000,
      note: 'Opus review start',
      created_at: nowMs - 140 * 60 * 1000,
    },
    {
      id: nextAnchorId++,
      pool: '3p',
      window_type: '5h',
      remaining_pct: 87.25,
      precision_step: 0.01,
      captured_at: nowMs - 35 * 60 * 1000,
      reset_at: nowMs + 160 * 60 * 1000,
      note: 'Opus review checkpoint',
      created_at: nowMs - 35 * 60 * 1000,
    },
  ];

  return {
    turns,
    conversations,
    anchors,
    getNextAnchorId: () => nextAnchorId++,
  };
}

const dataset = buildSyntheticDataset(Date.now());

function buildDemoPreloadJs(theme) {
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
  var params = new URLSearchParams(window.location.search);
  var themeParam = params.get('theme') || ${JSON.stringify(theme || 'light')};
  var mode = themeParam === 'dark' ? 'dark' : 'light';
  var cssVariables = VARS[mode];

  function applyThemeVars(vars) {
    var root = document.documentElement;
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        root.style.setProperty(k, vars[k]);
      }
    }
  }

  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'theme-change' && event.data.payload && event.data.payload.cssVariables) {
      applyThemeVars(event.data.payload.cssVariables);
    }
  });

  applyThemeVars(cssVariables);
  setTimeout(function () {
    window.postMessage({ type: 'theme-change', payload: { cssVariables: cssVariables } }, '*');
  }, 0);

  window.sidecar = {
    conversationId: 'demo-session-001',
    fetch: function (path, options) {
      return window.fetch(path, options);
    },
    getWorkspaceUris: function () {
      return Promise.resolve(['file:///workspace/acme-web']);
    },
    onWorkspaceChange: function () {
      return function () {};
    }
  };
})();
`;
}

function buildConfigPayload() {
  const pricingState = getDemoPricingState();
  return {
    config: structuredClone(demoConfig),
    paths: {
      dataDir: '/demo/agy-lens/data',
      defaultsFile: '/demo/agy-lens/lib/pricing_defaults.json',
      overridesFile: '/demo/agy-lens/data/pricing_overrides.json',
      cacheDb: '/demo/agy-lens/data/telemetry_cache.db',
    },
    pricingStatus: {
      lastSyncedAt: null,
      remoteCount: 0,
      overrideCount: Object.keys(pricingOverrides).length,
    },
    indexStatus: {
      desktopDbs: 18,
      cliDbs: 42,
      indexedTurns: dataset.turns.length,
      lastIndexedAt: Date.now(),
    },
  };
}

function buildSessionResponse(query) {
  const pricingState = getDemoPricingState();
  const convId = (query.conversationId || 'demo-session-001').trim();
  const convTurns = dataset.turns
    .filter((t) => t.conversation_id === convId)
    .sort((a, b) => a.step_idx - b.step_idx);

  const meta = dataset.conversations.get(convId);
  if (!meta || convTurns.length === 0) {
    return {
      conversationId: convId,
      source: null,
      title: '',
      workspace: '',
      found: false,
      indexedAt: Date.now(),
      liveContext: null,
      cacheDiagnostics: null,
      ioFlow: null,
    };
  }

  const mods = query.modules
    ? new Set(String(query.modules).split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const wantAll = !mods || mods.size === 0;
  const wantLive = wantAll || mods.has('live-context');
  const wantCache = wantAll || mods.has('cache-diagnostics');
  const wantIo = wantAll || mods.has('io-flow');

  const last = convTurns[convTurns.length - 1];
  const minStart = convTurns[0].created_at_ms;
  const maxEnd = last.completed_at_ms;

  const liveContext = wantLive
    ? {
        modelId: last.canonical_model_id,
        displayName: last.display_name,
        pool: last.pool,
        contextUsed: 242800,
        compactLimit: 512000,
        ratio: 242800 / 512000,
        turnCount: convTurns.length,
        sessionDurationMs: Math.max(0, maxEnd - minStart),
        breakdown: [
          {
            name: 'System Prompt',
            id: 1,
            tokens: 14200,
            items: [{ name: 'core_instructions', tokens: 14200 }],
          },
          {
            name: 'Tools',
            id: 2,
            tokens: 28600,
            items: [
              { name: 'workspace_tools', tokens: 19400 },
              { name: 'mcp_schemas', tokens: 9200 },
            ],
          },
          {
            name: 'Rules',
            id: 3,
            tokens: 9400,
            items: [{ name: 'project_guidelines', tokens: 9400 }],
          },
          {
            name: 'Skills',
            id: 5,
            tokens: 6800,
            items: [{ name: 'telemetry_analysis', tokens: 6800 }],
          },
          {
            name: 'Chat Messages',
            id: 7,
            tokens: 183800,
            items: [
              { name: 'assistant_history', tokens: 112400 },
              { name: 'tool_outputs', tokens: 56200 },
              { name: 'user_prompts', tokens: 15200 },
            ],
          },
        ],
      }
    : null;

  let uncachedIn = 0;
  let cacheRead = 0;
  let thinkingOut = 0;
  let visibleOut = 0;
  let totalOut = 0;
  let costUsd = 0;
  let savedUsd = 0;
  let longContextTurns = 0;
  let ttftSum = 0;
  let genSum = 0;
  const turnRows = [];
  let prevHit = null;

  for (const t of convTurns) {
    const c = calculateTurnCost(t, pricingState);
    uncachedIn += t.uncached_in;
    cacheRead += t.cache_read;
    thinkingOut += t.thinking_out;
    visibleOut += t.visible_out;
    totalOut += t.total_out;
    costUsd += c.costUsd;
    savedUsd += c.cacheSavedUsd;
    if (c.longContext) longContextTurns++;
    ttftSum += t.ttft_ms;
    genSum += t.gen_ms;

    const denom = t.cache_read + t.uncached_in;
    const hitRatio = denom > 0 ? t.cache_read / denom : 0;
    const cold = t.cache_read === 0;
    const drop = Boolean(!cold && prevHit !== null && prevHit >= 0.4 && hitRatio < prevHit - 0.25);
    prevHit = hitRatio;
    turnRows.push({
      stepIdx: t.step_idx,
      completedAt: t.completed_at_ms,
      cacheRead: t.cache_read,
      uncachedIn: t.uncached_in,
      hitRatio,
      cold,
      drop,
    });
  }

  const lastRow = turnRows[turnRows.length - 1];
  const sessDenom = cacheRead + uncachedIn;

  return {
    conversationId: meta.conversationId,
    source: meta.source,
    title: meta.title,
    workspace: meta.workspace,
    found: true,
    indexedAt: Date.now(),
    liveContext,
    cacheDiagnostics: wantCache
      ? {
          lastTurn: {
            hitRatio: lastRow.hitRatio,
            cacheRead: lastRow.cacheRead,
            uncachedIn: lastRow.uncachedIn,
            cold: lastRow.cold,
          },
          session: {
            hitRatio: sessDenom > 0 ? cacheRead / sessDenom : 0,
            totalCacheRead: cacheRead,
            totalUncachedIn: uncachedIn,
            cacheSavedUsd: savedUsd,
          },
          turns: turnRows,
        }
      : null,
    ioFlow: wantIo
      ? {
          uncachedIn,
          cacheRead,
          cacheCreate: 0,
          thinkingOut,
          visibleOut,
          totalOut,
          totalTokens: uncachedIn + cacheRead + totalOut,
          avgTtftMs: Math.round(ttftSum / convTurns.length),
          avgGenMs: Math.round(genSum / convTurns.length),
          costUsd,
          longContextTurns,
          unpricedTurns: 0,
        }
      : null,
  };
}

function buildAnalyticsResponse(query) {
  const nowMs = Date.now();
  const pricingState = getDemoPricingState();
  const rangeObj = resolveTimeRange(query.range || demoConfig.defaultRange || '7d', query.from || null, query.to || null, nowMs);
  const sourcesStr = typeof query.sources === 'string' && query.sources.trim() ? query.sources : null;
  const activeSources = sourcesStr
    ? sourcesStr.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'desktop' || s === 'cli')
    : [
        ...(demoConfig.sources.desktop ? ['desktop'] : []),
        ...(demoConfig.sources.cli ? ['cli'] : []),
      ];
  const srcSet = new Set(activeSources);
  const wsFilter = typeof query.workspace === 'string' ? query.workspace : '';

  const mods = query.modules
    ? new Set(String(query.modules).split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  const wantAll = !mods || mods.size === 0;
  const wantIo = wantAll || mods.has('io-flow');
  const wantModel = wantAll || mods.has('model-cost');
  const wantCal = wantAll || mods.has('calendar-trends');
  const wantObs = wantAll || mods.has('cache-observatory');

  const filteredTurns = dataset.turns.filter(
    (t) =>
      srcSet.has(t.source) &&
      t.completed_at_ms >= rangeObj.fromMs &&
      t.completed_at_ms <= rangeObj.toMs &&
      (!wsFilter || t.workspace === wsFilter)
  );

  let uncachedIn = 0;
  let cacheRead = 0;
  let thinkingOut = 0;
  let visibleOut = 0;
  let totalOut = 0;
  let totalCostUsd = 0;
  let cacheSavedUsd = 0;
  let longContextTurns = 0;
  let ttftSum = 0;
  let genSum = 0;
  let minTs = Infinity;
  let maxTs = 0;
  const modelMap = new Map();
  const wsMap = new Map();

  for (const t of filteredTurns) {
    const cost = calculateTurnCost(t, pricingState);
    const tTokens = t.uncached_in + t.cache_read + t.total_out;
    uncachedIn += t.uncached_in;
    cacheRead += t.cache_read;
    thinkingOut += t.thinking_out;
    visibleOut += t.visible_out;
    totalOut += t.total_out;
    totalCostUsd += cost.costUsd;
    cacheSavedUsd += cost.cacheSavedUsd;
    if (cost.longContext) longContextTurns++;
    ttftSum += t.ttft_ms;
    genSum += t.gen_ms;
    if (t.completed_at_ms < minTs) minTs = t.completed_at_ms;
    if (t.completed_at_ms > maxTs) maxTs = t.completed_at_ms;

    if (wantModel) {
      let m = modelMap.get(t.canonical_model_id);
      if (!m) {
        m = {
          canonicalId: t.canonical_model_id,
          displayName: t.display_name,
          pool: cost.pool,
          turns: 0,
          uncachedIn: 0,
          cacheRead: 0,
          totalOut: 0,
          thinkingOut: 0,
          longContextTurns: 0,
          costUsd: 0,
          cacheSavedUsd: 0,
          pricingSource: cost.pricingSource,
        };
        modelMap.set(t.canonical_model_id, m);
      }
      m.turns++;
      m.uncachedIn += t.uncached_in;
      m.cacheRead += t.cache_read;
      m.totalOut += t.total_out;
      m.thinkingOut += t.thinking_out;
      if (cost.longContext) m.longContextTurns++;
      m.costUsd += cost.costUsd;
      m.cacheSavedUsd += cost.cacheSavedUsd;

      let w = wsMap.get(t.workspace);
      if (!w) {
        w = { workspace: t.workspace, turns: 0, totalTokens: 0, costUsd: 0 };
        wsMap.set(t.workspace, w);
      }
      w.turns++;
      w.totalTokens += tTokens;
      w.costUsd += cost.costUsd;
    }
  }

  const totalTokens = uncachedIn + cacheRead + totalOut;
  const spanHours =
    rangeObj.key === 'all'
      ? Number.isFinite(minTs) && maxTs > minTs
        ? Math.max(0.25, (maxTs - minTs) / 3600000)
        : 1
      : Math.max(0.25, (Math.min(nowMs, rangeObj.toMs) - rangeObj.fromMs) / 3600000);

  const ioFlow = wantIo
    ? {
        uncachedIn,
        cacheRead,
        cacheCreate: 0,
        thinkingOut,
        visibleOut,
        totalOut,
        totalTokens,
        turns: filteredTurns.length,
        burnTokensPerHr: totalTokens / spanHours,
        burnUsdPerHr: totalCostUsd / spanHours,
        avgTtftMs: filteredTurns.length ? Math.round(ttftSum / filteredTurns.length) : 0,
        avgGenMs: filteredTurns.length ? Math.round(genSum / filteredTurns.length) : 0,
        costUsd: totalCostUsd,
        longContextTurns,
        unpricedTurns: 0,
      }
    : null;

  const modelCost = wantModel
    ? {
        totalCostUsd,
        cacheSavedUsd,
        unpricedTurns: 0,
        longContextTurns,
        models: [...modelMap.values()]
          .map((m) => {
            const denom = m.cacheRead + m.uncachedIn;
            return {
              ...m,
              cacheHitRatio: denom > 0 ? m.cacheRead / denom : 0,
              share:
                totalCostUsd > 0
                  ? m.costUsd / totalCostUsd
                  : filteredTurns.length > 0
                    ? m.turns / filteredTurns.length
                    : 0,
            };
          })
          .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
        workspaces: [...wsMap.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns),
      }
    : null;

  let calendarTrends = null;
  if (wantCal) {
    const calFromMs = nowMs - 115 * 86400 * 1000;
    const calTurns = dataset.turns.filter(
      (t) =>
        srcSet.has(t.source) &&
        t.completed_at_ms >= calFromMs &&
        t.completed_at_ms <= nowMs &&
        (!wsFilter || t.workspace === wsFilter)
    );
    const dayMap = new Map();
    const hourDayMatrix = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const t of calTurns) {
      const c = calculateTurnCost(t, pricingState);
      const dk = localDateKey(t.completed_at_ms);
      let d = dayMap.get(dk);
      if (!d) {
        d = { date: dk, turns: 0, totalTokens: 0, costUsd: 0, cacheRead: 0, uncachedIn: 0 };
        dayMap.set(dk, d);
      }
      d.turns++;
      d.totalTokens += t.uncached_in + t.cache_read + t.total_out;
      d.costUsd += c.costUsd;
      d.cacheRead += t.cache_read;
      d.uncachedIn += t.uncached_in;

      const dt = new Date(t.completed_at_ms);
      hourDayMatrix[dt.getDay()][dt.getHours()] += c.costUsd;
    }

    const days = [...dayMap.values()]
      .map((d) => ({
        date: d.date,
        turns: d.turns,
        totalTokens: d.totalTokens,
        costUsd: d.costUsd,
        cacheHitRatio: d.cacheRead + d.uncachedIn > 0 ? d.cacheRead / (d.cacheRead + d.uncachedIn) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const todayKey = localDateKey(nowMs);
    const todayCostUsd = dayMap.get(todayKey)?.costUsd || 0;
    let prev7Sum = 0;
    for (let i = 1; i <= 7; i++) {
      prev7Sum += dayMap.get(localDateKey(nowMs - i * 86400 * 1000))?.costUsd || 0;
    }
    const avg7dCostUsd = prev7Sum / 7;
    const deltaVs7dPct = avg7dCostUsd > 0 ? ((todayCostUsd - avg7dCostUsd) / avg7dCostUsd) * 100 : null;
    let streakDays = 0;
    const startOffset = dayMap.has(todayKey) ? 0 : 1;
    for (let i = startOffset; i < 365; i++) {
      const k = localDateKey(nowMs - i * 86400 * 1000);
      if (dayMap.has(k) && dayMap.get(k).turns > 0) streakDays++;
      else break;
    }
    calendarTrends = {
      days,
      streakDays,
      todayCostUsd,
      avg7dCostUsd,
      deltaVs7dPct,
      hourDayMatrix,
    };
  }

  let cacheObservatory = null;
  if (wantObs) {
    const activeConvs = new Set(filteredTurns.map((t) => t.conversation_id));
    const obsRows = dataset.turns.filter(
      (t) =>
        srcSet.has(t.source) &&
        t.completed_at_ms <= rangeObj.toMs &&
        activeConvs.has(t.conversation_id)
    );
    cacheObservatory = analyzeTurnsForObservatory(obsRows, pricingState, {
      fromMs: rangeObj.fromMs,
      toMs: rangeObj.toMs,
      gapBreakpointsSec: demoConfig.obsGapBreakpointsSec,
    });
  }

  return {
    range: rangeObj,
    sources: activeSources,
    indexStats: { scannedDbs: 60, changedDbs: 0, elapsedMs: 4 },
    ioFlow,
    modelCost,
    calendarTrends,
    cacheObservatory,
  };
}

function buildDayDetailResponse(query) {
  const bounds = parseLocalDateRange(query.date || '');
  if (!bounds) {
    return { date: query.date || '', totals: { turns: 0, totalTokens: 0, costUsd: 0 }, conversations: [], models: [] };
  }
  const pricingState = getDemoPricingState();
  const dayTurns = dataset.turns.filter(
    (t) => t.completed_at_ms >= bounds.start && t.completed_at_ms <= bounds.end
  );
  const convMap = new Map();
  const modelMap = new Map();
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const t of dayTurns) {
    const c = calculateTurnCost(t, pricingState);
    const tTokens = t.uncached_in + t.cache_read + t.total_out;
    totalTokens += tTokens;
    totalCostUsd += c.costUsd;

    const ck = `${t.source}:${t.conversation_id}`;
    let conv = convMap.get(ck);
    if (!conv) {
      conv = {
        conversationId: t.conversation_id,
        source: t.source,
        title: t.title,
        workspace: t.workspace,
        turns: 0,
        totalTokens: 0,
        costUsd: 0,
        modelSet: new Set(),
      };
      convMap.set(ck, conv);
    }
    conv.turns++;
    conv.totalTokens += tTokens;
    conv.costUsd += c.costUsd;
    conv.modelSet.add(t.canonical_model_id);

    let m = modelMap.get(t.canonical_model_id);
    if (!m) {
      m = {
        canonicalId: t.canonical_model_id,
        displayName: t.display_name,
        pool: c.pool,
        turns: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      modelMap.set(t.canonical_model_id, m);
    }
    m.turns++;
    m.totalTokens += tTokens;
    m.costUsd += c.costUsd;
  }

  return {
    date: query.date,
    totals: { turns: dayTurns.length, totalTokens, costUsd: totalCostUsd },
    conversations: [...convMap.values()]
      .map((c) => ({ ...c, models: [...c.modelSet] }))
      .sort((a, b) => b.costUsd - a.costUsd),
    models: [...modelMap.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

function buildQuotaStatusResponse(query = {}) {
  const pricingState = getDemoPricingState();
  const filterPool = query.pool ? normalizePool(query.pool) : null;
  const filterWin = query.window || query.windowType ? normalizeWindowType(query.window || query.windowType) : null;
  const nowMs = Date.now();
  const anchorModel = typeof query.anchorModel === 'string' && query.anchorModel.trim() ? query.anchorModel.trim() : null;
  const quotaCalibMode = query.quotaCalibMode || demoConfig.quotaCalibMode || 'auto';
  const quotaManualFactors = demoConfig.quotaManualFactors || { M: false, C: false, O: false };
  const forceSubset = query.forceSubset || null;
  const forceLevel = query.forceLevel || null;

  const turnsInMemory = (pool, startExclusiveMs, endInclusiveMs) => {
    if (endInclusiveMs <= startExclusiveMs) return [];
    return dataset.turns
      .filter(
        (t) =>
          t.pool === pool &&
          t.completed_at_ms > startExclusiveMs &&
          t.completed_at_ms <= endInclusiveMs
      )
      .sort((a, b) => a.completed_at_ms - b.completed_at_ms);
  };

  const ordered = [...dataset.anchors]
    .filter((a) => (!filterPool || a.pool === filterPool) && (!filterWin || a.window_type === filterWin))
    .sort((a, b) => a.captured_at - b.captured_at || a.id - b.id);

  const grouped = new Map();
  for (const r of ordered) {
    const k = `${r.pool}|${r.window_type}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r);
  }

  const pools = filterPool ? [filterPool] : VALID_POOLS;
  const windows = filterWin ? [filterWin] : VALID_WINDOWS;
  const summaries = [];
  for (const p of pools) {
    const preferredAnchor =
      (filterPool === p && anchorModel) ||
      demoConfig.quotaAnchorsByPool?.[p] ||
      null;
    for (const w of windows) {
      summaries.push(
        computeSummaryForPair(null, pricingState, p, w, grouped.get(`${p}|${w}`) || [], nowMs, {
          turnsFn: turnsInMemory,
          preferredAnchor,
          quotaCalibMode,
          quotaManualFactors,
          forceSubset,
          forceLevel,
        })
      );
    }
  }

  return {
    anchors: [...ordered]
      .reverse()
      .map((r) => ({
        id: r.id,
        pool: r.pool,
        windowType: r.window_type,
        remainingPct: r.remaining_pct,
        precisionStep: r.precision_step,
        capturedAt: r.captured_at,
        resetAt: r.reset_at,
        note: r.note || '',
        createdAt: r.created_at,
      })),
    summaries,
  };
}

function buildPricingPayload() {
  const listed = listPricingModels(getDemoPricingState());
  return {
    ...listed,
    defaultsFile: '/demo/agy-lens/lib/pricing_defaults.json',
    overridesFile: '/demo/agy-lens/data/pricing_overrides.json',
    autoSync: Boolean(demoConfig.pricingAutoSync),
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveWebFile(res, filename, contentType, fallback) {
  const fullPath = join(WEB_DIR, filename);
  if (!existsSync(fullPath)) {
    res.writeHead(fallback ? 200 : 404, { 'Content-Type': `${contentType}; charset=utf-8` });
    res.end(fallback || 'Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
  res.end(readFileSync(fullPath, 'utf-8'));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_048_576) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const query = Object.fromEntries(url.searchParams.entries());

  try {
    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveWebFile(res, 'index.html', 'text/html', '<!doctype html><html><body><p>AGY Lens UI pending.</p></body></html>');
      }
      if (url.pathname === '/styles.css') {
        return serveWebFile(res, 'styles.css', 'text/css', '/* styles pending */');
      }
      if (url.pathname === '/app.js') {
        return serveWebFile(res, 'app.js', 'application/javascript', '// app pending');
      }
      if (url.pathname === '/logo.svg') {
        if (!existsSync(LOGO_PATH)) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(readFileSync(LOGO_PATH, 'utf-8'));
      }
      if (url.pathname === '/preload.js') {
        let theme = query.theme;
        if (!theme && req.headers.referer) {
          try {
            theme = new URL(req.headers.referer).searchParams.get('theme') || '';
          } catch {
            // ignore
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        return res.end(buildDemoPreloadJs(theme));
      }
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, version: '1.4.2', diskVersion: '1.4.2', pid: process.pid });
      }
      if (url.pathname === '/api/update/status') {
        return sendJson(res, 200, {
          currentVersion: '1.4.2',
          installKind: 'git',
          canAutoApply: true,
          blockedReason: '',
          updateMode: demoConfig.updateMode || 'auto',
          dismissedVersion: demoConfig.dismissedUpdateVersion || '',
          latestVersion: '1.4.2',
          tagName: 'v1.4.2',
          releaseUrl: 'https://github.com/xukp20/agy-lens/releases',
          releaseNotes: '',
          manualOnly: false,
          publishedAt: null,
          hasUpdate: false,
          stagedVersion: null,
          requiresHostRestart: false,
          failedVersion: null,
          justUpdated: null,
          canRollback: false,
          rollbackVersion: null,
          checking: false,
          staging: false,
          lastCheckedAt: Date.now(),
          lastError: null,
        });
      }
      if (url.pathname === '/api/config') return sendJson(res, 200, buildConfigPayload());
      if (url.pathname === '/api/session') return sendJson(res, 200, buildSessionResponse(query));
      if (url.pathname === '/api/analytics') return sendJson(res, 200, buildAnalyticsResponse(query));
      if (url.pathname === '/api/day') return sendJson(res, 200, buildDayDetailResponse(query));
      if (url.pathname === '/api/pricing') return sendJson(res, 200, buildPricingPayload());
      if (url.pathname === '/api/quota/anchors') return sendJson(res, 200, buildQuotaStatusResponse(query));
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);

      if (url.pathname === '/api/config') {
        if (body.lang === 'en' || body.lang === 'zh-CN') demoConfig.lang = body.lang;
        if (body.modules && typeof body.modules === 'object') Object.assign(demoConfig.modules, body.modules);
        if (Array.isArray(body.moduleOrder)) {
          demoConfig.moduleOrder = body.moduleOrder.filter((k) => k in demoConfig.modules);
          for (const k of Object.keys(demoConfig.modules)) {
            if (!demoConfig.moduleOrder.includes(k)) demoConfig.moduleOrder.push(k);
          }
        }
        if (body.expanded && typeof body.expanded === 'object') Object.assign(demoConfig.expanded, body.expanded);
        if (body.sources && typeof body.sources === 'object') Object.assign(demoConfig.sources, body.sources);
        if (body.refreshSec !== undefined && Number.isFinite(Number(body.refreshSec))) {
          demoConfig.refreshSec = Math.max(0, Number(body.refreshSec));
        }
        if (typeof body.pricingAutoSync === 'boolean') demoConfig.pricingAutoSync = body.pricingAutoSync;
        if (body.quotaDisplayMode === 'used' || body.quotaDisplayMode === 'remaining') {
          demoConfig.quotaDisplayMode = body.quotaDisplayMode;
        }
        if (body.quotaAnchorsByPool && typeof body.quotaAnchorsByPool === 'object') {
          for (const [k, v] of Object.entries(body.quotaAnchorsByPool)) {
            if (k !== 'gemini' && k !== 'argon' && k !== '3p') continue;
            if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
              delete demoConfig.quotaAnchorsByPool[k];
            } else if (typeof v === 'string' && v.trim()) {
              demoConfig.quotaAnchorsByPool[k] = v.trim();
            }
          }
        }
        if (body.quotaManualFactors && typeof body.quotaManualFactors === 'object') {
          if (typeof body.quotaManualFactors.M === 'boolean') demoConfig.quotaManualFactors.M = body.quotaManualFactors.M;
          if (typeof body.quotaManualFactors.C === 'boolean') demoConfig.quotaManualFactors.C = body.quotaManualFactors.C;
          if (typeof body.quotaManualFactors.O === 'boolean') demoConfig.quotaManualFactors.O = body.quotaManualFactors.O;
        }
        const obsMetricOrder = ['weightedHit', 'keepRate', 'avgCost', 'totalCost', 'missPenalty', 'turns'];
        if (typeof body.obsMatrixPrimary === 'string' && obsMetricOrder.includes(body.obsMatrixPrimary)) {
          demoConfig.obsMatrixPrimary = body.obsMatrixPrimary;
          demoConfig.obsMatrixSubMetrics = demoConfig.obsMatrixSubMetrics.filter((k) => k !== demoConfig.obsMatrixPrimary);
        }
        if (Array.isArray(body.obsMatrixSubMetrics)) {
          const s = new Set(body.obsMatrixSubMetrics.filter((k) => obsMetricOrder.includes(k) && k !== demoConfig.obsMatrixPrimary));
          demoConfig.obsMatrixSubMetrics = obsMetricOrder.filter((k) => s.has(k));
        }
        if (Array.isArray(body.obsGapBreakpointsSec)) {
          const uniq = [...new Set(body.obsGapBreakpointsSec.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 1 && n <= 86400))].sort((a, b) => a - b).slice(0, 12);
          if (uniq.length > 0) demoConfig.obsGapBreakpointsSec = uniq;
        }
        if (['auto', 'notify', 'off'].includes(body.updateMode)) demoConfig.updateMode = body.updateMode;
        if (typeof body.dismissedUpdateVersion === 'string') {
          demoConfig.dismissedUpdateVersion = body.dismissedUpdateVersion.trim().slice(0, 32);
        }
        if (typeof body.quotaCalibMode === 'string') {
          const m = body.quotaCalibMode.trim().toLowerCase();
          if (m === 'auto' || m === 'manual') {
            demoConfig.quotaCalibMode = m;
          } else if (m === 'l0' || m === 'l1' || m === 'l2' || m === 'l3') {
            demoConfig.quotaCalibMode = 'manual';
            if (!body.quotaManualFactors) {
              demoConfig.quotaManualFactors = {
                M: m !== 'l0',
                C: m === 'l2' || m === 'l3',
                O: m === 'l3',
              };
            }
          }
        }
        if (typeof body.defaultRange === 'string' && body.defaultRange) demoConfig.defaultRange = body.defaultRange;
        return sendJson(res, 200, buildConfigPayload());
      }

      if (url.pathname === '/api/quota/anchors') {
        const pool = normalizePool(body?.pool);
        const windowType = normalizeWindowType(body?.windowType ?? body?.window);
        const num = Number(body?.remainingPct);
        if (!pool) return sendJson(res, 400, { error: 'Invalid pool (expected gemini, argon, or 3p)' });
        if (!windowType) return sendJson(res, 400, { error: 'Invalid windowType (expected 5h or 7d)' });
        if (!Number.isFinite(num) || num < 0 || num > 100) {
          return sendJson(res, 400, { error: 'remainingPct must be a number in [0, 100]' });
        }
        const remainingPct = Math.round(num * 100) / 100;
        const precisionStep = detectPrecisionStep(remainingPct, body?.rawInput);
        const nowMs = Date.now();
        const capturedAt = Math.round(body?.capturedAt ? Number(body.capturedAt) : nowMs);
        if (capturedAt > nowMs + 60_000) {
          return sendJson(res, 400, { error: 'capturedAt cannot be in the future' });
        }
        let resetAt = null;
        let resetSource = '';
        let resetPrecisionMs = null;
        if (body?.resetAt !== undefined && body?.resetAt !== null && body?.resetAt !== '') {
          resetAt = Math.round(Number(body.resetAt));
          try {
            validateResetAtForWindow(capturedAt, resetAt, windowType);
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
          resetSource = 'explicit';
          resetPrecisionMs = normalizeResetPrecisionMs(body?.resetPrecisionMs, 'explicit');
        }
        dataset.anchors.push({
          id: dataset.getNextAnchorId(),
          pool,
          window_type: windowType,
          remaining_pct: remainingPct,
          precision_step: precisionStep,
          captured_at: capturedAt,
          reset_at: resetAt,
          reset_source: resetSource,
          reset_precision_ms: resetPrecisionMs,
          note: typeof body?.note === 'string' ? body.note.trim().slice(0, 240) : '',
          created_at: nowMs,
        });
        return sendJson(res, 200, buildQuotaStatusResponse());
      }

      if (url.pathname === '/api/quota/anchors/update') {
        const id = Number(body?.id);
        if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'Invalid anchor id' });
        const row = dataset.anchors.find((a) => a.id === id);
        if (!row) return sendJson(res, 404, { error: `Anchor #${id} not found` });
        if (Object.prototype.hasOwnProperty.call(body, 'resetAt')) {
          if (body.resetAt === null || body.resetAt === '' || body.resetAt === undefined) {
            row.reset_at = null;
            row.reset_source = '';
            row.reset_precision_ms = null;
          } else {
            const nextReset = Math.round(Number(body.resetAt));
            try {
              validateResetAtForWindow(row.captured_at, nextReset, row.window_type);
            } catch (err) {
              return sendJson(res, 400, { error: err.message });
            }
            row.reset_at = nextReset;
            row.reset_source = 'explicit';
            row.reset_precision_ms = normalizeResetPrecisionMs(body?.resetPrecisionMs, 'explicit');
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'note') && typeof body.note === 'string') {
          row.note = body.note.trim().slice(0, 240);
        }
        return sendJson(res, 200, buildQuotaStatusResponse());
      }

      if (url.pathname === '/api/quota/anchors/delete') {
        const id = Number(body?.id);
        if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'Invalid anchor id' });
        const idx = dataset.anchors.findIndex((a) => a.id === id);
        if (idx >= 0) dataset.anchors.splice(idx, 1);
        return sendJson(res, 200, buildQuotaStatusResponse());
      }

      if (url.pathname === '/api/pricing/overrides') {
        if (!body?.canonicalId || typeof body.canonicalId !== 'string') {
          return sendJson(res, 400, { error: 'canonicalId is required' });
        }
        const id = body.canonicalId.trim();
        if (body.override === null || body.override === undefined) {
          delete pricingOverrides[id];
        } else {
          const r = body.override;
          pricingOverrides[id] = {
            pool: r.pool || inferPool(id),
            effective_from: r.effectiveFrom || r.effective_from || new Date().toISOString().slice(0, 10),
            input_per_1m: Number(r.inputPer1m ?? r.input_per_1m ?? 0) || 0,
            output_per_1m: Number(r.outputPer1m ?? r.output_per_1m ?? 0) || 0,
            thinking_per_1m: Number(r.thinkingPer1m ?? r.thinking_per_1m ?? r.outputPer1m ?? 0) || 0,
            cache_read_per_1m: Number(r.cacheReadPer1m ?? r.cache_read_per_1m ?? 0) || 0,
            cache_write_per_1m: Number(r.cacheWritePer1m ?? r.cache_write_per_1m ?? 0) || 0,
            long_context_threshold: r.longContextThreshold ? Number(r.longContextThreshold) : null,
            input_above_per_1m: r.inputAbovePer1m != null ? Number(r.inputAbovePer1m) : null,
            output_above_per_1m: r.outputAbovePer1m != null ? Number(r.outputAbovePer1m) : null,
            cache_read_above_per_1m: r.cacheReadAbovePer1m != null ? Number(r.cacheReadAbovePer1m) : null,
            notes: typeof r.notes === 'string' ? r.notes : 'Demo override',
          };
        }
        return sendJson(res, 200, buildPricingPayload());
      }

      if (url.pathname === '/api/pricing/sync') {
        const listed = buildPricingPayload();
        return sendJson(res, 200, {
          ok: true,
          syncedAt: Date.now(),
          matchedCount: listed.models.length,
          remoteTotalCount: 4980,
          pricing: listed,
        });
      }

      if (url.pathname === '/api/index/rebuild') {
        return sendJson(res, 200, {
          ok: true,
          scannedDbs: 60,
          changedDbs: 0,
          elapsedMs: 12,
          indexStatus: buildConfigPayload().indexStatus,
        });
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agy-lens demo] listening on http://${HOST}:${PORT}`);
});
