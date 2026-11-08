'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_DIRECTORY = path.resolve(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(APP_DIRECTORY, 'app.js'), 'utf8');
const PEER = 'ab'.repeat(32); // Synthetic public frame identifier, never a real identity.
const RECEIVED_AT = '2026-11-03T14:00:00.000Z';
const { EngineMetrics } = require('../lib/engine-metrics');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let tick = 0; tick < 50; tick++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('The simulated background operation did not settle');
}

function fixture({ probeError, onSend, onTrigger, packagedEngine = false } = {}) {
  const cards = new Map();
  const events = [];
  const sends = [];
  const engineCalls = [];
  const logs = [];
  const widgetListeners = new Map();

  class FakeEngine {
    async probe() {
      if (probeError) throw probeError;
      return { engine: 'simulated', protocolVersion: 1, goos: 'linux', goarch: 'arm64' };
    }
    async pair(code, options) {
      engineCalls.push({ operation: 'pair', code, options });
      return { peer: PEER, name: 'Family frame', width: 1920, height: 1080,
        protocolConfirmed: true, internalOnly: 'must not reach the pairing view' };
    }
    async permission() { assert.fail('App startup and pairing must not request additional frame permissions'); }
    async sendUrl() { assert.fail('Pairing must not call an engine send method'); }
    async sendImage() { assert.fail('Pairing must not call an engine send method'); }
    async prepareUrl(source) { return { kind: 'url', source }; }
    async prepareImage(source) { return { kind: 'image', source }; }
    async disposePrepared() {}
    close() { this.closed = true; }
  }

  function card(id) {
    if (!cards.has(id)) cards.set(id, {
      registerRunListener(listener) { this.run = listener; return this; },
      registerArgumentAutocompleteListener(argument, listener) { this.autocomplete = listener; return this; },
      async trigger(device, tokens) {
        events.push({ id, device, tokens });
        if (onTrigger) await onTrigger(id, tokens);
      },
    });
    return cards.get(id);
  }

  const loaded = { exports: {} };
  const localRequire = (name) => {
    if (name === 'homey') return { App: class {} };
    if (name === './lib/frameo-engine' && !packagedEngine) return { FrameoEngine: FakeEngine };
    if (name.startsWith('./')) return require(path.resolve(APP_DIRECTORY, name));
    return require(name);
  };
  // Load the actual app with fake SDK and engine dependencies. No network or native process runs.
  new Function('require', 'module', 'exports', '__dirname', APP_SOURCE)(
    localRequire, loaded, loaded.exports, APP_DIRECTORY,
  );
  const app = new loaded.exports();
  const device = {
    operation: null,
    getData: () => ({ id: PEER }),
    getName: () => 'Family frame',
    publicStatus: () => ({ id: PEER }),
    async refreshInfo() { return { width: 1920, height: 1080 }; },
    async sendUrl(source, options) {
      const send = { kind: 'url', source, options };
      sends.push(send);
      return onSend ? onSend(send) : { confirmed: true, at: RECEIVED_AT };
    },
    async sendImage(source, options) {
      const send = { kind: 'image', source, options };
      sends.push(send);
      return onSend ? onSend(send) : { confirmed: true, at: RECEIVED_AT };
    },
    async sendPrepared(handle, options) {
      const send = { kind: handle.kind, source: handle.source, options: { caption: options.caption, fit: options.fit } };
      sends.push(send);
      return onSend ? onSend(send) : { confirmed: true, at: RECEIVED_AT };
    },
  };
  app.log = (...args) => logs.push(args);
  app.homey = {
    __: (key) => key,
    settings: { get() { return null; }, async set() {} },
    manifest: { version: '0.1.0' },
    flow: { getActionCard: card, getConditionCard: card, getDeviceTriggerCard: card },
    drivers: { getDriver: () => ({ getDevices: () => [device] }) },
    dashboards: { getWidget(id) { return { registerSettingAutocompleteListener(setting, callback) { widgetListeners.set(id + ':' + setting, callback); } }; } },
  };
  return { app, device, cards, events, sends, engineCalls, logs, widgetListeners };
}

