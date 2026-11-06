'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { FrameoEngine, SETTINGS_KEY, runEngineProcess } = require('../lib/frameo-engine');
const { DevicePreview, PreviewCache } = require('../lib/device-preview');
const { MediaIndexCache } = require('../lib/media-index-cache');
const { EngineMetrics, nodeMemorySnapshot } = require('../lib/engine-metrics');
const PEER = 'ab'.repeat(32);
const JPEG = Buffer.from([255, 216, 255, 224, 0, 0, 0, 0, 255, 217]);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=', 'base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  let now = 0; const calls = [], files = [], retained = [], requestedMediaIds = [];
  const state = { mayView: true, items: [{ mediaId: '1', type: 'photo', visible: true }, { mediaId: '2', type: 'photo', visible: true }], failPreview: false, missingIds: new Set() };
  const homey = { settings: { get: key => key === SETTINGS_KEY ? { private_key: '17'.repeat(32), frames: { a: { peer_id: PEER } } } : null, set() { assert.fail('No identity changes'); } } };
  const engine = new FrameoEngine({ homey, mediaIndexCache: new MediaIndexCache({ now: () => now }), runner: async ({ request, onMetrics }) => {
    calls.push(request.operation); if (options.runner) await options.runner(request);
    onMetrics?.({ sampledChildRssBytes: 1024, sampledChildHwmBytes: 2048, sampledNodeRssBytes: 4096 });
    if (request.operation === 'info') return { ok: true, result: { peer: PEER, protocolConfirmed: true, mayView: state.mayView } };
    if (request.operation === 'listMedia') return { ok: true, result: { peer: PEER, items: structuredClone(state.items) } };
    if (request.operation === 'getMedia') {
      requestedMediaIds.push(request.mediaId);
      if (state.failPreview || state.missingIds.has(request.mediaId)) return { ok: false, error: { code: 'MEDIA_NOT_FOUND', message: 'private detail' } };
      files.push(request.path); await fs.writeFile(request.path, JPEG);
      return { ok: true, result: { peer: PEER, mediaId: request.mediaId, bytes: JPEG.length, mime: 'image/jpeg', width: 1, height: 1 } };
    }
    if (request.operation === 'send') return { ok: true, result: { peer: PEER, mediaId: '3', bytes: PNG.length, confirmed: true } };
    if (request.operation === 'deleteMedia') return { ok: true, result: { peer: PEER, mediaId: request.mediaId, acknowledged: true, deleted: true } };
    if (request.operation === 'setMediaVisible') return { ok: true, result: { peer: PEER, mediaId: request.mediaId, visible: request.visible, acknowledged: true, verified: true } };
    assert.fail('Unexpected native operation');
  } });
  const app = { engine, activeTransfer: null, transferQueue: [], permissionTask: null };
  const settings = { sender_name: 'Homey' };
  const device = { stopped: false, operation: null, lastInfo: { mayView: true }, homey: { app }, peer: () => PEER,
    accessMode: () => 'manage', getSetting: key => settings[key], async refreshInfo({ signal } = {}) { this.lastInfo = await engine.info(PEER, { name: settings.sender_name, signal }); } };
  const cache = new PreviewCache({ now: () => now }), helper = new DevicePreview(device, { cache, now: () => now, randomInt: () => 0 });
  const original = engine.previewMedia.bind(engine);
  engine.previewMedia = async (...args) => { const result = await original(...args); retained.push(result); return result; };
  t.after(async () => { await helper.close(); engine.close(); });
  return { engine, helper, state, settings, calls, files, retained, requestedMediaIds, advance(ms) { now += ms; } };
}

test('each new widget photo verifies current rights while a short shared index removes repeated native listings and base64 copies', async t => {
  const f = fixture(t); const first = await f.helper.load(), second = await f.helper.refresh(), third = await f.helper.refresh();
  assert.notEqual(first.mediaId, second.mediaId); assert.notEqual(second.mediaId, third.mediaId);
  assert.deepEqual(f.calls, ['info', 'listMedia', 'getMedia', 'info', 'getMedia', 'info', 'getMedia']);
  assert.equal(third.buffer, f.retained[2].buffer); assert.equal(f.retained[2].data, undefined);
  f.advance(29999); await f.helper.refresh(); assert.equal(f.calls.filter(value => value === 'listMedia').length, 1);
  f.advance(1); await f.helper.refresh(); assert.equal(f.calls.filter(value => value === 'listMedia').length, 2);
  for (const filename of f.files) await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  const stats = f.engine.mediaIndexStats(); assert(stats.hits > 0); assert(stats.bytes <= 2 * 1024 * 1024);
});

