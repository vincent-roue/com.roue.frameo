'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../drivers/frameo/pair/qr-scanner.js'), 'utf8');

class Element {
  constructor() { this.listeners = new Map(); this.hidden = true; this.clicks = 0; this.files = []; this.value = ''; this.disabled = false; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ type }); }
  click() { this.clicks++; this.dispatch('click'); }
  focus() { this.focused = true; }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function fixture({ secure = true, getUserMedia, decoded = { data: 'valid-payload' }, imageError = false, decode } = {}) {
  const window = new Element();
  const document = new Element();
  const elements = Object.fromEntries(['button', 'fileInput', 'overlay', 'video', 'canvas', 'closeButton', 'photoButton', 'status', 'codeInput', 'previewElement'].map((name) => [name, new Element()]));
  const timers = new Map();
  const revoked = [];
  const created = [];
  const codes = [];
  const pixels = [];
  let timerId = 0;
  const track = { stopped: 0, stop() { this.stopped++; } };
  const stream = { getTracks: () => [track] };
  const context = {
    drawImage() {},
    getImageData(_x, _y, width, height) { return { data: new Uint8ClampedArray(4), width, height }; },
  };
  Object.assign(elements.video, { videoWidth: 1920, videoHeight: 1080, readyState: 4, async play() {}, pause() {} });
  elements.canvas.getContext = () => context;
  document.hidden = false;
  Object.assign(window, {
    document, isSecureContext: secure,
    navigator: getUserMedia === null ? {} : { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    URL: {
      createObjectURL(file) { const url = `blob:local-${created.length}`; created.push({ url, file }); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    Image: class {
      naturalWidth = 3200;
      naturalHeight = 1800;
      set src(value) {
        if (value) queueMicrotask(() => imageError ? this.onerror?.() : this.onload?.());
      }
    },
  });
  const loaded = { exports: {} };
  new Function('window', 'module', 'exports', SOURCE)(window, loaded, loaded.exports);
  const scanner = window.FrameoScanner.create({ ...elements,
    returnFocusElement: elements.codeInput,
    translate: (key) => key,
    parseCode: (payload) => { if (payload !== 'valid-payload') throw new Error(); return '1234567890'; },
    onCode: (code) => codes.push(code),
    decode: async (data) => { pixels.push(data); return decode ? decode(data) : decoded; },
  });
  return { scanner, window, document, ...elements, timers, revoked, created, codes, pixels, track, stream,
    async scanTick() {
      const entry = [...timers].find(([, timer]) => timer.delay === 250);
      assert.ok(entry, 'A live scan should be scheduled');
      timers.delete(entry[0]);
      entry[1].callback();
      await settle();
    },
    select(file) { elements.fileInput.files = [file]; elements.fileInput.dispatch('change'); },
  };
}

test('unavailable live camera opens the photo picker in the original synchronous gesture', async (t) => {
  const f = fixture({ getUserMedia: null });
  t.after(() => f.scanner.destroy());
  f.button.click();
  assert.equal(f.fileInput.clicks, 1);
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.status.textContent, 'qr.camera_unavailable');
  assert.equal(f.codes.length, 0);
});

test('permission refusal offers a photo fallback without an asynchronous synthetic click', async (t) => {
  const f = fixture({ getUserMedia: async () => { throw Object.assign(new Error('private browser diagnostic'), { name: 'NotAllowedError' }); } });
  t.after(() => f.scanner.destroy());
  assert.equal(await f.scanner.start(), false);
  assert.equal(f.status.textContent, 'qr.camera_denied');
  assert.equal(f.previewElement.hidden, true);
  assert.equal(f.fileInput.clicks, 0);
  f.photoButton.click();
  assert.equal(f.fileInput.clicks, 1);
  assert.equal(f.codes.length, 0);
});

test('a valid live QR fills the code once and stops camera tracks and scan timers', async (t) => {
  const f = fixture();
  t.after(() => f.scanner.destroy());
  assert.equal(await f.scanner.start(), true);
  assert.equal(f.previewElement.hidden, false);
  await f.scanTick();
  assert.deepEqual(f.codes, ['1234567890']);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.previewElement.hidden, true);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.video.srcObject, null);
  assert.equal(f.timers.size, 0);
  assert.ok(f.pixels.every((image) => Math.max(image.width, image.height) <= 1000));
});

test('closing before camera permission resolves immediately stops a late-acquired camera', async (t) => {
  const camera = deferred();
  const f = fixture({ getUserMedia: () => camera.promise });
  t.after(() => f.scanner.destroy());
  const pending = f.scanner.start();
  f.closeButton.click();
  assert.equal(await pending, false);
  camera.resolve(f.stream);
  await settle();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.codes.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a camera-opening timeout stops any late stream and leaves a user-operated photo fallback', async (t) => {
  const camera = deferred();
  const f = fixture({ getUserMedia: () => camera.promise });
  t.after(() => f.scanner.destroy());
  const pending = f.scanner.start();
  const timer = [...f.timers.values()].find((value) => value.delay === 10000);
  timer.callback();
  assert.equal(await pending, false);
  camera.resolve(f.stream);
  await settle();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.fileInput.clicks, 0);
  assert.equal(f.status.textContent, 'qr.camera_error');
});

