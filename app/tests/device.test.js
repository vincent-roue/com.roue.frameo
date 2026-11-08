'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeFrameInfo } = require('../lib/frame-info');
const translations = require('../locales/fr.json');
const { FrameoMediaMonitor, STORE_KEY: MEDIA_BASELINE } = require('../lib/frameo-media-monitor');

const DEVICE_DIRECTORY = path.resolve(__dirname, '../drivers/frameo');
const DEVICE_SOURCE = fs.readFileSync(path.join(DEVICE_DIRECTORY, 'device.js'), 'utf8');
const PEER = 'ab'.repeat(32); // Synthetic frame identifier, never a real identity.
const FIXTURE_SECRET = '11'.repeat(32);
const CHECKED_AT = '2026-11-03T15:00:00.000Z';
const LAST_SENT = '2026-11-02T12:30:00.000Z';
const DETAILS = ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media',
  'measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received',
  'frameo_last_communication', 'frameo_frame_status', 'frameo_frame_name',
  'frameo_frame_placement', 'frameo_screen_resolution', 'frameo_connection_route', 'frameo_granted_permissions',
  'frameo_last_checked', 'frameo_name', 'frameo_placement', 'frameo_resolution', 'frameo_connection', 'frameo_permissions',
  'frameo_photo_count', 'frameo_video_count', 'frameo_media_checked'];
const RETIRED_CAPABILITIES = ['frameo_request_view', 'frameo_request_manage', 'frameo_next_photo', 'frameo_refresh'];
const MOVABLE_PRESENTATION = ['frameo_latest_received', 'frameo_last_communication', 'frameo_frame_status', 'frameo_frame_name',
  'frameo_frame_placement', 'frameo_screen_resolution', 'frameo_connection_route', 'frameo_granted_permissions'];
const clone = value => JSON.parse(JSON.stringify(value));
function t(key) {
  const value = key.split('.').reduce((current, part) => current?.[part], translations);
  assert.equal(typeof value, 'string', `Translation missing: ${key}`);
  return value;
}
function declaredInfo() {
  return { peer: PEER, name: 'Pexar du salon', placement: 'Salon', width: 2000, height: 1200,
    mayView: true, mayManage: false, maySharePairing: false, mayBackup: true,
    maxVideoWidth: 1920, maxVideoHeight: 1080, protocolConfirmed: true, route: 'local' };
}

function fixture({ store, capabilities, info = async () => declaredInfo(), data = { id: PEER }, now = CHECKED_AT, onStore, permission,
  initialized = true, settings = {}, previewRefresh } = {}) {
  store = store || new Map([['peer', PEER.toUpperCase()], ['last_sent', LAST_SENT]]);
  if (initialized && !store.has('access_mode_initialized')) store.set('access_mode_initialized', true);
  settings = { sender_name: 'Homey', photo_access_mode: 'send', auto_refresh_enabled: true, auto_refresh_interval: 30, ...settings };
  capabilities = capabilities || new Set(['frameo_status', 'frameo_last_sent', 'frameo_refresh']);
  const capabilityValues = new Map(), capabilityAdds = [], capabilityRemoves = [], listeners = new Map(), storeWrites = [], settingWrites = [], calls = [], logs = [];
  const previewEvents = [], previewInstances = [], previewCache = { synthetic: 'shared-preview-cache' };
  const snapshots = new Map();
  const clock = { now };
  const timers = new Map(); let timerId = 0;
  let onInfo = info;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return new Date(clock.now).getTime(); }
  }
  class FakeDevicePreview {
    constructor(device, options) {
      this.device = device;
      this.options = options;
      previewInstances.push(this);
      this.record('create');
    }
    record(operation) {
      previewEvents.push({ operation, mode: this.device.accessMode(), mayView: this.device.lastInfo?.mayView,
        initialized: this.device.getStoreValue('access_mode_initialized'), stopped: this.device.stopped });
    }
    async sync() { this.record('sync'); }
    async invalidate() { this.record('invalidate'); }
    async refresh() { this.record('refresh'); return previewRefresh ? previewRefresh(this.device) : { refreshed: true }; }
    async close() { this.record('close'); }
  }
  const loaded = { exports: {} };
  const localRequire = name => {
    if (name === 'homey') return { Device: class {} };
    if (name === '../../lib/frame-info') return { normalizeFrameInfo };
    if (name === '../../lib/device-preview') return { DevicePreview: FakeDevicePreview };
    if (name === '../../lib/frameo-refresh-scheduler') return require('../lib/frameo-refresh-scheduler');
    throw Error('Unexpected device dependency: ' + name);
  };
  // Actual device code, with fake SDK and clock. No engine process, pairing,
  // photo transfer, network access, or Homey device modification is possible.
  new Function('require', 'module', 'exports', '__dirname', 'Date', 'setInterval', DEVICE_SOURCE)(
    localRequire, loaded, loaded.exports, DEVICE_DIRECTORY, FixedDate,
    () => assert.fail('Device information must not start a polling interval'),
  );
  const device = new loaded.exports();
  Object.assign(device, {
    getData: () => data,
    getName: () => 'Cadre renommé dans Homey',
    getStoreValue: key => store.get(key),
    async setStoreValue(key, value) { if (onStore) await onStore(key, value); store.set(key, clone(value)); storeWrites.push({ key, value: clone(value) }); },
    getSetting: key => settings[key],
    getSettings: () => ({ ...settings }),
    async setSettings(values) { Object.assign(settings, clone(values)); settingWrites.push(clone(values)); },
    hasCapability: key => capabilities.has(key),
    getCapabilities: () => [...capabilities],
    getCapabilityOptions: key => require('../drivers/frameo/driver.compose.json').capabilitiesOptions[key] || {},
    async addCapability(key) { assert(!capabilities.has(key), 'Existing capability must not be added twice'); capabilities.add(key); capabilityAdds.push(key); },
    async removeCapability(key) {
      assert(RETIRED_CAPABILITIES.includes(key) || MOVABLE_PRESENTATION.includes(key), 'Migration must preserve legacy Flow fields and existing numeric tile indicators');
      assert(capabilities.has(key), 'An absent capability must not be removed again');
      capabilities.delete(key); capabilityValues.delete(key); listeners.delete(key); capabilityRemoves.push(key);
    },
    async setCapabilityValue(key, value) { assert(capabilities.has(key), 'Unknown capability'); capabilityValues.set(key, value); },
    registerCapabilityListener(key, listener) { assert(capabilities.has(key), 'A listener requires an installed capability'); listeners.set(key, listener); },
    async setAvailable() { device.available = true; device.unavailableReason = null; },
    async setUnavailable(reason) { device.available = false; device.unavailableReason = reason; },
    error: (...args) => logs.push(args),
  });
  device.homey = {
    __: t, i18n: { getLanguage: () => 'fr' }, clock: { getTimezone: () => 'Europe/Paris' },
    setTimeout(handler, milliseconds) { const id = ++timerId; timers.set(id, { handler, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); },
    app: {
      async waitUntilReady() {},
      gallery: { snapshots },
      previewCache,
      engine: {
        async info(peer, options) { calls.push({ operation: 'info', peer }); return onInfo(peer, options); },
        async permission(peer, access, options) {
          calls.push({ operation: 'permission', peer, access, options });
          if (!permission) assert.fail('Permission must be explicitly requested in this fixture');
          return permission(peer, access, options);
        },
        async pair() { assert.fail('Reading device information must not pair a frame'); },
        async sendUrl() { assert.fail('Reading device information must not send a photo'); },
        async sendImage() { assert.fail('Reading device information must not send a photo'); },
      },
    },
  };
  return { device, data, store, storeWrites, settings, settingWrites, snapshots, capabilities, capabilityValues, capabilityAdds, capabilityRemoves, listeners, calls, logs, clock,
    previewEvents, previewInstances, previewCache, timers,
    setInfo(next) { onInfo = next; } };
}

