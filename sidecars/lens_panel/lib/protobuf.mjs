/**
 * Minimal, zero-dependency Protobuf wire parser for Antigravity SQLite blobs.
 * Defensive bounds checking ensures malformed or truncated blobs never throw.
 */

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Decode an unsigned base-128 varint from `buf` starting at `offset`.
 * Uses BigInt internally so 64-bit timestamps/values never overflow 32-bit ops.
 */
export function decodeVarint(buf, offset = 0) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  const len = buf.length;
  while (pos < len) {
    const byte = BigInt(buf[pos++]);
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      const num = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      return { value: num, big: value, nextOffset: pos };
    }
    shift += 7n;
    if (shift > 63n) {
      return { value: 0, big: 0n, nextOffset: len };
    }
  }
  return { value: 0, big: 0n, nextOffset: len };
}

/**
 * Parse raw protobuf wire bytes into Map<fieldNumber, Array<Uint8Array|number|bigint>>.
 */
export function decodeFields(raw) {
  const fields = new Map();
  if (!raw || raw.length === 0) return fields;
  const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  let pos = 0;
  const len = buf.length;

  while (pos < len) {
    const tag = decodeVarint(buf, pos);
    pos = tag.nextOffset;
    const tagBig = tag.big;
    const fieldNum = Number(tagBig >> 3n);
    const wireType = Number(tagBig & 7n);
    if (fieldNum <= 0) break;

    let val;
    if (wireType === 0) {
      const v = decodeVarint(buf, pos);
      pos = v.nextOffset;
      val = v.value;
    } else if (wireType === 1) {
      if (pos + 8 > len) break;
      val = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) {
      const l = decodeVarint(buf, pos);
      pos = l.nextOffset;
      const byteLen = Number(l.value);
      if (!Number.isFinite(byteLen) || byteLen < 0 || pos + byteLen > len) break;
      val = buf.subarray(pos, pos + byteLen);
      pos += byteLen;
    } else if (wireType === 5) {
      if (pos + 4 > len) break;
      val = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      // Deprecated group wire types (3/4) or invalid wire types (6/7).
      break;
    }

    let arr = fields.get(fieldNum);
    if (!arr) {
      arr = [];
      fields.set(fieldNum, arr);
    }
    arr.push(val);
  }
  return fields;
}

export function getInt(fields, fieldNum, fallback = null) {
  const arr = fields?.get(fieldNum);
  if (!arr || arr.length === 0) return fallback;
  const v = arr[0];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return fallback;
}

export function getBytes(fields, fieldNum) {
  const arr = fields?.get(fieldNum);
  if (!arr || arr.length === 0) return null;
  const v = arr[0];
  return v instanceof Uint8Array ? v : null;
}

export function getString(fields, fieldNum, fallback = '') {
  const bytes = getBytes(fields, fieldNum);
  if (!bytes) return fallback;
  return textDecoder.decode(bytes);
}

export function getMsg(fields, fieldNum) {
  const bytes = getBytes(fields, fieldNum);
  return bytes ? decodeFields(bytes) : null;
}

export function getMsgs(fields, fieldNum) {
  const arr = fields?.get(fieldNum);
  if (!arr || arr.length === 0) return [];
  const out = [];
  for (const v of arr) {
    if (v instanceof Uint8Array) out.push(decodeFields(v));
  }
  return out;
}

export function decodePackedVarints(bytes) {
  const out = [];
  if (!bytes || bytes.length === 0) return out;
  let pos = 0;
  while (pos < bytes.length) {
    const v = decodeVarint(bytes, pos);
    pos = v.nextOffset;
    out.push(typeof v.value === 'bigint' ? Number(v.value) : v.value);
  }
  return out;
}

/**
 * Decode google.protobuf.Timestamp `{1: unix_sec, 2: nanos}` -> epoch ms.
 */
export function decodeTimestampMs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  const f = decodeFields(bytes);
  const sec = getInt(f, 1, 0);
  const nanos = getInt(f, 2, 0);
  if (!sec || sec <= 0) return null;
  return Math.round(sec * 1000 + nanos / 1e6);
}

/**
 * Decode google.protobuf.Duration `{1: sec, 2: nanos}` -> ms.
 */
export function decodeDurationMs(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  const f = decodeFields(bytes);
  const sec = getInt(f, 1, 0);
  const nanos = getInt(f, 2, 0);
  const ms = Math.round(sec * 1000 + nanos / 1e6);
  return ms >= 0 ? ms : null;
}

/**
 * Parse `steps.metadata` for `step_type = 15` (PLANNER_RESPONSE).
 * Always <= 400B and 100% lossless even when `gen_metadata` > 2MB.
 */
