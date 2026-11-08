'use strict';
const v8 = require('node:v8');

const OPERATIONS = Object.freeze(['probe', 'pair', 'info', 'permission', 'send', 'listMedia', 'getMedia', 'deleteMedia', 'setMediaVisible', 'displayMedia']);
const CODES = Object.freeze(['TIMEOUT', 'ABORTED', 'QUEUE_FULL', 'BUSY', 'FRAME_UNAVAILABLE', 'CONNECTION_FAILED', 'CONNECTION_REFUSED',
  'AUTHENTICATION_FAILED', 'PERMISSION_REQUIRED', 'PERMISSION_DENIED', 'PERMISSION_TIMEOUT', 'PERMISSION_NOT_GRANTED',
  'MEDIA_NOT_FOUND', 'MEDIA_TOO_LARGE', 'IMAGE_FORMAT_UNSUPPORTED', 'ENGINE_NOT_READY', 'ENGINE_CONFIG_INVALID',
  'SEND_UNVERIFIED', 'DELETE_UNVERIFIED', 'VISIBILITY_UNVERIFIED', 'DISPLAY_UNVERIFIED', 'PAIRING_CODE_INVALID', 'PAIRING_FAILED', 'UNKNOWN_ERROR']);
const safeBytes = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const rounded = value => Math.round(value * 100) / 100;
const max = (before, value) => value === null ? before : before === null ? value : Math.max(before, value);

function readNodeMemory({ memoryUsage = () => process.memoryUsage(), heapStatistics = () => v8.getHeapStatistics() } = {}) {
  const result = { rss: null, heapTotal: null, heapUsed: null, external: null, arrayBuffers: null };
  const available = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  try {
    const memory = memoryUsage();
    result.rss = safeBytes(memory?.rss); result.heapTotal = available(memory?.heapTotal); result.heapUsed = available(memory?.heapUsed);
    result.external = available(memory?.external); result.arrayBuffers = available(memory?.arrayBuffers);
  } catch { /* Homey's jail can deny uv_resident_set_memory and /proc. */ }
  if (result.heapUsed === null || result.heapTotal === null || result.external === null) {
    try {
      const heap = heapStatistics();
      if (result.heapUsed === null) result.heapUsed = available(heap?.used_heap_size);
      if (result.heapTotal === null) result.heapTotal = available(heap?.total_heap_size);
      if (result.external === null) result.external = available(heap?.external_memory);
    } catch { /* Heap statistics are optional too; null means unavailable. */ }
  }
  return result;
}

function nodeMemorySnapshot(options) {
  const memory = readNodeMemory(options);
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers };
}

class EngineMetrics {
  constructor(memoryOptions = {}) { this.operations = new Map(); this.memoryOptions = memoryOptions; }
  record(operation, durationMs, errorCode = null, sample = {}) {
    if (!OPERATIONS.includes(operation) || !Number.isFinite(durationMs) || durationMs < 0) return;
    let entry = this.operations.get(operation);
    if (!entry) {
      entry = { count: 0, failed: 0, durations: [], failures: new Map(), sampledChildRssBytes: null, sampledChildHwmBytes: null, sampledNodeRssBytes: null };
      this.operations.set(operation, entry);
    }
    entry.count++; entry.durations.push(durationMs); if (entry.durations.length > 32) entry.durations.shift();
    if (errorCode) {
      const code = CODES.includes(errorCode) ? errorCode : 'UNKNOWN_ERROR';
      entry.failed++; entry.failures.set(code, (entry.failures.get(code) || 0) + 1);
    }
    for (const key of ['sampledChildRssBytes', 'sampledChildHwmBytes', 'sampledNodeRssBytes']) entry[key] = max(entry[key], safeBytes(sample?.[key]));
  }
  snapshot() {
    return {
      operations: OPERATIONS.filter(operation => this.operations.has(operation)).map(operation => {
        const entry = this.operations.get(operation), sorted = [...entry.durations].sort((a, b) => a - b);
        const percentile = fraction => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
        return { operation, count: entry.count, failed: entry.failed, lastMs: rounded(entry.durations.at(-1)),
          medianMs: percentile(0.5), p95Ms: percentile(0.95), sampledChildRssBytes: entry.sampledChildRssBytes,
          sampledChildHwmBytes: entry.sampledChildHwmBytes, sampledNodeRssBytes: entry.sampledNodeRssBytes,
          failures: [...entry.failures].map(([code, count]) => ({ code, count })) };
      }),
      node: nodeMemorySnapshot(this.memoryOptions),
      sampleIntervalMs: 200,
    };
  }
}

module.exports = { EngineMetrics, OPERATIONS, CODES, nodeMemorySnapshot, readNodeMemory };
