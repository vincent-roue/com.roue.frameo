'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, translations } = require('../widgets/frameo/public/widget');

const ROOT = path.resolve(__dirname, '../widgets/frameo');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/widget.css'), 'utf8');
const compose = JSON.parse(fs.readFileSync(path.join(ROOT, 'widget.compose.json'), 'utf8'));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const PEER = 'ab'.repeat(32);
// A synthetic white 1 x 1 JPEG, never a user's photograph.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==', 'base64');
const photo = overrides => ({ mediaId: '1', name: 'Cadre du salon', mime: 'image/jpeg', data: JPEG.toString('base64'), bytes: JPEG.length, width: 1, height: 1, ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
const autoSettings = overrides => ({ frame: { id: PEER, name: 'Mon cadre' }, format: 'square', auto_change: true, interval_minutes: 1, ...overrides });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

class Element {
  constructor() { this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.src = ''; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  async dispatch(name, extra = {}) {
    if (name === 'click' && this.disabled && !extra.force) return;
    for (const fn of this.listeners.get(name) || []) await fn({ target: this, preventDefault() {}, ...extra });
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  set innerHTML(_) { assert.fail('Widget text must never be parsed as HTML'); }
}

class FakeClock {
  constructor() { this.now = 0; this.nextId = 0; this.timers = new Map(); }
  setTimeout(callback, delay) {
    assert(Number.isFinite(delay) && delay >= 0);
    const id = ++this.nextId; this.timers.set(id, { callback, at: this.now + delay }); return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(duration) {
    const target = this.now + duration;
    for (let iterations = 0; iterations < 1000; iterations++) {
      const pending = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) { this.now = target; await tick(); return; }
      this.now = pending[1].at; this.timers.delete(pending[0]); pending[1].callback(); await tick();
    }
    assert.fail('Timers must never create a catch-up burst');
  }
}

function setup({ settings = { frame: { id: PEER, name: 'Mon cadre' }, format: 'square' }, language = 'fr', navigatorLanguage,
  handler = async () => photo(), translate = key => key, clock = new FakeClock(), hidden = false, intersections = false, fixedFormat = 'square', requestTimeoutMs } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const document = new Element();
  Object.assign(document, { documentElement: { lang: '' }, getElementById: id => elements[id], hidden, visibilityState: hidden ? 'hidden' : 'visible' });
  const window = new Element();
  window.navigator = { language: navigatorLanguage || language };
  window.atob = globalThis.atob; window.btoa = globalThis.btoa; window.Blob = Blob;
  const calls = [], ready = [], liveUrls = new Map(), created = [], revoked = [], events = new Map();
  window.URL = {
    createObjectURL(blob) {
      assert.equal(liveUrls.size, 0, 'At most one browser Blob URL may remain live');
      const url = 'blob:synthetic-frameo-' + (created.length + 1); created.push({ url, blob }); liveUrls.set(url, blob); return url;
    },
    revokeObjectURL(url) { assert(liveUrls.has(url), 'Blob URLs must not be released twice'); revoked.push(url); liveUrls.delete(url); },
  };
  window.setInterval = () => assert.fail('Rotation must use one bounded delay, never a polling interval');
  window.setTimeout = (callback, delay) => clock.setTimeout(callback, delay);
  window.clearTimeout = id => clock.clearTimeout(id);
  const observers = [];
  if (intersections) window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  };
  const Homey = {
    __: translate, getSettings: () => settings, on: (event, callback) => events.set(event, callback),
    ready: options => ready.push(options),
    async api(method, route, body) { const call = { method, route, body }; calls.push(call); return handler(call); },
    popup: () => assert.fail('Widget must not open authorization or pairing'),
  };
  const ui = create({ Homey, document, window, language, format: fixedFormat, requestTimeoutMs });
  return { ui, elements, window, document, calls, ready, created, revoked, liveUrls, clock, observers, events,
    async setVisible(visible) { document.hidden = !visible; document.visibilityState = visible ? 'visible' : 'hidden'; await document.dispatch('visibilitychange'); await tick(); },
    async intersect(visible) { for (const observer of observers) observer.callback([{ target: observer.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]); await tick(); },
    decode() { assert.equal(typeof elements.photo.onload, 'function'); elements.photo.onload(); } };
}

test('the existing catalogue widget stays square and fixed formats defer sizing to their manifest rather than old settings', async () => {
  assert.equal(compose.settings.find(setting => setting.id === 'frame').type, 'autocomplete');
  assert.equal(Object.hasOwn(compose, 'devices'), false);
  assert.equal(compose.height, '100%');
  assert.deepEqual(compose.api, { getPhoto: { method: 'GET', path: '/photo' }, nextPhoto: { method: 'POST', path: '/next' } });
  assert.deepEqual(compose.settings.map(setting => setting.id), ['frame', 'auto_change', 'interval_minutes']);
  assert.match(html, /format: 'square'/);
  assert.equal(compose.settings.find(setting => setting.id === 'auto_change').value, false);
  const interval = compose.settings.find(setting => setting.id === 'interval_minutes');
  assert.deepEqual([interval.value, interval.min, interval.max], [5, 1, 1440]);
  for (const label of [compose.name, ...compose.settings.flatMap(setting => [setting.title, setting.hint, ...(setting.values || []).map(value => value.title)]).filter(Boolean)]) {
    assert.deepEqual(Object.keys(label).sort(), ['de', 'en', 'fr', 'nl']);
    assert(Object.values(label).every(value => typeof value === 'string' && value.length));
  }
  for (const fixedFormat of ['compact', 'square', 'portrait']) {
    const f = setup({ settings: { format: 'invalid-legacy-setting' }, fixedFormat }); await f.ui.init();
    assert.deepEqual(f.ready, [undefined], 'Fixed catalogue entries must never override the manifest height');
    assert.equal(f.elements.widget.dataset.format, fixedFormat);
    assert.deepEqual(f.calls, []); f.ui.destroy();
  }
});

test('legacy callers without a fixed catalogue format retain their former aspect-ratio behavior', async () => {
  for (const [format, height] of [['compact', '65%'], ['square', '100%'], ['portrait', '135%'], ['invalid', '100%']]) {
    const f = setup({ settings: { format }, fixedFormat: null }); await f.ui.init();
    assert.deepEqual(f.ready, [{ height }]); assert.deepEqual(f.calls, []); f.ui.destroy();
  }
});

test('missing or malformed frame selection shows a useful state and never calls the backend', async () => {
  for (const frame of [undefined, null, PEER, {}, { id: 'https://private.example/photo.jpg' }, { id: 'ab'.repeat(33) }]) {
    const f = setup({ settings: { frame } }); await f.ui.init(); await f.elements['next-photo'].dispatch('click', { force: true });
    assert.equal(f.elements.widget.dataset.state, 'no_frame');
    assert.equal(f.elements['state-title'].textContent, translations.fr.no_frame_title);
    assert.equal(f.elements['next-photo'].disabled, true); assert.deepEqual(f.calls, []); assert.equal(f.created.length, 0); f.ui.destroy();
  }
});

test('initial view reads once, decodes one private Blob and never rotates or lists photos by itself', async () => {
  const f = setup(); await f.ui.init();
  assert.deepEqual(f.calls, [{ method: 'GET', route: '/photo?deviceId=' + PEER, body: {} }]);
  assert.equal(f.ready.length, 1); assert.equal(f.elements['next-label'].textContent, 'Changer la photo');
  assert.equal(f.created.length, 1); assert.equal(f.created[0].blob.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await f.created[0].blob.arrayBuffer()), JPEG);
  assert.equal(f.elements.photo.src, f.created[0].url); assert.equal(f.elements.photo.hidden, true);
  f.decode(); assert.equal(f.elements.photo.hidden, false); assert.equal(f.elements.state.hidden, true);
  await f.ui.init(); await tick(); assert.equal(f.calls.length, 1, 'Repeated lifecycle initialization must not choose another photo');
  f.ui.destroy(); assert.equal(f.liveUrls.size, 0);
});

test('the visible next-photo button submits only the selected frame and coalesces repeated taps until the response', async () => {
  const next = deferred();
  const f = setup({ handler: call => call.method === 'POST' ? next.promise : photo() });
  await f.ui.init(); f.decode();
  const updating = f.elements['next-photo'].dispatch('click'); await tick();
  assert.equal(f.elements['next-photo'].disabled, true);
  await f.elements['next-photo'].dispatch('click', { force: true });
  assert.deepEqual(f.calls[1], { method: 'POST', route: '/next', body: { deviceId: PEER } }); assert.equal(f.calls.length, 2);
  assert.equal(f.created.length, 1, 'An in-flight replacement must not allocate a second image');
  next.resolve(photo({ name: '<img src=x onerror=alert(1)>' })); await updating;
  assert.deepEqual(f.revoked, [f.created[0].url]); assert.equal(f.liveUrls.size, 1);
  assert.equal(f.elements['frame-name'].textContent, '<img src=x onerror=alert(1)>');
  f.decode(); assert.equal(f.elements.photo.hidden, false); assert.equal(f.elements['next-photo'].disabled, false);
  f.ui.destroy(); assert.equal(f.revoked.length, 2);
});

test('successive rapid clicks after each decoded photo keep submitting next and replace the visible Blob without reinitializing', async () => {
  let selection = 0;
  const selectedBytes = [];
  const f = setup({ handler: async () => {
    // Distinct complete JPEG payloads: add a legal JPEG comment marker to the
    // synthetic image so each response and displayed source can be identified.
    const comment = Buffer.from('synthetic-selection-' + (++selection));
    const marker = Buffer.from([255, 254, 0, comment.length + 2]);
    const bytes = Buffer.concat([JPEG.subarray(0, 2), marker, comment, JPEG.subarray(2)]);
    selectedBytes.push(bytes);
    return photo({ data: bytes.toString('base64'), bytes: bytes.length });
  } });
  await f.ui.init(); f.decode();
  assert.equal(f.elements.photo.hidden, false);
  const original = f.created[0].url;
  for (let next = 1; next <= 4; next++) {
    const previous = f.elements.photo.src;
    await f.elements['next-photo'].dispatch('click');
    assert.deepEqual(f.calls[next], { method: 'POST', route: '/next', body: { deviceId: PEER } });
    assert.notEqual(f.elements.photo.src, previous);
    assert.equal(f.created.length, next + 1);
    assert.deepEqual(Buffer.from(await f.created[next].blob.arrayBuffer()), selectedBytes[next]);
    assert.notDeepEqual(selectedBytes[next], selectedBytes[next - 1]);
    assert.equal(f.revoked.at(-1), previous);
    assert.equal(f.liveUrls.size, 1);
    assert.equal(f.elements.widget.dataset.state, 'loading');
    f.decode();
    assert.equal(f.elements.photo.hidden, false);
    assert.equal(f.elements.state.hidden, true);
    assert.equal(f.elements.widget.dataset.state, 'photo');
    assert.equal(f.elements['next-photo'].disabled, false);
    assert.equal(f.elements['next-label'].textContent, 'Changer la photo');
  }
  assert.equal(f.clock.now, 0, 'Rapid successful clicks need no artificial delay');
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 4);
  assert.equal(f.ready.length, 1, 'The existing widget instance must remain usable');
  assert.equal(f.revoked[0], original);
  f.ui.destroy(); assert.equal(f.liveUrls.size, 0); assert.equal(f.revoked.length, 5);
});

test('known backend errors have recoverable states without opening permissions or showing raw diagnostics', async () => {
  for (const [code, state] of [['ACCESS_MODE_SEND', 'send'], ['PERMISSION_REQUIRED', 'permission'], ['MEDIA_NOT_FOUND', 'empty'],
    ['FRAME_UNAVAILABLE', 'offline'], ['TIMEOUT', 'offline'], ['ENGINE_NOT_READY', 'offline'], ['BUSY', 'busy'], ['QUEUE_FULL', 'busy'],
    ['WIDGET_DEVICE_INVALID', 'no_frame'], ['PRIVATE_NATIVE_TRACE', 'error'], ['toString', 'error']]) {
    const f = setup({ handler: async () => { throw Object.assign(Error('PRIVATE_NATIVE_TRACE'), { code }); } }); await f.ui.init();
    assert.equal(f.elements.widget.dataset.state, state, code);
    assert.equal(f.elements.photo.src, ''); assert.equal(f.created.length, 0);
    assert(!f.elements['state-title'].textContent.includes('PRIVATE'));
    assert(!f.elements['state-hint'].textContent.includes('PRIVATE'));
    assert.equal(f.elements['next-photo'].disabled, state === 'no_frame');
    assert.equal(f.calls.length, 1, 'A failure must not retry automatically'); f.ui.destroy();
  }
});

test('revoked permissions clear the displayed image immediately and an explicit retry may recover', async () => {
  let allowed = true;
  const f = setup({ handler: async () => { if (!allowed) throw { code: 'PERMISSION_REQUIRED' }; return photo(); } });
  await f.ui.init(); f.decode(); allowed = false;
  await f.elements['next-photo'].dispatch('click');
  assert.equal(f.elements.widget.dataset.state, 'permission'); assert.equal(f.elements.photo.src, ''); assert.equal(f.liveUrls.size, 0);
  assert.equal(f.revoked.length, 1); allowed = true;
  await f.elements['next-photo'].dispatch('click'); f.decode();
  assert.equal(f.elements.widget.dataset.state, 'photo'); assert.equal(f.calls.length, 3); f.ui.destroy();
});

test('controlled JSON error envelopes use the same states when Homey does not retain rejection codes', async () => {
  for (const [code, state] of [['PERMISSION_REQUIRED', 'permission'], ['ACCESS_MODE_SEND', 'send'], ['MEDIA_NOT_FOUND', 'empty'], ['TIMEOUT', 'offline'], ['PRIVATE_TRACE', 'error']]) {
    const f = setup({ handler: async () => ({ error: { code, message: 'PRIVATE_TRACE' }, data: 'https://private.example/image.jpg' }) });
    await f.ui.init();
    assert.equal(f.elements.widget.dataset.state, state);
    assert.equal(f.elements['next-label'].textContent, 'Réessayer');
    assert.equal(f.created.length, 0);
    assert(!f.elements['state-hint'].textContent.includes('PRIVATE_TRACE'));
    assert.equal(f.calls.length, 1); f.ui.destroy();
  }
});

test('unsafe MIME, external data, inconsistent byte counts and dimensions are rejected before creating a browser image', async () => {
  for (const invalid of [photo({ mime: 'image/svg+xml' }), photo({ mime: 'image/webp' }), photo({ data: 'https://private.example/photo.jpg' }),
    photo({ bytes: JPEG.length + 1 }), photo({ data: JPEG.toString('base64') + '\n' }), photo({ width: 0 }), photo({ width: 2049 }),
    photo({ width: 2001, height: 2001 }), photo({ data: Buffer.from('<svg/>').toString('base64'), bytes: 6 })]) {
    const f = setup({ handler: async () => invalid }); await f.ui.init();
    assert.equal(f.created.length, 0); assert.equal(f.elements.widget.dataset.state, 'error'); assert.equal(f.elements.photo.src, ''); f.ui.destroy();
  }
});

test('image decode errors revoke their Blob and late callbacks cannot replace a newer photo', async () => {
  const f = setup(); await f.ui.init(); const stale = f.elements.photo.onload;
  await f.elements['next-photo'].dispatch('click');
  stale(); assert.equal(f.elements.widget.dataset.state, 'loading');
  f.elements.photo.onerror(); assert.equal(f.liveUrls.size, 0); assert.equal(f.elements.widget.dataset.state, 'error');
  assert.equal(f.revoked.length, 2); f.ui.destroy();
});

test('destroy releases the single Blob, removes listeners and ignores a response arriving after page removal', async () => {
  const next = deferred(); const f = setup({ handler: call => call.method === 'POST' ? next.promise : photo() });
  await f.ui.init(); f.decode(); const updating = f.elements['next-photo'].dispatch('click'); await tick();
  await f.window.dispatch('pagehide'); assert.equal(f.liveUrls.size, 0);
  assert.equal(f.elements['next-photo'].listeners.get('click').size, 0);
  assert.equal(f.document.listeners.get('visibilitychange').size, 0);
  assert.equal(f.window.listeners.get('pageshow').size, 0);
  next.resolve(photo()); await updating; assert.equal(f.created.length, 1); assert.equal(f.elements.photo.src, '');
  f.ui.destroy(); await f.window.dispatch('unload'); assert.equal(f.revoked.length, 1);
});

test('automatic changes stay disabled by default and invalid opt-ins never start a timer or prevent manual changes', async () => {
  const disabled = [{ auto_change: false }, { auto_change: undefined }, { auto_change: 'true' }, { auto_change: 1 },
    ...[undefined, null, '5', 0, -1, 1441, 1.5, Infinity, NaN].map(interval_minutes => ({ interval_minutes }))];
  for (const invalid of disabled) {
    const f = setup({ settings: autoSettings(invalid) }); await f.ui.init(); f.decode();
    assert.equal(f.clock.timers.size, 0);
    await f.clock.advance(2 * 24 * 60 * 60000); assert.equal(f.calls.length, 1);
    await f.elements['next-photo'].dispatch('click'); f.decode();
    assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0); f.ui.destroy();
  }
});

test('enabled rotation waits for a displayed photo and sends one next request at the configured minimum or maximum interval', async () => {
  for (const interval_minutes of [1, 1440]) {
    const f = setup({ settings: autoSettings({ interval_minutes }) }); await f.ui.init();
    const interval = interval_minutes * 60000;
    await f.clock.advance(interval * 2); assert.equal(f.calls.length, 1, 'No rotation before the image has decoded');
    f.decode(); assert.equal(f.clock.timers.size, 1);
    await f.clock.advance(interval - 1); assert.equal(f.calls.length, 1);
    await f.clock.advance(1);
    assert.deepEqual(f.calls[1], { method: 'POST', route: '/next', body: { deviceId: PEER } });
    assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0, 'The replacement must decode before another delay starts');
    f.decode(); assert.equal(f.clock.timers.size, 1);
    assert.equal(f.liveUrls.size, 1); f.ui.destroy(); assert.equal(f.clock.timers.size, 0); assert.equal(f.liveUrls.size, 0);
  }
});

