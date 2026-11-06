'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FrameoQr = require('../drivers/frameo/pair/qr-code');

const folder = path.join(__dirname, '../drivers/frameo/pair');
const source = fs.readFileSync(path.join(folder, 'pair-ui.js'), 'utf8');
const ids = ['pair-form', 'code', 'sender', 'submit', 'status', 'error', 'scan', 'refresh', 'manual-divider',
  'qr-file', 'scanner-overlay', 'scanner-video', 'scanner-canvas', 'scanner-close', 'scanner-photo', 'scanner-status',
  'access-mode-options', 'access-mode-send', 'access-mode-view', 'access-mode-manage', 'access-enable-copy', 'connection-content', 'access-guide', 'access-guide-title',
  'access-sender', 'access-status', 'access-error', 'access-verify', 'access-later', 'access-back', 'manage-access'];
const repairOnlyIds = new Set(['refresh', 'access-back', 'manage-access']);
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(id, document) {
    this.id = id; this.document = document; this.listeners = new Map(); this.attributes = new Map();
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.open = false; this.dataset = {};
  }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener)); }
  async dispatch(type) {
    const event = { type, target: this, prevented: false, preventDefault() { this.prevented = true; } };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { this.document.activeElement = this; }
  closest(selector) { assert.equal(selector, 'details'); return this.document.senderDetails; }
  set innerHTML(_) { throw Error('Unsafe HTML rendering is forbidden in this test'); }
}

function view({ repair = false, accessMode = 'send', navigator = {}, translate, emit, createDevice, done } = {}) {
  const document = { body: { dataset: { mode: repair ? 'repair' : 'pair' } }, documentElement: { lang: '' }, activeElement: null };
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id, document)]));
  if (!repair) for (const id of repairOnlyIds) delete elements[id];
  elements.sender.value = 'Homey';
  elements['access-mode-send'].checked = accessMode === 'send';
  elements['access-mode-view'].checked = accessMode === 'view';
  elements['access-mode-manage'].checked = accessMode === 'manage';
  elements['access-guide'].hidden = true;
  elements['scanner-overlay'].hidden = elements['qr-file'].hidden = elements['scanner-canvas'].hidden = true;
  document.senderDetails = new Element('sender-details', document);
  document.getElementById = id => elements[id] || null;
  document.querySelectorAll = selector => { assert.equal(selector, '[data-i18n]'); return []; };
  let scannerOptions;
  const disabledHistory = [], calls = { emit: [], create: [], done: 0, titles: [] };
  const candidate = { name: 'Cadre salon', data: { id: 'ab'.repeat(32) }, settings: { sender_name: 'Homey', photo_access_mode: accessMode } };
  const Homey = {
    __: translate || (key => `translation:${key}`),
    setTitle: title => calls.titles.push(title),
    emit: async (event, payload) => {
      calls.emit.push({ event, payload: clone(payload) });
      if (emit) return emit(event, payload);
      if (event === 'pair_frame') { candidate.settings.sender_name = payload.senderName; candidate.settings.photo_access_mode = payload.mode; }
      if (event === 'get_access_state' || event === 'check_permissions') return { peer: candidate.data.id, senderName: candidate.settings.sender_name, mode: 'manage', mayView: false, mayManage: false };
      return candidate;
    },
    createDevice: async value => { calls.create.push(value); return createDevice ? createDevice(value) : undefined; },
    done: () => { calls.done++; if (done) return done(); },
  };
  const context = { document, navigator: { userAgent: 'Mozilla/5.0 Windows NT 10.0', platform: 'Win32', maxTouchPoints: 0, ...navigator },
    Homey, FrameoQr, jsQR: () => assert.fail('Controller should not decode outside scanner'),
    FrameoScanner: { create(options) { scannerOptions = options; return { setDisabled(value) { disabledHistory.push(value); elements.scan.disabled = value; } }; } } };
  vm.runInNewContext(source, context, { timeout: 1000 });
  return { elements, document, calls, candidate, disabledHistory, scanner: scannerOptions,
    submit: () => elements['pair-form'].dispatch('submit') };
}

