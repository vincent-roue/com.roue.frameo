'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameoRefreshScheduler, normalizeSettings, deterministicJitter } = require('../lib/frameo-refresh-scheduler');

const MINUTE = 60000;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Clock {
  constructor() { this.time = 0; this.nextId = 0; this.tasks = new Map(); this.cleared = []; }
  setTimeout(callback, delay) {
    const id = ++this.nextId;
    this.tasks.set(id, { id, callback, at: this.time + delay });
    return id;
  }
  clearTimeout(id) { this.cleared.push(id); this.tasks.delete(id); }
  async tick(ms) {
    const end = this.time + ms;
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < 20000, 'No timer catch-up loop');
      const next = [...this.tasks.values()].filter(task => task.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.tasks.delete(next.id); this.time = next.at; next.callback(); await flush();
    }
    this.time = end; await flush();
  }
}

function fixture({ clock = new Clock(), app, key = 'a'.repeat(64), refresh = async () => {}, jitter = () => 0, isBusy, homeyTimers = false } = {}) {
  app ||= {};
  const homey = { app };
  if (homeyTimers) {
    homey.setTimeout = function (callback, delay) { assert.equal(this, homey); return clock.setTimeout(callback, delay); };
    homey.clearTimeout = function (id) { assert.equal(this, homey); clock.clearTimeout(id); };
  }
  const device = { homey, getData: () => ({ id: key }), stopped: false, operation: null };
  const options = { refresh, isBusy, now: () => clock.time, jitter };
  if (!homeyTimers) options.timers = clock;
  const scheduler = new FrameoRefreshScheduler(device, options);
  return { clock, app, homey, device, scheduler };
}

test('defaults wait a whole thirty minutes and jitter before the first read', async t => {
  const calls = [];
  const { scheduler, clock } = fixture({ refresh: async options => calls.push(options), jitter: () => 15000 });
  t.after(() => scheduler.close());
  assert.equal(scheduler.stats().intervalMinutes, 30);
  assert.equal(scheduler.stats().enabled, true);
  assert.equal(scheduler.stats().nextRunAt, 30 * MINUTE + 15000);
  await clock.tick(30 * MINUTE + 14999); assert.equal(calls.length, 0);
  await clock.tick(1); assert.equal(calls.length, 1);
  assert.equal(calls[0].initial, false); assert.equal(calls[0].signal.aborted, false);
  assert.equal(scheduler.stats().nextRunAt, clock.time + 30 * MINUTE + 15000);
});

test('normalization bounds minutes without interpreting zero as disabled', () => {
  assert.deepEqual(normalizeSettings(), { enabled: true, intervalMinutes: 30 });
  assert.deepEqual(normalizeSettings(null), { enabled: true, intervalMinutes: 30 });
  for (const value of [0, -100, 0.2]) assert.equal(normalizeSettings({ intervalMinutes: value }).intervalMinutes, 1);
  assert.equal(normalizeSettings({ intervalMinutes: 3.9 }).intervalMinutes, 3);
  assert.equal(normalizeSettings({ intervalMinutes: 9999 }).intervalMinutes, 1440);
  for (const value of [NaN, Infinity, '12']) assert.equal(normalizeSettings({ intervalMinutes: value }).intervalMinutes, 30);
  assert.equal(normalizeSettings({ enabled: false }).enabled, false);
});

test('jitter is deterministic, bounded and changes over scheduling cycles', () => {
  const offsets = Array.from({ length: 64 }, (_, cycle) => deterministicJitter('frame-public-id', cycle));
  assert.deepEqual(offsets, Array.from({ length: 64 }, (_, cycle) => deterministicJitter('frame-public-id', cycle)));
  assert.ok(offsets.every(value => Number.isInteger(value) && value >= 0 && value <= 30000));
  assert.ok(new Set(offsets).size > 1);
});