test('a successful manual change resets the next automatic deadline by a full interval', async () => {
  const f = setup({ settings: autoSettings({ interval_minutes: 5 }) }); await f.ui.init(); f.decode();
  await f.clock.advance(4 * 60000); assert.equal(f.calls.length, 1);
  await f.elements['next-photo'].dispatch('click'); f.decode(); assert.equal(f.calls.length, 2);
  await f.clock.advance(60000); assert.equal(f.calls.length, 2, 'The old five-minute deadline must have been cancelled');
  await f.clock.advance(4 * 60000 - 1); assert.equal(f.calls.length, 2);
  await f.clock.advance(1); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].method, 'POST'); f.ui.destroy();
});

test('hidden documents release pixels and revalidate once on return before a full automatic interval', async () => {
  const f = setup({ settings: autoSettings(), hidden: true }); await f.ui.init();
  assert.equal(f.calls.length, 0);
  await f.clock.advance(600000); assert.equal(f.calls.length, 0);
  await f.setVisible(true); assert.equal(f.calls.length, 1); f.decode();
  await f.clock.advance(10000); await f.setVisible(false); assert.equal(f.clock.timers.size, 0); assert.equal(f.liveUrls.size, 0);
  await f.clock.advance(7200000); assert.equal(f.calls.length, 1);
  await f.setVisible(true); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].method, 'GET'); f.decode();
  await f.clock.advance(59999); assert.equal(f.calls.length, 2);
  await f.clock.advance(1); assert.equal(f.calls.length, 3); assert.equal(f.calls[2].method, 'POST'); f.decode();
  await f.window.dispatch('pagehide', { persisted: true }); assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(86400000); assert.equal(f.calls.length, 3);
  await f.window.dispatch('pageshow', { persisted: true }); await tick();
  assert.equal(f.calls.length, 4); assert.equal(f.calls[3].method, 'GET'); f.decode();
  await f.clock.advance(59999); assert.equal(f.calls.length, 4);
  await f.clock.advance(1); assert.equal(f.calls.length, 5); f.ui.destroy();
});