test('manual code fields remain visible on desktop and mobile; scan is mobile only', () => {
  for (const [navigator, mobile] of [
    [{ userAgent: 'Mozilla/5.0 Windows NT 10.0' }, false],
    [{ userAgent: 'Mozilla/5.0 Macintosh Intel Mac OS X', platform: 'MacIntel' }, false],
    [{ userAgent: 'Mozilla/5.0 iPhone Mobile Safari' }, true],
    [{ userAgent: 'Mozilla/5.0 Android Mobile' }, true],
    [{ userAgent: 'Mozilla/5.0 Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Unknown', userAgentData: { mobile: true } }, true],
  ]) {
    const ui = view({ navigator });
    assert.equal(ui.elements.scan.hidden, !mobile);
    assert.equal(ui.elements['manual-divider'].hidden, !mobile);
    assert.equal(ui.elements['pair-form'].hidden, false);
    assert.equal(ui.elements.code.hidden, false);
    assert.equal(ui.elements.code.disabled, false);
  }
});

test('gallery and widget onboarding only requires viewing permission', async () => {
  const ui = view({ accessMode: 'view', emit: async (event, payload) => {
    if (event === 'pair_frame') return { name: 'Cadre', data: { id: 'ab'.repeat(32) }, settings: { sender_name: payload.senderName, photo_access_mode: payload.mode } };
    if (event === 'check_permissions') return { peer: 'ab'.repeat(32), mayView: true, mayManage: false };
    assert.fail(event);
  } });
  ui.elements.code.value = '1234567890';
  await ui.submit();
  assert.equal(ui.calls.emit[0].payload.mode, 'manage');
  assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements['access-enable-copy'].textContent, 'translation:access.guide_enable_view');
  await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.calls.done, 1);
  assert.equal(ui.elements['access-status'].textContent, 'translation:access.verified_view');
});

test('a scanned code only prefills the manual field and focuses confirmation', () => {
  const ui = view({ navigator: { userAgent: 'iPhone' } });
  ui.scanner.onCode('0012345678');
  assert.equal(ui.elements.code.value, '00 12 34 56 78');
  assert.equal(ui.elements.status.textContent, 'translation:qr.scanned');
  assert.equal(ui.document.activeElement, ui.elements.submit);
  assert.deepEqual(ui.calls.emit, []);
  assert.deepEqual(ui.calls.create, []);
  assert.equal(ui.calls.done, 0);
});

test('manual confirmation sends a normalized code then creates exactly one device', async () => {
  const ui = view();
  ui.elements.code.value = '00 12-34 56 78'; ui.elements.sender.value = '  Maison é😀  ';
  const event = await ui.submit();
  assert.equal(event.prevented, true);
  assert.deepEqual(ui.calls.emit, [{ event: 'pair_frame', payload: { code: '0012345678', senderName: 'Maison é😀', mode: 'send' } }]);
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.create[0], ui.candidate);
  assert.equal(ui.calls.done, 1);
  assert.equal(ui.elements.code.value, '');
  assert.equal(ui.elements.status.textContent, 'translation:pair.success');
});

test('invalid code is rejected before pairing, highlights input and recovers on editing', async () => {
  const ui = view(); ui.elements.code.value = 'not a code';
  await ui.submit();
  assert.equal(ui.calls.emit.length, 0);
  assert.equal(ui.elements.code.getAttribute('aria-invalid'), 'true');
  assert.equal(ui.document.activeElement, ui.elements.code);
  assert.equal(ui.elements.error.textContent, 'translation:errors.code_invalid');
  ui.elements.code.value = '1234567890'; await ui.elements.code.dispatch('input');
  assert.equal(ui.elements.code.getAttribute('aria-invalid'), undefined);
  assert.equal(ui.elements.error.textContent, '');
  await ui.elements.code.dispatch('blur');
  assert.equal(ui.elements.code.value, '12 34 56 78 90');
});

test('sender validation counts Unicode characters and expands its options on failure', async () => {
  const valid = view(); valid.elements.code.value = '1234567890'; valid.elements.sender.value = '😀'.repeat(80);
  await valid.submit(); assert.equal(valid.calls.emit[0].payload.senderName, '😀'.repeat(80));
  for (const name of ['', ' '.repeat(5), '😀'.repeat(81), 'abc\u0000def']) {
    const ui = view(); ui.elements.code.value = '1234567890'; ui.elements.sender.value = name;
    await ui.submit(); assert.equal(ui.calls.emit.length, 0);
    assert.equal(ui.document.senderDetails.open, true);
    assert.equal(ui.document.activeElement, ui.elements.sender);
    assert.equal(ui.elements.error.textContent, 'translation:errors.sender_invalid');
  }
});

