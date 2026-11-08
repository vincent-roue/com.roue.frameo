'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FrameoEngine, SETTINGS_KEY } = require('../lib/frameo-engine');

// Synthetic identities and image bytes; these tests never use a real frame.
const PRIVATE = '17'.repeat(32);
const PEER = 'ad'.repeat(32);
const OTHER_PEER = 'ce'.repeat(32);
const MEDIA_ID = '9223372036854775807';
const CONFIG = { private_key: PRIVATE, client_name: 'Homey fixture', default_frame: PEER,
  frames: { fixture: { peer_id: PEER, name: 'Fixture frame', paired_at: '2026-01-01T00:00:00Z' } } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=', 'base64');
const clone = value => JSON.parse(JSON.stringify(value));
const replacement = () => ({ ...clone(CONFIG), private_key: '28'.repeat(32), client_name: 'Untrusted replacement' });
const success = result => ({ ok: true, result, config: replacement() });
const nativePreview = overrides => ({ peer: PEER, mediaId: MEDIA_ID, bytes: PNG.length, mime: 'image/png', width: 1, height: 1, ...overrides });
const nativeDeletion = overrides => ({ peer: PEER, mediaId: MEDIA_ID, acknowledged: true, deleted: true, ...overrides });

function fixture(t, runner, options) {
  const saved = clone(CONFIG), writes = [], requests = [];
  const homey = { settings: {
    get(key) { assert.equal(key, SETTINGS_KEY); return saved; },
    set(key, value) { writes.push({ key, value }); throw new Error('Gallery operations must not write identity settings'); },
  } };
  const engine = new FrameoEngine({ homey, fetch: async () => assert.fail('No network download is allowed'),
    runner: async value => { requests.push(clone(value.request)); return runner(value); }, ...options });
  t.after(() => { engine.close(); assert.deepEqual(saved, CONFIG); assert.equal(writes.length, 0); });
  return { engine, requests, saved, writes };
}

async function assertRemoved(filename) {
  await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.dirname(filename)), { code: 'ENOENT' });
}

async function inspectPrivateOutput(request) {
  assert.equal(request.operation, 'getMedia');
  assert.equal(request.size, 'preview', 'The adapter may never request an original for this operation');
  assert.equal(request.peer, PEER);
  assert.equal(request.mediaId, MEDIA_ID);
  assert.equal(path.basename(request.path), 'preview');
  assert(path.basename(path.dirname(request.path)).startsWith('homey-frameo-preview-'));
  const relative = path.relative(os.tmpdir(), request.path);
  assert(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  assert(!request.path.includes('userdata'));
  const stat = await fs.lstat(request.path);
  assert.equal(stat.size, 0, 'The trusted parent precreates an empty file');
  assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(request.path))).mode & 0o777, 0o700);
  }
}

test('gallery index preserves exact signed int64 IDs and returns only its public metadata allowlist', async t => {
  const values = [MEDIA_ID, '-9223372036854775808', '0'];
  const raw = values.map((mediaId, index) => ({ mediaId, type: ['photo', 'video', 'unexpected'][index],
    visible: index === 0 ? true : 'true', captureDate: index === 0 ? '2026-11-03T12:34:56+01:00' : 'not a date',
    receiveDate: '2026-11-03T12:00:00Z', caption: 'Not part of the metadata API', private_key: PRIVATE, path: '/private', data: 'DO_NOT_FORWARD' }));
  const f = fixture(t, async ({ request }) => {
    assert.equal(request.operation, 'listMedia');
    return success({ peer: PEER, items: raw, private_key: PRIVATE });
  });
  const result = await f.engine.listMedia(PEER, { name: 'Homey fixture', path: '/untrusted', operation: 'deleteMedia' });
  assert.deepEqual(result.map(item => item.mediaId), values);
  assert.equal(result[0].captureDate, '2026-11-03T11:34:56.000Z');
  assert.equal(result[1].captureDate, null);
  assert.equal(result[1].visible, null, 'String booleans cannot invent either a visible or a hidden state');
  assert.equal(result[2].type, 'unknown');
  for (const item of result) assert.deepEqual(Object.keys(item).sort(), ['captureDate', 'mediaId', 'receiveDate', 'type', 'visible']);
  assert.deepEqual(f.requests, [{ operation: 'listMedia', peer: PEER, name: 'Homey fixture', config: CONFIG }]);
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert(!JSON.stringify(result).includes('DO_NOT_FORWARD'));
  assert.deepEqual(await f.engine.frames(), [{ peer: PEER, name: 'Fixture frame' }]);
});