test('offscreen widgets defer work, release pixels and revalidate on return without background polling', async () => {
  const f = setup({ settings: autoSettings(), intersections: true }); await f.ui.init();
  assert.equal(f.calls.length, 0); await f.clock.advance(3600000); assert.equal(f.calls.length, 0);
  await f.intersect(true); assert.equal(f.calls.length, 1); f.decode();
  await f.intersect(false); assert.equal(f.clock.timers.size, 0); assert.equal(f.liveUrls.size, 0);
  await f.clock.advance(3600000); assert.equal(f.calls.length, 1);
  await f.intersect(true); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].method, 'GET'); f.decode();
  await f.clock.advance(59999); assert.equal(f.calls.length, 2);
  await f.clock.advance(1); assert.equal(f.calls.length, 3); f.decode();
  f.ui.destroy(); assert.equal(f.observers[0].disconnected, true); assert.equal(f.clock.timers.size, 0);
  await f.intersect(true); await f.clock.advance(3600000); assert.equal(f.calls.length, 3);
});

test('a slow automatic request coalesces taps and cannot queue changes before its finite deadline', async () => {
  const pending = deferred();
  const f = setup({ settings: autoSettings(), handler: call => call.method === 'POST' ? pending.promise : photo() });
  await f.ui.init(); f.decode(); await f.clock.advance(60000); assert.equal(f.calls.length, 2);
  assert.equal(f.elements['next-photo'].disabled, true); assert.equal(f.clock.timers.size, 1, 'Only the request deadline remains');
  await f.elements['next-photo'].dispatch('click', { force: true }); await f.clock.advance(44000);
  assert.equal(f.calls.length, 2); assert.equal(f.elements['next-photo'].disabled, true);
  pending.resolve(photo()); await tick(); f.decode();
  await f.clock.advance(59999); assert.equal(f.calls.length, 2);
  await f.clock.advance(1); assert.equal(f.calls.length, 3);
  f.ui.destroy();
});

