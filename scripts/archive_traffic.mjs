#!/usr/bin/env node
/**
 * Zero-dependency GitHub Traffic & Release Download Archiver.
 *
 * Merges GitHub's rolling 14-day traffic windows (clones, views, referrers)
 * together with repository growth (stars/forks) and Release Asset download
 * counts into persistent JSON files and a readable SUMMARY.md.
 *
 * Usage:
 *   node scripts/archive_traffic.mjs --repo xukp20/agy-lens --out ./traffic-data
 *
 * Env:
 *   TRAFFIC_TOKEN   Fine-grained PAT with Administration: Read (for /traffic/*)
 *   GITHUB_TOKEN    Standard Actions token (for repo metadata & releases)
 *   GH_TOKEN        Optional fallback token (e.g. local `gh auth token`)
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.github.com';
const API_HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'agy-lens-traffic-archiver',
};

export function toUtcDateKey(input) {
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const parsed = new Date(`${input}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
      throw new Error(`Invalid date value: ${input}`);
    }
    return input;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date value: ${String(input)}`);
  }
  return d.toISOString().slice(0, 10);
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonPretty(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sortObjectByKey(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}

/**
 * Merge a GitHub `/traffic/clones` or `/traffic/views` response into persisted daily archive.
 * Uses Math.max per UTC date so a partially truncated 14-day boundary never regresses archived days.
 */
export function mergeDailySeries(existing, apiPayload, seriesKey, capturedAtIso) {
  const prevDays = existing && typeof existing.days === 'object' && existing.days !== null
    ? { ...existing.days }
    : {};

  const entries = Array.isArray(apiPayload?.[seriesKey]) ? apiPayload[seriesKey] : [];
  for (const row of entries) {
    if (!row || !row.timestamp) continue;
    const day = toUtcDateKey(row.timestamp);
    const prev = prevDays[day] || { count: 0, uniques: 0 };
    const nextCount = Number(row.count) || 0;
    const nextUniques = Number(row.uniques) || 0;
    prevDays[day] = {
      count: Math.max(Number(prev.count) || 0, nextCount),
      uniques: Math.max(Number(prev.uniques) || 0, nextUniques),
    };
  }

  const sortedDays = sortObjectByKey(prevDays);
  let totalCount = 0;
  let sumDailyUniques = 0;
  for (const entry of Object.values(sortedDays)) {
    totalCount += Number(entry.count) || 0;
    sumDailyUniques += Number(entry.uniques) || 0;
  }

  return {
    updatedAt: capturedAtIso,
    last14d: {
      count: Number(apiPayload?.count) || 0,
      uniques: Number(apiPayload?.uniques) || 0,
      capturedAt: capturedAtIso,
    },
    totals: {
      count: totalCount,
      sumDailyUniques,
      recordedDays: Object.keys(sortedDays).length,
    },
    days: sortedDays,
  };
}

/**
 * Merge a GitHub `/traffic/popular/referrers` rolling 14-day response into persisted snapshots.
 */
export function mergeReferrerSnapshot(existing, apiList, capturedAtIso) {
  const day = toUtcDateKey(capturedAtIso);
  const prevSnapshots = existing && typeof existing.snapshots === 'object' && existing.snapshots !== null
    ? { ...existing.snapshots }
    : {};
  const prevSeen = existing && typeof existing.seenReferrers === 'object' && existing.seenReferrers !== null
    ? { ...existing.seenReferrers }
    : {};

  const normalized = (Array.isArray(apiList) ? apiList : [])
    .filter((item) => item && typeof item.referrer === 'string' && item.referrer.trim())
    .map((item) => ({
      referrer: item.referrer.trim(),
      count: Number(item.count) || 0,
      uniques: Number(item.uniques) || 0,
    }))
    .sort((a, b) => b.uniques - a.uniques || b.count - a.count || a.referrer.localeCompare(b.referrer));

  prevSnapshots[day] = normalized;

  for (const item of normalized) {
    const prev = prevSeen[item.referrer];
    prevSeen[item.referrer] = {
      firstSeen: prev?.firstSeen || day,
      lastSeen: day,
      max14dCount: Math.max(Number(prev?.max14dCount) || 0, item.count),
      max14dUniques: Math.max(Number(prev?.max14dUniques) || 0, item.uniques),
      lastSeen14dCount: item.count,
      lastSeen14dUniques: item.uniques,
    };
  }

  return {
    updatedAt: capturedAtIso,
    latest: {
      capturedAt: capturedAtIso,
      referrers: normalized,
    },
    seenReferrers: sortObjectByKey(prevSeen),
    snapshots: sortObjectByKey(prevSnapshots),
  };
}

