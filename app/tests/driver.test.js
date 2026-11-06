'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIRECTORY = path.resolve(__dirname, '../drivers/frameo');
const SOURCE = fs.readFileSync(path.join(DIRECTORY, 'driver.js'), 'utf8');
const PEER = 'ab'.repeat(32);
const OTHER_PEER = 'cd'.repeat(32);
const FIXTURE_SECRET = '11'.repeat(32); // Synthetic fixture only; never used by an engine.
const clone = value => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ onPair, onInfo } = {}) {
  const loaded = { exports: {} };
  const localRequire = name => {
    if (name === 'homey') return { Driver: class {} };
    throw Error('Unexpected driver dependency: ' + name);
  };
  // Run the real driver with no SDK connection, process, or network implementation.
  new Function('require', 'module', 'exports', '__dirname', SOURCE)(localRequire, loaded, loaded.exports, DIRECTORY);
  const driver = new loaded.exports();
  const calls = [], devices = [];
  const defaultInfo = () => ({ peer: PEER, name: 'Frameo réel', width: 2000, height: 1200,
    mayView: false, mayManage: false, private_key: FIXTURE_SECRET });
  const app = {
    async waitUntilReady() { calls.push({ operation: 'ready' }); },
    async pairFrame(code, senderName, mode) {
      calls.push({ operation: 'pair', code, senderName, mode });
      if (onPair) return onPair(code, senderName, mode);
      return { name: 'Family frame', data: { id: PEER.toUpperCase(), private: FIXTURE_SECRET },
        config: { private_key: FIXTURE_SECRET }, store: { private_key: FIXTURE_SECRET },
        settings: { internal: FIXTURE_SECRET } };
    },
    engine: {
      async info(peer, options) {
        calls.push({ operation: 'info', peer, ...(options ? { options: clone(options) } : {}) });
        return onInfo ? onInfo(peer, options) : defaultInfo();
      },
      async permission() { assert.fail('An onboarding information check must not request permissions'); },
      async sendUrl() { assert.fail('Onboarding must not send a photo'); },
      async sendImage() { assert.fail('Onboarding must not send a photo'); },
    },
  };
  driver.homey = { __: key => key, app };
  driver.getDevices = () => devices;
  function session() {
    const handlers = new Map();
    return {
      handlers,
      setHandler(event, handler) { assert(!handlers.has(event), 'A pairing handler was registered twice'); handlers.set(event, handler); },
      async emit(event, input) { assert(handlers.has(event), 'Pairing handler missing: ' + event); return handlers.get(event)(input); },
    };
  }
  function device({ peer = PEER, mode = 'send', senderName = 'Homey salon' } = {}) {
    const data = { id: peer };
    const settings = { sender_name: senderName, photo_access_mode: mode };
    const store = new Map([['peer', peer], ['access_mode_initialized', true]]);
    const settingWrites = [], storeWrites = [], modeWrites = [];
    const item = {
      settings, store, settingWrites, storeWrites, modeWrites, lastInfo: defaultInfo(),
      getData: () => data,
      getName: () => 'Cadre Homey existant',
      getSetting: key => settings[key],
      accessMode: () => settings.photo_access_mode,
      async setAccessMode(value) {
        assert(['send', 'manage'].includes(value));
        settings.photo_access_mode = value; modeWrites.push(value);
      },
      async setSettings(values) { Object.assign(settings, clone(values)); settingWrites.push(clone(values)); },
      async setStoreValue(key, value) { store.set(key, value); storeWrites.push({ key, value }); },
      async refreshInfo() { item.lastInfo = await app.engine.info(peer); return item.lastInfo; },
      async requestPermission() { assert.fail('The manual guide must not trigger an automatic request'); },
      async sendUrl() { assert.fail('Repair must not send a photo'); },
      async sendImage() { assert.fail('Repair must not send a photo'); },
    };
    return item;
  }
  return { driver, app, calls, devices, session, device };
}

test('ordinary onboarding defaults to send and returns only the public candidate with an initialized mode', async () => {
  const f = fixture(), session = f.session(); await f.driver.onPair(session);
  const candidate = await session.emit('pair_frame', { code: '12 34-56 78 90', senderName: '  Maison é😀  ' });
  assert.deepEqual(candidate, { name: 'Family frame', data: { id: PEER },
    store: { peer: PEER, access_mode_initialized: true },
    settings: { sender_name: 'Maison é😀', photo_access_mode: 'send' } });
  assert.deepEqual(f.calls, [{ operation: 'ready' }, { operation: 'pair', code: '1234567890', senderName: 'Maison é😀', mode: 'send' }]);
  assert(!JSON.stringify(candidate).includes(FIXTURE_SECRET));
  assert(!Object.hasOwn(candidate, 'mayView') && !Object.hasOwn(candidate, 'mayManage'));
});