test('photo decoding stays local, scales pixels, revokes its blob URL and only returns parsed digits', async (t) => {
  const f = fixture({ getUserMedia: null });
  t.after(() => f.scanner.destroy());
  f.button.click();
  // Native capture can hide the WebView: the chosen file must survive that transition.
  f.document.hidden = true;
  f.document.dispatch('visibilitychange');
  f.document.hidden = false;
  f.select({ name: 'qr.jpg', type: 'image/jpeg', size: 2048 });
  await settle();
  assert.deepEqual(f.codes, ['1234567890']);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.revoked, ['blob:local-0']);
  assert.ok(Math.max(f.pixels[0].width, f.pixels[0].height) <= 1600);
  assert.equal(f.fileInput.value, '');
  assert.equal(f.overlay.hidden, true);
});

test('SVG and oversized photos are rejected without loading image data', async (t) => {
  const f = fixture({ getUserMedia: null });
  t.after(() => f.scanner.destroy());
  f.button.click();
  f.select({ name: 'qr.svg', type: 'image/svg+xml', size: 20 });
  await settle();
  assert.equal(f.status.textContent, 'qr.invalid_photo');
  f.select({ name: 'qr.png', type: 'image/png', size: 15 * 1024 * 1024 + 1 });
  await settle();
  assert.equal(f.status.textContent, 'qr.photo_too_large');
  assert.equal(f.created.length, 0);
  assert.equal(f.codes.length, 0);
});

test('unsupported QR payloads never reach onCode, while unreadable files release their blob URL', async (t) => {
  const wrong = fixture({ getUserMedia: null, decoded: { data: 'https://example.invalid/not-frameo' } });
  const broken = fixture({ getUserMedia: null, imageError: true });
  t.after(() => { wrong.scanner.destroy(); broken.scanner.destroy(); });
  for (const f of [wrong, broken]) {
    f.button.click();
    f.select({ name: 'qr.png', type: 'image/png', size: 2048 });
    await settle();
    assert.deepEqual(f.codes, []);
    assert.deepEqual(f.revoked, ['blob:local-0']);
  }
  assert.equal(wrong.status.textContent, 'qr.wrong_code');
  assert.equal(broken.status.textContent, 'qr.photo_error');
});

test('disabling during photo decoding prevents a late result from changing the pairing code', async (t) => {
  const decoded = deferred();
  const f = fixture({ getUserMedia: null, decode: () => decoded.promise });
  t.after(() => f.scanner.destroy());
  f.button.click();
  f.select({ name: 'qr.png', type: 'image/png', size: 2048 });
  await settle();
  assert.equal(f.pixels.length, 1);
  f.scanner.setDisabled(true);
  decoded.resolve({ data: 'valid-payload' });
  await settle();
  assert.deepEqual(f.codes, []);
  assert.deepEqual(f.revoked, ['blob:local-0']);
  assert.equal(f.overlay.hidden, true);
});

test('disable, visibility changes and destruction cancel scans and remove listeners', async () => {
  const f = fixture({ decoded: null });
  await f.scanner.start();
  f.document.hidden = true;
  f.document.dispatch('visibilitychange');
  assert.equal(f.track.stopped, 1);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.timers.size, 0);
  f.scanner.setDisabled(true);
  assert.equal(f.button.disabled, true);
  assert.equal(f.fileInput.disabled, true);
  assert.equal(await f.scanner.start(), false);
  f.scanner.destroy();
  for (const target of [f.button, f.fileInput, f.closeButton, f.photoButton, f.document, f.window]) {
    assert.equal([...target.listeners.values()].reduce((total, listeners) => total + listeners.size, 0), 0);
  }
});

test('only a user closing the scanner returns focus to the manual code field', async (t) => {
  const manual = fixture({ decoded: null });
  const hidden = fixture({ decoded: null });
  const successful = fixture();
  t.after(() => { manual.scanner.destroy(); hidden.scanner.destroy(); successful.scanner.destroy(); });
  await manual.scanner.start();
  manual.closeButton.click();
  assert.equal(manual.codeInput.focused, true);
  assert.equal(manual.button.focused, undefined);
  assert.equal(manual.previewElement.hidden, true);
  await hidden.scanner.start();
  hidden.document.hidden = true;
  hidden.document.dispatch('visibilitychange');
  assert.equal(hidden.codeInput.focused, undefined);
  assert.equal(hidden.previewElement.hidden, true);
  await successful.scanner.start();
  await successful.scanTick();
  assert.equal(successful.codeInput.focused, undefined);
  assert.equal(successful.button.focused, undefined);
});