test('existing device upgrades in place and displays the frame’s actual safe information', async () => {
  const frame = { ...declaredInfo(), private_key: FIXTURE_SECRET, chia_id: 'account-fixture',
    current_state: 'sleep', has_backup: 'active', model: 'invented-model', storage: 999 };
  const f = fixture({ info: async () => frame });
  const originalData = f.data, originalPeer = f.store.get('peer');
  await f.device.onInit();
  assert.deepEqual(new Set(f.capabilityAdds), new Set(DETAILS));
  assert.equal(f.device.getData(), originalData);
  assert.equal(f.device.getData().id, PEER);
  assert.equal(f.store.get('peer'), originalPeer);
  assert(!f.capabilities.has('frameo_refresh') && f.capabilities.has('frameo_last_sent'));
  assert.equal(f.listeners.has('frameo_refresh'), false);
  assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
  assert.equal(f.capabilityValues.get('frameo_name'), 'Pexar du salon');
  assert.equal(f.capabilityValues.get('frameo_placement'), 'Salon');
  assert.equal(f.capabilityValues.get('frameo_resolution'), '2000 × 1200 px');
  assert.equal(f.capabilityValues.get('frameo_connection'), t('device.route_local'));
  assert.equal(f.capabilityValues.get('frameo_permissions'), `${t('device.permission_view')} · ${t('device.permission_backup')}`);
  assert.equal(f.capabilityValues.get('frameo_last_checked'), f.device.displayTime(CHECKED_AT));
  assert.equal(f.device.publicStatus().info.maxVideoWidth, 1920);
  assert.equal(f.device.publicStatus().info.maxVideoHeight, 1080);
  assert.equal(f.device.publicStatus().lastSent, LAST_SENT);
  assert.equal(f.store.get('frame_metadata').checkedAt, CHECKED_AT);
  for (const value of [f.device.publicStatus(), Object.fromEntries(f.capabilityValues), f.store.get('frame_metadata')]) {
    const serialized = JSON.stringify(value);
    for (const excluded of [FIXTURE_SECRET, 'account-fixture', 'current_state', 'has_backup', 'invented-model', '"storage"']) assert(!serialized.includes(excluded));
  }
  await f.device.onUninit();
});

test('upgrade removes retired device controls and preserves identity, receipts and retained capability IDs across restarts', async () => {
  const receipt = { confirmed: true, at: LAST_SENT, mediaId: '9223372036854775807', bytes: 100, route: 'local' };
  const store = new Map([['peer', PEER.toUpperCase()], ['last_sent', LAST_SENT], ['last_result', receipt], ['access_mode_initialized', true]]);
  const retained = ['frameo_status', 'frameo_last_sent', ...DETAILS];
  const f = fixture({ store, capabilities: new Set([...retained, ...RETIRED_CAPABILITIES]) });
  const originalData = f.data, originalPeer = store.get('peer');
  await f.device.onInit();
  assert.deepEqual(f.capabilityRemoves, RETIRED_CAPABILITIES);
  assert.deepEqual(f.capabilityAdds, []);
  assert.deepEqual(new Set(f.capabilities), new Set(retained));
  assert.deepEqual(new Set(f.listeners.keys()), new Set());
  assert.equal(f.device.getData(), originalData);
  assert.equal(f.store.get('peer'), originalPeer);
  assert.equal(f.store.get('last_sent'), LAST_SENT);
  assert.deepEqual(f.store.get('last_result'), receipt);
  assert(f.storeWrites.every(write => ['frame_metadata', 'last_communication'].includes(write.key)), 'Removing controls must not rewrite pairing or transfer history');
  assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
  await f.device.onUninit();

  const restarted = fixture({ store: f.store, settings: f.settings, capabilities: f.capabilities });
  await restarted.device.onInit();
  assert.deepEqual(restarted.capabilityRemoves, [], 'An already removed control must not be removed twice');
  assert.deepEqual(restarted.capabilityAdds, []);
  assert.deepEqual(new Set(restarted.capabilities), new Set(retained));
  assert.equal(restarted.store.get('peer'), originalPeer);
  assert.deepEqual(restarted.store.get('last_result'), receipt);
  assert.deepEqual(new Set(restarted.listeners.keys()), new Set());
  await restarted.device.onUninit();
});

test('device startup creates only a passive widget provider and never exposes a photo control', async () => {
    const f = fixture({ settings: { photo_access_mode: 'manage' } }); await f.device.onInit();
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['create']);
    assert.equal(f.previewInstances[0].options.cache, f.previewCache);
    for (const id of RETIRED_CAPABILITIES) { assert.equal(f.capabilities.has(id), false); assert.equal(f.listeners.has(id), false); }
    assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
    await f.device.onUninit();
  });

test('no device mode or viewing grant causes a photo to load on startup', async () => {
    for (const [mode, mayView] of [['send', true], ['manage', false], ['manage', true]]) {
      const f = fixture({ settings: { photo_access_mode: mode }, info: async () => ({ ...declaredInfo(), mayView }) });
      await f.device.onInit(); assert.deepEqual(f.previewEvents.map(event => event.operation), ['create']);
      assert.equal(f.listeners.has('frameo_next_photo'), false); await f.device.onUninit();
    }
  });

test('later information refreshes remain metadata-only and never prime widget photos', async () => {
    const f = fixture({ settings: { photo_access_mode: 'manage' } }); await f.device.onInit();
    await f.device.refreshInfo(); assert.equal(f.device.available, true);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['create']);
    await f.device.onUninit();
  });

test('a successful information check clears widget pixels on revoked viewing rights without recreating a native image', async () => {
    const f = fixture({ settings: { photo_access_mode: 'manage' } }); await f.device.onInit();
    for (const mayView of [false, undefined]) {
      f.previewEvents.length = 0; f.setInfo(async () => ({ ...declaredInfo(), mayView })); await f.device.refreshInfo();
      assert.deepEqual(f.previewEvents.map(event => event.operation), ['invalidate']);
    }
    f.previewEvents.length = 0; f.setInfo(async () => declaredInfo()); await f.device.refreshInfo();
    assert.deepEqual(f.previewEvents, []); await f.device.onUninit();
  });