test('manage onboarding records local intent without an automatic popup, information request, or image', async () => {
  const f = fixture(), session = f.session(); await f.driver.onPair(session);
  const candidate = await session.emit('pair_frame', { code: '1234567890', senderName: 'Homey', mode: 'manage' });
  assert.equal(candidate.settings.photo_access_mode, 'manage');
  assert.equal(candidate.store.access_mode_initialized, true);
  assert.deepEqual(f.calls.filter(call => call.operation !== 'ready'),
    [{ operation: 'pair', code: '1234567890', senderName: 'Homey', mode: 'manage' }]);
});

test('invalid mode, code, or sender is rejected before readiness checks or engine pairing', async () => {
  const f = fixture(), session = f.session(); await f.driver.onPair(session);
  for (const mode of ['', 'gallery', 'MANAGE', false, null, {}]) {
    await assert.rejects(session.emit('pair_frame', { code: '1234567890', senderName: 'Homey', mode }),
      { message: 'errors.access_mode_invalid' });
  }
  for (const input of [null, [], {}, { code: 'bad' }, { code: '1234567890', senderName: 'Homey\ninvalid' }]) {
    await assert.rejects(session.emit('pair_frame', input));
  }
  assert.deepEqual(f.calls, []);
});

test('a pairing view cannot inspect an arbitrary frame before or after its own pairing', async () => {
  const f = fixture(), session = f.session(); await f.driver.onPair(session);
  await assert.rejects(session.emit('check_permissions', { peer: PEER }), { message: 'errors.wrong_frame' });
  await assert.rejects(session.emit('get_access_state', { peer: PEER }), { message: 'errors.wrong_frame' });
  assert.deepEqual(f.calls, []);
  await session.emit('pair_frame', { code: '1234567890', senderName: 'Homey', mode: 'manage' });
  const before = f.calls.length;
  await assert.rejects(session.emit('check_permissions', { peer: OTHER_PEER }), { message: 'errors.wrong_frame' });
  await assert.rejects(session.emit('get_access_state', { peer: OTHER_PEER, mode: 'manage' }), { message: 'errors.wrong_frame' });
  assert.equal(f.calls.length, before);
});

test('checking the paired candidate uses only info and never coerces absent or string permissions into grants', async () => {
  const f = fixture({ onInfo: async () => ({ name: 'Frameo réel', mayView: true, mayManage: 'true', private_key: FIXTURE_SECRET }) });
  const session = f.session(); await f.driver.onPair(session);
  await session.emit('pair_frame', { code: '1234567890', senderName: 'Homey famille', mode: 'manage' });
  const before = f.calls.length;
  const state = await session.emit('check_permissions', { peer: PEER });
  assert.deepEqual(f.calls.slice(before), [{ operation: 'ready' }, { operation: 'info', peer: PEER, options: { name: 'Homey famille' } }]);
  assert.deepEqual(state, { peer: PEER, name: 'Frameo réel', senderName: 'Homey famille', mode: 'manage', mayView: true, mayManage: false });
  assert(!JSON.stringify(state).includes(FIXTURE_SECRET));
});

test('after device creation the permission guide refreshes that same device without changing its settings', async () => {
  const f = fixture(), session = f.session(); await f.driver.onPair(session);
  await session.emit('pair_frame', { code: '1234567890', senderName: 'Homey salon', mode: 'manage' });
  const device = f.device({ mode: 'manage' }); f.devices.push(device);
  const before = f.calls.length;
  const state = await session.emit('check_permissions', { peer: PEER });
  assert.deepEqual(f.calls.slice(before), [{ operation: 'info', peer: PEER }]);
  assert.equal(state.peer, device.getData().id);
  assert.equal(state.mayView, false); assert.equal(state.mayManage, false);
  assert.deepEqual(device.settingWrites, []); assert.deepEqual(device.storeWrites, []); assert.deepEqual(device.modeWrites, []);
});