test('duplicate taps and scans during a pending request cannot start another pair', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ui = view({ emit: async () => { await gate; return { name: 'Cadre', data: { id: 'frame' } }; } });
  ui.elements.code.value = '1234567890';
  const pending = ui.submit();
  assert.equal(ui.elements.submit.disabled, true);
  assert.equal(ui.elements.code.disabled, true);
  assert.equal(ui.elements.sender.disabled, true);
  assert.equal(ui.elements.scan.disabled, true);
  await ui.submit(); ui.scanner.onCode('9999999999');
  assert.equal(ui.elements.code.value, '1234567890');
  assert.equal(ui.calls.emit.length, 1);
  release(); await pending;
  assert.equal(ui.calls.create.length, 1);
});

test('createDevice failure retains candidate and retries adding without pairing again', async () => {
  let attempts = 0;
  const errorText = '<img src=x onerror=alert(1)>';
  const ui = view({ createDevice: async () => { if (++attempts === 1) throw Error(errorText); } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  assert.equal(ui.calls.emit.length, 1); assert.equal(ui.calls.create.length, 1); assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements.code.value, '');
  assert.equal(ui.elements.code.disabled, true); assert.equal(ui.elements.sender.disabled, true); assert.equal(ui.elements.scan.disabled, true);
  assert.equal(ui.elements.submit.disabled, false);
  assert.equal(ui.elements.submit.textContent, 'translation:pair.retry_add');
  assert.equal(ui.elements.error.textContent, errorText);
  ui.scanner.onCode('9999999999'); assert.equal(ui.elements.code.value, '');
  await ui.submit();
  assert.equal(ui.calls.emit.length, 1); assert.equal(ui.calls.create.length, 2);
  assert.equal(ui.calls.create[1], ui.calls.create[0]); assert.equal(ui.calls.done, 1);
});

test('pairing failure preserves manual fields and displays only text', async () => {
  const errorText = '<script>throw new Error("x")</script>';
  const ui = view({ emit: async () => { throw Error(errorText); } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements.code.value, '1234567890');
  assert.equal(ui.elements.error.textContent, errorText);
  assert.equal(ui.elements.code.disabled, false); assert.equal(ui.elements.sender.disabled, false);
  assert.equal(ui.document.activeElement, ui.elements.code);
});

test('repair uses the pairing handler without creating or duplicating a device', async () => {
  const ui = view({ repair: true }); ui.elements.code.value = '1234567890';
  await ui.submit();
  assert.deepEqual(ui.calls.emit, [{ event: 'pair_frame', payload: { code: '1234567890', senderName: 'Homey', mode: 'send' } }]);
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 1);
  assert.equal(ui.elements.status.textContent, 'translation:repair.success');
});

test('repair refresh can verify an existing connection without another code', async () => {
  const ui = view({ repair: true }); ui.elements.code.value = '';
  await ui.elements.refresh.dispatch('click');
  assert.deepEqual(ui.calls.emit, [{ event: 'refresh_frame', payload: {} }]);
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 1);
});