/**
 * Merge repository growth snapshot (stars, forks, watchers) keyed by UTC date.
 */
export function mergeRepoSnapshot(existing, repoPayload, capturedAtIso) {
  const day = toUtcDateKey(capturedAtIso);
  const prevHistory = existing && typeof existing.history === 'object' && existing.history !== null
    ? { ...existing.history }
    : {};

  const snapshot = {
    stars: Number(repoPayload?.stargazers_count) || 0,
    forks: Number(repoPayload?.forks_count) || 0,
    watchers: Number(repoPayload?.subscribers_count) || 0,
    openIssues: Number(repoPayload?.open_issues_count) || 0,
  };

  prevHistory[day] = snapshot;

  return {
    updatedAt: capturedAtIso,
    latest: {
      capturedAt: capturedAtIso,
      ...snapshot,
    },
    history: sortObjectByKey(prevHistory),
  };
}

/**
 * Summarize all GitHub Release asset download counts and record daily totals.
 */
export function mergeReleaseDownloads(existing, releasesList, capturedAtIso) {
  const day = toUtcDateKey(capturedAtIso);
  const prevHistory = existing && typeof existing.history === 'object' && existing.history !== null
    ? { ...existing.history }
    : {};

  let totalAssetDownloads = 0;
  const releases = (Array.isArray(releasesList) ? releasesList : [])
    .filter((rel) => rel && !rel.draft)
    .map((rel) => {
      const assets = (Array.isArray(rel.assets) ? rel.assets : []).map((asset) => {
        const downloads = Number(asset.download_count) || 0;
        totalAssetDownloads += downloads;
        return {
          name: String(asset.name || ''),
          downloads,
          sizeBytes: Number(asset.size) || 0,
        };
      });
      const releaseDownloads = assets.reduce((sum, a) => sum + a.downloads, 0);
      return {
        tag: String(rel.tag_name || ''),
        publishedAt: rel.published_at || null,
        totalDownloads: releaseDownloads,
        assets,
      };
    });

  prevHistory[day] = {
    totalAssetDownloads,
    releaseCount: releases.length,
  };

  return {
    updatedAt: capturedAtIso,
    totalAssetDownloads,
    releaseCount: releases.length,
    releases,
    history: sortObjectByKey(prevHistory),
  };
}

function escapeMdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Render a clean Markdown dashboard for the traffic-data branch root.
 */
