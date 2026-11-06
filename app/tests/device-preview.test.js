'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DevicePreview, PreviewCache } = require('../lib/device-preview');

const PEER = 'ab'.repeat(32);
// Synthetic, complete 1 x 1 images. The native image stream must contain the
// actual JPEG/PNG bytes returned by the engine, without relying on metadata.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const preview = (overrides = {}) => ({ mime: 'image/jpeg', data: JPEG.toString('base64'), bytes: JPEG.length, width: 1, height: 1, ...overrides });
const photos = [{ mediaId: '9223372036854775807', type: 'photo', visible: true }, { mediaId: '-9223372036854775808', type: 'photo', visible: true }];
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture(options = {}) {
  const clock = options.clock || { at: 0 };
  const now = () => clock.at;
  const cache = options.cache || new PreviewCache({ now });
  const store = new Map(options.slot ? [['frameo_preview_slot', true]] : []);
  const calls = [], images = [], attachments = [], writes = [];
  const settings = { photo_access_mode: options.mode || 'manage', sender_name: 'Homey du séjour' };
  const device = {
    stopped: false, operation: null, lastInfo: { mayView: options.mayView !== false },
    peer: () => PEER, accessMode: () => settings.photo_access_mode,
    getSetting: key => settings[key], getStoreValue: key => store.get(key),
    async setStoreValue(key, value) { writes.push([key, value]); store.set(key, value); },
    async refreshInfo({ signal } = {}) {
      calls.push(['info', signal]);
      if (options.info) return options.info(device, signal);
      return device.lastInfo;
    },
    async setCameraImage(id, title, image) {
      assert(image, 'A camera association must never be removed with undocumented null');
      attachments.push({ id, title, image });
      if (options.attach) return options.attach(image);
    },
  };
  device.homey = {
    __: key => key,
    images: {
      async createImage() {
        const image = {
          updates: 0, unregisters: 0, source: null, mode: null,
          setStream(callback) { this.source = callback; this.mode = 'stream'; },
          setPath(filename) { this.source = filename; this.mode = 'path'; },
          async update() { this.updates++; },
          async unregister() { this.unregisters++; },
        };
        images.push(image);
        if (options.create) await options.create(image);
        return image;
      },
    },
    app: {
      activeTransfer: null, transferQueue: [], permissionTask: null,
      engine: {
        async listMedia(peer, details) { calls.push(['list', peer, details]); return options.list ? options.list(details) : photos; },
        async previewMedia(peer, id, details) { calls.push(['preview', peer, id, details]); return options.preview ? options.preview(id, details) : preview(); },
        async pair() { assert.fail('An image must never pair a frame'); },
        async permission() { assert.fail('An image must never request access automatically'); },
        async sendImage() { assert.fail('An image must never send a photo'); },
        async deleteMedia() { assert.fail('An image must never delete a photo'); },
      },
    },
  };
  const helper = new DevicePreview(device, { cache, now, randomInt: options.randomInt || (() => 0) });
  return { helper, device, cache, clock, calls, images, attachments, writes, settings, store };
}


test('provider construction is passive and authenticated concurrent loads fetch exactly one bounded preview', async () => {
    const f = fixture();
    assert.deepEqual(f.calls, []); assert.equal(f.cache.size, 0); assert.equal(f.images.length, 0);
    const [a, b] = await Promise.all([f.helper.load(), f.helper.load()]);
    assert.equal(a, b); assert.deepEqual(a.buffer, JPEG);
    assert.deepEqual(f.calls.map(call => call[0]), ['info', 'list', 'preview']);
    assert.equal(f.calls[1][2].name, 'Homey du séjour');
    assert.equal(Object.hasOwn(f.calls[1][2], 'encoding'), false);
    assert.equal(f.calls[2][3].encoding, 'jpeg');
    assert.equal(f.calls[2][3].signal, f.calls[1][2].signal);
    assert(f.calls[1][2].signal instanceof AbortSignal);
    assert.equal(await f.helper.load(), a); assert.equal(f.calls.length, 3);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.attachments, []); assert.equal(f.images.length, 0);
    await f.helper.close();
  });