test('an unsupported runtime stays inspectable and rejects pairing with its own message', {
  skip: process.platform === 'linux' && process.arch === 'arm64',
}, async t => {
  const f = fixture({ packagedEngine: true });
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  const status = f.app.getPublicStatus();
  assert.equal(status.ready, false);
  assert.equal(status.error, 'UNSUPPORTED_RUNTIME');
  await assert.rejects(f.app.pairFrame('1234567890'), {
    code: 'UNSUPPORTED_RUNTIME', message: 'errors.unsupported_runtime',
  });
});

test('widget frame selector lists only known app devices without reading photos or requiring global device access', async t => {
  const f = fixture(); t.after(() => f.app.onUninit());
  await f.app.onInit();
  const suggest = f.widgetListeners.get('frameo:frame');
  assert.equal(typeof suggest, 'function');
  assert.equal(f.widgetListeners.size, 3);
  for (const id of ['frameo-compact', 'frameo-portrait']) {
    assert.deepEqual(await f.widgetListeners.get(id + ':frame')('family'), [{ id: PEER, name: 'Family frame' }]);
  }
  assert.deepEqual(await suggest('family'), [{ id: PEER, name: 'Family frame' }]);
  assert.deepEqual(await suggest('other'), []);
  assert.equal(f.engineCalls.length, 0);
  f.app.stopping = true;
  assert.deepEqual(await suggest(''), []);
});

test('pairing needs protocol confirmation only and returns public device data without sending an image', async (t) => {
  const f = fixture();
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  const candidate = await f.app.pairFrame('1234567890', 'Family');
  assert.deepEqual(f.engineCalls, [{ operation: 'pair', code: '1234567890', options: { name: 'Family' } }]);
  assert.deepEqual(candidate, {
    name: 'Family frame', data: { id: PEER }, store: { peer: PEER, access_mode_initialized: true },
    settings: { sender_name: 'Family', photo_access_mode: 'send' },
  });
  assert.equal(f.sends.length, 0);
  assert.equal(f.events.length, 0);
  assert.ok(!JSON.stringify(candidate).includes('internalOnly'));
});

test('manage onboarding stores only a local mode choice without requesting rights or sending a photo', async (t) => {
  const f = fixture();
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  const candidate = await f.app.pairFrame('1234567890', 'Homey salon', 'manage');
  assert.deepEqual(candidate.settings, { sender_name: 'Homey salon', photo_access_mode: 'manage' });
  assert.deepEqual(candidate.store, { peer: PEER, access_mode_initialized: true });
  assert.deepEqual(f.engineCalls, [{ operation: 'pair', code: '1234567890', options: { name: 'Homey salon' } }]);
  assert.equal(f.sends.length, 0);
  assert.equal(f.events.length, 0);
  assert(!Object.hasOwn(candidate, 'mayView') && !Object.hasOwn(candidate, 'mayManage'), 'A selected mode is not a frame authorization');
});

test('the Flow waits for receipt and emits one receipt event only after confirmation', async (t) => {
  const confirmation = deferred();
  const f = fixture({ onSend: () => confirmation.promise });
  t.after(() => { confirmation.resolve({ confirmed: true, at: RECEIVED_AT }); return f.app.onUninit(); });
  await f.app.onInit();
  const result = f.cards.get('send_photo_url').run({
    device: f.device, url: 'https://example.invalid/photo.jpg', caption: 'Hello', scale: 'fit',
  });
  let settled = false; void result.then(() => { settled = true; });
  await until(() => f.sends.length === 1);
  assert.equal(f.events.length, 0, 'accepting a request must not claim receipt');
  assert.equal(settled, false);
  assert.equal(f.app.getPublicStatus().pendingTransfers, 1);
  assert.deepEqual(f.sends[0].options, { caption: 'Hello', fit: true });
  confirmation.resolve({ confirmed: true, at: RECEIVED_AT });
  assert.equal(await result, true);
  await until(() => f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.events.map(({ id, tokens }) => ({ id, tokens })), [
    { id: 'photo_received', tokens: { received_at: RECEIVED_AT } },
  ]);
});

