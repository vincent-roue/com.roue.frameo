'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameoMediaMonitor, STORE_KEY, MAX_STORE_BYTES, MAX_ADDED } = require('../lib/frameo-media-monitor');
const PEER = 'ab'.repeat(32), RECEIVED = '2026-11-04T13:00:00.000Z';
const item = (mediaId, type = 'photo', extra = {}) => ({ mediaId, type, visible: true, receiveDate: RECEIVED, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const saved = new Map(), calls = [], writes = [];
  const settings = { sender_name: 'Mon Homey personnel', photo_access_mode: 'manage' };
  const state = { items: options.items || [item('1')], mayView: true };
  const app = { stopping: false, activeTransfer: false, transferQueue: [], permissionTask: null,
    engine: { async listMedia(peer, details) {
      calls.push(['list', peer, details]); if (options.list) await options.list(details); return structuredClone(state.items);
    }, async getMedia() { assert.fail('No image download'); }, async previewMedia() { assert.fail('No image download'); },
    async sendImage() { assert.fail('No send'); }, async permission() { assert.fail('No permission request'); } },
  };
  const device = { stopped: false, operation: null, lastInfo: { mayView: true }, peer: () => PEER,
    getSetting: key => settings[key], accessMode: () => settings.photo_access_mode,
    getStoreValue: key => saved.get(key), async setStoreValue(key, value) {
      if (options.onSave) await options.onSave(value); saved.set(key, structuredClone(value)); writes.push(structuredClone(value));
    }, async refreshInfo() {
      calls.push(['info']); this.operation = { kind: 'refresh' };
      try { if (options.info) await options.info(); this.lastInfo = { mayView: state.mayView }; }
      finally { this.operation = null; }
      return this.lastInfo;
    } };
  app.getDevices = () => [device];
  const monitor = new FrameoMediaMonitor(app, { now: () => Date.parse('2026-11-04T14:00:00.000Z') });
  t.after(() => monitor.close());
  return { app, device, monitor, settings, state, saved, calls, writes };
}

test('first baseline is silent and counts all photo/video/greeting/unknown metadata including hidden media', async t => {
  const f = fixture(t, { items: [item('-9223372036854775808'), item('9223372036854775807', 'video', { visible: false }),
    item('3', 'greeting'), item('4', 'new enum', { data: 'SECRET_PIXELS', private_key: 'SECRET_KEY' })] });
  const result = await f.monitor.check(f.device);
  assert.deepEqual(result.counts, { photos: 1, videos: 1, greetings: 1, unknown: 1, total: 4, visible: 3, hidden: 1, visibilityUnknown: 0 });
  assert.equal(result.baseline, true); assert.deepEqual(result.added, []); assert.equal(result.addedCount, 0);
  assert.deepEqual(f.calls.map(value => value[0]), ['info', 'list']); assert.equal(f.calls[1][2].name, f.settings.sender_name);
  const stored = f.saved.get(STORE_KEY);
  assert.deepEqual(stored.ids, ['-9223372036854775808', '9223372036854775807', '3', '4']);
  assert(!JSON.stringify(stored).includes('SECRET')); assert(!JSON.stringify(stored).includes(f.settings.sender_name));
  assert(!JSON.stringify(result).includes('SECRET')); assert.equal(stored.checkedAt, result.checkedAt);
});

test('new IDs preserve signed int64 strings and types while hiding, date changes and removals are not new media', async t => {
  const f = fixture(t); await f.monitor.check(f.device);
  f.state.items = [item('1', 'photo', { visible: false, receiveDate: null }),
    item('9223372036854775807', 'video'), item('-9223372036854775808', 'greeting', { receiveDate: 'invalid' })];
  const result = await f.monitor.check(f.device);
  assert.equal(result.baseline, false); assert.deepEqual(result.added, [
    { mediaId: '9223372036854775807', type: 'video', receiveDate: RECEIVED },
    { mediaId: '-9223372036854775808', type: 'greeting', receiveDate: null },
  ]);
  f.state.items = [item('9223372036854775807', 'video', { visible: false, receiveDate: null })];
  assert.equal((await f.monitor.check(f.device)).addedCount, 0);
});

test('restart restores validated last counts and diffs the persisted baseline without inventing a new first reception', async t => {
  const f = fixture(t); await f.monitor.check(f.device);
  const restored = new FrameoMediaMonitor(f.app); t.after(() => restored.close());
  assert.deepEqual(await restored.restore(f.device), { checkedAt: '2026-11-04T14:00:00.000Z',
    counts: { photos: 1, videos: 0, greetings: 0, unknown: 0, total: 1, visible: 1, hidden: 0, visibilityUnknown: 0 }, latestReceivedAt: RECEIVED, restored: true });
  f.state.items.push(item('2', 'video')); const result = await restored.check(f.device);
  assert.equal(result.baseline, false); assert.equal(result.added[0].mediaId, '2');
  assert.equal((await restored.check(f.device)).addedCount, 0);
  f.saved.get(STORE_KEY).counts.total = 99; assert.equal(await restored.restore(f.device), null);
});

test('revoked rights clear the baseline and restored rights or changed sender start silently', async t => {
  const f = fixture(t); await f.monitor.check(f.device); f.state.mayView = false;
  const before = f.calls.length; await assert.rejects(f.monitor.check(f.device), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(f.calls.slice(before).map(value => value[0]), ['info']); assert.equal(f.saved.get(STORE_KEY), null);
  assert.equal(await f.monitor.restore(f.device), null);
  f.state.mayView = true; f.state.items.push(item('2'));
  assert.equal((await f.monitor.check(f.device)).baseline, true);
  f.settings.sender_name = 'Autre expéditeur'; assert.equal(await f.monitor.restore(f.device), null);
  assert.deepEqual((await f.monitor.check(f.device)).added, []);
  f.settings.photo_access_mode = 'send'; const count = f.calls.length;
  await assert.rejects(f.monitor.check(f.device), { code: 'ACCESS_MODE_SEND' });
  assert.equal(f.calls.length, count); assert.equal(f.saved.get(STORE_KEY), null);
});

test('only successful persisted scans advance detection; storage failure returns no potentially duplicated event', async t => {
  let deny = false;
  const f = fixture(t, { onSave: () => { if (deny) throw Error('private filesystem path'); } });
  await f.monitor.check(f.device); f.state.items.push(item('2')); deny = true;
  await assert.rejects(f.monitor.check(f.device), error => { assert.equal(error.code, 'MEDIA_MONITOR_STORE_FAILED'); assert(!error.message.includes('private')); return true; });
  assert.deepEqual(f.saved.get(STORE_KEY).ids, ['1']); deny = false;
  assert.equal((await f.monitor.check(f.device)).added[0].mediaId, '2');
  assert.equal((await f.monitor.check(f.device)).addedCount, 0);
});

test('simultaneous checks coalesce even while their own fresh information check holds the device operation lock', async t => {
  const info = deferred(); const f = fixture(t, { info: () => info.promise });
  const first = f.monitor.check(f.device); await tick(); const second = f.monitor.check(f.device);
  assert.equal(first, second); info.resolve(); await Promise.all([first, second]);
  assert.deepEqual(f.calls.map(value => value[0]), ['info', 'list']); assert.equal(f.writes.length, 1);
});

test('busy transfers block scans and an internal already-fresh info path makes only a metadata list request', async t => {
  const f = fixture(t); f.app.activeTransfer = true;
  await assert.rejects(f.monitor.check(f.device), { code: 'BUSY' }); assert.deepEqual(f.calls, []);
  f.app.activeTransfer = false; const result = await f.monitor.check(f.device, { refreshInfo: false });
  assert.equal(result.counts.total, 1); assert.deepEqual(f.calls.map(value => value[0]), ['list']);
});

test('invalidation or shutdown fences a late uncancellable list without persisting or returning detections', async t => {
  for (const action of ['invalidate', 'close']) {
    const list = deferred(); const f = fixture(t, { list: () => list.promise });
    const check = f.monitor.check(f.device); await tick();
    await f.monitor[action](f.device); await assert.rejects(check, { code: 'ABORTED' });
    list.resolve(); await tick();
    assert(!f.saved.get(STORE_KEY)); assert.equal(f.writes.filter(value => value !== null).length, 0);
  }
});

test('invalidation during a store write is serialized after it and suppresses its late event result', async t => {
  const write = deferred(), entered = deferred(); let hold = false;
  const f = fixture(t, { onSave: value => { if (hold && value) { entered.resolve(); return write.promise; } } });
  await f.monitor.check(f.device); f.state.items.push(item('2')); hold = true;
  const check = f.monitor.check(f.device); await entered.promise;
  const invalidated = f.monitor.invalidate(f.device); write.resolve();
  await assert.rejects(check, { code: 'ABORTED' }); await invalidated;
  assert.equal(f.saved.get(STORE_KEY), null);
});

test('large additions report the full count but cap events and never replay the omitted remainder next time', async t => {
  const f = fixture(t, { items: [] }); await f.monitor.check(f.device);
  f.state.items = Array.from({ length: MAX_ADDED + 7 }, (_, n) => item(String(n), n % 2 ? 'video' : 'photo'));
  const result = await f.monitor.check(f.device);
  assert.equal(result.added.length, MAX_ADDED); assert.equal(result.addedCount, MAX_ADDED + 7); assert.equal(result.eventsSuppressed, true);
  const following = await f.monitor.check(f.device); assert.equal(following.addedCount, 0); assert.equal(following.eventsSuppressed, false);
});

test('ten thousand exact IDs fit the bounded private baseline; malformed or oversize lists cannot replace it', async t => {
  const f = fixture(t, { items: Array.from({ length: 10000 }, (_, n) => item(String(-9223372036854775808n + BigInt(n)))) });
  assert.equal((await f.monitor.check(f.device)).counts.photos, 10000);
  assert(Buffer.byteLength(JSON.stringify(f.saved.get(STORE_KEY))) <= MAX_STORE_BYTES);
  const previous = JSON.stringify(f.saved.get(STORE_KEY));
  for (const items of [[item('1'), item('1')], [item(9223372036854775807)], [item('9223372036854775808')], Array(10001).fill(item('1'))]) {
    f.state.items = items; await assert.rejects(f.monitor.check(f.device));
    assert.equal(JSON.stringify(f.saved.get(STORE_KEY)), previous);
  }
});

test('visibility counts require actual booleans and include all current media types', async t => {
  const f = fixture(t, { items: [item('1'), item('2', 'video', { visible: false }), item('3', 'greeting', { visible: undefined }),
    item('4', 'unknown', { visible: null }), item('5', 'photo', { visible: 'false' }), item('6', 'photo', { visible: 0 })] });
  const result = await f.monitor.check(f.device);
  assert.equal(result.counts.visible, 1); assert.equal(result.counts.hidden, 1); assert.equal(result.counts.visibilityUnknown, 4);
  assert.equal(result.counts.visible + result.counts.hidden + result.counts.visibilityUnknown, result.counts.total);
  const saved = f.saved.get(STORE_KEY), restored = await f.monitor.restore(f.device);
  assert.deepEqual(restored.counts, result.counts); assert.deepEqual(saved.counts, result.counts);
  assert.deepEqual(f.calls.map(value => value[0]), ['info', 'list']);
});

test('latest received date uses reception rather than capture across visible, hidden and unknown current media', async t => {
  const f = fixture(t, { items: [
    item('1', 'photo', { receiveDate: '2026-11-01T10:00:00Z', captureDate: '2035-01-01T00:00:00Z' }),
    item('2', 'video', { visible: false, receiveDate: '2026-11-03T10:00:00Z' }),
    item('3', 'unknown', { visible: undefined, receiveDate: '2026-11-04T13:59:00.123Z' }),
    item('4', 'greeting', { receiveDate: null, captureDate: '2036-01-01T00:00:00Z' }),
  ] });
  const result = await f.monitor.check(f.device);
  assert.equal(result.latestReceivedAt, '2026-11-04T13:59:00.123Z');
  assert.equal(f.saved.get(STORE_KEY).latestReceivedAt, result.latestReceivedAt);
  assert.equal((await f.monitor.restore(f.device)).latestReceivedAt, result.latestReceivedAt);
  f.state.items = f.state.items.filter(value => value.mediaId !== '3');
  assert.equal((await f.monitor.check(f.device)).latestReceivedAt, '2026-11-03T10:00:00.000Z', 'A deleted newest item must not remain the latest present medium');
  f.state.items = [item('4', 'greeting', { visible: false, receiveDate: '2026-11-04T13:58:00Z' })];
  assert.equal((await f.monitor.check(f.device)).latestReceivedAt, '2026-11-04T13:58:00.000Z', 'A hidden greeting is a received medium too');
});

test('empty or undated current media never substitute a detection or capture date', async t => {
  const f = fixture(t, { items: [] }); const empty = await f.monitor.check(f.device);
  assert.equal(empty.latestReceivedAt, null); assert.equal(empty.counts.visible, 0); assert.equal(empty.counts.hidden, 0); assert.equal(empty.counts.visibilityUnknown, 0);
  assert.equal((await f.monitor.restore(f.device)).latestReceivedAt, null);
  f.state.items = [item('1', 'photo', { receiveDate: undefined, captureDate: RECEIVED }), item('2', 'video', { receiveDate: 'invalid' }),
    item('3', 'greeting', { receiveDate: '2026-02-30T10:00:00Z' }), item('4', 'unknown', { receiveDate: '' })];
  const result = await f.monitor.check(f.device);
  assert.equal(result.latestReceivedAt, null); assert.notEqual(result.checkedAt, null);
  assert(result.added.every(value => value.receiveDate === null));
});

test('older version-one baselines restore unknown new summary fields and retain their existing-ID detection behavior', async t => {
  const f = fixture(t); await f.monitor.check(f.device);
  const legacy = f.saved.get(STORE_KEY); delete legacy.counts.visible; delete legacy.counts.hidden; delete legacy.counts.visibilityUnknown; delete legacy.latestReceivedAt;
  const restarted = new FrameoMediaMonitor(f.app); t.after(() => restarted.close());
  const restored = await restarted.restore(f.device);
  assert.equal(restored.counts.photos, 1); assert.equal(restored.counts.visible, null); assert.equal(restored.counts.hidden, null);
  assert.equal(restored.counts.visibilityUnknown, null); assert.equal(restored.latestReceivedAt, null);
  const checked = await restarted.check(f.device);
  assert.equal(checked.baseline, false); assert.deepEqual(checked.added, []); assert.equal(checked.counts.visible, 1); assert.equal(checked.latestReceivedAt, RECEIVED);
  f.state.items.push(item('2', 'video')); assert.equal((await restarted.check(f.device)).added[0].mediaId, '2');
});

test('malformed persisted visibility or receipt summaries stay unknown rather than inventing zero', async t => {
  const f = fixture(t); await f.monitor.check(f.device); const saved = f.saved.get(STORE_KEY), original = structuredClone(saved);
  for (const visibility of [{ visible: -1, hidden: 1, visibilityUnknown: 1 }, { visible: 1, hidden: 1, visibilityUnknown: 0 },
    { visible: true, hidden: 0, visibilityUnknown: 0 }, { visible: 1, hidden: 0 }]) {
    saved.counts = { ...original.counts }; delete saved.counts.visible; delete saved.counts.hidden; delete saved.counts.visibilityUnknown;
    Object.assign(saved.counts, visibility); saved.latestReceivedAt = 'not a date';
    const restored = await f.monitor.restore(f.device);
    assert.equal(restored.counts.photos, 1); assert.equal(restored.counts.visible, null); assert.equal(restored.counts.hidden, null);
    assert.equal(restored.counts.visibilityUnknown, null); assert.equal(restored.latestReceivedAt, null);
  }
});