test('unload and deletion close the widget provider and ignore late information responses', async () => {
  for (const hook of ['onUninit', 'onDeleted']) {
    const f = fixture({ settings: { photo_access_mode: 'manage' } });
    await f.device.onInit();
    const response = permissionGate();
    f.setInfo(() => response.promise);
    const pending = f.device.refreshInfo();
    for (let attempt = 0; attempt < 10 && f.calls.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 2, 'The synthetic information request must be in flight before teardown');
    const writesBefore = f.storeWrites.length;
    f.previewEvents.length = 0;
    await f.device[hook]();
    assert.equal(f.device.stopped, true);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['close']);
    assert.equal(f.previewEvents[0].stopped, true, 'The provider is closed after the device is marked stopped');
    response.resolve({ ...declaredInfo(), name: 'Late response that must be ignored' });
    assert.equal(await pending, null);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['close']);
    assert.equal(f.storeWrites.length, writesBefore);
    assert.notEqual(f.device.publicStatus().info.name, 'Late response that must be ignored');
  }
});

function permissionGate() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settledPermission(device) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!device.publicStatus().permissionRequest?.pending && !device.operation) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Simulated permission request did not settle');
}

test('the retained permission API starts only on an explicit call and returns promptly while the frame decision is pending', { timeout: 2000 }, async () => {
  for (const access of ['view', 'manage']) {
    const decision = permissionGate();
    const f = fixture({ info: async () => ({ ...declaredInfo(), mayView: false, mayManage: false }),
      permission: () => decision.promise });
    await f.device.onInit();
    assert.equal(f.calls.filter(call => call.operation === 'permission').length, 0);
    await f.device.refreshInfo();
    assert.equal(f.calls.filter(call => call.operation === 'permission').length, 0, 'Refresh must never request additional rights');
    const storedIdentityPeer = f.store.get('peer');
    const writesBefore = f.storeWrites.length;
    const accepted = await f.device.requestPermission(access);
    assert.deepEqual(accepted, { accepted: true, access });
    assert.equal(f.device.publicStatus().permissionRequest.pending, true);
    assert.equal(f.device.publicStatus().permissionRequest.granted, false);
    assert.equal(f.device.publicStatus().info.mayView, false);
    assert.equal(f.device.publicStatus().info.mayManage, false);
    assert.equal(f.device.publicStatus().busy, true);
    assert.equal(f.storeWrites.length, writesBefore, 'A pending request must not claim or persist a grant');
    await assert.rejects(f.device.requestPermission(access), { code: 'BUSY' });
    await assert.rejects(f.device.sendUrl('https://example.invalid/not-sent.png'), { code: 'BUSY' });
    for (let attempt = 0; attempt < 10 && !f.calls.some(call => call.operation === 'permission'); attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.calls.filter(call => call.operation === 'permission'), [{ operation: 'permission', peer: PEER, access, options: { name: 'Homey' } }]);
    f.clock.now = '2026-11-03T15:01:00.000Z';
    decision.resolve({ ...declaredInfo(), mayView: true, mayManage: access === 'manage', private_key: FIXTURE_SECRET });
    await settledPermission(f.device);
    assert.deepEqual(f.device.publicStatus().permissionRequest, { access, pending: false, granted: true });
    assert.equal(f.device.publicStatus().info.mayView, true);
    assert.equal(f.device.publicStatus().info.mayManage, access === 'manage');
    assert.equal(f.device.publicStatus().lastChecked, f.clock.now);
    assert.equal(f.capabilityValues.get('frameo_status'), t('device.permission_granted'));
    assert.equal(f.device.available, true);
    assert.equal(f.store.get('peer'), storedIdentityPeer);
    assert.equal(f.store.get('last_sent'), LAST_SENT);
    assert.equal(f.store.has('last_result'), false);
    assert(f.storeWrites.slice(writesBefore).every(write => ['frame_metadata', 'last_communication'].includes(write.key)));
    assert(!JSON.stringify(f.device.publicStatus()).includes(FIXTURE_SECRET));
    await f.device.onUninit();
  }
});

test('permission refusal or timeout preserves prior rights and does not claim that the frame is offline', async () => {
  for (const code of ['PERMISSION_DENIED', 'PERMISSION_TIMEOUT', 'PERMISSION_NOT_GRANTED', 'TIMEOUT']) {
    const decision = permissionGate();
    const f = fixture({ info: async () => ({ ...declaredInfo(), mayView: false, mayManage: false }), permission: () => decision.promise });
    await f.device.onInit();
    const cache = clone(f.store.get('frame_metadata'));
    assert.equal(f.device.available, true);
    await f.device.requestPermission('manage');
    decision.reject(Object.assign(Error('private upstream trace ' + FIXTURE_SECRET), { code }));
    await settledPermission(f.device);
    assert.deepEqual(f.device.publicStatus().permissionRequest, { access: 'manage', pending: false, granted: false });
    assert.deepEqual(f.store.get('frame_metadata'), cache);
    assert.equal(f.device.publicStatus().info.mayView, false);
    assert.equal(f.device.publicStatus().info.mayManage, false);
    assert.equal(f.device.available, true, code + ' does not prove that the frame is offline');
    assert.notEqual(f.capabilityValues.get('frameo_status'), t('device.permission_granted'));
    assert(!JSON.stringify(f.device.publicStatus()).includes(FIXTURE_SECRET));
    await f.device.onUninit();
  }
});

test('invalid permission access is rejected before engine calls or status changes', async () => {
  const f = fixture(); await f.device.onInit();
  const before = clone(f.device.publicStatus());
  for (const access of ['', 'admin', 'VIEW', null]) await assert.rejects(f.device.requestPermission(access), { code: 'INVALID_ACCESS' });
  assert.deepEqual(f.device.publicStatus(), before);
  assert.equal(f.calls.filter(call => call.operation === 'permission').length, 0);
  f.device.homey.app.activeTransfer = true;
  await assert.rejects(f.device.requestPermission('view'), { code: 'BUSY' });
  assert.equal(f.calls.filter(call => call.operation === 'permission').length, 0);
  await f.device.onUninit();
});

test('the app-wide permission lock prevents requests on another frame until the current decision finishes', async () => {
  const decision = permissionGate();
  let requests = 0;
  const first = fixture({ permission: async (peer) => {
    if (++requests === 1) return decision.promise;
    return { ...declaredInfo(), peer, mayView: true };
  } });
  const secondPeer = 'cd'.repeat(32);
  const second = fixture({ data: { id: secondPeer }, store: new Map([['peer', secondPeer]]) });
  await first.device.onInit(); await second.device.onInit();
  second.device.homey.app = first.device.homey.app;
  const app = first.device.homey.app;
  await first.device.requestPermission('view');
  assert(app.permissionTask && typeof app.permissionTask.then === 'function');
  assert.equal(second.device.operation, null, 'The second frame itself is idle');
  const before = clone(second.device.publicStatus());
  await assert.rejects(second.device.requestPermission('manage'), { code: 'BUSY' });
  assert.deepEqual(second.device.publicStatus(), before, 'A rejected second request must not create a waiting state');
  decision.resolve({ ...declaredInfo(), mayView: true });
  await settledPermission(first.device);
  assert.equal(app.permissionTask, null, 'The completed request releases the global lock');
  assert.deepEqual(await second.device.requestPermission('view'), { accepted: true, access: 'view' });
  await settledPermission(second.device);
  assert.equal(requests, 2);
  assert.deepEqual(first.calls.filter(call => call.operation === 'permission').map(call => call.peer), [PEER, secondPeer]);
  assert.equal(app.permissionTask, null);
  await first.device.onUninit(); await second.device.onUninit();
});

