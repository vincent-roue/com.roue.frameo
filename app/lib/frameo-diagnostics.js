'use strict';

const { randomInt } = require('node:crypto');
const { OPERATIONS, CODES, readNodeMemory } = require('./engine-metrics');
const { REASON_KEYS } = require('./transfer-journal');

const MAX_BYTES = 128 * 1024;
const MAX_RECORDS = 50;
const SAFE_CODES = new Set([
  ...CODES,
  ...Object.keys(REASON_KEYS),
  'UPLOAD_INVALID',
  'UPLOAD_NOT_FOUND',
  'UPLOAD_OFFSET_INVALID',
  'UPLOAD_INCOMPLETE',
  'UPLOAD_LIMIT',
  'UPLOAD_FAILED',
  'TRANSFER_BATCH_EXPIRED',
  'TRANSFER_NOT_FOUND',
]);
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'uncertain', 'partial']);
const OS = new Set(['linux', 'darwin', 'win32']);
const ARCH = new Set(['arm64', 'x64', 'arm', 'ia32']);
const ENGINE = new Set(['unframeo', 'unframeo-go', 'homey-frameo', 'frameo-go']);

function read(object, key) {
  try {
    return object?.[key];
  } catch {
    return undefined;
  }
}
function snapshot(object, method) {
  try {
    const fn = read(object, method);
    if (typeof fn !== 'function') return undefined;
    const value = fn.call(object);
    if (value?.then) {
      value.catch?.(() => {});
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}
function milliseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400000
    ? Math.round(value * 10) / 10
    : null;
}
function bool(value) {
  return typeof value === 'boolean' ? value : null;
}
function version(value) {
  return typeof value === 'string' && /^v?\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value)
    ? value.replace(/^v/, '')
    : null;
}
function code(value) {
  return typeof value === 'string' && SAFE_CODES.has(value) ? value : 'UNKNOWN_ERROR';
}
function minute(value) {
  if (
    typeof value !== 'string' ||
    !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(Math.floor(parsed / 60000) * 60000).toISOString();
}
function safeArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}
function size(value) {
  if (Array.isArray(value)) return integer(value.length);
  if (value instanceof Map || value instanceof Set) return integer(value.size);
  return null;
}
function bytes(value) {
  return integer(value, 1024 ** 4);
}