test('gallery listings stay fresh, sender scope changes reload, and fresh revocation prevents any more previews', async t => {
  const f = fixture(t); await f.engine.listMedia(PEER, { name: 'Homey' });
  await f.engine.visiblePhotoIds(PEER, { name: 'Homey' }); assert.equal(f.calls.length, 1);
  await f.engine.listMedia(PEER, { name: 'Homey' }); assert.equal(f.calls.length, 2);
  await f.engine.visiblePhotoIds(PEER, { name: 'Autre nom' }); assert.equal(f.calls.length, 3);
  await f.helper.load(); f.state.mayView = false;
  const before = f.calls.filter(value => value === 'getMedia').length;
  await assert.rejects(f.helper.refresh(), { code: 'PERMISSION_REQUIRED' });
  assert.equal(f.calls.filter(value => value === 'getMedia').length, before); assert.equal(f.engine.mediaIndexStats().entries, 0);
  assert.equal(f.helper.cache.size, 0);
});

test('a deleted photo in the short cached index triggers one fresh read and selects another surviving photo', async t => {
  const f = fixture(t); f.state.items = [{ mediaId: '1', type: 'photo', visible: true }];
  await f.engine.visiblePhotoIds(PEER, { name: 'Homey' });
  f.state.items = [{ mediaId: '2', type: 'photo', visible: true }]; f.state.missingIds.add('1');
  const content = await f.helper.load();
  assert.equal(content.mediaId, '2'); assert.deepEqual(f.requestedMediaIds, ['1', '2']);
  assert.deepEqual(f.calls, ['listMedia', 'info', 'getMedia', 'info', 'listMedia', 'getMedia']);
  assert.equal(f.helper.cache.get(PEER), content);
});

