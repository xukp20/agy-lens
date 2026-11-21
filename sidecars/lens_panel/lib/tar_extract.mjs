/**
 * Pure-JS zero-dependency streaming .tar.gz extractor for AGY Lens self-updater.
 * Supports USTAR prefix+name, PAX ('x'/'g') extended headers, GNU LongName ('L'),
 * octal & base-256 size fields, header checksum verification, and strict
 * cross-platform (Windows/macOS/Linux) path safety checks.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

const BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 600;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function readCString(buf, start, len) {
  let end = start;
  const max = start + len;
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(start, end).toString('utf-8');
}

function parseTarNumber(buf, start, len) {
  const first = buf[start];
  // GNU / POSIX base-256 binary encoding when high bit is set.
  if (first & 0x80) {
    if (first & 0x40) {
      throw new Error('Negative tar size is not supported');
    }
    let val = first & 0x7f;
    for (let i = 1; i < len; i++) {
      val = val * 256 + buf[start + i];
      if (!Number.isSafeInteger(val)) throw new Error('Tar numeric overflow');
    }
    return val;
  }
  const str = readCString(buf, start, len).trim();
  if (!str) return 0;
  if (!/^[0-7]+$/.test(str)) {
    throw new Error(`Invalid octal tar header field: "${str}"`);
  }
  return parseInt(str, 8);
}

function isZeroBlock(buf) {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function verifyHeaderChecksum(block) {
  const expected = parseTarNumber(block, 148, 8);
  let unsignedSum = 0;
  let signedSum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsignedSum += b;
    signedSum += b < 128 ? b : b - 256;
  }
  return expected === unsignedSum || expected === signedSum;
}

function parsePaxRecords(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const spaceIdx = buf.indexOf(0x20, pos); // ' '
    if (spaceIdx === -1) break;
    const lenStr = buf.subarray(pos, spaceIdx).toString('ascii');
    const recLen = parseInt(lenStr, 10);
    if (!Number.isFinite(recLen) || recLen <= 0 || pos + recLen > buf.length) break;
    const recordBuf = buf.subarray(spaceIdx + 1, pos + recLen);
    // Strip trailing '\n'
    const trimmed =
      recordBuf.length > 0 && recordBuf[recordBuf.length - 1] === 0x0a
        ? recordBuf.subarray(0, recordBuf.length - 1)
        : recordBuf;
    const eqIdx = trimmed.indexOf(0x3d); // '='
    if (eqIdx > 0) {
      const key = trimmed.subarray(0, eqIdx).toString('utf-8');
      const val = trimmed.subarray(eqIdx + 1).toString('utf-8');
      out[key] = val;
    }
    pos += recLen;
  }
  return out;
}

function validateNormalizedRelPath(relPath) {
  if (!relPath || relPath.length > 240) {
    throw new Error(`Unsafe archive path length: "${relPath}"`);
  }
  if (relPath.startsWith('/') || relPath.includes('\\') || relPath.includes(':') || relPath.includes('\0')) {
    throw new Error(`Unsafe archive path characters: "${relPath}"`);
  }
  const segs = relPath.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') {
      throw new Error(`Path traversal segment rejected: "${relPath}"`);
    }
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      throw new Error(`Windows-unsafe trailing dot/space rejected: "${relPath}"`);
    }
    if (WIN_RESERVED_RE.test(seg)) {
      throw new Error(`Windows reserved filename rejected: "${relPath}"`);
    }
  }
}

/**
 * Extract a .tar.gz Buffer or Readable stream into `destDir`.
 * Automatically validates a single shared top-level root folder and strips it.
 */