test('live configuration resets changed intervals but repeated identical settings do not postpone a read', async t => {
  let calls = 0;
  const { scheduler, clock } = fixture({ refresh: async () => { calls++; }, homeyTimers: true });
  t.after(() => scheduler.close());
  await clock.tick(1000); scheduler.configure({ enabled: true, intervalMinutes: 2 });
  assert.equal(clock.tasks.size, 1); assert.equal(scheduler.stats().nextRunAt, 121000);
  await clock.tick(30000); scheduler.configure({ enabled: true, intervalMinutes: 2 });
  assert.equal(scheduler.stats().nextRunAt, 121000);
  await clock.tick(90000); assert.equal(calls, 1);
  scheduler.configure({ enabled: false, intervalMinutes: 2 });
  assert.equal(clock.tasks.size, 0);
  await clock.tick(10 * MINUTE); assert.equal(calls, 1);
  scheduler.configure({ enabled: true, intervalMinutes: 1 });
  await clock.tick(MINUTE); assert.equal(calls, 2);
  assert.ok(clock.cleared.length > 0);
});

test('a slow read cannot overlap or accumulate a catch-up queue', async t => {
  const pending = deferred(); let calls = 0;
  const { scheduler, clock } = fixture({ refresh: async () => { calls++; await pending.promise; } });
  t.after(() => scheduler.close()); scheduler.configure({ enabled: true, intervalMinutes: 1 });
  await clock.tick(MINUTE); assert.equal(calls, 1); assert.equal(scheduler.stats().running, true);
  await clock.tick(30 * MINUTE); assert.equal(calls, 1); assert.equal(clock.tasks.size, 0);
  scheduler.configure({ enabled: true, intervalMinutes: 2 });
  assert.equal(clock.tasks.size, 0);
  pending.resolve(); await flush();
  assert.equal(scheduler.stats().nextRunAt, clock.time + 2 * MINUTE);
  await clock.tick(2 * MINUTE); assert.equal(calls, 2);
});

test('sixty-four missing inventories admit one background operation without filling an RPC queue', async t => {
  const app = {}, clock = new Clock(), pending = deferred(), schedulers = [], calls = [];
  for (let index = 0; index < 64; index++) {
    const { scheduler } = fixture({ app, clock, key: String(index), refresh: async ({ initial }) => { calls.push({ index, initial }); await pending.promise; } });
    schedulers.push(scheduler); assert.equal(scheduler.requestInitial(), true);
  }
  t.after(() => schedulers.forEach(scheduler => scheduler.close()));
  await clock.tick(0);
  assert.equal(calls.length, 1); assert.equal(calls[0].initial, true);
  assert.equal(schedulers.filter(scheduler => scheduler.stats().running).length, 1);
  assert.equal(schedulers.reduce((sum, scheduler) => sum + scheduler.stats().skippedBusy, 0), 63);
  await clock.tick(MINUTE); assert.equal(calls.length, 1);
  pending.resolve(); await flush();
  assert.equal(schedulers.filter(scheduler => scheduler.stats().running).length, 0);
  await clock.tick(MINUTE);
  assert.equal(calls.length, 64);
});

test('send, permission, mutation and foreground flags defer locally for one minute plus jitter', async t => {
  for (const kind of ['send', 'queued', 'permission', 'delete', 'own-refresh', 'other-refresh', 'extra']) {
    let calls = 0, extra = kind === 'extra';
    const fx = fixture({ jitter: () => 1234, refresh: async () => { calls++; }, isBusy: () => extra });
    const { app, device, scheduler, clock } = fx; t.after(() => scheduler.close());
    if (kind === 'send') app.activeTransfer = true;
    if (kind === 'queued') app.transferQueue = [{}];
    if (kind === 'permission') app.permissionTask = Promise.resolve();
    if (kind === 'delete') app.gallery = { deleting: new Set(['x']) };
    if (kind === 'own-refresh') device.operation = { kind: 'refresh' };
    if (kind === 'other-refresh') app.getDevices = () => [device, { operation: { kind: 'refresh' } }];
    scheduler.requestInitial(); await clock.tick(1234);
    assert.equal(calls, 0, kind); assert.equal(scheduler.stats().skippedBusy, 1, kind);
    assert.equal(scheduler.stats().nextRunAt, clock.time + MINUTE + 1234, kind);
    app.activeTransfer = false; app.transferQueue = []; app.permissionTask = null; app.gallery = null;
    device.operation = null; app.getDevices = () => [device]; extra = false;
    await clock.tick(MINUTE + 1234); assert.equal(calls, 1, kind);
    scheduler.close();
  }
});