test('failed background transfers emit one failure without a receipt event or automatic retry', async (t) => {
  const f = fixture({ onSend: async () => { throw Object.assign(new Error('private upstream trace'), { code: 'FRAME_UNAVAILABLE' }); } });
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  await assert.rejects(f.cards.get('send_photo_url').run({ device: f.device, url: 'https://example.invalid/photo.jpg' }), { code: 'TRANSFER_INCOMPLETE' });
  await until(() => f.events.length === 1 && f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.events.map(({ id, tokens }) => ({ id, tokens })), [
    { id: 'photo_failed', tokens: { reason: 'errors.frame_unavailable' } },
  ]);
});

test('only eight outstanding requests are admitted and accepted photos are sent once, one at a time', async (t) => {
  const firstReceipt = deferred();
  let active = 0;
  let maximumActive = 0;
  const f = fixture({ onSend: async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (f.sends.length === 1) await firstReceipt.promise;
      return { confirmed: true, at: RECEIVED_AT };
    } finally { active--; }
  } });
  t.after(() => { firstReceipt.resolve(); return f.app.onUninit(); });
  await f.app.onInit();
  const pending = Array.from({ length: 8 }, (_, index) => f.app.queueTransfer(f.device, 'url', `https://example.invalid/photo-${index}.jpg`));
  await until(() => f.app.getPublicStatus().pendingTransfers === 8);
  await assert.rejects(f.app.queueTransfer(f.device, 'url', 'https://example.invalid/rejected.jpg'), { code: 'QUEUE_FULL' });
  assert.equal(f.app.getPublicStatus().pendingTransfers, 8);
  firstReceipt.resolve();
  await Promise.all(pending);
  await until(() => f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(maximumActive, 1);
  assert.deepEqual(f.sends.map((send) => send.source), Array.from({ length: 8 }, (_, index) => `https://example.invalid/photo-${index}.jpg`));
  assert.equal(f.events.filter((event) => event.id === 'photo_received').length, 8);
  assert.equal(f.events.filter((event) => event.id === 'photo_failed').length, 0);
});

test('startup failure rejects pairing and admission without sending, and transfer failures remain observable', async (t) => {
  const f = fixture({ probeError: Object.assign(new Error('internal diagnostic'), { code: 'ENGINE_NOT_READY' }) });
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  await assert.rejects(f.app.pairFrame('1234567890'), { code: 'ENGINE_NOT_READY' });
  await assert.rejects(f.cards.get('send_photo_url').run({ device: f.device, url: 'https://example.invalid/photo.jpg' }), { code: 'ENGINE_NOT_READY' });
  assert.equal(f.engineCalls.length, 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.app.getPublicStatus().pendingTransfers, 0);
  assert.equal(f.app.getPublicStatus().ready, false);
  assert.ok(!JSON.stringify(f.app.getPublicStatus()).includes('internal diagnostic'));
  await assert.rejects(f.app.transfer(f.device, 'url', 'https://example.invalid/photo.jpg'), { code: 'ENGINE_NOT_READY' });
  assert.deepEqual(f.events, [], 'No transfer was admitted, so no delivery result may be invented');
});

test('reachability distinguishes an unavailable frame from a busy or starting app', async (t) => {
  const f = fixture();
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  const condition = f.cards.get('frame_reachable');
  assert.equal(await condition.run({ device: f.device }), true);
  f.device.refreshInfo = async () => { throw Object.assign(new Error('Unavailable'), { code: 'FRAME_UNAVAILABLE' }); };
  assert.equal(await condition.run({ device: f.device }), false);
  for (const code of ['BUSY', 'QUEUE_FULL', 'ENGINE_NOT_READY', 'ABORTED']) {
    f.device.refreshInfo = async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(condition.run({ device: f.device }), { code });
  }
});

