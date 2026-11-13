'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { getReport, MAX_BYTES, MAX_RECORDS } = require('../lib/frameo-diagnostics');
const { OPERATIONS, CODES } = require('../lib/engine-metrics');
const { serialize } = require('../settings/diagnostic-report');

const now = () => Date.parse('2026-11-04T10:12:59.777Z');
const memoryUsage = () => ({
  rss: 40000000,
  heapTotal: 20000000,
  heapUsed: 10000000,
  external: 3000000,
  arrayBuffers: 2000000,
});
const privateValue = 'PRIVATE-TEST-MARKER';
const forbiddenReads = [];
function forbid(object, names) {
  for (const name of names)
    Object.defineProperty(object, name, {
      get() {
        forbiddenReads.push(name);
        assert.fail('Prohibited diagnostic read: ' + name);
      },
    });
  return object;
}
function fixture() {
  forbiddenReads.length = 0;
  const info = forbid(
    { route: 'local', mayView: true, mayManage: false, mayBackup: null, maySharePairing: false },
    ['name', 'placement', 'private_key', 'peer', 'image', 'toJSON'],
  );
  const device = forbid({ lastInfo: info, accessMode: () => 'manage', getAvailable: () => true }, [
    'getData',
    'getName',
    'peer',
    'refreshInfo',
    'publicStatus',
    'getStoreValue',
    'senderName',
    'toJSON',
  ]);
  const result = forbid(
    { status: 'uncertain', code: 'SEND_UNVERIFIED', completedAt: '2026-11-04T10:11:45.555Z' },
    ['frameId', 'name', 'mediaId', 'reason', 'toJSON'],
  );
  const job = forbid(
    { status: 'uncertain', createdAt: '2026-11-04T10:10:19.000Z', results: [result] },
    ['id', 'targetName', 'caption', 'url', 'data', 'source', 'toJSON'],
  );
  const engine = forbid(
    {
      performanceStats: () => ({
        operations: [
          {
            operation: 'send',
            count: 2,
            failed: 1,
            lastMs: 124.48,
            medianMs: 100.4,
            p95Ms: 124.48,
            sampledNodeRssBytes: 40000000,
            sampledChildRssBytes: 12000000,
            sampledChildHwmBytes: 15000000,
            failures: [{ code: 'SEND_UNVERIFIED', count: 1 }],
            request: privateValue,
          },
        ],
        sampleIntervalMs: 200,
        secret: privateValue,
      }),
      mediaIndexStats: () => ({
        entries: 1,
        bytes: 222,
        maxBytes: 2097152,
        maxEntries: 8,
        ttlMs: 30000,
        hits: 3,
        misses: 1,
        loads: 1,
        evictions: 0,
        invalidations: 0,
        media: privateValue,
      }),
    },
    [
      'config',
      'privateKey',
      'frames',
      'info',
      'listMedia',
      'getMedia',
      'sendImage',
      'sendUrl',
      'probe',
      'toJSON',
    ],
  );
  const app = forbid(
    {
      homey: forbid(
        {
          manifest: { version: '0.9.2', sdk: 3 },
          version: '12.6.1',
          platform: 'local',
          platformVersion: 2,
        },
        ['settings', 'cloud', 'images', 'api', 'toJSON'],
      ),
      runtimeStatus: {
        ready: true,
        platform: 'linux',
        architecture: 'arm64',
        error: null,
        engine: {
          engine: 'homey-frameo',
          protocolVersion: 1,
          goos: 'linux',
          goarch: 'arm64',
          revision: privateValue,
        },
      },
      engine,
      uploads: {
        stats: () => ({ sessions: 1, bytes: 1048576, maxBytes: 16777216, files: privateValue }),
        recovery: forbid(
          {
            scanned: 4,
            removed: 1,
            failed: 0,
            live: 2,
            unknown: 1,
            budgetExhausted: false,
            remainingUnknown: false,
          },
          ['path', 'ownerMarker', 'processToken', 'toJSON'],
        ),
      },
      transfers: {
        journal: { jobs: [job] },
        queue: [privateValue],
        runtime: new Map([[privateValue, privateValue]]),
        batches: new Map([[privateValue, privateValue]]),
        sourceMemory: 1048576,
      },
      groups: { groups: [forbid({}, ['id', 'name', 'frameIds', 'toJSON'])] },
      previewCache: { bytes: 12345, size: 1, items: privateValue },
      getDevices: () => [device],
      startedAt: '2026-11-04T10:00:27.123Z',
      stopping: false,
    },
    ['getPublicStatus', 'log', 'error', 'toJSON'],
  );
  return { app, device, info, job };
}