test('real errors wait a complete configured interval and expose only an allowlisted code', async t => {
  let calls = 0;
  const { scheduler, clock } = fixture({ refresh: async () => { calls++; throw Object.assign(new Error('private path/photo/name'), { code: 'SECRET_NATIVE_DETAIL' }); } });
  t.after(() => scheduler.close()); scheduler.configure({ enabled: true, intervalMinutes: 30 });
  scheduler.requestInitial(); await clock.tick(0);
  assert.equal(calls, 1); assert.equal(scheduler.stats().failed, 1); assert.equal(scheduler.stats().lastErrorCode, 'REFRESH_FAILED');
  assert.equal(scheduler.stats().nextRunAt, 30 * MINUTE);
  assert.equal(JSON.stringify(scheduler.stats()).includes('private'), false);
  await clock.tick(MINUTE); assert.equal(calls, 1);
  await clock.tick(29 * MINUTE); assert.equal(calls, 2);
});

test('late busy admission retains an initial inventory request, while a real failure consumes it', async t => {
  const calls = [];
  const { scheduler, clock } = fixture({ refresh: async ({ initial }) => {
    calls.push(initial);
    if (calls.length === 1) throw Object.assign(new Error(), { code: 'BUSY' });
    if (calls.length === 2) throw Object.assign(new Error(), { code: 'TIMEOUT' });
  } });
  t.after(() => scheduler.close()); scheduler.requestInitial();
  assert.equal(scheduler.requestInitial(), false);
  await clock.tick(0); assert.deepEqual(calls, [true]);
  await clock.tick(MINUTE); assert.deepEqual(calls, [true, true]);
  assert.equal(scheduler.stats().nextRunAt, 31 * MINUTE);
  await clock.tick(30 * MINUTE); assert.deepEqual(calls, [true, true, false]);
  assert.equal(scheduler.stats().lastErrorCode, null);
});

test('initial inventory is opt-in, disabled safely and followed by the configured interval', async t => {
  const calls = [];
  const { scheduler, clock } = fixture({ jitter: () => 30000, refresh: async options => calls.push(options.initial) });
  t.after(() => scheduler.close());
  scheduler.configure({ enabled: false, intervalMinutes: 7 });
  assert.equal(scheduler.requestInitial(), false); assert.equal(clock.tasks.size, 0);
  scheduler.configure({ enabled: true, intervalMinutes: 7 });
  assert.equal(scheduler.requestInitial(), true);
  await clock.tick(29999); assert.equal(calls.length, 0);
  await clock.tick(1); assert.deepEqual(calls, [true]);
  assert.equal(scheduler.stats().nextRunAt, clock.time + 7 * MINUTE + 30000);
  await clock.tick(7 * MINUTE + 30000); assert.deepEqual(calls, [true, false]);
});

test('disable aborts a running operation and re-enable does not overlap its late settlement', async t => {
  const pending = deferred(); const calls = [];
  const { scheduler, clock } = fixture({ refresh: async options => { calls.push(options); await pending.promise; } });
  t.after(() => scheduler.close()); scheduler.requestInitial(); await clock.tick(0);
  scheduler.configure({ enabled: false, intervalMinutes: 1 });
  assert.equal(calls[0].signal.aborted, true);
  scheduler.configure({ enabled: true, intervalMinutes: 1 });
  assert.equal(clock.tasks.size, 0);
  await clock.tick(10 * MINUTE); assert.equal(calls.length, 1);
  pending.resolve(); await flush();
  assert.equal(scheduler.stats().completed, 0); assert.equal(scheduler.stats().failed, 0);
  assert.equal(scheduler.stats().nextRunAt, clock.time + MINUTE);
  await clock.tick(MINUTE); assert.equal(calls.length, 2);
});