test('both HTML views keep manual input, iPhone capture fallback and required scanner elements', () => {
  for (const filename of ['connect.html', 'repair.html']) {
    const html = fs.readFileSync(path.join(folder, filename), 'utf8');
    for (const id of ids.filter(id => !repairOnlyIds.has(id) || filename === 'repair.html')) {
      assert.equal((html.match(new RegExp(`\\bid="${id}"`, 'g')) || []).length, 1, `${filename}: ${id}`);
    }
    assert.match(html, /<form\b[^>]*id="pair-form"[^>]*>/);
    assert.doesNotMatch(html.match(/<form\b[^>]*id="pair-form"[^>]*>/)[0], /\bhidden\b/);
    assert.match(html, /<input\b[^>]*id="code"[^>]*inputmode="numeric"/);
    assert.doesNotMatch(html.match(/<input\b[^>]*id="code"[^>]*>/)[0], /\bhidden\b/);
    assert.match(html, /<input\b[^>]*id="qr-file"[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/);
    assert.match(html, /<video\b[^>]*\bplaysinline\b/);
    assert.match(html, /<button\b[^>]*id="scan"[^>]*\bhidden\b/);
    assert.match(html, /id="error"[^>]*role="alert"/);
    assert.match(html, /id="status"[^>]*aria-live="polite"/);
    assert.match(html, /src="vendor\/jsQR\.js"/);
    assert.match(html, /id="access-mode-send"[^>]*value="send"[^>]*checked/);
    assert.match(html, /id="access-mode-manage"[^>]*value="manage"/);
    assert.match(html, /<section[^>]*id="access-guide"[^>]*hidden/);
    assert.match(html, /id="access-error"[^>]*role="alert"/);
    assert.match(html, /id="access-status"[^>]*aria-live="polite"/);
  }
});

test('send mode is the default and does not request or check photo permissions', async () => {
  const ui = view(); ui.elements.code.value = '1234567890';
  assert.equal(ui.elements['access-mode-send'].checked, true);
  await ui.submit();
  assert.equal(ui.calls.done, 1);
  assert.deepEqual(ui.calls.emit.map(call => call.event), ['pair_frame']);
  assert.equal(ui.elements['access-guide'].hidden, true);
});

test('manage mode creates the same single device then waits at the manual access guide', async () => {
  const ui = view({ accessMode: 'manage' });
  ui.elements.code.value = '1234567890'; ui.elements.sender.value = '<b>Famille é😀</b>';
  await ui.submit();
  assert.equal(ui.calls.emit[0].payload.mode, 'manage');
  assert.equal(ui.calls.create.length, 1); assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements['connection-content'].hidden, true);
  assert.equal(ui.elements['access-guide'].hidden, false);
  assert.equal(ui.elements['access-sender'].textContent, '<b>Famille é😀</b>');
  assert.equal(ui.elements['access-status'].textContent, '');
  assert.equal(ui.document.activeElement, ui.elements['access-verify']);
  assert.equal(ui.elements.scan.disabled, true);
  await ui.submit(); ui.scanner.onCode('9999999999');
  assert.equal(ui.calls.create.length, 1); assert.equal(ui.calls.emit.length, 1);
  assert.equal(ui.elements.code.value, '');
});

test('manage guide appears only after createDevice succeeds and retries never pair twice', async () => {
  let attempts = 0;
  const ui = view({ accessMode: 'manage', createDevice: async () => { if (++attempts === 1) throw Error('Try adding again'); } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  assert.equal(ui.elements['access-guide'].hidden, true); assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements['access-mode-send'].disabled, true);
  // Even a programmatic change cannot replace the pending candidate's mode.
  ui.elements['access-mode-manage'].checked = false;
  await ui.submit();
  assert.equal(ui.calls.emit.length, 1); assert.equal(ui.calls.create.length, 2);
  assert.equal(ui.calls.create[0], ui.calls.create[1]);
  assert.equal(ui.elements['access-guide'].hidden, false); assert.equal(ui.calls.done, 0);
});

test('permission checks are read-only and both explicit booleans are required before finishing', async () => {
  const peer = 'ab'.repeat(32);
  const answers = [{ mayView: true, mayManage: false }, { mayView: true, mayManage: 'true' }, { mayView: true, mayManage: true }];
  const ui = view({ accessMode: 'manage', emit: async (event, payload) => {
    if (event === 'pair_frame') return { data: { id: peer }, settings: { sender_name: payload.senderName, photo_access_mode: payload.mode } };
    assert.equal(event, 'check_permissions'); assert.deepEqual(clone(payload), { peer });
    return { peer, ...answers.shift() };
  } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  for (let attempt = 0; attempt < 2; attempt++) {
    await ui.elements['access-verify'].dispatch('click');
    assert.equal(ui.calls.done, 0);
    assert.equal(ui.elements['access-status'].textContent, 'translation:access.pending');
  }
  await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.calls.done, 1);
  assert.equal(ui.elements['access-status'].textContent, 'translation:access.verified');
  assert.equal(ui.calls.create.length, 1);
  assert.deepEqual(ui.calls.emit.map(call => call.event), ['pair_frame', 'check_permissions', 'check_permissions', 'check_permissions']);
});

test('a manage user can finish later with no permission claim or extra pairing', async () => {
  const ui = view({ accessMode: 'manage' }); ui.elements.code.value = '1234567890';
  await ui.submit(); await ui.elements['access-later'].dispatch('click');
  assert.equal(ui.calls.done, 1); assert.equal(ui.calls.create.length, 1);
  assert.deepEqual(ui.calls.emit.map(call => call.event), ['pair_frame']);
  assert.notEqual(ui.elements['access-status'].textContent, 'translation:access.verified');
  await ui.elements['access-later'].dispatch('click'); await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.calls.done, 1); assert.equal(ui.calls.emit.length, 1);
});

test('permission check failure keeps the existing guide and allows another check', async () => {
  let checks = 0;
  const ui = view({ accessMode: 'manage', emit: async event => {
    if (event === 'pair_frame') return { data: { id: 'ab'.repeat(32) } };
    if (++checks === 1) throw Error('<img src=x onerror=alert(1)>');
    return { peer: 'ab'.repeat(32), mayView: false, mayManage: false };
  } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.elements['access-error'].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(ui.calls.done, 0); assert.equal(ui.elements['access-verify'].disabled, false);
  await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.elements['access-error'].textContent, ''); assert.equal(ui.calls.create.length, 1);
});

test('a response for another peer cannot confirm the permission guide', async () => {
  const ui = view({ accessMode: 'manage', emit: async event => event === 'pair_frame' ? { data: { id: 'ab'.repeat(32) } } :
    { peer: 'cd'.repeat(32), mayView: true, mayManage: true } });
  ui.elements.code.value = '1234567890'; await ui.submit(); await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements['access-error'].textContent, 'translation:access.error');
});

test('repair opens management instructions for the existing device without a code or new device', async () => {
  const peer = 'ab'.repeat(32);
  const ui = view({ repair: true, emit: async (event, payload) => {
    if (event === 'get_access_state') {
      assert.deepEqual(clone(payload), { mode: 'manage' });
      return { peer, senderName: 'Homey salon', mode: 'manage', mayView: false, mayManage: false };
    }
    assert.equal(event, 'check_permissions'); return { peer, mayView: true, mayManage: true };
  } });
  await ui.elements['manage-access'].dispatch('click');
  assert.equal(ui.elements['access-sender'].textContent, 'Homey salon');
  assert.equal(ui.elements['access-guide'].hidden, false);
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 0);
  await ui.elements['access-verify'].dispatch('click');
  assert.equal(ui.calls.done, 1);
  assert.deepEqual(ui.calls.emit.map(call => call.event), ['get_access_state', 'check_permissions']);
});

