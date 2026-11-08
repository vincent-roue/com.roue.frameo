'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { FrameoGroups, GROUPS_KEY } = require('../lib/frameo-groups');
const { FrameoTransfers } = require('../lib/frameo-transfers');
const { TransferJournal, JOURNAL_KEY } = require('../lib/transfer-journal');
const A = 'ab'.repeat(32), B = 'bc'.repeat(32), C = 'cd'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const saved = options.saved || new Map(), events = [], calls = [], logs = [];
  let devices;
  const app = { stopping: false, log: value => logs.push(value), getDevices: () => devices,
    homey: { settings: { get: key => saved.get(key), async set(key, value) { if (options.onSave) await options.onSave(key, value); saved.set(key, clone(value)); } },
      __: (key, tokens) => key + (tokens ? JSON.stringify(tokens) : '') },
    engine: {
      async prepareUrl(value) { calls.push(['prepare', 'url']); if (options.prepare) await options.prepare(value); return {}; },
      async prepareImage(image) { calls.push(['prepare', 'image']); await image.getStream(); return {}; },
      async prepareBase64(data) { calls.push(['prepare', 'base64']); if (options.prepare) await options.prepare(data); return {}; },
      async preparedSize() { return options.size || 32; },
      async disposePrepared() { calls.push(['dispose']); },
    },
    photoReceived: { async trigger(device, tokens) { events.push(['received', device.getData().id, tokens]); if (options.trigger) await options.trigger(); } },
    photoFailed: { async trigger(device, tokens) { events.push(['failed', device.getData().id, tokens]); } },
  };
  devices = [A, B, C].map((id, index) => ({ stopped: false, operation: null, getData: () => ({ id }), getName: () => ['Salon', 'Cuisine', 'Bureau'][index],
    async sendPrepared(handle, details) { calls.push(['send', id, handle, details]);
      return options.send ? options.send(id, details) : { confirmed: true, at: '2026-11-03T12:00:00Z', mediaId: '9223372036854775807' }; } }));
  app.groups = new FrameoGroups(app); app.transfers = new FrameoTransfers(app, { flowTimeoutMs: 20, ...options.timing });
  t.after(async () => { app.stopping = true; await app.transfers.close(); });
  return { app, saved, events, calls, logs, get devices() { return devices; }, remove(id) { devices = devices.filter(device => device.getData().id !== id); } };
}

test('groups preserve stable IDs, deduplicate peers, allow overlaps and empty saves, and remove deleted references', async t => {
  const f = fixture(t);
  const first = (await f.app.groups.save({ name: 'Étage', frameIds: [A, A.toUpperCase(), B] })).group;
  const second = (await f.app.groups.save({ name: 'Cuisine et bureau', frameIds: [B, C] })).group;
  assert.deepEqual(first.frameIds, [A, B]);
  const changed = (await f.app.groups.save({ id: first.id, name: 'Rez-de-chaussée', frameIds: [] })).group;
  assert.equal(changed.id, first.id); assert.deepEqual(changed.frameIds, []);
  await assert.rejects(f.app.transfers.start({ groupId: first.id }), { code: 'GROUP_EMPTY' });
  await f.app.groups.removeFrame(B);
  assert.deepEqual((await f.app.groups.get(second.id)).frameIds, [C]);
  await assert.rejects(f.app.groups.save({ name: 'Inconnu', frameIds: ['ee'.repeat(32)] }), { code: 'GROUP_FRAME_UNKNOWN' });
  const restored = new FrameoGroups(f.app); assert.deepEqual(await restored.list(), await f.app.groups.list());
  assert.equal(f.saved.get(GROUPS_KEY).groups.length, 2);
});

const offlineBeforeSend = () => Object.assign(new Error('offline before transfer'), { code: 'CONNECTION_FAILED', beforeSend: true });
async function waitUntil(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Transfer never reached the expected state');
}