test('a failed refresh and restart preserve the last successful information and timestamp', async () => {
  const f = fixture();
  await f.device.onInit();
  const known = clone(f.store.get('frame_metadata'));
  const displayedAt = f.capabilityValues.get('frameo_last_checked');
  f.clock.now = '2026-11-04T10:00:00.000Z';
  f.setInfo(async () => { throw Object.assign(Error('private native trace ' + FIXTURE_SECRET), { code: 'TIMEOUT' }); });
  await assert.rejects(f.device.refreshInfo(), error => {
    assert.equal(error.code, 'TIMEOUT'); assert.equal(error.message, t('errors.timeout')); return true;
  });
  assert.deepEqual(f.store.get('frame_metadata'), known);
  assert.equal(f.storeWrites.filter(write => write.key === 'frame_metadata').length, 1);
  assert.equal(f.device.publicStatus().lastChecked, CHECKED_AT);
  assert.equal(f.capabilityValues.get('frameo_last_checked'), displayedAt);
  assert.equal(f.capabilityValues.get('frameo_name'), known.info.name);
  assert.equal(f.device.available, false);
  assert.equal(f.capabilityValues.get('frameo_status'), t('errors.timeout'));
  assert(!JSON.stringify(f.device.publicStatus()).includes(FIXTURE_SECRET));
  await f.device.onUninit();

  const restarted = fixture({ store: f.store, capabilities: f.capabilities, now: '2026-11-05T10:00:00.000Z',
    info: async () => { throw Object.assign(Error('offline fixture'), { code: 'FRAME_UNAVAILABLE' }); } });
  await restarted.device.onInit();
  assert.deepEqual(restarted.capabilityAdds, [], 'Already migrated capabilities must survive app restart');
  assert.deepEqual(restarted.device.publicStatus().info, known.info);
  assert.equal(restarted.device.publicStatus().lastChecked, CHECKED_AT);
  assert.equal(restarted.capabilityValues.get('frameo_last_checked'), displayedAt);
  assert.equal(restarted.capabilityValues.get('frameo_resolution'), '2000 × 1200 px');
  assert.equal(restarted.store.get('last_sent'), LAST_SENT);
  assert.equal(restarted.storeWrites.length, 0, 'An unsuccessful startup check must not replace cache or historical timestamps');
  assert.deepEqual(restarted.calls, [{ operation: 'info', peer: PEER }]);
  await restarted.device.onUninit();
});

test('unknown metadata is shown as unreported instead of inferred states or permissions', async () => {
  const f = fixture({ info: async () => ({ name: 'Frameo', placement: '', width: 0, height: -1,
    route: 'unknown-network', mayView: 'yes', mayManage: 1, maySharePairing: null,
    maxVideoWidth: 0, maxVideoHeight: 999999, current_state: 1, has_backup: 2 }) });
  await f.device.onInit();
  for (const id of ['frameo_placement', 'frameo_resolution', 'frameo_connection', 'frameo_permissions']) {
    assert.equal(f.capabilityValues.get(id), t('device.not_reported'));
  }
  const info = f.device.publicStatus().info;
  assert.equal(info.width, null); assert.equal(info.height, null);
  assert.equal(info.route, null); assert.equal(info.mayView, null); assert.equal(info.mayManage, null);
  assert.equal(info.maxVideoWidth, null); assert.equal(info.maxVideoHeight, null);
  for (const key of ['current_state', 'has_backup', 'screenOn', 'brightness', 'firmware', 'storage', 'photoCount']) assert(!Object.hasOwn(info, key));
  assert.equal(f.capabilityValues.get('frameo_status'), t('device.reachable'), 'A completed information exchange may still omit optional metadata');
  f.setInfo(async () => ({ name: 'Frameo', width: 2000, height: 1200,
    mayView: false, mayManage: false, maySharePairing: false, mayBackup: false }));
  await f.device.refreshInfo();
  assert.equal(f.capabilityValues.get('frameo_permissions'), t('device.permissions_none'), 'Explicit false permission flags differ from missing flags');
  await f.device.onUninit();
});

test('a cache without a valid successful-check timestamp is never presented as verified', async () => {
  const store = new Map([['peer', PEER], ['frame_metadata', { info: declaredInfo(), checkedAt: 'not-a-date' }]]);
  const f = fixture({ store, info: async () => { throw Object.assign(Error('offline'), { code: 'FRAME_UNAVAILABLE' }); } });
  await f.device.onInit();
  assert.equal(f.device.publicStatus().info, null);
  assert.equal(f.device.publicStatus().lastChecked, null);
  assert.equal(f.capabilityValues.get('frameo_last_checked'), t('device.never_checked'));
  assert.equal(f.capabilityValues.get('frameo_name'), t('device.not_reported'));
  assert.equal(f.capabilityValues.get('frameo_last_sent'), t('device.never_sent'));
  assert.equal(f.storeWrites.length, 0);
  assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
  await f.device.onUninit();
});

test('confirmed receipt persists the exact signed int64 media ID before the last-sent timestamp', async () => {
  const f = fixture(); await f.device.onInit();
  const receipt = await f.device.recordTransfer({ confirmed: true, mediaId: '9223372036854775807', bytes: 1234, route: 'local',
    config: { private_key: FIXTURE_SECRET }, url: 'https://private.example/photo.jpg', path: '/tmp/private-photo.jpg' });
  const expected = { confirmed: true, at: CHECKED_AT, mediaId: '9223372036854775807', bytes: 1234, route: 'local' };
  assert.deepEqual(receipt, expected);
  assert.deepEqual(f.store.get('last_result'), expected);
  assert.deepEqual(f.storeWrites.slice(-2).map(write => write.key), ['last_result', 'last_sent']);
  assert.equal(f.store.get('last_sent'), CHECKED_AT);
  assert.deepEqual(f.device.publicStatus().lastResult, expected);
  for (const value of [receipt, f.store.get('last_result'), f.device.publicStatus().lastResult]) {
    const serialized = JSON.stringify(value);
    assert(!serialized.includes(FIXTURE_SECRET)); assert(!serialized.includes('private-photo')); assert(!serialized.includes('private.example'));
  }
  const minimum = await f.device.recordTransfer({ confirmed: true, mediaId: '-9223372036854775808', bytes: 1, route: 'relay' });
  assert.equal(minimum.mediaId, '-9223372036854775808');
  assert.equal(minimum.route, 'relay');
  await f.device.onUninit();
});

test('missing or invalid receipt metadata never invents or rounds a media ID', async () => {
  const f = fixture(); await f.device.onInit();
  for (const mediaId of [undefined, 9223372036854775807, '9223372036854775808', '-9223372036854775809', '00123', '-0', 'not-an-id']) {
    const receipt = await f.device.recordTransfer({ confirmed: true, mediaId, bytes: 1.5, route: 'untrusted-route' });
    assert.deepEqual(receipt, { confirmed: true, at: CHECKED_AT });
    assert(!Object.hasOwn(f.store.get('last_result'), 'mediaId'));
  }
  await assert.rejects(f.device.recordTransfer({ mediaId: '12345', confirmed: false }), { code: 'SEND_UNCONFIRMED' });
  await f.device.onUninit();
});