test('a second vanished preview stops recovery and backs off; a permission error is never retried', async t => {
  const f = fixture(t); f.state.missingIds.add('1'); f.state.missingIds.add('2');
  await assert.rejects(f.helper.load(), { code: 'MEDIA_NOT_FOUND' });
  assert.deepEqual(f.requestedMediaIds, ['1', '2']); assert.equal(f.helper.cache.size, 0);
  const count = f.calls.length; await assert.rejects(f.helper.load(), { code: 'MEDIA_NOT_FOUND' }); assert.equal(f.calls.length, count);
  const denied = fixture(t); const original = denied.engine.previewMedia;
  denied.engine.previewMedia = async () => { throw Object.assign(new Error('private text'), { code: 'PERMISSION_REQUIRED' }); };
  await assert.rejects(denied.helper.load(), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(denied.calls, ['info', 'listMedia']); assert.equal(denied.helper.cache.size, 0);
  denied.engine.previewMedia = original;
});

test('rights revoked during missing-photo recovery stop before a new index or preview', async t => {
  let f;
  f = fixture(t, { runner: request => { if (request.operation === 'getMedia') f.state.mayView = false; } });
  f.state.missingIds.add('1');
  await assert.rejects(f.helper.load(), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(f.calls, ['info', 'listMedia', 'getMedia', 'info']);
  assert.equal(f.helper.cache.size, 0); assert.equal(f.engine.mediaIndexStats().entries, 0);
});

test('invalidating during the recovery list fences its late response and never fetches its new photo', async t => {
  const recovery = deferred(), entered = deferred(); let lists = 0;
  const f = fixture(t, { runner: request => {
    if (request.operation === 'listMedia' && ++lists === 2) { entered.resolve(); return recovery.promise; }
  } });
  f.state.missingIds.add('1'); const loading = f.helper.load(); await entered.promise;
  await f.helper.invalidate(); await assert.rejects(loading, { code: 'ABORTED' }); recovery.resolve();
  await tick(); assert.deepEqual(f.requestedMediaIds, ['1']); assert.equal(f.helper.cache.size, 0);
  assert.equal(f.engine.mediaIndexStats().entries, 0);
});

test('send, delete, visibility, missing media and close invalidate the compact index without retries', async t => {
  const f = fixture(t), seed = () => f.engine.visiblePhotoIds(PEER);
  await seed(); const prepared = await f.engine.prepareBase64(PNG.toString('base64'), 'image/png');
  await f.engine.sendPrepared(PEER, prepared); await f.engine.disposePrepared(prepared); assert.equal(f.engine.mediaIndexStats().entries, 0);
  await seed(); await f.engine.deleteMedia(PEER, '1'); assert.equal(f.engine.mediaIndexStats().entries, 0);
  await seed(); await f.engine.setMediaVisible(PEER, '1', false); assert.equal(f.engine.mediaIndexStats().entries, 0);
  await seed(); f.state.failPreview = true;
  await assert.rejects(f.engine.previewMedia(PEER, '1'), { code: 'MEDIA_NOT_FOUND' }); assert.equal(f.engine.mediaIndexStats().entries, 0);
  await seed(); f.engine.close(); assert.equal(f.engine.mediaIndexStats().entries, 0);
  assert.equal(f.calls.filter(value => value === 'send').length, 1);
});

test('an index response arriving after an invalidation is discarded rather than reused', async t => {
  const waiting = deferred(); const f = fixture(t, { runner: request => request.operation === 'listMedia' ? waiting.promise : undefined });
  const loading = f.engine.visiblePhotoIds(PEER); await tick(); f.engine.invalidateMediaIndex(PEER); waiting.resolve();
  await assert.rejects(loading, { code: 'ABORTED' }); assert.equal(f.engine.mediaIndexStats().entries, 0);
});

test('base64 remains the gallery default and unsupported internal output modes fail before a process starts', async t => {
  const f = fixture(t), value = await f.engine.previewMedia(PEER, '1');
  assert.equal(value.data, JPEG.toString('base64')); assert.equal(value.buffer, undefined);
  await assert.rejects(f.engine.previewMedia(PEER, '1', { output: 'file' }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  assert.equal(f.calls.length, 1);
});

test('performance records have fixed operation/code enums, last32 percentiles and numeric memory only', () => {
  const metrics = new EngineMetrics();
  for (let n = 1; n <= 40; n++) metrics.record('info', n, n === 1 ? 'secret upstream content' : null,
    { sampledChildRssBytes: n * 1024, sampledChildHwmBytes: n * 2048, private_key: 'secret' });
  metrics.record('secret peer or URL', 1); metrics.record('info', -1);
  const snapshot = metrics.snapshot(), info = snapshot.operations[0];
  assert.equal(info.count, 40); assert.equal(info.failed, 1); assert.equal(info.medianMs, 24); assert.equal(info.p95Ms, 39);
  assert.equal(info.lastMs, 40); assert.equal(info.sampledChildRssBytes, 40960);
  assert.deepEqual(info.failures, [{ code: 'UNKNOWN_ERROR', count: 1 }]); assert.equal(snapshot.operations.length, 1);
  assert(Object.values(snapshot.node).every(Number.isSafeInteger)); assert(!JSON.stringify(snapshot).includes('secret'));
});

test('a process metrics callback cannot change a confirmed native response and is called once on completion', async () => {
  let count = 0, sample;
  const result = await runEngineProcess({ binaryPath: process.execPath,
    args: ['-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result:{confirmed:true}})),250)'],
    request: { operation: 'probe' }, timeoutMs: 2000, onMetrics(value) { count++; sample = value; throw Error('irrelevant'); } });
  assert.equal(result.result.confirmed, true); assert.equal(count, 1); assert(Number.isSafeInteger(sample.sampledNodeRssBytes));
  if (process.platform !== 'linux') assert.equal(sample.sampledChildRssBytes, null);
});

test('late runner samples and unknown error text never enter diagnostic snapshots', async t => {
  let callback;
  const engine = new FrameoEngine({ homey: { settings: { get() {}, set() {} } }, runner: async ({ onMetrics }) => {
    callback = onMetrics; return { ok: false, error: { code: 'SECRET_PRIVATE_VALUE', message: 'private URL' } };
  } });
  t.after(() => engine.close()); await assert.rejects(engine.probe());
  const before = engine.performanceStats().operations;
  callback({ sampledChildRssBytes: 9999999 });
  assert.deepEqual(engine.performanceStats().operations, before); assert(!JSON.stringify(before).includes('SECRET'));
  assert.equal(before[0].sampledChildRssBytes, null);
});

test('engine close interrupts immediately and awaits active source cleanup before resolving once', async () => {
  const entered = deferred(); let filename;
  const engine = new FrameoEngine({ homey: { settings: {
    get: () => ({ private_key: '17'.repeat(32), frames: { a: { peer_id: PEER } } }), set() {} } },
    runner: async ({ request }) => { filename = request.path; entered.resolve(); return new Promise(() => {}); } });
  const handle = await engine.prepareBase64(PNG.toString('base64'), 'image/png');
  const sending = engine.sendPrepared(PEER, handle); await entered.promise;
  const closing = engine.close(); assert.equal(engine.close(), closing);
  await assert.rejects(engine.info(PEER), { code: 'ABORTED' });
  await assert.rejects(sending, { code: 'SEND_UNVERIFIED' }); await closing;
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('denied RSS degrades to nullable memory with independently guarded V8 heap fallback', () => {
  const denied = () => { throw Object.assign(new Error('uv_resident_set_memory'), { code: 'ENOENT' }); };
  assert.deepEqual(nodeMemorySnapshot({ memoryUsage: denied, heapStatistics: () => ({ used_heap_size: 1234, external_memory: 5678 }) }),
    { rssBytes: null, heapUsedBytes: 1234, externalBytes: 5678, arrayBuffersBytes: null });
  const metrics = new EngineMetrics({ memoryUsage: denied, heapStatistics: denied });
  metrics.record('info', 12);
  assert.deepEqual(metrics.snapshot().node, { rssBytes: null, heapUsedBytes: null, externalBytes: null, arrayBuffersBytes: null });
  assert.equal(metrics.snapshot().operations[0].count, 1);
});

test('RSS sampling failures never reject a native result or leave an unhandled timer rejection', async () => {
  let attempts = 0, sample;
  const result = await runEngineProcess({ binaryPath: process.execPath,
    args: ['-e', 'setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result:{confirmed:true}})),300)'],
    request: { operation: 'probe' }, timeoutMs: 2000,
    memoryUsage() { attempts++; throw Error('uv_resident_set_memory'); }, onMetrics(value) { sample = value; } });
  assert.equal(result.result.confirmed, true); assert(attempts >= 2); assert.equal(sample.sampledNodeRssBytes, null);
});