test('opt-in deferral keeps one prepared photo and resumes only the pending frame', async t => {
  let online = false;
  const f = fixture(t, { send: id => {
    if (id === B && !online) throw offlineBeforeSend();
    return { confirmed: true, mediaId: '123' };
  } });
  const group = (await f.app.groups.save({ name: 'Two frames', frameIds: [A, B] })).group;
  const { jobId } = await f.app.transfers.enqueueManual({ groupId: group.id, data: 'AQ==', mime: 'image/jpeg', defer: true,
    center: [0.25, 0.75], caption: 'private caption' });
  await waitUntil(() => f.app.transfers.runtime.get(jobId)?.retryAt != null);
  const waiting = (await f.app.transfers.get(jobId)).job;
  assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.status, 'waiting');
  assert.deepEqual(waiting.results.map(result => result.status), ['succeeded', 'waiting']);
  assert.equal(f.app.activeTransfer, false);
  assert.equal(f.calls.filter(([kind]) => kind === 'dispose').length, 0);
  assert.equal(f.events.filter(([kind]) => kind === 'failed').length, 0);
  await f.app.transfers.clear();
  assert.equal((await f.app.transfers.get(jobId)).job.status, 'waiting');
  assert(!JSON.stringify(f.saved.get(JOURNAL_KEY)).includes('private caption'));

  online = true;
  f.app.transfers.frameReachable(B);
  await waitUntil(() => !f.app.transfers.runtime.has(jobId));
  assert.equal((await f.app.transfers.get(jobId)).job.status, 'succeeded');
  const attempts = f.calls.filter(([kind]) => kind === 'send');
  assert.deepEqual(attempts.map(([, id]) => id), [A, B, B]);
  for (const [, , handle, options] of attempts) {
    assert.equal(handle, attempts[0][2]);
    assert.deepEqual(options.center, [0.25, 0.75]);
  }
  assert.equal(f.calls.filter(([kind]) => kind === 'prepare').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'dispose').length, 1);
});

test('default, unproved connection failure and uncertain send never enter deferred delivery', async t => {
  const f = fixture(t, { send: id => {
    if (id === A) throw offlineBeforeSend();
    if (id === B) throw Object.assign(new Error('unproved'), { code: 'CONNECTION_FAILED' });
    throw Object.assign(new Error('uncertain'), { code: 'SEND_UNVERIFIED', beforeSend: true });
  } });
  for (const [frameId, defer, status] of [[A, false, 'failed'], [B, true, 'failed'], [C, true, 'uncertain']]) {
    const { jobId } = await f.app.transfers.enqueueManual({ frameId, url: 'https://example.test/a.jpg', defer });
    await assert.rejects(f.app.transfers.waitFor(jobId), { code: 'TRANSFER_INCOMPLETE' });
    assert.equal((await f.app.transfers.get(jobId)).job.status, status);
    f.app.transfers.frameReachable(frameId);
  }
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'send').map(([, id]) => id), [A, B, C]);
});

test('retained photos obey the aggregate byte cap and expire without launching another transfer', async t => {
  let now = Date.parse('2026-11-06T10:00:00Z');
  const foregroundReceipt = deferred();
  let holdForeground = false;
  const f = fixture(t, { size: 8 * 1024 * 1024, timing: { now: () => now }, send: () => {
    if (holdForeground) return foregroundReceipt.promise;
    throw offlineBeforeSend();
  } });
  const ids = [];
  for (const frameId of [A, B]) {
    const { jobId } = await f.app.transfers.enqueueManual({ frameId, url: 'https://example.test/a.jpg', defer: true });
    ids.push(jobId);
    await waitUntil(() => f.app.transfers.runtime.get(jobId)?.retryAt != null);
  }
  const overflow = await f.app.transfers.enqueueManual({ frameId: C, url: 'https://example.test/a.jpg', defer: true });
  await assert.rejects(f.app.transfers.waitFor(overflow.jobId), { code: 'TRANSFER_INCOMPLETE' });
  assert.equal((await f.app.transfers.get(overflow.jobId)).job.results[0].code, 'TRANSFER_DEFERRED_LIMIT');
  assert.equal(f.calls.filter(([kind]) => kind === 'dispose').length, 1);
  holdForeground = true;
  const foreground = await f.app.transfers.enqueueManual({ frameId: C, url: 'https://example.test/a.jpg' });
  await waitUntil(() => f.calls.filter(([kind]) => kind === 'send').length === 4);
  now += 24 * 60 * 60 * 1000;
  f.app.transfers.resumeWaiting();
  await waitUntil(() => ids.every(id => !f.app.transfers.runtime.has(id)));
  for (const id of ids) assert.equal((await f.app.transfers.get(id)).job.results[0].code, 'TRANSFER_DEFERRED_EXPIRED');
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 4);
  assert.equal(f.calls.filter(([kind]) => kind === 'dispose').length, 3);
  foregroundReceipt.resolve({ confirmed: true, mediaId: '123' });
  await f.app.transfers.waitFor(foreground.jobId);
});

test('shutdown during the waiting journal write cancels the job and releases its photo', async t => {
  const atWrite = deferred(), unblock = deferred();
  const f = fixture(t, { send: () => { throw offlineBeforeSend(); }, onSave: async (key, value) => {
    if (key === JOURNAL_KEY && value.jobs[0]?.phase === 'waiting') {
      atWrite.resolve(); await unblock.promise;
    }
  } });
  const { jobId } = await f.app.transfers.enqueueManual({ frameId: A, url: 'https://example.test/a.jpg', defer: true });
  await atWrite.promise;
  const close = f.app.transfers.close();
  unblock.resolve(); await close;
  const result = (await f.app.transfers.get(jobId)).job.results[0];
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'TRANSFER_CANCELLED');
  assert.equal(f.calls.filter(([kind]) => kind === 'dispose').length, 1);
  assert.equal(f.app.transfers.runtime.size, 0);
});