test('gallery index accepts 10000 entries but rejects duplicates, malformed entries, wrong peers and larger lists', async t => {
  const index = Array.from({ length: 10000 }, (_, i) => ({ mediaId: String(i + 1), type: 'photo', visible: true }));
  const accepted = fixture(t, async () => success({ peer: PEER, items: index }));
  assert.equal((await accepted.engine.listMedia(PEER)).length, 10000);
  const invalid = [
    ['too many', { peer: PEER, items: [...index, { mediaId: '10001' }] }],
    ['duplicate IDs', { peer: PEER, items: [{ mediaId: MEDIA_ID }, { mediaId: MEDIA_ID }] }],
    ['numeric IDs', { peer: PEER, items: [{ mediaId: 42 }] }],
    ['out of range', { peer: PEER, items: [{ mediaId: '9223372036854775808' }] }],
    ['missing item', { peer: PEER, items: [null] }],
    ['non-array index', { peer: PEER, items: {} }],
    ['wrong frame', { peer: OTHER_PEER, items: [] }],
    ['missing response', null],
  ];
  for (const [label, response] of invalid) await t.test(label, async sub => {
    const f = fixture(sub, async () => success(response));
    await assert.rejects(f.engine.listMedia(PEER), error => {
      assert(['ENGINE_NOT_READY', 'INVALID_MEDIA_ID'].includes(error.code));
      assert(!error.message.includes(PRIVATE)); return true;
    });
    assert.equal(f.requests.length, 1);
  });
});

test('preview and delete reject non-canonical IDs or unknown frames before a native invocation', async t => {
  const f = fixture(t, async () => assert.fail('Invalid input must never reach the native engine'));
  const invalid = [undefined, null, 42, Number.MAX_SAFE_INTEGER + 1, '', '01', '-0', '+1', ' 1', '1 ', '1;delete',
    '9223372036854775808', '-9223372036854775809', '1'.repeat(200)];
  for (const id of invalid) {
    await assert.rejects(f.engine.previewMedia(PEER, id), { code: 'INVALID_MEDIA_ID' });
    await assert.rejects(f.engine.deleteMedia(PEER, id), { code: 'INVALID_MEDIA_ID' });
  }
  for (const method of ['listMedia', 'previewMedia', 'deleteMedia']) {
    await assert.rejects(f.engine[method](OTHER_PEER, MEDIA_ID), { code: 'FRAME_UNKNOWN' });
  }
  assert.equal(f.requests.length, 0);
});

test('preview reads a precreated private file, ignores native base64 and extra fields, and removes all temporary output', async t => {
  let output;
  const f = fixture(t, async ({ request }) => {
    output = request.path; await inspectPrivateOutput(request);
    assert.deepEqual(Object.keys(request).sort(), ['config', 'mediaId', 'name', 'operation', 'path', 'peer', 'size']);
    await fs.writeFile(request.path, PNG, { flag: 'r+' });
    return success(nativePreview({ data: 'UNTRUSTED_BASE64', path: '/private/output', private_key: PRIVATE,
      config: replacement(), caption: 'Not exposed by preview', arbitrary: 'not public' }));
  });
  const result = await f.engine.previewMedia(PEER, MEDIA_ID, { name: 'Homey fixture', path: '/untrusted', size: 'full', operation: 'deleteMedia' });
  assert.deepEqual(result, { mime: 'image/png', data: PNG.toString('base64'), bytes: PNG.length, width: 1, height: 1 });
  assert.equal(f.requests.length, 1);
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert(!JSON.stringify(result).includes(output));
  assert(!JSON.stringify(result).includes('UNTRUSTED_BASE64'));
  assert(!JSON.stringify(f.requests[0]).includes('UNTRUSTED_BASE64'));
  await assertRemoved(output);
  assert.deepEqual(await f.engine.frames(), [{ peer: PEER, name: 'Fixture frame' }]);
});

test('JPEG encoding is explicitly relayed for one preview and its output format is verified', async t => {
  // Simulated native result: this boundary checks MIME/signature and exact
  // bytes; actual JPEG encoding and decoding are covered by the Go tests.
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(20)]);
  let output;
  const f = fixture(t, async ({ request }) => {
    output = request.path; await inspectPrivateOutput(request);
    assert.equal(request.encoding, 'jpeg');
    await fs.writeFile(output, jpeg, { flag: 'r+' });
    return success(nativePreview({ bytes: jpeg.length, mime: 'image/jpeg' }));
  });
  const result = await f.engine.previewMedia(PEER, MEDIA_ID, { encoding: 'jpeg' });
  assert.equal(result.mime, 'image/jpeg'); assert.equal(result.bytes, jpeg.length);
  assert.deepEqual(Buffer.from(result.data, 'base64'), jpeg); assert.equal(f.requests.length, 1);
  await assertRemoved(output);

  const wrong = fixture(t, async ({ request }) => {
    await fs.writeFile(request.path, PNG, { flag: 'r+' });
    return success(nativePreview());
  });
  await assert.rejects(wrong.engine.previewMedia(PEER, MEDIA_ID, { encoding: 'jpeg' }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  await assertRemoved(wrong.requests[0].path);
});

