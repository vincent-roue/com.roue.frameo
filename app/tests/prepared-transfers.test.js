'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const { FrameoEngine, SETTINGS_KEY } = require('../lib/frameo-engine');
const A = 'ab'.repeat(32), B = 'bc'.repeat(32);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=', 'base64');
function fixture(t, runner) {
  const config = { private_key: '17'.repeat(32), frames: { a: { peer_id: A }, b: { peer_id: B } } };
  const engine = new FrameoEngine({ homey: { settings: { get: key => key === SETTINGS_KEY ? config : null, set() { assert.fail('No pairing or identity write'); } } }, runner });
  t.after(() => engine.close()); return engine;
}
test('one-shot Homey image is prepared once, reused privately for two receivers, then removed', async t => {
  let streams = 0; const paths = [];
  const engine = fixture(t, async ({ request }) => {
    assert.equal(request.operation, 'send'); paths.push(request.path); assert.deepEqual(await fs.readFile(request.path), PNG);
    return { ok: true, result: { peer: request.peer, confirmed: true, mediaId: '9223372036854775807', bytes: PNG.length } };
  });
  const handle = await engine.prepareImage({ async getStream() { if (++streams > 1) throw Error('one-shot token consumed twice'); return Readable.from([PNG]); } });
  assert.deepEqual(handle, {}); assert(!JSON.stringify(handle).includes('path'));
  await engine.sendPrepared(A, handle); await engine.sendPrepared(B, handle);
  assert.equal(streams, 1); assert.equal(paths[0], paths[1]); assert(!paths[0].includes('userdata'));
  await engine.disposePrepared(handle); await assert.rejects(fs.stat(paths[0]), { code: 'ENOENT' });
  await assert.rejects(engine.sendPrepared(A, handle), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
});
test('native pre-send timeout remains a known failure but parent deadline after launch is uncertain', async t => {
  const native = fixture(t, async () => ({ ok: false, error: { code: 'TIMEOUT', message: 'private trace' } }));
  const first = await native.prepareBase64(PNG.toString('base64'), 'image/png');
  await assert.rejects(native.sendPrepared(A, first), { code: 'TIMEOUT' }); await native.disposePrepared(first);
  const interrupted = fixture(t, async () => { throw Object.assign(new Error('private trace'), { code: 'TIMEOUT' }); });
  const second = await interrupted.prepareBase64(PNG.toString('base64'), 'image/png');
  await assert.rejects(interrupted.sendPrepared(A, second), { code: 'SEND_UNVERIFIED' }); await interrupted.disposePrepared(second);
});