test('automatic errors or busy responses stop rotation until a successful manual retry', async () => {
  for (const code of ['BUSY', 'TIMEOUT', 'PERMISSION_REQUIRED', 'MEDIA_NOT_FOUND']) {
    let recovered = false;
    const f = setup({ settings: autoSettings(), handler: call => call.method === 'GET' || recovered ? photo() : { error: { code } } });
    await f.ui.init(); f.decode(); await f.clock.advance(60000);
    assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0);
    assert.equal(f.elements['next-photo'].disabled, false); assert.equal(f.liveUrls.size, 0);
    await f.clock.advance(24 * 60 * 60000); await f.setVisible(false); await f.setVisible(true);
    assert.equal(f.calls.length, 2); assert.equal(f.clock.timers.size, 0, 'Visibility changes must not retry a failed automatic operation');
    recovered = true; await f.elements['next-photo'].dispatch('click'); f.decode();
    assert.equal(f.calls.length, 3); assert.equal(f.clock.timers.size, 1);
    await f.clock.advance(60000); assert.equal(f.calls.length, 4); f.ui.destroy();
  }
});

test('all four languages have complete fallback text and Homey language takes precedence over browser language', async () => {
  for (const language of ['fr', 'en', 'nl', 'de']) {
    assert.deepEqual(Object.keys(translations[language]).sort(), Object.keys(translations.en).sort());
    assert(Object.values(translations[language]).every(value => typeof value === 'string' && value.length));
    const f = setup({ settings: {}, language: 'fr', navigatorLanguage: 'fr-FR', translate: key => key === 'widgets.frameo.language' ? language : key });
    await f.ui.init(); assert.equal(f.document.documentElement.lang, language);
    assert.equal(f.elements['next-label'].textContent, translations[language].next);
    assert.equal(f.elements['state-title'].textContent, translations[language].no_frame_title); f.ui.destroy();
  }
  const english = setup({ settings: {}, language: 'en' }); await english.ui.init();
  assert.equal(english.document.documentElement.lang, 'en'); assert.equal(english.elements['next-label'].textContent, 'Change photo'); english.ui.destroy();
  const translated = setup({ settings: {}, translate: key => key === 'widgets.frameo.no_frame_title' ? 'Cadre personnalisé' : key }); await translated.ui.init();
  assert.equal(translated.elements['state-title'].textContent, 'Cadre personnalisé'); translated.ui.destroy();
});