test('restart restores allowlisted receipt metadata even if the later last-sent write failed', async () => {
  const writes = [];
  const f = fixture({ onStore: async key => { writes.push(key); if (key === 'last_sent') throw Error('simulated storage error'); } });
  await f.device.onInit();
  const receipt = await f.device.recordTransfer({ confirmed: true, mediaId: '9223372036854775807', bytes: 100, route: 'local' });
  assert.equal(receipt.mediaId, '9223372036854775807');
  assert.deepEqual(writes.slice(-2), ['last_result', 'last_sent']);
  assert.equal(f.store.get('last_sent'), LAST_SENT);
  const persisted = f.store.get('last_result');
  persisted.private_key = FIXTURE_SECRET;
  persisted.otherMetadata = { unknown: true };
  await f.device.onUninit();
  const restarted = fixture({ store: f.store, capabilities: f.capabilities,
    info: async () => { throw Object.assign(Error('offline fixture'), { code: 'FRAME_UNAVAILABLE' }); } });
  await restarted.device.onInit();
  assert.deepEqual(restarted.device.publicStatus().lastResult, receipt);
  assert.equal(restarted.device.publicStatus().lastSent, CHECKED_AT);
  assert.equal(restarted.capabilityValues.get('frameo_last_sent'), restarted.device.displayTime(CHECKED_AT));
  assert(!JSON.stringify(restarted.device.publicStatus()).includes(FIXTURE_SECRET));
  await restarted.device.onUninit();
});

test('information checks keep the exact sender name used by the permission guide', async () => {
  let checked = 0;
  const f = fixture({ settings: { sender_name: 'Homey du salon' }, info: async (peer, options) => {
    checked++; assert.equal(peer, PEER); assert.equal(options.name, 'Homey du salon'); return declaredInfo();
  } });
  await f.device.onInit(); await f.device.refreshInfo(); assert.equal(checked, 2);
  await f.device.onUninit();
});

test('receipt persistence failures never turn an acknowledged transfer into a failure', async () => {
  const f = fixture({ onStore: async key => { if (key === 'last_result' || key === 'last_sent') throw Error('private storage trace ' + FIXTURE_SECRET); } });
  await f.device.onInit();
  const receipt = await f.device.recordTransfer({ confirmed: true, mediaId: '9223372036854775807', bytes: 100, route: 'relay' });
  assert.equal(receipt.confirmed, true); assert.equal(receipt.mediaId, '9223372036854775807');
  assert.deepEqual(f.device.publicStatus().lastResult, receipt);
  assert.equal(f.device.publicStatus().lastSent, CHECKED_AT);
  assert(!JSON.stringify(f.logs).includes(FIXTURE_SECRET));
  assert(!JSON.stringify(f.logs).includes('9223372036854775807'));
  await f.device.onUninit();
});

test('legacy devices with existing viewing rights migrate to manage in place without pairing or a permission request', async () => {
  for (const mayManage of [false, true]) {
    const f = fixture({ initialized: false, info: async () => ({ ...declaredInfo(), mayView: true, mayManage }) });
    const originalData = f.data, originalPeer = f.store.get('peer');
    assert.equal(f.store.has('access_mode_initialized'), false);
    await f.device.onInit();
    assert.equal(f.device.getData(), originalData);
    assert.equal(f.store.get('peer'), originalPeer);
    assert.equal(f.store.get('last_sent'), LAST_SENT);
    assert.equal(f.device.accessMode(), 'manage');
    assert.equal(f.settings.photo_access_mode, 'manage');
    assert.equal(f.store.get('access_mode_initialized'), true);
    assert.deepEqual(f.settingWrites, [{ photo_access_mode: 'manage' }]);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['create']);
    assert(f.previewEvents.every(event => event.mode === 'manage' && event.initialized === true), 'Native image registration must follow the legacy mode migration');
    assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
    assert.equal(f.device.publicStatus().info.mayManage, mayManage, 'Migration must preserve the actual permission, not claim management rights');
    await f.device.onUninit();

    const restarted = fixture({ store: f.store, settings: f.settings, capabilities: f.capabilities });
    await restarted.device.onInit();
    assert.equal(restarted.device.accessMode(), 'manage');
    assert.deepEqual(restarted.settingWrites, [], 'Migration must not repeat once the local mode is initialized');
    assert.deepEqual(restarted.calls, [{ operation: 'info', peer: PEER }]);
    await restarted.device.onUninit();
  }
});

test('an explicit new send-only choice remains send-only even when the frame already grants both photo permissions', async () => {
  const f = fixture({ settings: { photo_access_mode: 'send' }, info: async () => ({ ...declaredInfo(), mayView: true, mayManage: true }) });
  await f.device.onInit();
  assert.equal(f.store.get('access_mode_initialized'), true);
  assert.equal(f.device.accessMode(), 'send');
  assert.deepEqual(f.settingWrites, []);
  await f.device.refreshInfo();
  assert.equal(f.device.accessMode(), 'send');
  assert.deepEqual(f.settingWrites, []);
  assert(f.calls.every(call => call.operation === 'info'));
  assert.equal(f.device.publicStatus().info.mayView, true);
  assert.equal(f.device.publicStatus().info.mayManage, true, 'Actual frame permissions and the selected local mode are distinct');
  await f.device.onUninit();
});

test('changing the local mode invalidates the gallery cache without granting rights or contacting the frame', async () => {
  const f = fixture({ info: async () => ({ ...declaredInfo(), mayView: false, mayManage: false }) });
  await f.device.onInit();
  const before = clone(f.device.publicStatus());
  const callsBefore = f.calls.length;
  for (const mode of ['manage', 'send']) {
    f.snapshots.set(PEER, { synthetic: 'cached-gallery' });
    f.previewEvents.length = 0;
    await f.device.setAccessMode(mode);
    assert.equal(f.device.accessMode(), mode);
    assert.equal(f.snapshots.has(PEER), false);
    assert.equal(f.store.get('access_mode_initialized'), true);
    assert.equal(f.calls.length, callsBefore);
    assert.deepEqual(f.device.publicStatus(), before);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['invalidate']);
    assert(f.previewEvents.every(event => event.mode === mode), 'Preview invalidation and registration must use the new local mode');
  }
  assert.deepEqual(f.settingWrites, [{ photo_access_mode: 'manage' }, { photo_access_mode: 'send' }]);
  for (const mode of ['', 'gallery', 'MANAGE', null, true, {}]) {
    await assert.rejects(f.device.setAccessMode(mode), { message: t('errors.access_mode_invalid') });
  }
  assert.equal(f.device.accessMode(), 'send');
  assert.equal(f.settingWrites.length, 2);
  assert.equal(f.calls.length, callsBefore);
  await f.device.onUninit();
});

