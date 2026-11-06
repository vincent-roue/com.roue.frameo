(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FrameoDiagnosticReport = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const MAX_BYTES = 128 * 1024;
  const nullable = (check) => (value) => value === null || check(value);
  const integer = nullable((value) => Number.isSafeInteger(value) && value >= 0);
  const bytes = nullable(
    (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4,
  );
  const duration = nullable((value) => Number.isFinite(value) && value >= 0 && value <= 86400000);
  const boolean = nullable((value) => typeof value === 'boolean');
  const choice =
    (...values) =>
    (value) =>
      values.includes(value);
  const version = nullable(
    (value) => typeof value === 'string' && /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value),
  );
  const time = (value) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  const codes = new Set([
    'TIMEOUT',
    'ABORTED',
    'QUEUE_FULL',
    'BUSY',
    'FRAME_UNAVAILABLE',
    'CONNECTION_FAILED',
    'CONNECTION_REFUSED',
    'AUTHENTICATION_FAILED',
    'PERMISSION_REQUIRED',
    'PERMISSION_DENIED',
    'PERMISSION_TIMEOUT',
    'PERMISSION_NOT_GRANTED',
    'MEDIA_NOT_FOUND',
    'MEDIA_TOO_LARGE',
    'IMAGE_FORMAT_UNSUPPORTED',
    'ENGINE_NOT_READY',
    'ENGINE_CONFIG_INVALID',
    'SEND_UNVERIFIED',
    'DELETE_UNVERIFIED',
    'VISIBILITY_UNVERIFIED',
    'PAIRING_CODE_INVALID',
    'PAIRING_FAILED',
    'UNKNOWN_ERROR',
    'URL_INVALID',
    'IMAGE_TOO_LARGE',
    'INVALID_IMAGE',
    'DOWNLOAD_FAILED',
    'FRAME_UNKNOWN',
    'SEND_UNCONFIRMED',
    'TRANSFER_CANCELLED',
    'TRANSFER_RESTART_QUEUED',
    'TRANSFER_RESTART_RUNNING',
    'TRANSFER_JOURNAL_FAILED',
    'TRANSFER_BATCH_EXPIRED',
    'TRANSFER_NOT_FOUND',
    'UPLOAD_INVALID',
    'UPLOAD_NOT_FOUND',
    'UPLOAD_OFFSET_INVALID',
    'UPLOAD_INCOMPLETE',
    'UPLOAD_LIMIT',
    'UPLOAD_FAILED',
  ]);
  const code = (value) => typeof value === 'string' && codes.has(value);
  const object = (shape) => (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const keys = Object.keys(value);
    return (
      keys.length === Object.keys(shape).length &&
      keys.every((key) => Object.hasOwn(shape, key) && shape[key](value[key]))
    );
  };
  const array = (check, maximum) => (value) =>
    Array.isArray(value) && value.length <= maximum && value.every(check);
  const counts = object({
    queued: integer,
    running: integer,
    succeeded: integer,
    failed: integer,
    uncertain: integer,
    partial: integer,
  });
  const operation = object({
    operation: choice(
      'probe',
      'pair',
      'info',
      'permission',
      'send',
      'listMedia',
      'getMedia',
      'deleteMedia',
      'setMediaVisible',
    ),
    count: integer,
    failed: integer,
    lastMs: duration,
    medianMs: duration,
    p95Ms: duration,
    sampledNodeRssBytes: bytes,
    sampledChildRssBytes: bytes,
    sampledChildHwmBytes: bytes,
  });
  const frame = object({
    frame: integer,
    connection: choice('local', 'relay', 'unknown'),
    mode: choice('send', 'manage', 'unknown'),
    available: boolean,
    grants: object({ view: boolean, manage: boolean, backup: boolean, sharePairing: boolean }),
  });
  const schema = object({
    schemaVersion: choice(1),
    generatedAt: time,
    versions: object({
      app: version,
      sdk: nullable(choice(0, 1, 2, 3)),
      homey: version,
      node: version,
      engine: object({
        family: choice(null, 'unframeo', 'unframeo-go', 'homey-frameo', 'frameo-go'),
        protocolVersion: integer,
        os: choice(null, 'linux', 'darwin', 'win32'),
        architecture: choice(null, 'arm64', 'x64', 'arm', 'ia32'),
      }),
    }),
    runtime: object({
      platform: choice(null, 'local', 'cloud'),
      platformVersion: integer,
      os: choice(null, 'linux', 'darwin', 'win32'),
      architecture: choice(null, 'arm64', 'x64', 'arm', 'ia32'),
      ready: boolean,
      stopping: boolean,
      errorCode: nullable(code),
      uptimeSeconds: integer,
    }),
    counts: object({
      frames: integer,
      groups: integer,
      queuedTransfers: integer,
      liveTransfers: integer,
      batches: integer,
      historyJobs: integer,
      historyStatus: counts,
    }),
    memory: object({
      node: object({
        rssBytes: bytes,
        heapTotalBytes: bytes,
        heapUsedBytes: bytes,
        externalBytes: bytes,
        arrayBuffersBytes: bytes,
      }),
      transferSourceBytes: bytes,
    }),
    previewCache: object({ bytes, entries: integer, maxBytes: bytes }),
    uploads: object({ sessions: integer, reservedBytes: bytes, maxBytes: bytes }),
    temporaryRecovery: object({
      scanned: integer,
      removed: integer,
      failed: integer,
      live: integer,
      unknown: integer,
      budgetExhausted: boolean,
      remainingUnknown: boolean,
    }),
    mediaIndex: object({
      available: boolean,
      entries: integer,
      bytes,
      maxBytes: bytes,
      maxEntries: integer,
      ttlMs: integer,
      hits: integer,
      misses: integer,
      loads: integer,
      evictions: integer,
      invalidations: integer,
    }),
    performance: object({
      available: boolean,
      durationWindowMaxSamples: choice(32),
      sampleIntervalMs: integer,
      operations: array(operation, 9),
    }),
    errors: object({
      counts: array(object({ code, count: integer }), 10),
      recent: array(object({ code, at: nullable(time) }), 10),
    }),
    frames: array(frame, 50),
    limits: object({ maxBytes: choice(MAX_BYTES), maxRecords: choice(50) }),
    truncated: object({ frames: boolean, errorCounts: boolean, recentErrors: boolean }),
  });

  // This second allowlist refuses future or accidental raw fields before they
  // can enter a download, the clipboard or the diagnostic preview.
  function serialize(report) {
    if (!schema(report)) throw Error('DIAGNOSTIC_INVALID');
    const records =
      report.frames.length +
      report.performance.operations.length +
      report.errors.counts.length +
      report.errors.recent.length;
    if (records > 50) throw Error('DIAGNOSTIC_INVALID');
    const text = JSON.stringify(report, null, 2);
    // Every permitted string is ASCII: JSON length is its UTF-8 byte length.
    if (text.length > MAX_BYTES) throw Error('DIAGNOSTIC_INVALID');
    return text;
  }

  return { serialize, MAX_BYTES };
});