test('repair guide can return to the manual reconnection form without losing its code', async () => {
  const ui = view({ repair: true }); ui.elements.code.value = '1234567890';
  await ui.elements['manage-access'].dispatch('click'); await ui.elements['access-back'].dispatch('click');
  assert.equal(ui.elements['connection-content'].hidden, false); assert.equal(ui.elements['access-guide'].hidden, true);
  assert.equal(ui.elements.code.value, '1234567890'); assert.equal(ui.elements.code.disabled, false);
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 0);
  assert.equal(ui.document.activeElement, ui.elements['manage-access']);
});

test('repair in manage mode reconnects then guides access without creating a device', async () => {
  const ui = view({ repair: true, accessMode: 'manage', emit: async event => {
    if (event === 'pair_frame') return { confirmed: true };
    if (event === 'get_access_state') return { peer: 'ab'.repeat(32), senderName: 'Homey', mode: 'manage', mayView: false, mayManage: false };
    assert.fail('No permission request should be sent automatically');
  } });
  ui.elements.code.value = '1234567890'; await ui.submit();
  assert.equal(ui.calls.create.length, 0); assert.equal(ui.calls.done, 0);
  assert.equal(ui.elements['access-guide'].hidden, false);
  assert.deepEqual(ui.calls.emit.map(call => call.event), ['pair_frame', 'get_access_state']);
  await ui.elements['access-later'].dispatch('click'); assert.equal(ui.calls.done, 1);
});


test('pairing uses Homey language before the phone language and supports all four language tags', () => {
  for (const language of ['fr', 'en', 'nl', 'de']) {
    const ui = view({ navigator: { language: language === 'fr' ? 'de-DE' : 'fr-FR' },
      translate: key => key === 'pair.language' ? language : 'translation:' + key });
    assert.equal(ui.document.documentElement.lang, language);
    assert.equal(ui.calls.emit.length, 0);
  }
  const fallback = view({ navigator: { language: 'nl-NL' }, translate: key => key });
  assert.equal(fallback.document.documentElement.lang, 'nl');
  const unsupported = view({ navigator: { language: 'es-ES' }, translate: key => key });
  assert.equal(unsupported.document.documentElement.lang, 'en');
});