// Build a fresh DTO from literal approved fields. Never serialize an upstream
// object and redact it afterwards: those objects can contain photos and names.
function getReport(app, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const safeNow = Number.isFinite(now) && now >= 0 && now <= 8640000000000000 ? now : 0;
  const generatedAt = new Date(Math.floor(safeNow / 60000) * 60000).toISOString();
  const homey = read(app, 'homey');
  const manifest = read(homey, 'manifest');
  const runtime = read(app, 'runtimeStatus');
  const engine = read(app, 'engine');
  const probe = read(runtime, 'engine');
  const performance = snapshot(engine, 'performanceStats');
  const index = snapshot(engine, 'mediaIndexStats');
  const uploads = snapshot(read(app, 'uploads'), 'stats');
  const recovery = read(read(app, 'uploads'), 'recovery');
  const transfers = read(app, 'transfers');
  const jobs = read(read(transfers, 'journal'), 'jobs');
  const groups = read(read(app, 'groups'), 'groups');
  const devices = snapshot(app, 'getDevices');
  const cache = read(app, 'previewCache');
  let memory;
  try {
    memory = options.memoryUsage ? options.memoryUsage() : readNodeMemory();
  } catch {}

  const failures = new Map();
  const operations = [];
  const operationRows = safeArray(read(performance, 'operations'), MAX_RECORDS);
  for (const operation of OPERATIONS) {
    const row = operationRows.find((value) => read(value, 'operation') === operation);
    if (!row) continue;
    operations.push({
      operation,
      count: integer(read(row, 'count')),
      failed: integer(read(row, 'failed')),
      lastMs: milliseconds(read(row, 'lastMs')),
      medianMs: milliseconds(read(row, 'medianMs')),
      p95Ms: milliseconds(read(row, 'p95Ms')),
      sampledNodeRssBytes: bytes(read(row, 'sampledNodeRssBytes')),
      sampledChildRssBytes: bytes(read(row, 'sampledChildRssBytes')),
      sampledChildHwmBytes: bytes(read(row, 'sampledChildHwmBytes')),
    });
    for (const failure of safeArray(read(row, 'failures'), MAX_RECORDS)) {
      const count = integer(read(failure, 'count'));
      if (!count) continue;
      const key = code(read(failure, 'code'));
      failures.set(key, Math.min(Number.MAX_SAFE_INTEGER, (failures.get(key) || 0) + count));
    }
  }
  const recent = [];
  const seen = new Set();
  const historyStatus = {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    uncertain: 0,
    partial: 0,
  };
  for (const job of safeArray(jobs, MAX_RECORDS)) {
    const state = read(job, 'status');
    if (STATES.has(state)) historyStatus[state]++;
    for (const result of safeArray(read(job, 'results'), 64)) {
      if (!['failed', 'uncertain'].includes(read(result, 'status'))) continue;
      const key = code(read(result, 'code'));
      const at =
        minute(read(result, 'completedAt')) ||
        minute(read(job, 'completedAt')) ||
        minute(read(job, 'createdAt'));
      const unique = key + ':' + at;
      if (!seen.has(unique)) {
        seen.add(unique);
        recent.push({ code: key, at });
      }
    }
  }
  const errorCounts = [...failures]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 10);
  recent.sort((a, b) => (b.at || '').localeCompare(a.at || '') || a.code.localeCompare(b.code));
  const recentErrors = recent.slice(0, 10);
  const frameBudget = MAX_RECORDS - operations.length - errorCounts.length - recentErrors.length;
  const frameRows = [];
  for (const device of safeArray(devices, MAX_RECORDS)) {
    const info = read(device, 'lastInfo');
    const modeValue = snapshot(device, 'accessMode');
    const routeValue = read(info, 'route');
    frameRows.push({
      connection: ['local', 'relay'].includes(routeValue) ? routeValue : 'unknown',
      mode: ['send', 'manage'].includes(modeValue) ? modeValue : 'unknown',
      available: bool(snapshot(device, 'getAvailable')),
      grants: {
        view: bool(read(info, 'mayView')),
        manage: bool(read(info, 'mayManage')),
        backup: bool(read(info, 'mayBackup')),
        sharePairing: bool(read(info, 'maySharePairing')),
      },
    });
  }
  // Fresh shuffled positions, with no ID lookup, hash, seed or saved mapping.
  const choose = options.randomInt || randomInt;
  for (let at = frameRows.length - 1; at > 0; at--) {
    const picked = choose(at + 1);
    const index = Number.isInteger(picked) && picked >= 0 && picked <= at ? picked : 0;
    [frameRows[at], frameRows[index]] = [frameRows[index], frameRows[at]];
  }
  const frames = frameRows
    .slice(0, frameBudget)
    .map((row, index) => ({ frame: index + 1, ...row }));
  const started = minute(read(app, 'startedAt'));
  const startedMs = started ? Date.parse(started) : null;
  const architecture = read(runtime, 'architecture') || process.arch;
  const osPlatform = read(runtime, 'platform') || process.platform;
  const report = {
    schemaVersion: 1,
    generatedAt,
    versions: {
      app: version(read(manifest, 'version')),
      sdk: integer(read(manifest, 'sdk'), 3),
      homey: version(read(homey, 'version')),
      node: version(process.versions.node),
      engine: {
        family: ENGINE.has(read(probe, 'engine')) ? read(probe, 'engine') : null,
        protocolVersion: integer(read(probe, 'protocolVersion'), 100),
        os: OS.has(read(probe, 'goos')) ? read(probe, 'goos') : null,
        architecture: ARCH.has(read(probe, 'goarch')) ? read(probe, 'goarch') : null,
      },
    },
    runtime: {
      platform: ['local', 'cloud'].includes(read(homey, 'platform'))
        ? read(homey, 'platform')
        : null,
      platformVersion: integer(read(homey, 'platformVersion'), 100),
      os: OS.has(osPlatform) ? osPlatform : null,
      architecture: ARCH.has(architecture) ? architecture : null,
      ready: bool(read(runtime, 'ready')),
      stopping: bool(read(app, 'stopping')),
      errorCode: read(runtime, 'error') ? code(read(runtime, 'error')) : null,
      uptimeSeconds:
        startedMs === null
          ? null
          : Math.max(0, Math.floor((Date.parse(generatedAt) - startedMs) / 1000)),
    },
    counts: {
      frames: size(devices),
      groups: size(groups),
      queuedTransfers: size(read(transfers, 'queue')),
      liveTransfers: size(read(transfers, 'runtime')),
      batches: size(read(transfers, 'batches')),
      historyJobs: size(jobs),
      historyStatus,
    },
    memory: {
      node: {
        rssBytes: bytes(read(memory, 'rss')),
        heapTotalBytes: bytes(read(memory, 'heapTotal')),
        heapUsedBytes: bytes(read(memory, 'heapUsed')),
        externalBytes: bytes(read(memory, 'external')),
        arrayBuffersBytes: bytes(read(memory, 'arrayBuffers')),
      },
      transferSourceBytes: bytes(read(transfers, 'sourceMemory')),
    },
    previewCache: {
      bytes: bytes(read(cache, 'bytes')),
      entries: integer(read(cache, 'size')),
      maxBytes: 8 * 1024 * 1024,
    },
    uploads: {
      sessions: integer(read(uploads, 'sessions')),
      reservedBytes: bytes(read(uploads, 'bytes')),
      maxBytes: 16 * 1024 * 1024,
    },
    temporaryRecovery: {
      scanned: integer(read(recovery, 'scanned')),
      removed: integer(read(recovery, 'removed')),
      failed: integer(read(recovery, 'failed')),
      live: integer(read(recovery, 'live')),
      unknown: integer(read(recovery, 'unknown')),
      budgetExhausted: bool(read(recovery, 'budgetExhausted')),
      remainingUnknown: bool(read(recovery, 'remainingUnknown')),
    },
    mediaIndex: {
      available: Boolean(index),
      entries: integer(read(index, 'entries')),
      bytes: bytes(read(index, 'bytes')),
      maxBytes: integer(read(index, 'maxBytes')),
      maxEntries: integer(read(index, 'maxEntries')),
      ttlMs: integer(read(index, 'ttlMs')),
      hits: integer(read(index, 'hits')),
      misses: integer(read(index, 'misses')),
      loads: integer(read(index, 'loads')),
      evictions: integer(read(index, 'evictions')),
      invalidations: integer(read(index, 'invalidations')),
    },
    performance: {
      available: Boolean(performance),
      durationWindowMaxSamples: 32,
      sampleIntervalMs: integer(read(performance, 'sampleIntervalMs'), 60000),
      operations,
    },
    errors: { counts: errorCounts, recent: recentErrors },
    frames,
    limits: { maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS },
    truncated: {
      frames: (size(devices) || 0) > frames.length,
      errorCounts: failures.size > errorCounts.length,
      recentErrors: recent.length > recentErrors.length,
    },
  };
  // Record strings are fixed enums or minute timestamps, so this is normally
  // far below the byte cap. Keep the limit explicit for future additions.
  while (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_BYTES && report.frames.length) {
    report.frames.pop();
    report.truncated.frames = true;
  }
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > MAX_BYTES)
    throw new Error('DIAGNOSTIC_LIMIT');
  return report;
}

module.exports = { getReport, MAX_BYTES, MAX_RECORDS };