test('restart marks only waiting recipients as cancelled before transmission and never replays them', async t => {
  const f = fixture(t, { send: () => { throw offlineBeforeSend(); } });
  const { jobId } = await f.app.transfers.enqueueManual({ frameId: A, url: 'https://example.test/a.jpg', defer: true });
  await waitUntil(() => f.app.transfers.runtime.get(jobId)?.retryAt != null);
  const restarted = fixture(t, { saved: new Map(f.saved) });
  const result = (await restarted.app.transfers.get(jobId)).job.results[0];
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'TRANSFER_RESTART_QUEUED');
  assert.deepEqual(restarted.calls, []);
});

test('one group photo is prepared once, snapshots survive edits, and other receivers continue after a failure', async t => {
  const f = fixture(t, { send: async id => {
    if (id === B) throw Object.assign(new Error('private network detail'), { code: 'FRAME_UNAVAILABLE' });
    return { confirmed: true, mediaId: '9223372036854775807' };
  } });
  const group = (await f.app.groups.save({ name: 'Tous', frameIds: [A, B, C] })).group;
  const batch = await f.app.transfers.start({ groupId: group.id });
  await f.app.groups.save({ id: group.id, name: 'Modifié', frameIds: [C] });
  let streams = 0;
  const { jobId } = await f.app.transfers.enqueueFlow({ groupId: group.id }, 'image', { async getStream() { streams++; return {}; } });
  assert.equal((await f.app.transfers.waitFor(jobId)).status, 'succeeded', 'Flow group uses its own launch snapshot');
  const manual = await f.app.transfers.enqueueManual({ batchId: batch.batchId, url: 'https://private.invalid/photo?secret=never-saved', caption: 'never save caption' });
  await assert.rejects(f.app.transfers.waitFor(manual.jobId), error => {
    assert.equal(error.code, 'TRANSFER_INCOMPLETE'); assert(error.message.includes('Cuisine')); assert(error.message.includes('errors.frame_unavailable')); return true;
  });
  const job = (await f.app.transfers.get(manual.jobId)).job;
  assert.deepEqual(job.results.map(value => value.status), ['succeeded', 'failed', 'succeeded']);
  assert.deepEqual(job.summary, { total: 3, succeeded: 2, failed: 1, uncertain: 0 });
  assert.equal(job.initiator, 'manual'); assert.equal(job.targetName, 'Tous'); assert.equal(streams, 1);
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'dispose').length, 2);
  const serialized = JSON.stringify(f.saved.get(JOURNAL_KEY));
  assert(!serialized.includes('private.invalid') && !serialized.includes('caption') && !serialized.includes('network detail'));
  assert.equal(job.results[0].mediaId, '9223372036854775807');
  assert.equal(f.events.filter(value => value[0] === 'failed').length, 1, 'receiver failures notify once');
  assert.equal(f.events.filter(value => value[0] === 'received').length, 3);
});

test('preparation failure is failed rather than uncertain; lost send confirmation is uncertain', async t => {
  const invalid = fixture(t, { prepare: () => { throw Object.assign(new Error('secret URL'), { code: 'URL_INVALID' }); } });
  const first = await invalid.app.transfers.enqueueManual({ frameId: A, url: 'invalid address', caption: 'private' });
  await assert.rejects(invalid.app.transfers.waitFor(first.jobId), { code: 'TRANSFER_INCOMPLETE' });
  assert.equal((await invalid.app.transfers.get(first.jobId)).job.results[0].status, 'failed');
  assert.equal(invalid.calls.filter(call => call[0] === 'send').length, 0);
  assert.deepEqual(invalid.events, [['failed', A, { reason: 'errors.url_invalid' }]], 'source failure preserves its failure Flow without leaking the source');
  const lost = fixture(t, { send: () => { throw Object.assign(new Error('private trace'), { code: 'SEND_UNVERIFIED' }); } });
  const second = await lost.app.transfers.enqueueManual({ frameId: A, url: 'https://private.invalid/a.jpg' });
  await assert.rejects(lost.app.transfers.waitFor(second.jobId), { code: 'TRANSFER_INCOMPLETE' });
  const result = (await lost.app.transfers.get(second.jobId)).job.results[0];
  assert.equal(result.status, 'uncertain'); assert.equal(result.code, 'SEND_UNVERIFIED');
  assert.equal(result.reason, 'errors.send_uncertain');
});