test('completed refreshes immediately choose another photo while concurrent requests still share one buffer', async () => {
    const next = deferred(); let count = 0;
    const f = fixture({ preview: () => ++count === 2 ? next.promise : preview() });
    const initial = await f.helper.load();
    const update = f.helper.refresh(); await tick();
    assert.equal(f.cache.get(PEER), initial);
    const repeated = f.helper.refresh(); next.resolve(preview());
    const [a, b] = await Promise.all([update, repeated]);
    assert.equal(a, b); assert.notEqual(a.mediaId, initial.mediaId);
    assert.equal(f.cache.size, 1); assert.equal(f.cache.get(PEER), a); assert.equal(count, 2);
    const third = await f.helper.refresh();
    assert.equal(count, 3); assert.notEqual(third.mediaId, a.mediaId); assert.equal(f.images.length, 0);
    const fourth = await f.helper.refresh();
    assert.equal(count, 4); assert.notEqual(fourth.mediaId, third.mediaId);
    assert.equal(f.clock.at, 0, 'Completed refreshes must work without waiting five seconds');
    assert.equal(f.cache.size, 1); assert.equal(f.cache.get(PEER), fourth);
    await f.helper.close();
  });

test('only explicitly visible photos can be selected; hidden photos and videos never provide a fallback', async () => {
  const visible = fixture({ list: () => [
    { mediaId: '1', type: 'video', visible: true },
    { mediaId: '2', type: 'photo', visible: false },
    { mediaId: '4', type: 'photo' },
    { mediaId: '3', type: 'photo', visible: true },
  ] });
  assert.equal((await visible.helper.load()).mediaId, '3');
  assert.equal(visible.calls.filter(call => call[0] === 'preview').length, 1);
  await visible.helper.close();
  for (const items of [[], [{ mediaId: '1', type: 'video', visible: true }],
    [{ mediaId: '2', type: 'photo', visible: false }], [{ mediaId: '3', type: 'photo' }]]) {
    const empty = fixture({ list: () => items });
    await assert.rejects(empty.helper.load(), { code: 'MEDIA_NOT_FOUND' });
    assert.equal(empty.calls.filter(call => call[0] === 'preview').length, 0);
    assert.equal(empty.cache.size, 0);
    await empty.helper.close();
  }
});