test('Flow failures use Homey language and never expose internal error codes or upstream text', async t => {
  for (const language of ['fr', 'en', 'nl', 'de']) {
    const dictionary = require('../locales/' + language + '.json');
    const f = fixture({ onSend: async () => { throw Object.assign(Error('private trace'), { code: 'FRAME_UNAVAILABLE' }); } });
    t.after(() => f.app.onUninit());
    f.app.homey.__ = key => key.split('.').reduce((current, part) => current?.[part], dictionary);
    await f.app.onInit();
    await assert.rejects(f.app.transfer(f.device, 'url', 'https://example.invalid/photo.jpg'), error => {
      assert.equal(error.code, 'TRANSFER_INCOMPLETE'); assert(error.message.includes(dictionary.errors.frame_unavailable)); return true;
    });
    assert.equal(f.events[0].tokens.reason, dictionary.errors.frame_unavailable);
    assert(!JSON.stringify(f.events).includes('private trace'));
    f.device.refreshInfo = async () => { throw Object.assign(Error('BUSY'), { code: 'BUSY' }); };
    await assert.rejects(f.cards.get('frame_reachable').run({ device: f.device }), { message: dictionary.errors.busy });
  }
});

test('a pending refresh finishes before a queued photo starts', async (t) => {
  const refresh = deferred();
  const f = fixture();
  t.after(() => { refresh.resolve(); return f.app.onUninit(); });
  await f.app.onInit();
  f.device.operation = { kind: 'refresh', promise: refresh.promise };
  const sent = f.app.queueTransfer(f.device, 'url', 'https://example.invalid/photo.jpg');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sends.length, 0);
  f.device.operation = null;
  refresh.resolve();
  await sent;
  await until(() => f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.events.filter((event) => event.id === 'photo_received').length, 1);
});

test('a queued transfer waits for an explicit permission request and does not request rights itself', async (t) => {
  for (const denied of [false, true]) {
    const permission = deferred();
    const f = fixture();
    t.after(() => { permission.resolve(); return f.app.onUninit(); });
    await f.app.onInit();
    const pending = denied ? permission.promise.then(() => { throw Object.assign(Error('Permission denied'), { code: 'PERMISSION_DENIED' }); }) : permission.promise;
    f.device.operation = { kind: 'permission', promise: pending };
    const sent = f.app.queueTransfer(f.device, 'url', 'https://example.invalid/photo.jpg');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.sends.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.app.getPublicStatus().pendingTransfers, 1);
    f.device.operation = null;
    permission.resolve();
    await sent;
    await until(() => f.app.getPublicStatus().pendingTransfers === 0);
    assert.equal(f.sends.length, 1);
    assert.equal(f.events.filter(event => event.id === 'photo_received').length, 1);
    assert.equal(f.events.filter(event => event.id === 'photo_failed').length, 0,
      'Denial of optional management rights must not prevent ordinary photo sending');
    assert.equal(f.engineCalls.length, 0);
  }
});

test('a photo for another idle frame waits for the app-wide permission task before entering the engine queue', async (t) => {
  const permission = deferred();
  const f = fixture();
  t.after(() => { permission.resolve(); return f.app.onUninit(); });
  await f.app.onInit();
  assert.equal(f.app.permissionTask, null);
  f.app.permissionTask = permission.promise;
  assert.equal(f.device.operation, null, 'The target photo frame has no local operation to wait for');
  const sent = f.app.queueTransfer(f.device, 'url', 'https://example.invalid/photo-other-frame.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 0, 'Waiting must happen before the bounded backend queue starts a photo timeout');
  assert.equal(f.app.getPublicStatus().pendingTransfers, 1);
  assert.equal(f.events.length, 0);
  f.app.permissionTask = null;
  permission.resolve();
  await sent;
  await until(() => f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].source, 'https://example.invalid/photo-other-frame.jpg');
  assert.equal(f.events.filter(event => event.id === 'photo_received').length, 1);
  assert.equal(f.events.filter(event => event.id === 'photo_failed').length, 0);
});