test('Flow deadline rejects explicitly while the job stays running and can confirm later', async t => {
  const receipt = deferred(); const f = fixture(t, { send: () => receipt.promise });
  const { jobId } = await f.app.transfers.enqueueFlow({ frameId: A }, 'url', 'https://private.invalid/a.jpg');
  await assert.rejects(f.app.transfers.waitFor(jobId, { timeoutMs: 5 }), error => {
    assert.equal(error.code, 'TRANSFER_STILL_RUNNING'); assert.equal(error.jobId, jobId); assert(error.message.includes(jobId.slice(0, 8))); return true;
  });
  assert.equal((await f.app.transfers.get(jobId)).job.status, 'running');
  receipt.resolve({ confirmed: true, mediaId: '123' });
  assert.equal((await f.app.transfers.waitFor(jobId)).status, 'succeeded');
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1);
});

test('a consumer Flow cannot delay or overturn an acknowledged receipt', async t => {
  const f = fixture(t, { trigger: () => new Promise(() => {}) });
  const { jobId } = await f.app.transfers.enqueueManual({ frameId: A, url: 'https://private.invalid/a.jpg' });
  assert.equal((await f.app.transfers.waitFor(jobId)).status, 'succeeded');
});

test('restart recovers queued as failed and only in-flight receiver states as uncertain without replay', async t => {
  const saved = new Map([[JOURNAL_KEY, { version: 1, jobs: [{ id: randomUUID(), createdAt: '2026-01-01T00:00:00Z',
    initiator: 'manual', source: 'image', targetName: 'Tous', results: [
      { frameId: A, name: 'Salon', status: 'succeeded', mediaId: '9223372036854775807' },
      { frameId: B, name: 'Cuisine', status: 'running' }, { frameId: C, name: 'Bureau', status: 'queued' },
    ], private_key: 'must disappear', data: 'must disappear' }] }]]);
  const f = fixture(t, { saved }); await f.app.transfers.ready;
  const job = (await f.app.transfers.history()).jobs[0];
  assert.deepEqual(job.results.map(value => value.status), ['succeeded', 'uncertain', 'failed']);
  assert.equal(job.results[1].code, 'TRANSFER_RESTART_RUNNING'); assert.equal(job.results[2].code, 'TRANSFER_RESTART_QUEUED');
  assert.equal(job.status, 'partial'); assert.equal(f.app.transfers.runtime.size, 0); assert.deepEqual(f.calls, []);
  assert(!JSON.stringify(saved.get(JOURNAL_KEY)).includes('must disappear'));
});

test('source memory admission is aggregated and shutdown settles active and queued jobs without replay', async t => {
  const preparing = deferred(); const f = fixture(t, { prepare: () => preparing.promise });
  const data = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4);
  const first = await f.app.transfers.enqueueManual({ frameId: A, data, mime: 'image/jpeg' });
  await assert.rejects(f.app.transfers.enqueueManual({ frameId: B, data, mime: 'image/jpeg' }), { code: 'QUEUE_FULL' });
  assert(f.app.transfers.sourceMemory <= 20 * 1024 * 1024);
  const second = await f.app.transfers.enqueueManual({ frameId: B, url: 'https://private.invalid/b.jpg' });
  preparing.resolve(); await tick();
  await f.app.transfers.close();
  assert.equal(f.app.transfers.sourceMemory, 0);
  for (const jobId of [first.jobId, second.jobId]) assert(!['queued', 'running'].includes((await f.app.transfers.get(jobId)).job.status));
});

test('journal bounds history and does not clear active jobs or turn storage failure into a send', async t => {
  const f = fixture(t); await f.app.transfers.ready;
  const journal = new TransferJournal(f.app); await journal.ready;
  for (let i = 0; i < 55; i++) await journal.create({ id: randomUUID(), createdAt: new Date().toISOString(), status: 'succeeded',
    source: 'url', initiator: 'manual', targetName: 'Salon', results: [{ frameId: A, name: 'Salon', status: 'succeeded' }] });
  assert.equal((await journal.history()).jobs.length, 50);
  assert(Buffer.byteLength(JSON.stringify(f.saved.get(JOURNAL_KEY))) <= 512 * 1024);
  const denied = fixture(t, { onSave: key => { if (key === JOURNAL_KEY) throw Error('private storage error'); } });
  await assert.rejects(denied.app.transfers.enqueueManual({ frameId: A, url: 'https://private.invalid/a.jpg' }), { code: 'TRANSFER_JOURNAL_FAILED' });
  assert.deepEqual(denied.calls, []); assert.equal(denied.app.transfers.sourceMemory, 0);
});