test('send-only and missing permissions never create a fresh image or call the engine', async () => {
  for (const options of [{ mode: 'send' }, { mayView: false }]) {
    const f = fixture(options);
    await assert.rejects(f.helper.load(), { code: options.mode ? 'ACCESS_MODE_SEND' : 'PERMISSION_REQUIRED' });
    assert.equal(f.images.length, 0); assert.deepEqual(f.calls, []);
  }
  const revoked = fixture({ info: device => { device.lastInfo = { mayView: false }; return device.lastInfo; } });
  await assert.rejects(revoked.helper.load(), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(revoked.calls.map(call => call[0]), ['info']);
  assert.equal(revoked.cache.size, 0);
});

test('busy activity is rejected before engine work while already cached bytes remain readable', async () => {
  for (const busy of ['activeTransfer', 'transferQueue', 'permissionTask', 'operation']) {
    const f = fixture();
    if (busy === 'operation') f.device.operation = { kind: 'send' };
    else f.device.homey.app[busy] = busy === 'transferQueue' ? [{}] : {};
    await assert.rejects(f.helper.load(), { code: 'BUSY' }); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); const cached = await f.helper.load();
  f.device.homey.app.activeTransfer = {};
  assert.equal(await f.helper.load(), cached); assert.equal(f.calls.length, 3);
  await assert.rejects(f.helper.refresh(), { code: 'BUSY' }); assert.equal(f.calls.length, 3);
  await f.helper.close();
});

test('read failures back off for thirty seconds while every explicit refresh can bypass the backoff', async () => {
  let failed = true;
  const f = fixture({ preview: () => {
    if (failed) throw Object.assign(new Error('secret native identity or photo URL'), { code: 'TIMEOUT' });
    return preview();
  } });
  await assert.rejects(f.helper.load(), error => { assert.equal(error.code, 'TIMEOUT'); assert(!error.message.includes('secret')); return true; });
  f.clock.at = 20000; await assert.rejects(f.helper.load(), { code: 'TIMEOUT' }); assert.equal(f.calls.length, 3);
  failed = false; await f.helper.refresh(); assert.equal(f.calls.length, 6);
  await f.helper.close();

  let attempts = 0;
  const manual = fixture({ preview: () => { attempts++; throw Object.assign(new Error('private upstream detail'), { code: 'TIMEOUT' }); } });
  await assert.rejects(manual.helper.refresh(), { code: 'TIMEOUT' });
  await assert.rejects(manual.helper.refresh(), { code: 'TIMEOUT' }); assert.equal(attempts, 2);
  manual.clock.at = 29999; await assert.rejects(manual.helper.load(), { code: 'TIMEOUT' }); assert.equal(attempts, 2);
  manual.clock.at = 30000; await assert.rejects(manual.helper.load(), { code: 'TIMEOUT' }); assert.equal(attempts, 3);
  await manual.helper.close();
});

test('invalidation aborts in-flight work and discards late pixels without any SDK image', async () => {
    const pending = deferred(); let signal;
    const f = fixture({ preview: (id, details) => { signal = details.signal; return pending.promise; } });
    const loading = f.helper.load(); await tick(); await f.helper.invalidate();
    await assert.rejects(loading, { code: 'ABORTED' }); assert.equal(signal.aborted, true);
    pending.resolve(preview()); await tick(); assert.equal(f.cache.size, 0);
    assert.equal(f.images.length, 0); assert.deepEqual(f.attachments, []);
    await f.helper.close(); await f.helper.close();
  });

test('legacy slot markers do not create new images or trigger a photo request', async () => {
    const f = fixture({ mode: 'send', slot: true });
    assert.equal(f.images.length, 0); assert.deepEqual(f.calls, []);
    await assert.rejects(f.helper.load(), { code: 'ACCESS_MODE_SEND' });
    await f.helper.close(); assert.deepEqual(f.attachments, []); assert.deepEqual(f.writes, []);
  });

test('observed access changes clear pixels and re-enabling needs another explicit widget load', async () => {
    const f = fixture(); await f.helper.load();
    f.settings.photo_access_mode = 'send'; await f.helper.invalidate();
    assert.equal(f.cache.bytes, 0); await assert.rejects(f.helper.load(), { code: 'ACCESS_MODE_SEND' });
    f.settings.photo_access_mode = 'manage'; assert.equal(f.calls.length, 3); await f.helper.load();
    f.device.lastInfo.mayView = false; await f.helper.invalidate();
    assert.equal(f.cache.size, 0); await assert.rejects(f.helper.load(), { code: 'PERMISSION_REQUIRED' });
    assert.equal(f.images.length, 0); await f.helper.close();
  });

test('closing the provider rejects subsequent widget requests and releases its cache', async () => {
    const f = fixture(); await f.helper.load(); await f.helper.close();
    assert.equal(f.cache.bytes, 0); await assert.rejects(f.helper.refresh(), { code: 'ABORTED' });
    await assert.rejects(f.helper.load(), { code: 'ABORTED' }); assert.equal(f.calls.length, 3);
  });

test('preview validation strips arbitrary metadata and rejects bad bytes, MIME or dimensions before caching', async () => {
  for (const invalid of [
    preview({ bytes: JPEG.length + 1 }), preview({ data: 'https://example.test/private.jpg' }),
    preview({ mime: 'image/svg+xml' }), preview({ mime: 'image/webp' }),
    preview({ mime: 'image/webp', data: WEBP.toString('base64'), bytes: WEBP.length }),
    preview({ mime: 'image/jpeg', data: WEBP.toString('base64'), bytes: WEBP.length }),
    preview({ mime: 'image/png' }),
    preview({ mime: 'image/jpeg', data: PNG.toString('base64'), bytes: PNG.length }),
    preview({ width: 2049 }), preview({ width: 2001, height: 2001 }),
    preview({ data: 'AA==' + '\n' }), preview({ bytes: 4 * 1024 * 1024 + 1 }),
    preview({ buffer: JPEG }),
    preview({ data: undefined, buffer: JPEG, bytes: JPEG.length + 1 }),
    preview({ data: undefined, buffer: PNG, bytes: PNG.length }),
  ]) {
    const f = fixture({ preview: () => invalid });
    await assert.rejects(f.helper.load(), { code: 'IMAGE_FORMAT_UNSUPPORTED' }); assert.equal(f.cache.size, 0);
    await f.helper.close();
  }
  const f = fixture({ preview: () => preview({ config: { private_key: 'PRIVATE' }, url: 'PRIVATE', arbitrary: 'PRIVATE' }) });
  const content = await f.helper.load();
  assert.deepEqual(Object.keys(content).sort(), ['buffer', 'filename', 'height', 'mediaId', 'mime', 'width']);
  assert(!JSON.stringify(content).includes('PRIVATE'));
  await f.helper.close();
});

test('only the selected validated image bytes enter the memory cache', async () => {
    for (const [mime, buffer, extension] of [['image/jpeg', JPEG, 'jpg'], ['image/png', PNG, 'png']]) {
      const f = fixture({ preview: () => preview({ mime, data: buffer.toString('base64'), bytes: buffer.length }) });
      const value = await f.helper.load(); assert.deepEqual(value.buffer, buffer);
      assert.equal(value.filename, 'frameo-preview.' + extension); assert.equal(f.cache.bytes, buffer.length);
      assert.equal(f.images.length, 0); assert.deepEqual(f.writes, []); await f.helper.close();
    }
  });

test('shared cache enforces byte and entry budgets, one entry per peer, LRU and a fixed ten-minute TTL', () => {
  const clock = { at: 0 }; const cache = new PreviewCache({ now: () => clock.at });
  const small = () => ({ buffer: Buffer.alloc(1), mediaId: '1' });
  for (let i = 0; i < 8; i++) cache.set('frame-' + i, small());
  cache.get('frame-0'); cache.set('frame-8', small());
  assert.equal(cache.size, 8); assert.equal(cache.get('frame-1'), null); assert(cache.get('frame-0'));
  cache.set('frame-0', small()); assert.equal(cache.size, 8); assert.equal(cache.bytes, 8);
  clock.at = 599999; assert(cache.get('frame-0'));
  clock.at = 600000; assert.equal(cache.get('frame-0'), null); assert.equal(cache.size, 0, 'Reads do not extend the original TTL');
  const large = () => ({ buffer: Buffer.alloc(4 * 1024 * 1024) });
  cache.set('a', large()); cache.set('b', large()); cache.get('a'); cache.set('c', large());
  assert.equal(cache.bytes, 8 * 1024 * 1024); assert.equal(cache.size, 2); assert.equal(cache.get('b'), null);
  assert.throws(() => cache.set('too-big', { buffer: Buffer.alloc(4 * 1024 * 1024 + 1) }), { code: 'MEDIA_TOO_LARGE' });
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0);
});

