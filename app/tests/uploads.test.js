'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FrameoUploads, CHUNK_BYTES, MAX_BYTES, TTL_MS } = require('../lib/frameo-uploads');
const { FrameoTransfers } = require('../lib/frameo-transfers');
const { FrameoGroups } = require('../lib/frameo-groups');
const { FrameoEngine, SETTINGS_KEY } = require('../lib/frameo-engine');
const A = 'ab'.repeat(32);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nvAAAAAASUVORK5CYII=', 'base64');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameo-upload-test-'));
  let clock = 0; const calls = [], saved = new Map();
  saved.set(SETTINGS_KEY, { private_key: '17'.repeat(32), frames: { a: { peer_id: A } } });
  const app = { stopping: false, log() {}, homey: {
    settings: { get: key => saved.get(key), set: (key, value) => saved.set(key, JSON.parse(JSON.stringify(value))) },
    __: key => key,
  } };
  app.engine = new FrameoEngine({ homey: app.homey, runner: async ({ request }) => {
    calls.push(request.operation);
    assert.deepEqual(await fs.readFile(request.path), PNG);
    if (options.send) await options.send();
    return { ok: true, result: { peer: A, confirmed: true, mediaId: '9223372036854775807', bytes: PNG.length } };
  } });
  const device = { stopped: false, getData: () => ({ id: A }), getName: () => 'Salon',
    sendPrepared: (handle, details) => app.engine.sendPrepared(A, handle, details) };
  app.getDevices = () => [device]; app.groups = new FrameoGroups(app);
  app.transfers = new FrameoTransfers(app, { flowTimeoutMs: 1000 });
  app.uploads = new FrameoUploads(app, { now: () => clock, tmpdir: directory, sweepMs: 0 });
  const batch = await app.transfers.start({ frameId: A });
  t.after(async () => { app.stopping = true; app.engine.close(); await app.transfers.close(); await app.uploads.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, batch, calls, directory, advance(ms) { clock += ms; } };
}
async function uploaded(f, bytes = PNG, mime = 'image/png') {
  const result = await f.app.uploads.start({ batchId: f.batch.batchId, bytes: bytes.length, mime });
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
    assert.deepEqual(await f.app.uploads.chunk({ uploadId: result.uploadId, offset, data: chunk.toString('base64') }), { offset: offset + chunk.length });
  }
  return result;
}

test('upload chunks stay private and never send before explicit finish; repeated finish returns the exact same job', async t => {
  const f = await fixture(t); const { uploadId, chunkBytes } = await uploaded(f);
  assert.equal(chunkBytes, 196608); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.app.uploads.stats(), { sessions: 1, bytes: PNG.length, maxBytes: 16 * 1024 * 1024 });
  const session = f.app.uploads.sessions.get(uploadId), filename = session.filename;
  assert(!filename.includes('userdata'));
  assert.deepEqual(await fs.readFile(filename), PNG);
  const [first, second] = await Promise.all([f.app.uploads.finish({ uploadId }), f.app.uploads.finish({ uploadId })]);
  assert.deepEqual(first, second);
  const job = await f.app.transfers.waitFor(first.jobId);
  assert.equal(job.status, 'succeeded'); assert.deepEqual(f.calls, ['send']);
  assert.deepEqual(await f.app.uploads.finish({ uploadId }), first);
  assert.deepEqual(await f.app.uploads.abort({ uploadId }), { aborted: false, jobId: first.jobId });
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  assert.equal(f.app.uploads.stats().bytes, 0);
  const output = JSON.stringify({ first, second, job });
  assert(!output.includes(filename) && !output.includes(PNG.toString('base64')) && !output.includes('private_key'));
});