test('AMD64 diagnostics keep the Go architecture readable through browser export', () => {
  const { app } = fixture();
  app.runtimeStatus.architecture = 'x64';
  app.runtimeStatus.engine.goarch = 'amd64';
  const report = getReport(app, { now, memoryUsage });
  assert.equal(report.runtime.architecture, 'x64');
  assert.equal(report.versions.engine.architecture, 'amd64');
  assert.equal(JSON.parse(serialize(report)).versions.engine.architecture, 'amd64');
});

test('diagnostics constructs a strict snapshot without reading identifiers, media, credentials or network methods', () => {
  const { app } = fixture();
  const report = getReport(app, { now, memoryUsage });
  const text = JSON.stringify(report);
  assert(!text.includes(privateValue));
  assert.equal(report.generatedAt, '2026-11-04T10:12:00.000Z');
  assert.deepEqual(report.versions.engine, {
    family: 'homey-frameo',
    protocolVersion: 1,
    os: 'linux',
    architecture: 'arm64',
  });
  assert.equal(report.runtime.uptimeSeconds, 720);
  assert.equal(report.memory.node.rssBytes, 40000000);
  assert.equal(report.memory.transferSourceBytes, 1048576);
  assert.deepEqual(report.frames, [
    {
      frame: 1,
      connection: 'local',
      mode: 'manage',
      available: true,
      grants: { view: true, manage: false, backup: null, sharePairing: false },
    },
  ]);
  assert.deepEqual(report.errors.recent, [
    { code: 'SEND_UNVERIFIED', at: '2026-11-04T10:11:00.000Z' },
  ]);
  assert.equal(report.performance.operations[0].lastMs, 124.5);
  assert.equal(report.mediaIndex.bytes, 222);
  assert.equal(report.counts.groups, 1);
  assert.equal(report.counts.liveTransfers, 1);
  assert.equal(report.counts.historyStatus.uncertain, 1);
  assert.deepEqual(forbiddenReads, []);
  assert.deepEqual(report.temporaryRecovery, {
    scanned: 4,
    removed: 1,
    failed: 0,
    live: 2,
    unknown: 1,
    budgetExhausted: false,
    remainingUnknown: false,
  });
});

test('invalid or opaque values never become diagnostic strings or numbers', () => {
  const { app, device, info } = fixture();
  app.homey.manifest.version = 'Alice-private';
  app.homey.version = '192.168.1.42';
  app.runtimeStatus.engine.engine = privateValue;
  app.runtimeStatus.engine.protocolVersion = privateValue;
  app.runtimeStatus.engine.goarch = privateValue;
  app.runtimeStatus.error = 'TIMEOUT ' + privateValue;
  app.runtimeStatus.architecture = privateValue;
  info.route = 'https://private.invalid/path';
  info.mayView = 'true';
  device.accessMode = () => privateValue;
  app.engine.performanceStats = () => ({
    operations: [
      {
        operation: 'getMedia',
        count: -1,
        failed: Infinity,
        lastMs: NaN,
        medianMs: -3,
        p95Ms: 999999999,
        sampledNodeRssBytes: -2,
        sampledChildRssBytes: privateValue,
        failures: [{ code: privateValue, count: 3 }],
      },
      { operation: privateValue, count: 10 },
    ],
    sampleIntervalMs: -1,
  });
  const report = getReport(app, {
    now,
    memoryUsage: () => ({ rss: Infinity, heapTotal: '4', heapUsed: -1 }),
  });
  assert(!JSON.stringify(report).includes(privateValue));
  assert.equal(report.versions.app, null);
  assert.equal(report.versions.homey, null);
  assert.equal(report.runtime.errorCode, 'UNKNOWN_ERROR');
  assert.equal(report.runtime.architecture, null);
  assert.equal(report.frames[0].mode, 'unknown');
  assert.equal(report.frames[0].connection, 'unknown');
  assert.equal(report.frames[0].grants.view, null);
  assert.equal(report.memory.node.rssBytes, null);
  assert.equal(report.performance.operations.length, 1);
  assert.equal(report.performance.operations[0].lastMs, null);
  assert.deepEqual(report.errors.counts, [{ code: 'UNKNOWN_ERROR', count: 3 }]);
});