test('advanced settings validate send/manage before the SDK saves a change', async () => {
  const f = fixture(); await f.device.onInit();
  const callsBefore = f.calls.length;
  for (const mode of ['send', 'manage']) {
    f.snapshots.set(PEER, { synthetic: 'old-gallery' });
    const values = { sender_name: 'Famille é😀', photo_access_mode: mode };
    f.previewEvents.length = 0;
    await f.device.onSettings({ newSettings: values });
    assert.equal(f.snapshots.has(PEER), false);
    assert.deepEqual(f.previewEvents.map(event => event.operation), ['invalidate']);
    assert(f.previewEvents.every(event => event.mode === mode), 'The preview must see the requested mode before Homey persists the settings');
    // Homey persists newSettings only after the validation hook succeeds.
    await f.device.setSettings(values);
    assert.equal(f.device.accessMode(), mode);
  }
  const saved = clone(f.settings);
  f.previewEvents.length = 0;
  for (const mode of ['gallery', 'SEND', '', false, null]) {
    await assert.rejects(f.device.onSettings({ newSettings: { sender_name: 'Homey', photo_access_mode: mode } }),
      { message: t('errors.access_mode_invalid') });
    assert.deepEqual(f.settings, saved);
  }
  for (const sender_name of ['', 'Homey\nnew line', '😀'.repeat(81)]) {
    await assert.rejects(f.device.onSettings({ newSettings: { sender_name, photo_access_mode: 'manage' } }),
      { message: t('errors.sender_invalid') });
  }
  assert.equal(f.calls.length, callsBefore, 'Settings validation must not pair, send a photo, or request frame rights');
  assert.deepEqual(f.previewEvents, [], 'Rejected settings must not disturb the registered image or its cache');
  await f.device.onUninit();
});

test('metadata index survives a fresh allowed check but is discarded on access and identity changes', async () => {
  const f = fixture({ settings: { photo_access_mode: 'manage' } });
  const invalidated = [];
  f.device.homey.app.engine.invalidateMediaIndex = peer => invalidated.push(peer);
  await f.device.onInit();
  await f.device.refreshInfo();
  assert.deepEqual(invalidated, [], 'Fresh viewing permission must not discard the useful short-lived index');
  await f.device.onSettings({ newSettings: { sender_name: 'Another sender', photo_access_mode: 'manage' } });
  await f.device.setAccessMode('send');
  await f.device.recordInfo({ ...declaredInfo(), mayView: false });
  await f.device.onDeleted();
  assert.deepEqual(invalidated, [PEER, PEER, PEER, PEER]);
});

test('a verified receipt reaches its correlated observer before a blocked SDK save', async () => {
  let unblock;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const f = fixture({ onStore: async key => { if (key === 'last_result') await blocked; } });
  await f.device.onInit();
  let observed;
  const saving = f.device.recordTransfer({ confirmed: true, mediaId: '9007199254740993123', bytes: 123,
    privateOutput: FIXTURE_SECRET }, value => { observed = value; });
  assert.equal(observed.confirmed, true);
  assert.equal(observed.mediaId, '9007199254740993123');
  assert.equal(observed.privateOutput, undefined);
  assert(!f.storeWrites.some(item => item.key === 'last_result'));
  unblock();
  const receipt = await saving;
  assert.deepEqual(receipt, observed);
  await f.device.onUninit();
});

test('receipt observers cannot turn a confirmed delivery into a failure or leak their exception', async () => {
  const f = fixture(); await f.device.onInit();
  const result = await f.device.recordTransfer({ confirmed: true, mediaId: '123' }, () => { throw Error(FIXTURE_SECRET); });
  assert.equal(result.confirmed, true);
  assert(!JSON.stringify(f.logs).includes(FIXTURE_SECRET));
  await f.device.onUninit();
});

function monitoredFixture(options = {}) {
  const f = fixture({ ...options, settings: { photo_access_mode: 'manage', ...options.settings } });
  let items = [
    { mediaId: '1', type: 'photo', visible: true }, { mediaId: '2', type: 'photo', visible: false },
    { mediaId: '3', type: 'video', visible: false }, { mediaId: '4', type: 'greeting' }, { mediaId: '5', type: 'unknown' },
  ];
  let lists = 0, listError = null;
  const events = [], app = f.device.homey.app;
  app.getDevices = () => [f.device];
  app.mediaMonitor = new FrameoMediaMonitor(app, { now: () => Date.parse(f.clock.now) });
  app.engine.listMedia = async () => { lists++; if (listError) throw listError; return clone(items); };
  app.mediaDetected = { trigger: async (device, tokens) => { assert.equal(device, f.device); events.push(clone(tokens)); } };
  return { ...f, app, events, lists: () => lists, setItems: value => { items = value; }, items: () => clone(items),
    failList: value => { listError = value; }, async close() { await f.device.onUninit(); await app.mediaMonitor.close(); } };
}

test('device counts metadata including hidden media and detects an exact new video ID without fetching pixels', async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  await f.device.onInit();
  assert.equal(f.lists(), 0, 'Initial inventory is staggered, not a startup burst');
  assert.equal(f.capabilityValues.get('frameo_video_count'), null);
  await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('frameo_photo_count'), 2);
  assert.equal(f.capabilityValues.get('frameo_video_count'), 1);
  assert.equal(f.capabilityValues.get('measure_frameo_photos'), 2);
  assert.equal(f.capabilityValues.get('measure_frameo_videos'), 1);
  assert.equal(f.capabilityValues.get('measure_frameo_media'), 5, 'The total includes greetings and unrecognised media, without downloading them');
  assert.deepEqual(f.events, [], 'Existing media must never be announced as newly received');
  assert.equal(f.device.lastInventory.counts.greetings, 1);
  assert.equal(f.device.lastInventory.counts.unknown, 1);
  f.clock.now = '2026-11-03T15:30:00.000Z';
  f.setItems([...f.items(), { mediaId: '9223372036854775807', type: 'video', receiveDate: '2026-11-03T15:25:00.000Z' }]);
  const before = f.lists();
  await Promise.all([f.device.refreshDetails(), f.device.refreshDetails()]);
  assert.equal(f.lists(), before + 1);
  assert.equal(f.capabilityValues.get('frameo_video_count'), 2);
  assert.deepEqual(f.events, [{ media_id: '9223372036854775807', type: 'video',
    received_at: '2026-11-03T15:25:00.000Z', detected_at: f.clock.now, new_count: 1, events_truncated: false }]);
  assert(!f.previewEvents.some(event => event.operation === 'refresh'), 'Inventory cannot retrieve any photo or video');
  await f.device.refreshDetails();
  assert.equal(f.events.length, 1);
});

test('inventory survives restart silently; a failed scan preserves counts and their last successful date', async context => {
  const first = monitoredFixture(); await first.device.onInit(); await first.device.refreshDetails();
  const saved = clone(first.device.lastInventory);
  await first.close();
  const f = monitoredFixture({ store: first.store }); context.after(() => f.close());
  await f.device.onInit();
  assert.equal(f.capabilityValues.get('frameo_photo_count'), 2);
  assert(!f.device.refreshScheduler.initialPending);
  await f.device.refreshDetails(); assert.equal(f.events.length, 0);
  f.clock.now = '2026-11-03T16:00:00.000Z';
  f.failList(Object.assign(Error('internal details must not reach the user'), { code: 'TIMEOUT' }));
  await assert.rejects(f.device.refreshDetails(), { message: t('errors.timeout') });
  assert.equal(f.device.lastInventory.checkedAt, saved.checkedAt);
  assert.equal(f.capabilityValues.get('frameo_photo_count'), 2);
});