test('cache expiry drops pixels without background work until an explicit widget load', async () => {
    const f = fixture(); await f.helper.load();
    f.clock.at = 599999; assert(f.cache.get(PEER)); assert.equal(f.calls.length, 3);
    f.clock.at = 600000; assert.equal(f.cache.get(PEER), null); assert.equal(f.calls.length, 3);
    await f.helper.load(); assert.equal(f.calls.length, 6); assert.equal(f.cache.size, 1);
    await f.helper.close();
  });

test('stopping during a widget download cancels it without saving late bytes', async () => {
    const wait = deferred(); const f = fixture({ preview: () => wait.promise });
    const pending = f.helper.load(); await tick(); await f.helper.close();
    await assert.rejects(pending, { code: 'ABORTED' }); wait.resolve(preview()); await tick();
    assert.equal(f.cache.bytes, 0); assert.deepEqual(f.writes, []);
  });

test('invalidation during an uncancellable info check prevents later list or preview commands', async () => {
  const info = deferred(); const f = fixture({ info: () => info.promise });
  const pending = f.helper.load(); await tick(); await f.helper.invalidate();
  await assert.rejects(pending, { code: 'ABORTED' }); info.resolve({ mayView: true }); await tick();
  assert.deepEqual(f.calls.map(call => call[0]), ['info']); assert.equal(f.cache.size, 0);
});

test('preview retrieval failures never turn into an image association or persisted photo', async () => {
    const f = fixture({ preview: () => { throw Error('private frame trace'); } });
    await assert.rejects(f.helper.load(), { code: 'ENGINE_NOT_READY' });
    assert.equal(f.images.length, 0); assert.deepEqual(f.attachments, []); assert.deepEqual(f.writes, []);
    await f.helper.close();
  });
