import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mergeDailySeries,
  mergeReferrerSnapshot,
  mergeReleaseDownloads,
  mergeRepoSnapshot,
  renderSummaryMarkdown,
  runArchive,
} from './archive_traffic.mjs';

test('mergeDailySeries merges overlapping 14-day windows monotonically without regression', () => {
  const day1 = mergeDailySeries(
    null,
    {
      count: 30,
      uniques: 12,
      clones: [
        { timestamp: '2026-11-10T00:00:00Z', count: 10, uniques: 5 },
        { timestamp: '2026-11-11T00:00:00Z', count: 20, uniques: 7 },
      ],
    },
    'clones',
    '2026-11-11T12:00:00Z',
  );

  assert.equal(day1.totals.count, 30);
  assert.equal(day1.totals.recordedDays, 2);

  // Next run: 11-10 appears truncated at rolling boundary (lower value -> must NOT regress),
  // 11-11 grows as UTC day completes, 11-12 is a new day.
  const day2 = mergeDailySeries(
    day1,
    {
      count: 37,
      uniques: 15,
      clones: [
        { timestamp: '2026-11-10T00:00:00Z', count: 4, uniques: 2 },
        { timestamp: '2026-11-11T00:00:00Z', count: 25, uniques: 9 },
        { timestamp: '2026-11-12T00:00:00Z', count: 8, uniques: 4 },
      ],
    },
    'clones',
    '2026-11-12T01:30:00Z',
  );

  assert.deepEqual(day2.days['2026-11-10'], { count: 10, uniques: 5 });
  assert.deepEqual(day2.days['2026-11-11'], { count: 25, uniques: 9 });
  assert.deepEqual(day2.days['2026-11-12'], { count: 8, uniques: 4 });
  assert.equal(day2.totals.count, 43);
  assert.equal(day2.totals.sumDailyUniques, 18);
  assert.equal(day2.totals.recordedDays, 3);
});

test('mergeReferrerSnapshot and mergeReleaseDownloads preserve history and aggregate totals', () => {
  const ref1 = mergeReferrerSnapshot(
    null,
    [
      { referrer: 'github.com', count: 18, uniques: 3 },
      { referrer: 'reddit.com', count: 90, uniques: 42 },
    ],
    '2026-11-23T01:30:00Z',
  );
  assert.equal(ref1.latest.referrers[0].referrer, 'reddit.com');
  assert.equal(ref1.seenReferrers['reddit.com'].max14dUniques, 42);

  const ref2 = mergeReferrerSnapshot(
    ref1,
    [
      { referrer: 'news.ycombinator.com', count: 210, uniques: 120 },
      { referrer: 'reddit.com', count: 60, uniques: 30 },
    ],
    '2026-11-24T01:30:00Z',
  );
  assert.equal(ref2.seenReferrers['reddit.com'].max14dCount, 90);
  assert.equal(ref2.seenReferrers['reddit.com'].lastSeen14dCount, 60);
  assert.equal(ref2.seenReferrers['news.ycombinator.com'].firstSeen, '2026-11-24');
  assert.equal(Object.keys(ref2.snapshots).length, 2);

  const rel = mergeReleaseDownloads(
    null,
    [
      {
        tag_name: 'v1.11.0',
        published_at: '2026-11-23T00:00:00Z',
        draft: false,
        assets: [
          { name: 'agy-lens-1.11.0.tgz', download_count: 14, size: 220000 },
          { name: 'SHA256SUMS.txt', download_count: 3, size: 96 },
        ],
      },
      {
        tag_name: 'v1.12.0-draft',
        draft: true,
        assets: [{ name: 'ignored.tgz', download_count: 99, size: 100 }],
      },
    ],
    '2026-11-23T01:30:00Z',
  );
  assert.equal(rel.releaseCount, 1);
  assert.equal(rel.totalAssetDownloads, 17);
  assert.equal(rel.history['2026-11-23'].totalAssetDownloads, 17);

  const repoStats = mergeRepoSnapshot(
    null,
    { stargazers_count: 42, forks_count: 5, subscribers_count: 3, open_issues_count: 1 },
    '2026-11-23T01:30:00Z',
  );
  const md = renderSummaryMarkdown({
    repo: 'xukp20/agy-lens',
    capturedAtIso: '2026-11-23T01:30:00Z',
    clones: null,
    views: null,
    referrers: ref2,
    repoStats,
    releases: rel,
    trafficStatus: 'ok',
  });
  assert.match(md, /news\.ycombinator\.com/);
  assert.match(md, /agy-lens-1\.11\.0\.tgz/);
  assert.match(md, /\| Stars \/ Forks \| 42 \/ 5 \|/);
});

test('runArchive writes all files and gracefully degrades when Traffic API returns 403', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-lens-traffic-test-'));
  try {
    const makeResponse = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => '' },
      text: async () => JSON.stringify(body),
    });

    const mockFetch = async (url) => {
      if (url.endsWith('/repos/xukp20/agy-lens')) {
        return makeResponse(200, { stargazers_count: 9, forks_count: 1, subscribers_count: 2, open_issues_count: 0 });
      }
      if (url.includes('/releases?')) {
        return makeResponse(200, [
          {
            tag_name: 'v1.11.0',
            published_at: '2026-11-23T02:00:00Z',
            draft: false,
            assets: [{ name: 'agy-lens-1.11.0.tgz', download_count: 7, size: 225000 }],
          },
        ]);
      }
      if (url.includes('/traffic/')) {
        return makeResponse(403, { message: 'Must have push access to repository' });
      }
      return makeResponse(404, { message: 'not found' });
    };

    // Soft mode (default in Actions): degrades gracefully on 403 while still writing repo/releases/SUMMARY
    const res = await runArchive({
      repo: 'xukp20/agy-lens',
      outDir: tmpDir,
      publicToken: 'fake-gh-token',
      trafficToken: '',
      requireTraffic: false,
      now: new Date('2026-11-23T08:00:00Z'),
      fetchImpl: mockFetch,
    });

    assert.equal(res.trafficStatus, 'http_403');
    assert.equal(res.totals.stars, 9);
    assert.equal(res.totals.assetDownloads, 7);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'repo.json')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'releases.json')), true);
    const summary = fs.readFileSync(path.join(tmpDir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /TRAFFIC_TOKEN/);

    // Strict mode (--require-traffic): fails explicitly on 403
    await assert.rejects(
      () =>
        runArchive({
          repo: 'xukp20/agy-lens',
          outDir: tmpDir,
          publicToken: 'fake-gh-token',
          trafficToken: '',
          requireTraffic: true,
          now: new Date('2026-11-23T08:00:00Z'),
          fetchImpl: mockFetch,
        }),
      /Traffic API access denied/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