test('layout keeps a single contained image and a separate visible control for all formats and Homey themes', () => {
  assert.equal((html.match(/<img\b/g) || []).length, 1);
  assert.match(html, /id="next-photo"/); assert.doesNotMatch(html, /<iframe|<video|\/homey\.js|https?:\/\//);
  assert.match(css, /object-fit:\s*contain/); assert.match(css, /grid-template-rows:\s*26px minmax\(0, 1fr\) 42px/);
  assert.match(css, /prefers-color-scheme:\s*dark/); assert.match(css, /\.homey-dark-mode/); assert.match(css, /--homey-background-color/);
  assert.equal(new Set(ids).size, ids.length);
});

test('a never-settling request times out after 45 seconds, permits only manual retry and ignores its late response', async () => {
  const old = deferred(); let calls = 0;
  const f = setup({ settings: autoSettings(), handler: () => ++calls === 1 ? old.promise : photo({ mediaId: '2' }) });
  const opening = f.ui.init(); await tick();
  await f.clock.advance(44999); assert.equal(f.elements['next-photo'].disabled, true);
  await f.clock.advance(1); await opening;
  assert.equal(f.elements.widget.dataset.state, 'timeout');
  assert.equal(f.elements['state-title'].textContent, translations.fr.timeout_title);
  assert.equal(f.elements['next-photo'].disabled, false);
  assert.equal(f.clock.timers.size, 0);
  await f.clock.advance(86400000); assert.equal(f.calls.length, 1, 'Timeout must never auto retry');
  await f.elements['next-photo'].dispatch('click'); f.decode();
  const current = f.elements.photo.src;
  old.resolve(photo({ mediaId: '1', name: 'Stale response' })); await tick();
  assert.equal(f.elements.photo.src, current); assert.equal(f.created.length, 1);
  assert.equal(f.elements.widget.dataset.state, 'photo'); f.ui.destroy();
});
test('a targeted gallery event removes only the affected selected photo with no automatic frame request', async () => {
  const f = setup({ settings: autoSettings() }); await f.ui.init(); f.decode();
  assert.equal(typeof f.events.get('gallery.changed'), 'function');
  f.events.get('gallery.changed')({ id: 'cd'.repeat(32), mediaId: '1', change: 'delete' });
  f.events.get('gallery.changed')({ id: PEER, mediaId: '2', change: 'visibility', visible: false });
  assert.equal(f.liveUrls.size, 1); assert.equal(f.elements.widget.dataset.state, 'photo');
  f.events.get('gallery.changed')({ id: PEER, mediaId: '1', change: 'delete' });
  assert.equal(f.liveUrls.size, 0); assert.equal(f.elements.widget.dataset.state, 'error');
  assert.equal(f.elements['next-photo'].disabled, false);
  await f.clock.advance(86400000); assert.equal(f.calls.length, 1); f.ui.destroy();
});
test('an event during a request fences late pixels and a later explicit retry can display another photo', async () => {
  const stale = deferred(); let calls = 0;
  const f = setup({ handler: () => ++calls === 1 ? stale.promise : photo({ mediaId: '2' }) });
  const opening = f.ui.init(); await tick();
  f.events.get('gallery.changed')({ id: PEER, mediaId: '1', change: 'visibility', visible: false });
  await opening; assert.equal(f.liveUrls.size, 0); assert.equal(f.elements['next-photo'].disabled, false);
  await f.elements['next-photo'].dispatch('click'); f.decode();
  const current = f.elements.photo.src;
  stale.resolve(photo({ mediaId: '1' })); await tick();
  assert.equal(f.elements.photo.src, current); assert.equal(f.created.length, 1); f.ui.destroy();
});
