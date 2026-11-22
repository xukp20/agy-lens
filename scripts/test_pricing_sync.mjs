/**
 * Unit tests for Commit 1 pricing sync optimization:
 * - LiteLLM direct whitelist & proxy provider rejection (Bedrock/Azure/Vertex/etc.)
 * - OpenRouter <vendor>/ support for observed 3p models & :nitro/:free variant skipping
 * - Dot/hyphen canonical alignment (gemini-3.5-flash-lite, gemini-3.8-flash, gemini-2.5-pro, claude-*)
 * - (mtimeNs, size, ino) stat cache hits, invalidation on atomic write, and ENOENT cleanup
 * - Legacy bloated 4,980-model cache filtering in listPricingModels
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  REMOTE_CACHE_VERSION,
  calculateTurnCost,
  clearPricingJsonCache,
  getRemoteCachePath,
  listPricingModels,
  loadPricingState,
  maybeAutoSync,
  normalizeModelId,
  resolveRate,
  saveOverride,
  syncRemotePricing,
  writeJsonAtomic,
} from '../sidecars/lens_panel/lib/pricing.mjs';

function makeMockFetch(litellmObj, openrouterData) {
  return async (url) => {
    if (String(url).includes('litellm')) {
      return { ok: true, status: 200, json: async () => litellmObj };
    }
    if (String(url).includes('openrouter')) {
      return { ok: true, status: 200, json: async () => ({ data: openrouterData }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('syncRemotePricing filters proxy/noise models, preserves direct priority & observed 3p models, and aligns dot/hyphen keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-pricing-'));
  try {
    const litellm = {
      // Official direct entry ($4/$20) vs inflated Bedrock entry ($99/$199)
      'claude-opus-5-5': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 4e-6,
        output_cost_per_token: 20e-6,
        cache_read_input_token_cost: 0.2e-6,
      },
      'bedrock/claude-opus-5-5': {
        litellm_provider: 'bedrock',
        input_cost_per_token: 99e-6,
        output_cost_per_token: 199e-6,
      },
      'azure/claude-opus-5-5': {
        litellm_provider: 'azure',
        input_cost_per_token: 88e-6,
        output_cost_per_token: 188e-6,
      },
      // Google AI Studio direct with gemini/ prefix & dots preserved
      'gemini/gemini-2.5-pro': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 10e-6,
      },
      'gemini/gemini-3-5-flash-lite': {
        litellm_provider: 'gemini',
        input_cost_per_token: 0.3e-6,
        output_cost_per_token: 2.5e-6,
      },
      // Non-chat noise that must be excluded
      'gemini/gemini-embedding-001': {
        litellm_provider: 'gemini',
        input_cost_per_token: 0.1e-6,
        output_cost_per_token: 0.1e-6,
      },
      'gemini/imagen-4.0': {
        litellm_provider: 'gemini',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 1e-6,
      },
      'together_ai/meta-llama-3-70b': {
        litellm_provider: 'together_ai',
        input_cost_per_token: 0.8e-6,
        output_cost_per_token: 0.8e-6,
      },
    };

    const openrouter = [
      // Observed 3p model on OpenRouter -> MUST be kept!
      {
        id: 'deepseek/deepseek-r1',
        pricing: { prompt: '0.55e-6', completion: '2.19e-6' },
      },
      // Variant suffix -> MUST be skipped
      {
        id: 'deepseek/deepseek-r1:nitro',
        pricing: { prompt: '9.99e-6', completion: '19.99e-6' },
      },
      // OpenRouter gpt-oss-120b -> kept via default/family
      {
        id: 'openai/gpt-oss-120b',
        pricing: { prompt: '0.15e-6', completion: '0.6e-6' },
      },
      // Unobserved third-party noise -> filtered out
      {
        id: 'cohere/command-r-plus',
        pricing: { prompt: '2.5e-6', completion: '10e-6' },
      },
    ];

    const res = await syncRemotePricing(dir, {
      observedModelIds: ['deepseek-r1'],
      fetchImpl: makeMockFetch(litellm, openrouter),
    });

    assert.equal(res.ok, true);
    assert.equal(res.remoteTotalCount, 12);
    assert.equal(res.matchedCount, 5);

    const state = loadPricingState(dir);
    assert.equal(state.remote.models['claude-opus-5-5'].input_per_1m, 4, 'Bedrock/Azure must NOT overwrite direct price');
    assert.equal(state.remote.models['gemini-2.5-pro'].input_per_1m, 1.25, 'gemini/ prefix stripped and dots preserved');
    assert.equal(state.remote.models['gemini-3.5-flash-lite'].input_per_1m, 0.3, 'hyphen alias maps back to canonical dot ID');
    assert.equal(state.remote.models['deepseek-r1'].input_per_1m, 0.55, 'observed OpenRouter 3p model kept without :nitro overwrite');
    assert.equal(state.remote.models['gpt-oss-120b'].input_per_1m, 0.15);
    assert.equal(state.remote.models['gemini-embedding-001'], undefined);
    assert.equal(state.remote.models['command-r-plus'], undefined);
    assert.equal(normalizeModelId('gemini/gemini-3-5-flash-lite'), 'gemini-3.5-flash-lite');

    // No stray .tmp.* files left behind
    const files = readdirSync(dir);
    assert.equal(files.some((f) => f.includes('.tmp.')), false);
  } finally {
    clearPricingJsonCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stat cache hits across repeated loads, invalidates immediately on atomic write & ENOENT, and filters legacy 4980-model caches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-cache-'));
  try {
    // Write a legacy bloated cache containing 1000 unrelated models + 1 relevant model
    const bloatedModels = {
      'gemini-2.5-flash': { pool: 'gemini', effective_from: '2026-11-01', input_per_1m: 0.15, output_per_1m: 0.6 },
    };
    for (let i = 0; i < 1000; i++) {
      bloatedModels[`noise-vendor-model-${i}`] = {
        pool: '3p',
        effective_from: '2026-11-01',
        input_per_1m: 1,
        output_per_1m: 2,
      };
    }
    writeJsonAtomic(getRemoteCachePath(dir), { fetchedAt: Date.now(), models: bloatedModels }, false);

    const s1 = loadPricingState(dir);
    const s2 = loadPricingState(dir);
    assert.strictEqual(s1.remote.models, s2.remote.models, 'second loadPricingState must hit stat cache (same object ref)');

    // listPricingModels immediately filters legacy bloated cache down to relevant models only
    const listed = listPricingModels(s1, Date.now(), { observedModelIds: ['noise-vendor-model-42'] });
    const ids = new Set(listed.models.map((m) => m.canonicalId));
    assert.equal(ids.has('gemini-2.5-flash'), true);
    assert.equal(ids.has('noise-vendor-model-42'), true, 'locally observed model included');
    assert.equal(ids.has('noise-vendor-model-99'), false, 'unobserved noise excluded');
    assert.ok(listed.models.length < 25);

    // saveOverride invalidates cache immediately even within the same millisecond
    const s3 = saveOverride(dir, 'gemini-4-neon', { inputPer1m: 4.5, outputPer1m: 18 });
    assert.equal(s3.overrides['gemini-4-neon'].input_per_1m, 4.5);

    // Removing cache file clears stale entry on ENOENT
    unlinkSync(getRemoteCachePath(dir));
    const s4 = loadPricingState(dir);
    assert.deepEqual(s4.remote.models, {});

    // maybeAutoSync must NOT call lazy observed-model getter when autoSync is off or cache is fresh
    let getterCalls = 0;
    maybeAutoSync(dir, false, () => {
      getterCalls++;
      return [];
    });
    assert.equal(getterCalls, 0);
  } finally {
    clearPricingJsonCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.9.1: Gemini 4 Neon & Claude 5.5 use flat 1M standard rates and strip stale >200K fields from legacy remote caches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-lens-flat1m-'));
  try {
    const cleanState = loadPricingState(dir);
    const nowMs = Date.parse('2026-11-22T08:00:00Z');

    for (const mid of ['gemini-4-neon', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      const rate = resolveRate(mid, nowMs, cleanState);
      assert.equal(rate.long_context_threshold, null, `${mid} bundled default must be flat 1M (no >200K tier)`);
    }

    // 300k-token Gemini 4 Neon turn billed strictly at $3/1M in, $0.15/1M cache read, $15/1M out (NOT 2x)
    const neon300k = calculateTurnCost(
      {
        canonical_model_id: 'gemini-4-neon',
        completed_at_ms: nowMs,
        uncached_in: 100_000,
        cache_read: 200_000,
        cache_create: 0,
        thinking_out: 0,
        visible_out: 10_000,
        total_out: 10_000,
      },
      cleanState
    );
    // 0.1*3 + 0.2*0.15 + 0.01*15 = 0.3 + 0.03 + 0.15 = $0.48
    assert.ok(Math.abs(neon300k.costUsd - 0.48) < 1e-9, `expected $0.48, got $${neon300k.costUsd}`);
    assert.equal(neon300k.longContext, false);

    // Legacy pre-v1.9.1 remote_pricing_cache.json (missing cacheVersion: 2) poisoned with stale >200K fields
    writeJsonAtomic(
      getRemoteCachePath(dir),
      {
        fetchedAt: nowMs,
        models: {
          'gemini-4-neon': {
            pool: 'gemini',
            effective_from: '2026-11-21',
            input_per_1m: 3.0,
            output_per_1m: 15.0,
            thinking_per_1m: 15.0,
            cache_read_per_1m: 0.15,
            cache_write_per_1m: 0,
            long_context_threshold: 200000,
            input_above_per_1m: 6.0,
            output_above_per_1m: 30.0,
            thinking_above_per_1m: 30.0,
            cache_read_above_per_1m: 0.3,
            cache_write_above_per_1m: 7.5,
            notes: 'Synced from LiteLLM',
          },
          'claude-opus-5-5': {
            pool: '3p',
            effective_from: '2026-11-21',
            input_per_1m: 4.0,
            output_per_1m: 20.0,
            thinking_per_1m: 20.0,
            cache_read_per_1m: 0.2,
            cache_write_per_1m: 5.0,
            long_context_threshold: 200000,
            input_above_per_1m: 8.0,
            output_above_per_1m: 30.0,
            notes: 'Synced from LiteLLM',
          },
        },
      },
      false
    );

    const legacyState = loadPricingState(dir);
    assert.equal(legacyState.remote.cacheVersion, 1);
    const resolvedNeon = resolveRate('gemini-4-neon', nowMs, legacyState);
    assert.equal(resolvedNeon.long_context_threshold, null, 'legacy poisoned >200K threshold must be stripped');
    assert.equal(resolvedNeon.input_above_per_1m, null);
    const resolvedOpus = resolveRate('claude-opus-5-5', nowMs, legacyState);
    assert.equal(resolvedOpus.long_context_threshold, null);

    // Explicit user override with >200K threshold must STILL be respected
    const ovState = saveOverride(dir, 'gemini-4-neon', {
      inputPer1m: 3.0,
      outputPer1m: 15.0,
      cacheReadPer1m: 0.15,
      longContextThreshold: 200000,
      inputAbovePer1m: 6.0,
      outputAbovePer1m: 30.0,
    });
    assert.equal(resolveRate('gemini-4-neon', nowMs, ovState).long_context_threshold, 200000);

    // Fresh v2 remote cache entry carrying a genuine provider >200K tier is preserved
    writeJsonAtomic(
      getRemoteCachePath(dir),
      {
        cacheVersion: REMOTE_CACHE_VERSION,
        fetchedAt: nowMs,
        models: {
          'gemini-2.5-pro': {
            pool: 'gemini',
            effective_from: '2026-11-22',
            input_per_1m: 1.25,
            output_per_1m: 10.0,
            long_context_threshold: 200000,
            input_above_per_1m: 2.5,
            output_above_per_1m: 15.0,
          },
        },
      },
      false
    );
    const v2State = loadPricingState(dir);
    assert.equal(v2State.remote.cacheVersion, REMOTE_CACHE_VERSION);
    assert.equal(resolveRate('gemini-2.5-pro', nowMs, v2State).long_context_threshold, 200000);
  } finally {
    clearPricingJsonCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