test('wrong offsets, duplicate chunks, overflow, malformed and oversize base64 fail without advancing the upload', async t => {
  const f = await fixture(t);
  const { uploadId } = await f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/png', bytes: 10 });
  await assert.rejects(f.app.uploads.chunk({ uploadId, offset: 1, data: 'YQ==' }), { code: 'UPLOAD_OFFSET_INVALID' });
  for (const data of ['%%%', 'YQ', 'YQ===', 'A'.repeat(Math.ceil(CHUNK_BYTES / 3) * 4 + 4)]) {
    await assert.rejects(f.app.uploads.chunk({ uploadId, offset: 0, data }), { code: 'UPLOAD_INVALID' });
  }
  const simultaneous = await Promise.allSettled([0, 0].map(offset => f.app.uploads.chunk({ uploadId, offset, data: 'YQ==' })));
  assert.equal(simultaneous.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(simultaneous.find(value => value.status === 'rejected').reason.code, 'UPLOAD_OFFSET_INVALID');
  await assert.rejects(f.app.uploads.chunk({ uploadId, offset: 1, data: Buffer.alloc(10).toString('base64') }), { code: 'UPLOAD_OFFSET_INVALID' });
  await assert.rejects(f.app.uploads.finish({ uploadId }), { code: 'UPLOAD_INCOMPLETE' });
  assert.deepEqual(f.calls, []); assert.equal(f.app.uploads.sessions.get(uploadId).offset, 1);
});

test('8MiB admission, two-file quota and real file size are checked before a transfer starts', async t => {
  const f = await fixture(t);
  for (const bytes of [0, -1, 1.5, MAX_BYTES + 1]) await assert.rejects(f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/png', bytes }), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/webp', bytes: 1 }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  await assert.rejects(f.app.uploads.start({ batchId: 'missing', mime: 'image/png', bytes: 1 }), { code: 'TRANSFER_BATCH_EXPIRED' });
  const first = await uploaded(f);
  await fs.appendFile(f.app.uploads.sessions.get(first.uploadId).filename, Buffer.from('extra'));
  await assert.rejects(f.app.uploads.finish({ uploadId: first.uploadId }), { code: 'UPLOAD_INCOMPLETE' });
  await f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/jpeg', bytes: MAX_BYTES });
  await assert.rejects(f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/png', bytes: 1 }), { code: 'UPLOAD_LIMIT' });
  assert.equal(f.app.uploads.stats().sessions, 2); assert.deepEqual(f.calls, []);
});

test('queued uploads keep their file quota until preparation and are not erased by TTL or abort', async t => {
  const f = await fixture(t); const permission = deferred(); f.app.permissionTask = permission.promise;
  const first = await uploaded(f), second = await uploaded(f);
  const one = await f.app.uploads.finish({ uploadId: first.uploadId });
  const two = await f.app.uploads.finish({ uploadId: second.uploadId });
  f.advance(TTL_MS + 1); await f.app.uploads.sweep();
  assert.equal(f.app.uploads.stats().sessions, 2);
  await assert.rejects(f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/png', bytes: 1 }), { code: 'UPLOAD_LIMIT' });
  assert.deepEqual(await f.app.uploads.abort({ uploadId: first.uploadId }), { aborted: false, jobId: one.jobId });
  assert.deepEqual(f.calls, []);
  permission.resolve();
  await f.app.transfers.waitFor(one.jobId); await f.app.transfers.waitFor(two.jobId);
  assert.deepEqual(f.calls, ['send', 'send']); assert.equal(f.app.uploads.stats().sessions, 0);
});

test('expired or aborted incomplete uploads remove files without sending and release reservations', async t => {
  const f = await fixture(t), first = await uploaded(f), second = await uploaded(f);
  const paths = [...f.app.uploads.sessions.values()].map(value => value.filename);
  assert.deepEqual(await f.app.uploads.abort({ uploadId: first.uploadId }), { aborted: true });
  f.advance(TTL_MS); await f.app.uploads.sweep();
  await assert.rejects(f.app.uploads.chunk({ uploadId: second.uploadId, offset: PNG.length, data: 'YQ==' }), { code: 'UPLOAD_NOT_FOUND' });
  for (const filename of paths) await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
  assert.equal(f.app.uploads.stats().bytes, 0); assert.deepEqual(f.calls, []);
});

test('an entire 8MiB image crosses the bounded chunk path and can be discarded without a send', async t => {
  const f = await fixture(t);
  const image = Buffer.alloc(MAX_BYTES, 0x7a); PNG.copy(image);
  const { uploadId } = await uploaded(f, image);
  const session = f.app.uploads.sessions.get(uploadId);
  assert.equal(session.offset, MAX_BYTES); assert.equal((await fs.stat(session.filename)).size, MAX_BYTES);
  assert.equal(f.app.uploads.stats().bytes, MAX_BYTES); assert.deepEqual(f.calls, []);
  await f.app.uploads.abort({ uploadId });
  assert.equal(f.app.uploads.stats().bytes, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('an invalid complete image fails in the existing image validator before sending and deletes both temporary sources', async t => {
  const f = await fixture(t); const { uploadId } = await uploaded(f, Buffer.from('<html>not an image</html>'));
  const { jobId } = await f.app.uploads.finish({ uploadId });
  await assert.rejects(f.app.transfers.waitFor(jobId), { code: 'TRANSFER_INCOMPLETE' });
  const job = (await f.app.transfers.get(jobId)).job;
  assert.equal(job.results[0].code, 'IMAGE_FORMAT_UNSUPPORTED'); assert.equal(job.results[0].status, 'failed');
  assert.deepEqual(f.calls, []); assert.equal(f.app.uploads.stats().bytes, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('shutdown clears incomplete and queued uploaded files without replay or quota leaks', async t => {
  const f = await fixture(t); const permission = deferred(); f.app.permissionTask = permission.promise;
  const first = await uploaded(f); await uploaded(f);
  const { jobId } = await f.app.uploads.finish({ uploadId: first.uploadId });
  f.app.stopping = true; f.app.engine.close(); await f.app.transfers.close(); await f.app.uploads.close();
  assert.equal(f.app.uploads.stats().bytes, 0); assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(f.calls, []); assert.equal((await f.app.transfers.get(jobId)).job.status, 'failed');
  await assert.rejects(f.app.uploads.start({ batchId: f.batch.batchId, mime: 'image/png', bytes: 1 }), { code: 'TRANSFER_CANCELLED' });
});
