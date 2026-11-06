'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevicePreview, PreviewCache } = require('../lib/device-preview');
const { FrameoWidget } = require('../lib/frameo-widget');
const api = require('../widgets/frameo/api');

const PEER = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const PRIVATE = '12'.repeat(32);
// Synthetic bytes at the mocked native boundary; codec validity is checked by
// Go tests. The widget serves these exact JPEG bytes and does no new decoding.
const JPEG = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
const rawPreview = overrides => ({ mime: 'image/jpeg', data: JPEG.toString('base64'), bytes: JPEG.length,
  width: 1, height: 1, private_key: PRIVATE, url: 'http://private.invalid', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture(t, options = {}) {
  const clock = { at: 0 }; const now = () => clock.at;
  const cache = new PreviewCache({ now }), calls = [], writes = [], images = [];
  const state = { mode: options.mode || 'manage', mayView: options.mayView !== false };
  const device = {
    stopped: false, operation: null, lastInfo: { mayView: state.mayView },
    getData: () => ({ id: PEER }), peer: () => PEER,
    getName: () => options.name || 'Pexar du salon', accessMode: () => state.mode,
    getSetting: () => 'Homey', getStoreValue: () => false,
    async setStoreValue(key, value) { writes.push([key, value]); },
    async setCameraImage(id, title, image) { assert(image); },
    async refreshInfo() {
      calls.push(['info']); device.operation = { kind: 'refresh' };
      try {
        if (options.info) await options.info(device);
        device.lastInfo = { mayView: state.mayView }; return device.lastInfo;
      } finally { device.operation = null; }
    },
  };
  const app = {
    stopping: false, activeTransfer: false, transferQueue: [], permissionTask: null,
    previewCache: cache,
    async waitUntilReady() { if (options.ready) await options.ready(); },
    getDevices: () => options.devices ? options.devices(device) : [device],
    getDevice() { assert.fail('Widget lookup must use only the current own-device list'); },
    engine: {
      async listMedia(peer, details) {
        calls.push(['list', peer, details]);
        return options.items || [{ mediaId: '1', type: 'photo', visible: true }, { mediaId: '2', type: 'photo', visible: true }];
      },
      async previewMedia(peer, id, details) {
        calls.push(['preview', peer, id, details]);
        assert.equal(details.encoding, 'jpeg');
        return options.preview ? options.preview(id) : rawPreview();
      },
      async pair() { assert.fail('A widget must never pair'); },
      async permission() { assert.fail('A widget must never request permission'); },
      async sendImage() { assert.fail('A widget must never send a photo'); },
      async deleteMedia() { assert.fail('A widget must never delete a photo'); },
    },
  };
  const homey = {
    app, __: key => key,
    images: { async createImage() {
      const image = { updates: 0, unregisters: 0, setStream(callback) { this.source = callback; },
        setPath(filename) { this.source = filename; }, async update() { this.updates++; }, async unregister() { this.unregisters++; } };
      images.push(image); return image;
    } },
  };
  app.homey = homey; device.homey = homey;
  device.preview = new DevicePreview(device, { cache, now, randomInt: () => 0 });
  const widget = new FrameoWidget(app); app.widget = widget;
  t.after(async () => { await device.preview?.close(); cache.clear(); });
  return { widget, device, app, homey, cache, clock, state, calls, writes, images };
}

test('first authenticated widget view loads exactly one JPEG and later widget views share the same cache', async t => {
  const f = fixture(t);
  const first = await f.widget.state({ deviceId: PEER });
  assert.deepEqual(Object.keys(first).sort(), ['bytes', 'data', 'height', 'mediaId', 'mime', 'name', 'width']);
  assert.deepEqual(first, { name: 'Pexar du salon', mediaId: '1', mime: 'image/jpeg', data: JPEG.toString('base64'), width: 1, height: 1, bytes: JPEG.length });
  assert.equal(f.images.length, 0, 'Widget requests must not create a native device image');
  assert.deepEqual(f.calls.map(call => call[0]), ['info', 'list', 'preview']);
  assert.deepEqual(await f.widget.state({ deviceId: PEER.toUpperCase() }), first);
  assert.equal(f.calls.length, 3); assert.equal(f.cache.size, 1); assert.equal(f.cache.bytes, JPEG.length);
  assert.equal(f.device.preview.cache, f.app.previewCache, 'There must be no second widget image cache');
  assert.equal(f.widget.pending.size, 0);
  const encoded = JSON.stringify(first);
  for (const value of [PEER, PRIVATE, 'private.invalid', 'filename', 'cloudUrl', 'localUrl']) assert(!encoded.includes(value));
  assert.deepEqual(f.writes, [], 'No image slot, photo, base64 or configuration is persisted');
});

test('concurrent cache misses and next taps coalesce before the info lock and fetch just one image', async t => {
  const pixels = deferred(); const f = fixture(t, { preview: () => pixels.promise });
  const a = f.widget.state({ deviceId: PEER }); await tick();
  const b = f.widget.state({ deviceId: PEER }); const c = f.widget.next({ deviceId: PEER });
  pixels.resolve(rawPreview());
  const results = await Promise.all([a, b, c]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
  assert.deepEqual(f.calls.map(call => call[0]), ['info', 'list', 'preview']);
  assert.equal(f.widget.pending.size, 0);
});

test('widget joins an existing authenticated preview load even while its own information check holds the device lock', async t => {
  const info = deferred(); const f = fixture(t, { info: () => info.promise });
  const native = f.device.preview.refresh(); await tick();
  assert.equal(f.device.operation.kind, 'refresh');
  const widget = f.widget.state({ deviceId: PEER });
  info.resolve(); await native; const result = await widget;
  assert.equal(result.mime, 'image/jpeg'); assert.deepEqual(f.calls.map(call => call[0]), ['info', 'list', 'preview']);
});

test('GET then immediate completed POSTs each change the photo without a five-second silent cache hit', async t => {
  const f = fixture(t, { preview: id => {
    const bytes = Buffer.concat([JPEG, Buffer.from(id)]);
    return rawPreview({ data: bytes.toString('base64'), bytes: bytes.length });
  } });
  const first = await api.getPhoto({ homey: f.homey, query: { deviceId: PEER } });
  const second = await api.nextPhoto({ homey: f.homey, body: { deviceId: PEER } });
  const third = await api.nextPhoto({ homey: f.homey, body: { deviceId: PEER } });
  assert.notEqual(second.data, first.data); assert.notEqual(third.data, second.data);
  assert.deepEqual(f.calls.filter(call => call[0] === 'preview').map(call => call[2]), ['1', '2', '1']);
  assert.equal(f.clock.at, 0); assert.equal(f.calls.length, 9);
  assert.equal(f.cache.size, 1); assert.equal(f.cache.bytes, JPEG.length + 1);
});

test('simultaneous next requests after a completed load still fetch just one additional preview', async t => {
  const pixels = deferred(); let count = 0;
  const f = fixture(t, { preview: () => ++count === 2 ? pixels.promise : rawPreview() });
  await f.widget.state({ deviceId: PEER });
  const a = f.widget.next({ deviceId: PEER }); await tick();
  const b = f.widget.next({ deviceId: PEER }); const c = f.widget.state({ deviceId: PEER });
  pixels.resolve(rawPreview());
  const [first, second, third] = await Promise.all([a, b, c]);
  assert.deepEqual(first, second); assert.deepEqual(second, third);
  assert.deepEqual(f.calls.filter(call => call[0] === 'preview').map(call => call[2]), ['1', '2']);
  assert.equal(f.calls.length, 6); assert.equal(f.widget.pending.size, 0);
});

test('GET cache misses respect failure backoff and a manual next can retry immediately', async t => {
  let fail = true;
  const f = fixture(t, { preview: () => {
    if (fail) throw Object.assign(new Error('private frame detail'), { code: 'TIMEOUT' });
    return rawPreview();
  } });
  const query = { deviceId: PEER };
  assert.deepEqual(await api.getPhoto({ homey: f.homey, query }), { error: { code: 'TIMEOUT' } });
  f.clock.at = 29999;
  assert.deepEqual(await api.getPhoto({ homey: f.homey, query }), { error: { code: 'TIMEOUT' } });
  assert.equal(f.calls.length, 3, 'A GET after failure must not force another frame request');
  fail = false;
  const changed = await api.nextPhoto({ homey: f.homey, body: query });
  assert.equal(changed.mime, 'image/jpeg'); assert.equal(f.calls.length, 6);
  assert.deepEqual(await api.getPhoto({ homey: f.homey, query }), changed); assert.equal(f.calls.length, 6);
  assert.equal(f.widget.pending.size, 0);
});

test('large metadata lists still cause only one selected preview, never an album or video download', async t => {
  const items = Array.from({ length: 10000 }, (_, index) => ({ mediaId: String(index + 1), type: index ? 'photo' : 'video', visible: true }));
  const f = fixture(t, { items }); await f.widget.state({ deviceId: PEER });
  assert.equal(f.calls.filter(call => call[0] === 'list').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'preview').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'preview')[2], '2');
});

test('selection is validated against current own frames and never resolved through a URL or arbitrary device', async t => {
  const f = fixture(t);
  for (const deviceId of [undefined, null, '', {}, [PEER], 'https://example.test/photo', '1234', OTHER, PRIVATE, '1'.repeat(10000)]) {
    await assert.rejects(f.widget.state({ deviceId }), { code: 'WIDGET_DEVICE_INVALID', message: 'WIDGET_DEVICE_INVALID' });
  }
  assert.deepEqual(f.calls, []); assert.equal(f.cache.size, 0);
});

test('mode, grant and initialization are required even if image bytes were previously cached', async t => {
  for (const invalid of ['send', 'permission', 'uninitialized', 'no-preview']) {
    const f = fixture(t); await f.widget.state({ deviceId: PEER }); f.calls.length = 0;
    if (invalid === 'send') f.state.mode = 'send';
    if (invalid === 'permission') f.device.lastInfo.mayView = 'true';
    if (invalid === 'uninitialized') f.device.stopped = undefined;
    if (invalid === 'no-preview') { await f.device.preview.close(); f.device.preview = null; }
    const code = invalid === 'send' ? 'ACCESS_MODE_SEND' : invalid === 'permission' ? 'PERMISSION_REQUIRED' : 'ENGINE_NOT_READY';
    await assert.rejects(f.widget.state({ deviceId: PEER }), { code });
    await assert.rejects(f.widget.next({ deviceId: PEER }), { code }); assert.deepEqual(f.calls, []);
  }
});

test('busy work prevents a new load while already prepared cached bytes remain available', async t => {
  for (const busy of ['activeTransfer', 'transferQueue', 'permissionTask', 'operation']) {
    const f = fixture(t);
    if (busy === 'operation') f.device.operation = { kind: 'send' };
    else f.app[busy] = busy === 'transferQueue' ? [{}] : {};
    await assert.rejects(f.widget.state({ deviceId: PEER }), { code: 'BUSY' });
    await assert.rejects(f.widget.next({ deviceId: PEER }), { code: 'BUSY' }); assert.deepEqual(f.calls, []);
  }
  const cached = fixture(t); const first = await cached.widget.state({ deviceId: PEER });
  cached.app.activeTransfer = true;
  assert.deepEqual(await cached.widget.state({ deviceId: PEER }), first);
  await assert.rejects(cached.widget.next({ deviceId: PEER }), { code: 'BUSY' }); assert.equal(cached.calls.length, 3);
});

test('app shutdown, device removal and rights changes during loading never return late photo bytes', async t => {
  for (const change of ['shutdown', 'stopped', 'removed', 'permission', 'mode']) {
    const pixels = deferred(); let removed = false;
    const f = fixture(t, { preview: () => pixels.promise, devices: device => removed ? [] : [device] });
    const loading = f.widget.state({ deviceId: PEER }); await tick();
    if (change === 'shutdown') f.app.stopping = true;
    if (change === 'stopped') f.device.stopped = true;
    if (change === 'removed') removed = true;
    if (change === 'permission') f.device.lastInfo.mayView = false;
    if (change === 'mode') f.state.mode = 'send';
    pixels.resolve(rawPreview());
    const code = ['shutdown', 'stopped'].includes(change) ? 'ABORTED' : change === 'removed' ? 'WIDGET_DEVICE_INVALID' : change === 'permission' ? 'PERMISSION_REQUIRED' : 'ACCESS_MODE_SEND';
    await assert.rejects(loading, { code }); assert.equal(f.widget.pending.size, 0);
  }
});

test('errors remain fixed codes; neither failed previews nor raw upstream diagnostics leak to the widget', async t => {
  for (const code of ['MEDIA_NOT_FOUND', 'TIMEOUT', 'QUEUE_FULL', 'UNKNOWN_UPSTREAM_CODE']) {
    const f = fixture(t, { preview: () => { throw Object.assign(new Error('secret ' + PRIVATE + ' http://private.invalid'), { code }); } });
    const expected = code === 'UNKNOWN_UPSTREAM_CODE' ? 'ENGINE_NOT_READY' : code;
    await assert.rejects(f.widget.state({ deviceId: PEER }), error => {
      assert.equal(error.code, expected); assert.equal(error.message, expected);
      assert(!String(error).includes(PRIVATE)); return true;
    });
    assert.equal(f.cache.size, 0); assert.equal(f.widget.pending.size, 0);
  }
});

test('cached output is revalidated and its allowlist excludes native URLs and arbitrary metadata', async t => {
  for (const invalid of [
    { buffer: JPEG, mime: 'image/png', width: 1, height: 1 },
    { buffer: Buffer.from('not a JPEG'), mime: 'image/jpeg', width: 1, height: 1 },
    { buffer: JPEG, mime: 'image/jpeg', width: 2049, height: 1 },
    { buffer: JPEG, mime: 'image/jpeg', width: 2001, height: 2001 },
    { buffer: JPEG, mime: 'image/jpeg', width: '1', height: 1 },
    { buffer: Buffer.alloc(4 * 1024 * 1024 + 1), mime: 'image/jpeg', width: 1, height: 1 },
  ]) {
    const f = fixture(t); f.app.previewCache = { get: () => invalid };
    await assert.rejects(f.widget.state({ deviceId: PEER }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(t); f.cache.set(PEER, { buffer: JPEG, mime: 'image/jpeg', width: 1, height: 1,
    private_key: PRIVATE, localUrl: 'http://private.invalid', mediaId: '123', peer: PEER });
  const result = await f.widget.state({ deviceId: PEER });
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'data', 'height', 'mediaId', 'mime', 'name', 'width']); assert.deepEqual(f.calls, []);
});

test('widget-scoped API forwards only its selected ID to state or next, without adding global endpoints', async t => {
  const f = fixture(t); const input = { deviceId: PEER, private_key: PRIVATE, url: 'http://private.invalid', encoding: 'full' };
  const first = await api.getPhoto({ homey: f.homey, query: input });
  assert.equal(first.name, 'Pexar du salon');
  f.clock.at = 5000; const second = await api.nextPhoto({ homey: f.homey, body: input });
  assert.equal(second.mime, 'image/jpeg'); assert.equal(f.calls.filter(call => call[0] === 'preview').length, 2);
  assert.deepEqual(Object.keys(api).sort(), ['getPhoto', 'nextPhoto']);
  assert.deepEqual(await api.getPhoto({ homey: f.homey, body: input }), { error: { code: 'WIDGET_DEVICE_INVALID' } });
});

test('API error envelopes contain only a fixed code even when custom Error fields are lost by Homey', async t => {
  const f = fixture(t, { mode: 'send' });
  assert.deepEqual(await api.getPhoto({ homey: f.homey, query: { deviceId: PEER } }), { error: { code: 'ACCESS_MODE_SEND' } });
  const broken = { app: { widget: { async next() { throw Object.assign(new Error(PRIVATE + ' http://private.invalid'), { code: 'PRIVATE_PROTOCOL_DETAIL' }); } } } };
  const result = await api.nextPhoto({ homey: broken, body: { deviceId: PEER } });
  assert.deepEqual(result, { error: { code: 'FRAME_UNAVAILABLE' } });
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert.deepEqual(await api.getPhoto({ homey: { app: {} }, query: { deviceId: PEER } }), { error: { code: 'ENGINE_NOT_READY' } });
});