test('unsupported preview encodings fail before native invocation and default gallery previews request no conversion', async t => {
  const f = fixture(t, async () => assert.fail('Unsupported encoding must not start a process'));
  for (const encoding of ['png', 'webp', 'JPEG', '', null, true, {}, ['jpeg']]) {
    await assert.rejects(f.engine.previewMedia(PEER, MEDIA_ID, { encoding }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  }
  assert.equal(f.requests.length, 0);
  const gallery = fixture(t, async ({ request }) => {
    assert.equal(Object.hasOwn(request, 'encoding'), false);
    await fs.writeFile(request.path, PNG, { flag: 'r+' }); return success(nativePreview());
  });
  const result = await gallery.engine.previewMedia(PEER, MEDIA_ID);
  assert.equal(result.mime, 'image/png'); assert.deepEqual(Buffer.from(result.data, 'base64'), PNG);
});

test('video preview explicitly requests a still JPEG and includes only a bounded caption when asked', async t => {
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(20)]);
  const f = fixture(t, async ({ request }) => {
    await inspectPrivateOutput(request);
    assert.equal(request.videoThumbnail, true);
    assert.equal(request.encoding, 'jpeg');
    assert.equal(request.previewCaption, true);
    await fs.writeFile(request.path, jpeg, { flag: 'r+' });
    return success(nativePreview({ mime: 'image/jpeg', bytes: jpeg.length, caption: ' Photo\u0000 ' + 'é'.repeat(1200) }));
  });
  await assert.rejects(f.engine.previewMedia(PEER, MEDIA_ID, { videoThumbnail: true }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  const result = await f.engine.previewMedia(PEER, MEDIA_ID, { videoThumbnail: true, encoding: 'jpeg', includeCaption: true });
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.caption, 'Photo ' + 'é'.repeat(994));
  await assertRemoved(f.requests[0].path);
});

test('preview validates native frame, ID, byte count, image MIME and dimensions and always removes failures', async t => {
  const cases = [
    ['wrong peer', nativePreview({ peer: OTHER_PEER })],
    ['wrong photo', nativePreview({ mediaId: '2' })],
    ['numeric photo ID', nativePreview({ mediaId: Number(MEDIA_ID) })],
    ['wrong byte count', nativePreview({ bytes: PNG.length + 1 })],
    ['string byte count', nativePreview({ bytes: String(PNG.length) })],
    ['MIME mismatch', nativePreview({ mime: 'image/jpeg' })],
    ['active format', nativePreview({ mime: 'image/svg+xml' })],
    ['zero width', nativePreview({ width: 0 })],
    ['negative height', nativePreview({ height: -1 })],
    ['fractional width', nativePreview({ width: 1.5 })],
    ['string dimensions', nativePreview({ height: '1' })],
    ['width above 2048', nativePreview({ width: 2049 })],
    ['height above 2048', nativePreview({ height: 2049 })],
    ['pixel count above four million', nativePreview({ width: 2048, height: 2048 })],
  ];
  for (const [label, response] of cases) await t.test(label, async sub => {
    let output;
    const f = fixture(sub, async ({ request }) => {
      output = request.path; await inspectPrivateOutput(request);
      await fs.writeFile(output, PNG, { flag: 'r+' }); return success(response);
    });
    await assert.rejects(f.engine.previewMedia(PEER, MEDIA_ID), error => {
      assert(['MEDIA_TOO_LARGE', 'IMAGE_FORMAT_UNSUPPORTED'].includes(error.code)); return true;
    });
    assert.equal(f.requests.length, 1); await assertRemoved(output);
  });
});

test('preview rejects an empty, oversized or non-image file instead of trusting the native response', async t => {
  for (const variant of ['empty', 'oversized', 'not image']) await t.test(variant, async sub => {
    let output;
    const f = fixture(sub, async ({ request }) => {
      output = request.path; await inspectPrivateOutput(request);
      let bytes = 0;
      if (variant === 'oversized') {
        await fs.writeFile(output, PNG, { flag: 'r+' });
        const file = await fs.open(output, 'r+');
        try { await file.truncate(4 * 1024 * 1024 + 1); } finally { await file.close(); }
        bytes = 4 * 1024 * 1024 + 1;
      } else if (variant === 'not image') {
        const wrong = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        await fs.writeFile(output, wrong, { flag: 'r+' }); bytes = wrong.length;
      }
      return success(nativePreview({ bytes }));
    });
    await assert.rejects(f.engine.previewMedia(PEER, MEDIA_ID));
    assert.equal(f.requests.length, 1); await assertRemoved(output);
  });
});

test('native preview errors and caller cancellation clean output and never replace the identity', async t => {
  let failedOutput;
  const failed = fixture(t, async ({ request }) => {
    failedOutput = request.path; await fs.writeFile(failedOutput, PNG, { flag: 'r+' });
    return { ok: false, error: { code: 'FRAME_UNAVAILABLE', message: 'private native trace ' + PRIVATE }, config: replacement() };
  });
  await assert.rejects(failed.engine.previewMedia(PEER, MEDIA_ID), error => {
    assert.equal(error.code, 'FRAME_UNAVAILABLE'); assert(!error.message.includes(PRIVATE)); return true;
  });
  await assertRemoved(failedOutput);

  let output, started, finish;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const aborted = fixture(t, async ({ request }) => {
    output = request.path; await fs.writeFile(output, PNG, { flag: 'r+' }); started(); return pending;
  });
  const controller = new AbortController();
  const operation = aborted.engine.previewMedia(PEER, MEDIA_ID, { signal: controller.signal });
  await hasStarted; controller.abort();
  await assert.rejects(operation, { code: 'ABORTED' });
  await assertRemoved(output);
  finish(success(nativePreview()));
  assert.equal(aborted.requests.length, 1);
});

test('delete forwards one exact ID and only publishes a matching acknowledged deletion', async t => {
  const f = fixture(t, async ({ request }) => {
    assert.deepEqual(request, { operation: 'deleteMedia', peer: PEER, mediaId: MEDIA_ID, name: 'Homey fixture', config: CONFIG });
    return success(nativeDeletion({ path: '/private', private_key: PRIVATE, mediaIds: ['1', '2'], data: 'NOT_PUBLIC' }));
  });
  const result = await f.engine.deleteMedia(PEER, MEDIA_ID, { name: 'Homey fixture', mediaIds: ['1', '2'], operation: 'send' });
  assert.deepEqual(result, { mediaId: MEDIA_ID, deleted: true });
  assert.equal(f.requests.length, 1);
  assert(!JSON.stringify(result).includes(PRIVATE));
  assert.deepEqual(await f.engine.frames(), [{ peer: PEER, name: 'Fixture frame' }]);
});

test('wrong, missing or loosely typed deletion confirmations are rejected after exactly one invocation', async t => {
  const invalid = [nativeDeletion({ peer: OTHER_PEER }), nativeDeletion({ mediaId: '1' }), nativeDeletion({ mediaId: Number(MEDIA_ID) }),
    nativeDeletion({ acknowledged: false }), nativeDeletion({ acknowledged: 'true' }), nativeDeletion({ deleted: false }),
    nativeDeletion({ deleted: 'true' }), { peer: PEER, mediaId: MEDIA_ID, deleted: true }, null];
  for (let i = 0; i < invalid.length; i++) await t.test('invalid confirmation ' + (i + 1), async sub => {
    const f = fixture(sub, async () => success(invalid[i]));
    await assert.rejects(f.engine.deleteMedia(PEER, MEDIA_ID), { code: 'DELETE_UNVERIFIED' });
    assert.equal(f.requests.length, 1);
  });
});

test('an ambiguous native error or deadline never retries deletion automatically', async t => {
  for (const code of ['DELETE_UNVERIFIED', 'TIMEOUT', 'ABORTED', 'ENGINE_NOT_READY', 'FRAME_UNAVAILABLE', 'PERMISSION_REQUIRED', 'MEDIA_NOT_FOUND']) await t.test(code, async sub => {
    const f = fixture(sub, async () => ({ ok: false, error: { code, message: PRIVATE }, config: replacement() }));
    await assert.rejects(f.engine.deleteMedia(PEER, MEDIA_ID), error => {
      assert.equal(error.code, ['TIMEOUT', 'ABORTED', 'ENGINE_NOT_READY'].includes(code) ? 'DELETE_UNVERIFIED' : code);
      assert(!error.message.includes(PRIVATE)); return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
  });
  await t.test('parent deadline', async sub => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture(sub, async () => pending, { timeouts: { deleteMedia: 10 } });
    await assert.rejects(f.engine.deleteMedia(PEER, MEDIA_ID), { code: 'DELETE_UNVERIFIED' });
    finish(success(nativeDeletion()));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 1);
  });
});