test('permission revocation clears counts and reference; restoring access creates a silent new baseline', async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  const before = f.lists();
  f.setInfo(async () => ({ ...declaredInfo(), mayView: false }));
  await f.device.refreshDetails();
  assert.equal(f.lists(), before);
  assert.equal(f.capabilityValues.get('frameo_photo_count'), null);
  assert.equal(f.capabilityValues.get('frameo_video_count'), null);
  for (const id of ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media']) assert.equal(f.capabilityValues.get(id), null);
  assert.equal(f.store.get(MEDIA_BASELINE), null);
  f.setItems([...f.items(), { mediaId: '99', type: 'photo' }]);
  f.setInfo(async () => declaredInfo());
  await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('frameo_photo_count'), 3);
  assert.deepEqual(f.events, []);
});

test('an already paired device shows counts first and a single date while preserving established Flow fields', async context => {
  const old = ['frameo_status', 'frameo_last_sent', 'frameo_last_checked', 'frameo_name', 'frameo_placement',
    'frameo_resolution', 'frameo_connection', 'frameo_permissions', 'frameo_photo_count', 'frameo_video_count', 'frameo_media_checked'];
  const f = monitoredFixture({ capabilities: new Set(old) }); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  assert.deepEqual(f.capabilityRemoves, [], 'Moving UI cells must not remove Flow capabilities');
  assert(old.every(id => f.capabilities.has(id)));
  const visible = [...f.capabilities].filter(id => require('../.homeycompose/capabilities/' + id + '.json').uiComponent === 'sensor');
  assert.deepEqual(visible, ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media',
    'measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received',
    'frameo_last_communication', 'frameo_frame_status', 'frameo_frame_name', 'frameo_frame_placement',
    'frameo_screen_resolution', 'frameo_connection_route', 'frameo_granted_permissions']);
  assert.equal(f.capabilityValues.get('frameo_frame_name'), f.capabilityValues.get('frameo_name'));
  assert.equal(f.capabilityValues.get('frameo_frame_status'), f.capabilityValues.get('frameo_status'));
});

test('the 0.12 overview migration groups new counters without removing legacy fields or existing tile indicators', async context => {
  const old = ['frameo_status', 'frameo_last_sent', 'frameo_last_checked', 'frameo_name', 'frameo_placement',
    'frameo_resolution', 'frameo_connection', 'frameo_permissions', 'frameo_photo_count', 'frameo_video_count', 'frameo_media_checked'];
  const indicators = ['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media'];
  const text = MOVABLE_PRESENTATION.filter(id => id !== 'frameo_latest_received');
  const f = monitoredFixture({ capabilities: new Set([...old, ...indicators, ...text]) }); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  assert.deepEqual(new Set(f.capabilityRemoves), new Set(text));
  assert(!f.capabilityRemoves.some(id => old.includes(id) || indicators.includes(id)));
  const visible = [...f.capabilities].filter(id => require('../.homeycompose/capabilities/' + id + '.json').uiComponent === 'sensor');
  assert.deepEqual(visible.slice(0, 7), [...indicators, 'measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received', 'frameo_last_communication']);
  await f.close();
  const restarted = monitoredFixture({ capabilities: f.capabilities, store: f.store }); context.after(() => restarted.close());
  await restarted.device.onInit();
  assert.deepEqual(restarted.capabilityRemoves, [], 'A completed layout migration must be stable on restart');
});

test('unexposed presentation options fall back to appending fields rather than removing a possible dependency', async context => {
  const f = monitoredFixture({ capabilities: new Set(['measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media', 'frameo_last_communication']) });
  context.after(() => f.close()); f.device.getCapabilityOptions = () => ({});
  await f.device.onInit();
  assert.deepEqual(f.capabilityRemoves, []);
  assert(f.capabilities.has('measure_frameo_visible') && f.capabilities.has('measure_frameo_hidden'));
});

test('device overview counts all slideshow/hidden media and reports the latest actual receive date without media retrieval', async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  const items = [
    { mediaId: '1', type: 'photo', visible: true, receiveDate: '2026-11-01T08:00:00Z', captureDate: '2030-01-01T00:00:00Z' },
    { mediaId: '2', type: 'video', visible: false, receiveDate: '2026-11-02T09:00:00Z' },
    { mediaId: '3', type: 'greeting', visible: false, receiveDate: '2026-11-03T10:00:00Z' },
  ];
  f.setItems(items); await f.device.onInit(); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('measure_frameo_visible'), 1);
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), 2);
  assert.equal(f.capabilityValues.get('frameo_latest_received'), f.device.displayTime('2026-11-03T10:00:00Z'));
  assert.equal(f.device.publicStatus().inventory.latestReceivedAt, '2026-11-03T10:00:00.000Z');
  items[0].visible = false; f.setItems(items); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('measure_frameo_visible'), 0);
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), 3);
  assert.deepEqual(f.events, [], 'Visibility changes do not announce a new medium');
  f.setInfo(async () => { throw Object.assign(Error('synthetic timeout'), { code: 'TIMEOUT' }); });
  await assert.rejects(f.device.refreshDetails(), { code: 'TIMEOUT' });
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), 3);
  assert.equal(f.capabilityValues.get('frameo_latest_received'), f.device.displayTime('2026-11-03T10:00:00Z'));
  assert(!f.previewEvents.some(event => event.operation === 'refresh'));
});

test('empty, undated, unknown visibility and revoked inventories remain distinguishable in the overview', async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  f.setItems([]); await f.device.onInit(); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('measure_frameo_visible'), 0);
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), 0);
  assert.equal(f.capabilityValues.get('frameo_latest_received'), t('device.no_media'));
  f.setItems([{ mediaId: '1', type: 'photo', visible: true }]); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('frameo_latest_received'), t('device.media_receive_date_unknown'));
  f.setItems([{ mediaId: '1', type: 'photo', visible: 'true' }]); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('measure_frameo_visible'), null);
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), null);
  f.setInfo(async () => ({ ...declaredInfo(), mayView: false })); await f.device.refreshDetails();
  assert.equal(f.capabilityValues.get('measure_frameo_visible'), null);
  assert.equal(f.capabilityValues.get('measure_frameo_hidden'), null);
  assert.equal(f.capabilityValues.get('frameo_latest_received'), t('device.inventory_unavailable'));
});