export function parseStep15Metadata(raw) {
  const f = decodeFields(raw);
  const createdAtMs = decodeTimestampMs(getBytes(f, 1));
  const firstTokenAtMs = decodeTimestampMs(getBytes(f, 6));
  const completedAtMs = decodeTimestampMs(getBytes(f, 7));

  const usage = getMsg(f, 9);
  const usageModelEnum = usage ? getInt(usage, 1, null) : null;
  const uncachedIn = usage ? getInt(usage, 2, 0) : 0;
  const totalOut = usage ? getInt(usage, 3, 0) : 0;
  const cacheRead = usage ? getInt(usage, 5, 0) : 0;
  const providerEnum = usage ? getInt(usage, 6, null) : null;
  const thinkingOut = usage ? getInt(usage, 9, 0) : 0;
  const rawVisibleOut = usage ? getInt(usage, 10, null) : null;
  const visibleOut = rawVisibleOut !== null ? rawVisibleOut : Math.max(0, totalOut - thinkingOut);
  const providerRequestId = usage ? getString(usage, 11, '') : '';

  const modelEnum = getInt(f, 11, usageModelEnum);
  const ttftMs =
    firstTokenAtMs && createdAtMs && firstTokenAtMs >= createdAtMs
      ? firstTokenAtMs - createdAtMs
      : null;
  const genMs =
    completedAtMs && firstTokenAtMs && completedAtMs >= firstTokenAtMs
      ? completedAtMs - firstTokenAtMs
      : null;

  return {
    createdAtMs,
    firstTokenAtMs,
    completedAtMs,
    ttftMs,
    genMs,
    modelEnum,
    providerEnum,
    providerRequestId,
    uncachedIn,
    cacheRead,
    cacheCreate: 0,
    totalOut,
    thinkingOut,
    visibleOut,
  };
}

/**
 * Parse `gen_metadata.data` outer wrapper.
 * Optionally includes detailed `9.10.3` breakdown (present only on latest row).
 */
export function parseGenMetadata(raw, { includeBreakdown = false } = {}) {
  const outer = decodeFields(raw);
  const gen = getMsg(outer, 1);
  const stepBytes = getBytes(outer, 2);
  const stepIdxs = stepBytes ? decodePackedVarints(stepBytes) : [];

  if (!gen) {
    return { stepIdxs, modelEnum: null, modelId: '', displayName: '', ttftMs: null, genMs: null, contextEst: null, compactLimit: null, breakdown: [] };
  }

  const modelEnum = getInt(gen, 3, null);
  const modelId = getString(gen, 19, '');
  const displayName = getString(gen, 21, '');
  const ttftMs = decodeDurationMs(getBytes(gen, 11));
  const genMs = decodeDurationMs(getBytes(gen, 12));

  let contextEst = null;
  let compactLimit = null;
  const breakdown = [];

  const f9 = getMsg(gen, 9);
  const f10 = f9 ? getMsg(f9, 10) : null;
  if (f10) {
    contextEst = getInt(f10, 1, null);
    compactLimit = getInt(f10, 4, null);
    if (includeBreakdown) {
      const f3 = getMsg(f10, 3);
      if (f3) {
        const total = getInt(f3, 2, null);
        if (contextEst === null && total !== null) contextEst = total;
        for (const cat of getMsgs(f3, 1)) {
          const items = getMsgs(cat, 5).map((item) => ({
            name: getString(item, 1, 'unknown'),
            tokens: getInt(item, 3, 0),
          }));
          breakdown.push({
            name: getString(cat, 1, 'Unspecified'),
            id: getInt(cat, 2, 0),
            tokens: getInt(cat, 4, 0),
            items,
          });
        }
      }
    }
  }

  return {
    stepIdxs,
    modelEnum,
    modelId,
    displayName,
    ttftMs,
    genMs,
    contextEst,
    compactLimit,
    breakdown,
  };
}

/**
 * Parse `trajectory_metadata_blob.data` (`id = 'main'`) to extract workspace path/URI.
 */
export function parseTrajectoryMetaBlob(raw) {
  const f = decodeFields(raw);
  let workspaceUri = '';

  const f7 = getString(f, 7, '');
  if (f7) {
    workspaceUri = f7;
  } else {
    const f1Bytes = getBytes(f, 1);
    if (f1Bytes) {
      const f1Msg = decodeFields(f1Bytes);
      const sub1 = getString(f1Msg, 1, '');
      if (sub1 && (sub1.startsWith('file://') || sub1.startsWith('/'))) {
        workspaceUri = sub1;
      } else {
        const asStr = textDecoder.decode(f1Bytes);
        if (asStr.startsWith('file://') || asStr.startsWith('/')) {
          workspaceUri = asStr;
        }
      }
    }
  }

  const createdAtMs = decodeTimestampMs(getBytes(f, 2));
  return {
    workspace: normalizeWorkspaceUri(workspaceUri),
    workspaceUri,
    createdAtMs,
  };
}

export function normalizeWorkspaceUri(uri) {
  if (!uri || typeof uri !== 'string') return '';
  let clean = uri.trim();
  if (clean.startsWith('file://')) {
    try {
      clean = decodeURIComponent(clean.slice(7));
    } catch {
      clean = clean.slice(7);
    }
  }
  return clean;
}