test('repair can open a manual management guide by changing only local mode intent and reading information', async () => {
  const f = fixture(), session = f.session(), device = f.device(); f.devices.push(device);
  await f.driver.onRepair(session, device);
  const originalPeer = device.getData().id;
  const state = await session.emit('get_access_state', { mode: 'manage' });
  assert.equal(state.peer, originalPeer); assert.equal(device.getData().id, originalPeer);
  assert.equal(state.senderName, 'Homey salon'); assert.equal(state.mode, 'manage');
  assert.equal(state.mayView, false); assert.equal(state.mayManage, false);
  assert.deepEqual(device.modeWrites, ['manage']);
  assert.deepEqual(device.storeWrites, []); assert.deepEqual(device.settingWrites, []);
  assert.deepEqual(f.calls, [{ operation: 'info', peer: PEER }]);
  const count = f.calls.length;
  await assert.rejects(session.emit('check_permissions', { peer: OTHER_PEER }), { message: 'errors.wrong_frame' });
  assert.equal(f.calls.length, count);
});

test('a repair re-pairs only the existing frame and stores the chosen mode without replacing the device', async () => {
  const f = fixture(), session = f.session(), device = f.device(); f.devices.push(device);
  await f.driver.onRepair(session, device);
  const originalData = device.getData();
  const result = await session.emit('pair_frame', { code: '1234567890', senderName: 'Nouvel expéditeur', mode: 'manage' });
  assert.equal(device.getData(), originalData);
  assert.equal(f.devices.length, 1);
  assert.deepEqual(device.settingWrites, [{ sender_name: 'Nouvel expéditeur', photo_access_mode: 'manage' }]);
  assert.deepEqual(device.storeWrites, [{ key: 'peer', value: PEER }]);
  assert.deepEqual(result, { repaired: true, peer: PEER, senderName: 'Nouvel expéditeur', mode: 'manage',
    name: 'Cadre Homey existant', mayView: false, mayManage: false });
  assert.deepEqual(f.calls.filter(call => call.operation !== 'ready').map(call => call.operation), ['pair', 'info']);
});

test('repairing with a code for another frame cannot change the existing device or its mode', async () => {
  const f = fixture({ onPair: async () => ({ name: 'Different frame', data: { id: OTHER_PEER } }) });
  const session = f.session(), device = f.device(); f.devices.push(device);
  await f.driver.onRepair(session, device);
  await assert.rejects(session.emit('pair_frame', { code: '1234567890', mode: 'manage' }), { message: 'errors.wrong_frame' });
  assert.equal(device.getData().id, PEER); assert.equal(device.accessMode(), 'send');
  assert.deepEqual(device.settingWrites, []); assert.deepEqual(device.storeWrites, []); assert.deepEqual(device.modeWrites, []);
  assert.equal(f.calls.filter(call => call.operation === 'info').length, 0);
});

test('an in-flight info request locks all session operations and a disconnected view cannot do more work', async () => {
  const gate = deferred();
  const f = fixture({ onInfo: () => gate.promise }), session = f.session(); await f.driver.onPair(session);
  await session.emit('pair_frame', { code: '1234567890', mode: 'manage' });
  const pending = session.emit('check_permissions', { peer: PEER });
  await assert.rejects(session.emit('check_permissions', { peer: PEER }), { message: 'errors.busy' });
  await assert.rejects(session.emit('pair_frame', { code: '1234567890' }), { message: 'errors.busy' });
  gate.resolve({ name: 'Frameo', mayView: true, mayManage: true }); await pending;
  assert.equal(f.calls.filter(call => call.operation === 'info').length, 1);
  await session.emit('disconnect');
  const count = f.calls.length;
  await assert.rejects(session.emit('get_access_state', { peer: PEER }), { message: 'errors.busy' });
  await assert.rejects(session.emit('pair_frame', { code: '1234567890' }), { message: 'errors.busy' });
  assert.equal(f.calls.length, count);
});

test('a failed read exposes only a translated error and releases the session lock for retry', async () => {
  let attempt = 0;
  const f = fixture({ onInfo: async () => {
    if (++attempt === 1) throw Object.assign(Error('private native trace ' + FIXTURE_SECRET), { code: 'TIMEOUT' });
    return { name: 'Frameo', mayView: true, mayManage: true };
  } });
  const session = f.session(); await f.driver.onPair(session);
  await session.emit('pair_frame', { code: '1234567890', mode: 'manage' });
  await assert.rejects(session.emit('check_permissions', { peer: PEER }), { message: 'errors.timeout' });
  const result = await session.emit('check_permissions', { peer: PEER });
  assert.equal(result.mayView, true); assert.equal(result.mayManage, true);
  assert(!JSON.stringify(result).includes(FIXTURE_SECRET));
});