test('report remains bounded with many cached frames and journal errors, without mutating source state', () => {
  const { app } = fixture();
  const devices = Array.from({ length: 200 }, (_, index) => ({
    lastInfo: { route: index % 2 ? 'local' : 'relay', mayView: true, mayManage: false },
    accessMode: () => 'manage',
    getAvailable: () => true,
  }));
  app.getDevices = () => devices;
  app.engine.performanceStats = () => ({
    operations: OPERATIONS.map((operation) => ({
      operation,
      count: 32,
      failed: 24,
      failures: CODES.map((code) => ({ code, count: 1 })),
    })),
    sampleIntervalMs: 200,
  });
  app.transfers.journal.jobs = Array.from({ length: 50 }, (_, index) => ({
    status: 'failed',
    createdAt: new Date(now() - index * 60000).toISOString(),
    results: CODES.map((code) => ({ status: 'failed', code })),
  }));
  const originalJobs = structuredClone(app.transfers.journal.jobs);
  const report = getReport(app, { now, memoryUsage, randomInt: () => 0 });
  const records =
    report.frames.length +
    report.performance.operations.length +
    report.errors.counts.length +
    report.errors.recent.length;
  assert(records <= MAX_RECORDS);
  assert(Buffer.byteLength(JSON.stringify(report, null, 2)) <= MAX_BYTES);
  assert.equal(report.counts.frames, 200);
  assert.equal(report.counts.historyJobs, 50);
  assert.deepEqual(report.truncated, { frames: true, errorCounts: true, recentErrors: true });
  assert.deepEqual(app.transfers.journal.jobs, originalJobs);
  assert.equal(devices.length, 200);
  assert.equal(devices[0].lastInfo.route, 'relay');
});

test('temporary frame numbers do not persist an ID mapping between reports', () => {
  const { app } = fixture();
  const devices = [
    { lastInfo: { route: 'local' }, accessMode: () => 'send', getAvailable: () => true },
    { lastInfo: { route: 'relay' }, accessMode: () => 'manage', getAvailable: () => false },
  ];
  app.getDevices = () => devices;
  const a = getReport(app, { now, memoryUsage, randomInt: () => 0 });
  const b = getReport(app, { now, memoryUsage, randomInt: (limit) => limit - 1 });
  assert.equal(a.frames[0].connection, 'relay');
  assert.equal(b.frames[0].connection, 'local');
  assert.deepEqual(Object.keys(devices[0]).sort(), ['accessMode', 'getAvailable', 'lastInfo']);
});

test('missing or unavailable cached services produce unknown values and never expose exception messages', () => {
  const { app } = fixture();
  const fail = () => {
    throw Error(privateValue);
  };
  app.getDevices = fail;
  app.uploads.stats = fail;
  app.engine.performanceStats = fail;
  app.engine.mediaIndexStats = fail;
  app.startedAt = privateValue;
  const report = getReport(app, { now: () => Infinity, memoryUsage: fail });
  assert(!JSON.stringify(report).includes(privateValue));
  assert.equal(report.runtime.uptimeSeconds, null);
  assert.equal(report.memory.node.rssBytes, null);
  assert.equal(report.uploads.sessions, null);
  assert.equal(report.performance.available, false);
  assert.equal(report.mediaIndex.available, false);
  assert.deepEqual(report.frames, []);
  assert.equal(report.generatedAt, '1970-01-01T00:00:00.000Z');
});

test('diagnostics retains safe heap measurements when the Homey jail denies RSS access', () => {
  const { app } = fixture();
  const originalMemoryUsage = process.memoryUsage;
  const originalHeapStatistics = v8.getHeapStatistics;
  try {
    process.memoryUsage = () => {
      throw Object.assign(Error(privateValue), { code: 'ENOENT' });
    };
    v8.getHeapStatistics = () => ({
      total_heap_size: 18000000,
      used_heap_size: 9000000,
      external_memory: 4000000,
      privateValue,
    });
    const report = getReport(app, { now });
    assert.deepEqual(report.memory.node, {
      rssBytes: null,
      heapTotalBytes: 18000000,
      heapUsedBytes: 9000000,
      externalBytes: 4000000,
      arrayBuffersBytes: null,
    });
    assert(!serialize(report).includes(privateValue));
  } finally {
    process.memoryUsage = originalMemoryUsage;
    v8.getHeapStatistics = originalHeapStatistics;
  }
});