export function renderSummaryMarkdown({
  repo,
  capturedAtIso,
  clones,
  views,
  referrers,
  repoStats,
  releases,
  trafficStatus,
}) {
  const lines = [];
  lines.push(`# ${repo} — Traffic & Download Archive`);
  lines.push('');
  lines.push(`Last updated: \`${capturedAtIso}\``);
  lines.push('');

  if (trafficStatus && trafficStatus !== 'ok') {
    lines.push(`> **Notice**: GitHub Traffic API status is \`${trafficStatus}\`. Ensure repository secret \`TRAFFIC_TOKEN\` is set to a Fine-grained PAT with **Administration: Read** permission for \`${repo}\`.`);
    lines.push('');
  }

  const stars = repoStats?.latest?.stars ?? 0;
  const forks = repoStats?.latest?.forks ?? 0;
  const totalClones = clones?.totals?.count ?? 0;
  const totalViews = views?.totals?.count ?? 0;
  const last14dClones = clones?.last14d?.count ?? 0;
  const last14dCloneUniques = clones?.last14d?.uniques ?? 0;
  const last14dViews = views?.last14d?.count ?? 0;
  const last14dViewUniques = views?.last14d?.uniques ?? 0;
  const totalAssetDownloads = releases?.totalAssetDownloads ?? 0;

  lines.push('## Overview');
  lines.push('');
  lines.push('| Metric | All-Time Archived | Rolling 14d |');
  lines.push('| :--- | ---: | ---: |');
  lines.push(`| Git Clones | ${totalClones} | ${last14dClones} (${last14dCloneUniques} unique) |`);
  lines.push(`| Repo Views | ${totalViews} | ${last14dViews} (${last14dViewUniques} unique) |`);
  lines.push(`| Release Asset Downloads | ${totalAssetDownloads} | — |`);
  lines.push(`| Stars / Forks | ${stars} / ${forks} | — |`);
  lines.push('');

  const topRefs = referrers?.latest?.referrers || [];
  lines.push('## Top Referrers (Last 14d)');
  lines.push('');
  if (topRefs.length === 0) {
    lines.push('_No referrer data captured yet._');
  } else {
    lines.push('| Referrer | Views | Unique Visitors |');
    lines.push('| :--- | ---: | ---: |');
    for (const r of topRefs) {
      lines.push(`| ${escapeMdCell(r.referrer)} | ${r.count} | ${r.uniques} |`);
    }
  }
  lines.push('');

  const releasesWithAssets = (releases?.releases || []).filter((r) => r.assets.length > 0);
  lines.push('## Release Asset Downloads');
  lines.push('');
  if (releasesWithAssets.length === 0) {
    lines.push('_No uploaded release assets yet._');
  } else {
    lines.push('| Tag | Asset | Downloads |');
    lines.push('| :--- | :--- | ---: |');
    for (const rel of releasesWithAssets.slice(0, 15)) {
      for (const asset of rel.assets) {
        lines.push(`| ${escapeMdCell(rel.tag)} | \`${escapeMdCell(asset.name)}\` | ${asset.downloads} |`);
      }
    }
  }
  lines.push('');

  const allDates = new Set([
    ...Object.keys(clones?.days || {}),
    ...Object.keys(views?.days || {}),
  ]);
  const recentDates = [...allDates].sort().reverse().slice(0, 30);

  lines.push('## Recent 30 Days (UTC)');
  lines.push('');
  if (recentDates.length === 0) {
    lines.push('_No daily traffic records archived yet._');
  } else {
    lines.push('| Date (UTC) | Clones (Unique) | Views (Unique) |');
    lines.push('| :--- | ---: | ---: |');
    for (const d of recentDates) {
      const c = clones?.days?.[d] || { count: 0, uniques: 0 };
      const v = views?.days?.[d] || { count: 0, uniques: 0 };
      lines.push(`| ${d} | ${c.count} (${c.uniques}) | ${v.count} (${v.uniques}) |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

async function fetchGitHubJson(url, token, fetchImpl = fetch) {
  const headers = { ...API_HEADERS_BASE };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(url, {
    headers,
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(15000)
      : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    message: json?.message || text.slice(0, 200),
    link: res.headers.get('link') || '',
  };
}

async function fetchAllReleases(repo, token, fetchImpl = fetch) {
  const all = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${API_BASE}/repos/${repo}/releases?per_page=100&page=${page}`;
    const res = await fetchGitHubJson(url, token, fetchImpl);
    if (!res.ok) {
      throw new Error(`Failed to fetch releases (HTTP ${res.status}): ${res.message}`);
    }
    const items = Array.isArray(res.json) ? res.json : [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

export async function runArchive({
  repo,
  outDir,
  trafficToken = '',
  publicToken = '',
  requireTraffic = false,
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid --repo value: ${String(repo)}`);
  }
  if (!outDir) {
    throw new Error('Missing --out directory');
  }

  const capturedAtIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const dataDir = path.join(outDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const clonesPath = path.join(dataDir, 'clones.json');
  const viewsPath = path.join(dataDir, 'views.json');
  const referrersPath = path.join(dataDir, 'referrers.json');
  const repoPath = path.join(dataDir, 'repo.json');
  const releasesPath = path.join(dataDir, 'releases.json');

  let clones = readJsonSafe(clonesPath, null);
  let views = readJsonSafe(viewsPath, null);
  let referrers = readJsonSafe(referrersPath, null);
  let repoStats = readJsonSafe(repoPath, null);
  let releases = readJsonSafe(releasesPath, null);

  // 1. Public metadata & release assets
  const repoRes = await fetchGitHubJson(`${API_BASE}/repos/${repo}`, publicToken || trafficToken, fetchImpl);
  if (!repoRes.ok) {
    throw new Error(`Failed to fetch repo metadata (HTTP ${repoRes.status}): ${repoRes.message}`);
  }
  repoStats = mergeRepoSnapshot(repoStats, repoRes.json, capturedAtIso);
  writeJsonPretty(repoPath, repoStats);

  const releasesList = await fetchAllReleases(repo, publicToken || trafficToken, fetchImpl);
  releases = mergeReleaseDownloads(releases, releasesList, capturedAtIso);
  writeJsonPretty(releasesPath, releases);

  // 2. Traffic endpoints (requires Administration: Read permission)
  let trafficStatus = 'ok';
  const effectiveTrafficToken = trafficToken || publicToken;
  if (!effectiveTrafficToken) {
    trafficStatus = 'missing_token';
  } else {
    const [clonesRes, viewsRes, refsRes] = await Promise.all([
      fetchGitHubJson(`${API_BASE}/repos/${repo}/traffic/clones?per=day`, effectiveTrafficToken, fetchImpl),
      fetchGitHubJson(`${API_BASE}/repos/${repo}/traffic/views?per=day`, effectiveTrafficToken, fetchImpl),
      fetchGitHubJson(`${API_BASE}/repos/${repo}/traffic/popular/referrers`, effectiveTrafficToken, fetchImpl),
    ]);

    const anyAuthErr = [clonesRes, viewsRes, refsRes].find((r) => r.status === 401 || r.status === 403);
    if (anyAuthErr) {
      trafficStatus = `http_${anyAuthErr.status}`;
      if (requireTraffic) {
        throw new Error(`Traffic API access denied (HTTP ${anyAuthErr.status}): ${anyAuthErr.message}`);
      }
    } else {
      const anyErr = [clonesRes, viewsRes, refsRes].find((r) => !r.ok);
      if (anyErr) {
        throw new Error(`Traffic API request failed (HTTP ${anyErr.status}): ${anyErr.message}`);
      }
      clones = mergeDailySeries(clones, clonesRes.json, 'clones', capturedAtIso);
      views = mergeDailySeries(views, viewsRes.json, 'views', capturedAtIso);
      referrers = mergeReferrerSnapshot(referrers, refsRes.json, capturedAtIso);

      writeJsonPretty(clonesPath, clones);
      writeJsonPretty(viewsPath, views);
      writeJsonPretty(referrersPath, referrers);
    }
  }

  if (trafficStatus !== 'ok' && requireTraffic) {
    throw new Error(`Traffic API unavailable (${trafficStatus})`);
  }

  const summaryMd = renderSummaryMarkdown({
    repo,
    capturedAtIso,
    clones,
    views,
    referrers,
    repoStats,
    releases,
    trafficStatus,
  });
  fs.writeFileSync(path.join(outDir, 'SUMMARY.md'), `${summaryMd}`, 'utf8');

  return {
    repo,
    capturedAtIso,
    trafficStatus,
    totals: {
      clones: clones?.totals?.count ?? 0,
      views: views?.totals?.count ?? 0,
      assetDownloads: releases?.totalAssetDownloads ?? 0,
      stars: repoStats?.latest?.stars ?? 0,
    },
    summaryMd,
  };
}

function parseCliArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || 'xukp20/agy-lens',
    outDir: '',
    requireTraffic: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--repo' && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (token === '--out' && argv[i + 1]) {
      args.outDir = argv[++i];
    } else if (token === '--require-traffic') {
      args.requireTraffic = true;
    } else if (token === '-h' || token === '--help') {
      console.log('Usage: node scripts/archive_traffic.mjs --repo <owner/repo> --out <dir> [--require-traffic]');
      process.exit(0);
    }
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const cli = parseCliArgs(process.argv.slice(2));
  const trafficToken = process.env.TRAFFIC_TOKEN || process.env.GH_TOKEN || '';
  const publicToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

  runArchive({
    repo: cli.repo,
    outDir: cli.outDir,
    trafficToken,
    publicToken,
    requireTraffic: cli.requireTraffic,
  })
    .then((result) => {
      if (result.trafficStatus !== 'ok' && process.env.GITHUB_ACTIONS === 'true') {
        console.log(
          `::warning::GitHub Traffic API skipped (${result.trafficStatus}). Add repository secret TRAFFIC_TOKEN (Fine-grained PAT with Administration: Read) to archive clones/views/referrers.`,
        );
      }
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.summaryMd}\n`, 'utf8');
      }
      console.log(JSON.stringify({
        ok: true,
        repo: result.repo,
        trafficStatus: result.trafficStatus,
        totals: result.totals,
      }));
    })
    .catch((err) => {
      console.error(`archive_traffic failed: ${err?.message || err}`);
      process.exit(1);
    });
}