test('close cancels stale timers, aborts active work and keeps its admission slot until settlement', async t => {
  const app = {}, clock = new Clock(), pending = deferred(); let firstCalls = 0, otherCalls = 0;
  const first = fixture({ app, clock, refresh: async ({ signal }) => { firstCalls++; assert.equal(signal.aborted, false); await pending.promise; assert.equal(signal.aborted, true); } });
  const staleCallback = [...clock.tasks.values()][0].callback;
  first.scheduler.requestInitial(); await clock.tick(0); first.scheduler.close();
  staleCallback(); await flush(); assert.equal(firstCalls, 1); assert.equal(first.scheduler.stats().scheduled, false);
  const other = fixture({ app, clock, refresh: async () => { otherCalls++; } });
  t.after(() => other.scheduler.close()); other.scheduler.requestInitial(); await clock.tick(0);
  assert.equal(otherCalls, 0);
  pending.resolve(); await flush(); assert.equal(first.scheduler.stats().completed, 0);
  await clock.tick(MINUTE); assert.equal(otherCalls, 1);
  first.scheduler.configure({ enabled: true, intervalMinutes: 1 }); assert.equal(first.scheduler.requestInitial(), false);
});

test('device deletion and app shutdown prevent all subsequent reads and clear fired timer state', async () => {
  for (const kind of ['deleted', 'shutdown']) {
    let calls = 0;
    const { scheduler, device, app, clock } = fixture({ refresh: async () => { calls++; } });
    if (kind === 'deleted') device.stopped = true; else app.stopping = true;
    await clock.tick(60 * MINUTE);
    assert.equal(calls, 0, kind); assert.equal(clock.tasks.size, 0, kind);
    assert.equal(scheduler.stats().scheduled, false, kind); assert.equal(scheduler.stats().nextRunAt, null, kind);
    scheduler.close();
  }
});

test('an unreadable busy flag fails closed without a network call', async t => {
  let calls = 0;
  const { scheduler, clock, app } = fixture({ refresh: async () => { calls++; } });
  t.after(() => scheduler.close()); app.getDevices = () => { throw new Error('driver loading'); };
  scheduler.requestInitial(); await clock.tick(0);
  assert.equal(calls, 0); assert.equal(scheduler.stats().skippedBusy, 1);
  assert.equal(scheduler.stats().nextRunAt, MINUTE);
});


test('a successful manual inventory completes the initial request and restores a full interval', async t => {
  let calls = 0;
  const { scheduler, clock } = fixture({ jitter: () => 10000, refresh: async () => { calls++; } });
  t.after(() => scheduler.close());
  scheduler.requestInitial();
  const staleInitialCallback = [...clock.tasks.values()][0].callback;
  await clock.tick(5000);
  assert.equal(scheduler.completeInitial(), true);
  const nextRunAt = clock.time + 30 * MINUTE + 10000;
  assert.equal(scheduler.stats().nextRunAt, nextRunAt);
  assert.equal(scheduler.completeInitial(), false);
  assert.equal(scheduler.stats().nextRunAt, nextRunAt);
  staleInitialCallback(); await flush(); assert.equal(calls, 0);
  await clock.tick(30 * MINUTE + 9999); assert.equal(calls, 0);
  await clock.tick(1); assert.equal(calls, 1);
  scheduler.configure({ enabled: false, intervalMinutes: 30 });
  assert.equal(scheduler.completeInitial(), false); assert.equal(clock.tasks.size, 0);
  scheduler.close(); assert.equal(scheduler.completeInitial(), false);
});