test('last communication combines successful checks, counts and confirmed sends, survives reset, and ignores failed attempts', async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  const initial = f.device.publicStatus().lastCommunication;
  f.clock.now = '2026-11-03T15:10:00.000Z';
  f.setInfo(async () => { throw Object.assign(Error('synthetic unavailable frame'), { code: 'TIMEOUT' }); });
  await assert.rejects(f.device.refreshInfo(), { code: 'TIMEOUT' });
  assert.equal(f.device.publicStatus().lastCommunication, initial);
  f.clock.now = '2026-11-03T15:20:00.000Z';
  await f.device.recordTransfer({ confirmed: true, mediaId: '123', bytes: 40 });
  assert.equal(f.device.publicStatus().lastCommunication, f.clock.now);
  assert.equal(f.capabilityValues.get('frameo_last_checked'), f.device.displayTime(initial), 'The hidden legacy check field keeps its original semantics');
  assert.equal(f.capabilityValues.get('frameo_last_communication'), f.device.displayTime(f.clock.now));
  f.device.lastInventory = { ...f.device.lastInventory, checkedAt: '2026-11-03T15:30:00.000Z' };
  await f.device.displayInventory();
  await f.device.resetInventory();
  assert.equal(f.device.publicStatus().lastCommunication, '2026-11-03T15:30:00.000Z');
  assert.equal(f.store.get('last_communication'), '2026-11-03T15:30:00.000Z');
  assert.equal(f.capabilityValues.get('measure_frameo_media'), null);
  assert.equal(f.capabilityValues.get('frameo_last_communication'), f.device.displayTime('2026-11-03T15:30:00.000Z'));
});

test('a successful inventory date survives a reset while its older count publication is blocked', { timeout: 2000 }, async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  const oldCheck = f.device.lastChecked;
  f.clock.now = '2026-11-03T15:00:10.000Z';
  const entered = permissionGate(), release = permissionGate();
  const write = f.device.setCapabilityValue.bind(f.device);
  let blocked = false;
  f.device.setCapabilityValue = async (id, value) => {
    if (!blocked && id === 'frameo_photo_count') { blocked = true; entered.resolve(); await release.promise; }
    return write(id, value);
  };
  const scan = f.device.refreshDetails({ inventoryOnly: true });
  await entered.promise;
  const reset = f.device.resetInventory();
  try { assert.equal(f.device.lastInventory, null); } finally { release.resolve(); }
  await Promise.all([scan, reset]);
  assert.equal(f.device.lastChecked, oldCheck, 'A fresh cached frame-info check was reused');
  assert.equal(f.capabilityValues.get('measure_frameo_media'), null);
  assert.equal(f.device.publicStatus().lastCommunication, f.clock.now);
  assert.equal(f.store.get('last_communication'), f.clock.now);
});

test('automatic refresh defaults migrate without changing identity and live interval changes retain inventory', async context => {
  const f = monitoredFixture({ settings: { auto_refresh_enabled: undefined, auto_refresh_interval: undefined } });
  context.after(() => f.close()); await f.device.onInit(); await f.device.refreshDetails();
  assert.equal(f.settings.auto_refresh_enabled, true); assert.equal(f.settings.auto_refresh_interval, 30);
  assert.equal(f.store.get('peer'), PEER.toUpperCase());
  const baseline = clone(f.store.get(MEDIA_BASELINE)), events = f.previewEvents.length;
  await f.device.onSettings({ newSettings: { ...f.settings, auto_refresh_interval: 1 } });
  assert.equal(f.device.refreshScheduler.stats().intervalMinutes, 1);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.store.get(MEDIA_BASELINE), baseline);
  assert.equal(f.previewEvents.length, events);
  await f.device.onSettings({ newSettings: { ...f.settings, auto_refresh_enabled: false } });
  assert.equal(f.device.refreshScheduler.stats().enabled, false); assert.equal(f.timers.size, 0);
  for (const value of [0, 1.5, 1441, '30']) await assert.rejects(f.device.onSettings({
    newSettings: { ...f.settings, auto_refresh_interval: value } }), { message: t('errors.auto_refresh_invalid') });
});


test('revocation queues a fresh inventory publication behind a delayed older SDK write', { timeout: 2000 }, async context => {
  const f = monitoredFixture(); context.after(() => f.close());
  await f.device.onInit(); await f.device.refreshDetails();
  const entered = permissionGate(), release = permissionGate(), resetQueued = permissionGate();
  const actualDisplay = f.device.displayInventory.bind(f.device);
  let publications = 0;
  f.device.displayInventory = () => {
    const pending = actualDisplay();
    if (++publications === 2) resetQueued.resolve();
    return pending;
  };
  const writes = [];
  const originalWrite = f.device.setCapabilityValue.bind(f.device);
  let blocked = false;
  f.device.setCapabilityValue = async (id, value) => {
    writes.push({ id, value });
    if (!blocked && id === 'frameo_photo_count' && value === 2) {
      blocked = true; entered.resolve(); await release.promise;
    }
    return originalWrite(id, value);
  };
  const oldPublication = f.device.displayInventory();
  await entered.promise;
  f.device.lastInfo = { ...f.device.lastInfo, mayView: false };
  const reset = f.device.resetInventory();
  let writesBeforeRelease;
  try {
    // Let the reset clear its persistent baseline and enqueue its publication
    // while the old SDK call is still in flight. Neither operation waits on a
    // callback that only the other can release.
    await resetQueued.promise;
    writesBeforeRelease = writes.length;
    assert.equal(f.device.lastInventory, null);
  } finally { release.resolve(); }
  await Promise.all([oldPublication, reset]);
  assert.equal(writesBeforeRelease, 1, 'Reset must not publish in parallel with the older SDK write');
  assert.equal(f.store.get(MEDIA_BASELINE), null);
  assert.equal(f.capabilityValues.get('frameo_photo_count'), null);
  assert.equal(f.capabilityValues.get('frameo_video_count'), null);
  assert.equal(f.capabilityValues.get('frameo_media_checked'), t('device.inventory_unavailable'));
});

test('a return-to-reachability Flow fires once after two genuine failures following a baseline', async context => {
  const f = fixture(); context.after(() => f.device.onUninit());
  const events = [];
  f.device.homey.app.frameBackOnline = { async trigger(device, tokens) {
    assert.equal(device, f.device);
    assert.equal(device.operation, null);
    events.push(tokens);
  } };
  await f.device.onInit();
  assert.deepEqual(events, []);
  const fail = (code, details) => async () => { throw Object.assign(new Error(code), { code, details }); };
  f.setInfo(fail('CONNECTION_FAILED'));
  await assert.rejects(f.device.refreshInfo(), { code: 'CONNECTION_FAILED' });
  f.setInfo(fail('TIMEOUT', { started: false }));
  await assert.rejects(f.device.refreshInfo(), { code: 'TIMEOUT' });
  f.setInfo(async () => declaredInfo());
  await f.device.refreshInfo();
  assert.deepEqual(events, []);
  f.setInfo(fail('CONNECTION_REFUSED'));
  await assert.rejects(f.device.refreshInfo(), { code: 'CONNECTION_REFUSED' });
  await assert.rejects(f.device.refreshInfo(), { code: 'CONNECTION_REFUSED' });
  f.setInfo(async () => declaredInfo());
  await Promise.all([f.device.refreshInfo(), f.device.refreshInfo()]);
  await f.device.refreshInfo();
  assert.deepEqual(events, [{ checked_at: CHECKED_AT }]);
});