export async function extractTarGz(
  input,
  destDir,
  {
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  } = {}
) {
  const gunzip = createGunzip({ maxOutputLength: maxTotalBytes + BLOCK_SIZE * 64 });
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : input;

  const entries = [];
  let paxComment = '';
  let rootPrefix = null;

  // Incremental tar block state machine
  let pendingChunks = [];
  let pendingLen = 0;
  let state = 'header'; // 'header' | 'data' | 'pad' | 'eof'
  let currentEntry = null;
  let remainingBytes = 0;
  let padBytes = 0;
  let currentDataChunks = [];
  let nextPax = null;
  let nextGnuLongName = null;
  let totalUncompressed = 0;
  let zeroBlocks = 0;

  function takeBytes(n) {
    if (pendingLen < n) return null;
    let combined;
    if (pendingChunks.length === 1) {
      combined = pendingChunks[0];
      pendingChunks = [];
    } else {
      combined = Buffer.concat(pendingChunks, pendingLen);
      pendingChunks = [];
    }
    const slice = combined.subarray(0, n);
    if (combined.length > n) {
      pendingChunks.push(combined.subarray(n));
    }
    pendingLen -= n;
    return slice;
  }

  function finishEntryData() {
    const dataBuf =
      currentDataChunks.length === 0
        ? Buffer.alloc(0)
        : currentDataChunks.length === 1
          ? currentDataChunks[0]
          : Buffer.concat(currentDataChunks);
    currentDataChunks = [];

    const tf = currentEntry.typeflag;
    if (tf === 'x') {
      nextPax = parsePaxRecords(dataBuf);
    } else if (tf === 'g') {
      const globalPax = parsePaxRecords(dataBuf);
      if (globalPax.comment) paxComment = globalPax.comment;
    } else if (tf === 'L') {
      nextGnuLongName = dataBuf.toString('utf-8').replace(/\0+$/, '');
    } else if (tf === '0' || tf === '\0') {
      entries.push({
        rawPath: currentEntry.rawPath,
        type: 'file',
        data: dataBuf,
      });
    } else if (tf === '5') {
      entries.push({
        rawPath: currentEntry.rawPath,
        type: 'dir',
        data: null,
      });
    }
    currentEntry = null;
  }

  function processBuffer() {
    while (state !== 'eof') {
      if (state === 'header') {
        if (pendingLen < BLOCK_SIZE) return;
        const header = takeBytes(BLOCK_SIZE);
        if (isZeroBlock(header)) {
          zeroBlocks++;
          if (zeroBlocks >= 2) {
            state = 'eof';
            return;
          }
          continue;
        }
        zeroBlocks = 0;

        if (!verifyHeaderChecksum(header)) {
          throw new Error('Corrupt tar archive: header checksum mismatch');
        }

        const namePart = readCString(header, 0, 100);
        const magic = readCString(header, 257, 6);
        const prefixPart = magic.startsWith('ustar') ? readCString(header, 345, 155) : '';
        let rawPath = prefixPart ? `${prefixPart}/${namePart}` : namePart;
        let size = parseTarNumber(header, 124, 12);
        const typeflag = String.fromCharCode(header[156]);

        // Apply pending GNU LongName or PAX overrides to real entries (not metadata headers).
        if (typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L') {
          if (nextGnuLongName) {
            rawPath = nextGnuLongName;
            nextGnuLongName = null;
          }
          if (nextPax) {
            if (typeof nextPax.path === 'string' && nextPax.path) rawPath = nextPax.path;
            if (typeof nextPax.size === 'string' && /^\d+$/.test(nextPax.size)) {
              size = Number(nextPax.size);
            }
            nextPax = null;
          }
        }

        const isMeta = typeflag === 'x' || typeflag === 'g' || typeflag === 'L';
        const isFile = typeflag === '0' || typeflag === '\0';
        const isDir = typeflag === '5';

        if (!isMeta && !isFile && !isDir) {
          throw new Error(`Unsupported tar entry typeflag "${typeflag}" for "${rawPath}"`);
        }

        if (isFile && size > maxFileBytes) {
          throw new Error(`Tar entry "${rawPath}" exceeds max file size (${size} bytes)`);
        }
        if (isMeta && size > 256 * 1024) {
          throw new Error(`Tar metadata header too large (${size} bytes)`);
        }

        totalUncompressed += size;
        if (totalUncompressed > maxTotalBytes) {
          throw new Error(`Tar archive exceeds max uncompressed limit (${maxTotalBytes} bytes)`);
        }

        if (!isMeta && entries.length >= maxEntries) {
          throw new Error(`Tar archive exceeds max entry limit (${maxEntries})`);
        }

        currentEntry = { rawPath, typeflag, size };
        remainingBytes = size;
        padBytes = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
        currentDataChunks = [];

        if (remainingBytes > 0) {
          state = 'data';
        } else {
          finishEntryData();
          state = 'header';
        }
      } else if (state === 'data') {
        if (pendingLen === 0) return;
        const n = Math.min(pendingLen, remainingBytes);
        currentDataChunks.push(takeBytes(n));
        remainingBytes -= n;
        if (remainingBytes === 0) {
          finishEntryData();
          state = padBytes > 0 ? 'pad' : 'header';
        }
      } else if (state === 'pad') {
        if (pendingLen < padBytes) return;
        takeBytes(padBytes);
        padBytes = 0;
        state = 'header';
      }
    }
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      reject(err);
    };
    source.on('error', fail);
    gunzip.on('error', fail);
    gunzip.on('data', (chunk) => {
      if (settled) return;
      try {
        pendingChunks.push(chunk);
        pendingLen += chunk.length;
        processBuffer();
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('end', () => {
      if (settled) return;
      try {
        if (state === 'data' && remainingBytes > 0) {
          throw new Error('Truncated tar archive');
        }
        settled = true;
        resolve();
      } catch (err) {
        fail(err);
      }
    });
    source.pipe(gunzip);
  });

  if (entries.length === 0) {
    throw new Error('Archive contained no extractable entries');
  }

  // Validate single shared top-level root folder (e.g., "xukp20-agy-lens-abc123/" or "agy-lens-1.4.0/").
  const cleanEntries = [];
  const lowerSeen = new Set();

  for (const e of entries) {
    const cleaned = e.rawPath.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!cleaned) continue;
    if (cleaned.startsWith('/') || cleaned.includes('\\')) {
      throw new Error(`Unsafe archive entry path: "${e.rawPath}"`);
    }
    const slashIdx = cleaned.indexOf('/');
    const top = slashIdx === -1 ? cleaned : cleaned.slice(0, slashIdx);
    if (!top || top === '.' || top === '..') {
      throw new Error(`Invalid archive top-level folder: "${e.rawPath}"`);
    }
    if (rootPrefix === null) {
      rootPrefix = top;
    } else if (rootPrefix !== top) {
      throw new Error(`Archive does not share a single root directory ("${rootPrefix}" vs "${top}")`);
    }
    if (slashIdx === -1) continue; // Top-level directory entry itself.

    const relPath = cleaned.slice(slashIdx + 1);
    if (!relPath) continue;
    validateNormalizedRelPath(relPath);

    if (e.type === 'file') {
      const lower = relPath.toLowerCase();
      if (lowerSeen.has(lower)) {
        throw new Error(`Case-insensitive path collision in archive: "${relPath}"`);
      }
      lowerSeen.add(lower);
      cleanEntries.push({ relPath, data: e.data });
    }
  }

  if (!rootPrefix || cleanEntries.length === 0) {
    throw new Error('Archive contained no files under root directory');
  }

  mkdirSync(destDir, { recursive: true });
  const files = [];
  for (const item of cleanEntries) {
    const outPath = join(destDir, ...item.relPath.split('/'));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, item.data);
    const sha256 = createHash('sha256').update(item.data).digest('hex');
    files.push({ relPath: item.relPath, sha256, size: item.data.length });
  }

  return { rootPrefix, paxComment, files };
}