test('a receipt Flow error does not turn an acknowledged photo into a failed send', async (t) => {
  const f = fixture({ onTrigger: async (id) => { if (id === 'photo_received') throw new Error('Flow failed'); } });
  t.after(() => f.app.onUninit());
  await f.app.onInit();
  await f.app.queueTransfer(f.device, 'url', 'https://example.invalid/photo.jpg');
  await until(() => f.app.getPublicStatus().pendingTransfers === 0);
  assert.equal(f.sends.length, 1);
  assert.equal(f.events.filter((event) => event.id === 'photo_received').length, 1);
  assert.equal(f.events.filter((event) => event.id === 'photo_failed').length, 0);
});

test('public status still responds when the Homey jail denies resident memory measurements', async t => {
  const f = fixture(); t.after(() => f.app.onUninit()); await f.app.onInit();
  const metrics = new EngineMetrics(); metrics.record('info', 12);
  f.app.engine.performanceStats = () => metrics.snapshot();
  const original = process.memoryUsage;
  process.memoryUsage = () => { throw Object.assign(new Error('uv_resident_set_memory'), { code: 'ENOENT' }); };
  try {
    const status = f.app.getPublicStatus();
    assert.equal(status.ready, true); assert.equal(status.performance.node.rssBytes, null);
    assert.equal(status.performance.node.arrayBuffersBytes, null);
    assert.equal(status.performance.operations[0].count, 1);
    assert(!JSON.stringify(status).includes('uv_resident_set_memory'));
  } finally { process.memoryUsage = original; }
});

test('display Flow resolves the named gallery choice only for the selected frame', async t => {
  const f = fixture(); t.after(() => f.app.onUninit()); await f.app.onInit();
  const mediaId = '-9223372036854775808';
  const selection = { id: PEER, mediaId, revision: 'gallery-revision', name: 'Holiday sunset' };
  f.app.gallery.selectDisplayPhoto = async candidate => {
    assert.equal(candidate.revision, selection.revision);
    return { mediaId };
  };
  await f.app.displayPhotos.save(selection);
  const card = f.cards.get('display_saved_photo');
  const [choice] = await card.autocomplete('sunset', { device: f.device });
  assert.deepEqual(Object.keys(choice).sort(), ['id', 'name']);
  assert.equal(choice.name, 'Holiday sunset');
  const other = { getData: () => ({ id: 'cd'.repeat(32) }) };
  assert.deepEqual(await card.autocomplete('', { device: other }), []);
  await assert.rejects(card.run({ device: other, photo: choice }), { code: 'DISPLAY_PHOTO_NOT_FOUND' });
  const requests = [];
  f.app.gallery.displayPhoto = async (frameId, id) => {
    requests.push({ frameId, id }); return { mediaId: id, requested: true };
  };
  await f.app.displayPhotos.save({ ...selection, name: 'Renamed sunset' });
  assert.equal((await card.autocomplete('renamed', { device: f.device }))[0].id, choice.id);
  assert.equal(await card.run({ device: f.device, photo: choice }), true);
  assert.deepEqual(requests, [{ frameId: PEER, id: mediaId }]);
  f.app.gallery.displayPhoto = async () => { throw Object.assign(new Error('Gone'), { code: 'MEDIA_NOT_FOUND' }); };
  await assert.rejects(card.run({ device: f.device, photo: choice }), { code: 'MEDIA_NOT_FOUND' });
  assert.deepEqual(await card.autocomplete('', { device: f.device }), []);
});
