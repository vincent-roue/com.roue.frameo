'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { create, previewUrl, translations } = require('../settings/gallery');

const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
const ids = [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).concat(['toggle-visibility', 'filter-type', 'filter-visibility', 'filter-sort']))];
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const preview = { mime: 'image/jpeg', data: 'AA==', bytes: 1 };
const photo = (id = '9007199254740993123') => ({ id, type: 'picture', visible: true, captureDate: '2026-10-01T12:00:00.000Z', receiveDate: '2026-11-03T10:00:00.000Z' });
const frame = overrides => ({ id: 'frame-a', name: 'Cadre salon', senderName: 'Homey maison', mayView: true, mayManage: true, mode: 'manage', ...overrides });
const page = (items = [photo()], overrides) => ({ items, total: items.length, nextCursor: null, revision: 'snapshot-a', ...overrides });

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.className = ''; this.complete = false; this.naturalWidth = 0;
    this.classList = {
      add: name => { if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim(); },
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      contains: name => this.className.split(' ').includes(name),
    };
  }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(value => value !== fn)); }
  async dispatch(name, extra = {}) {
    if (this.disabled && name === 'click' && !extra.force) return;
    const event = { type: name, target: this, preventDefault() { this.prevented = true; }, ...extra };
    for (const fn of this.listeners.get(name) || []) await fn(event);
    return event;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  focus() { this.document.activeElement = this; }
  set innerHTML(_) { throw new Error('HTML injection must never be used'); }
}

function setup(handler, language = 'fr', homeyLanguage = null, browserLanguage = 'fr-FR', extra = {}) {
  const document = new Element('document'); document.documentElement = { lang: '' }; document.body = new Element('body', document);
  const elements = Object.fromEntries(ids.map(id => [id, new Element('div', document)]));
  elements['photo-dialog'].hidden = true;
  document.getElementById = id => elements[id];
  document.querySelectorAll = () => [];
  document.createElement = tag => new Element(tag, document);
  const window = new Element('window', document); window.navigator = { language: browserLanguage };
  Object.assign(window, extra.window || {});
  const calls = [], events = new Map(); let ready = 0;
  const Homey = {
    __: key => key === 'gallery.language' && homeyLanguage ? homeyLanguage : key,
    ready: () => { ready++; },
    on: (event, fn) => events.set(event, fn),
    api(method, route, body, callback) {
      calls.push({ method, route, body });
      Promise.resolve().then(() => handler({ method, route, body, calls })).then(value => callback(null, value), err => callback(err));
    },
  };
  const ui = create({ Homey, document, window, language, ...extra.options });
  return { ui, elements, document, window, calls, events, ready: () => ready,
    tiles: () => elements['photo-grid'].children,
    async open(index = 0) { await elements['photo-grid'].children[index].dispatch('click'); },
    decodeDialog() { elements['dialog-image'].onload(); },
  };
}

test('sending-only mode never lists photos until explicitly enabled; permission checks do not request a popup', async () => {
  let enabled = false;
  const view = setup(({ route, body }) => {
    if (route === '/gallery/frames') return { frames: [frame({ mode: 'send', mayView: false, mayManage: false })] };
    if (route === '/gallery/mode') { assert.deepEqual(body, { id: 'frame-a', mode: 'manage' }); enabled = true; return { mode: 'manage', frame: frame({ mayView: false, mayManage: false }) }; }
    if (route === '/gallery/check-access') return frame();
    if (route === '/gallery/list') return page();
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  });
  await view.ui.init();
  assert.equal(view.ready(), 1);
  assert.deepEqual(view.calls.map(call => call.route), ['/gallery/frames']);
  assert.equal(view.elements['permission-panel'].hidden, false);
  await view.elements['enable-gallery'].dispatch('click');
  assert.equal(enabled, true);
  assert.equal(view.elements['check-access'].hidden, false);
  assert.equal(view.calls.some(call => call.route === '/gallery/list'), false);
  assert.match(view.elements['permission-step-friend'].textContent, /Homey maison/);
  await view.elements['check-access'].dispatch('click');
  await tick();
  assert.equal(view.tiles().length, 1);
  assert.equal(view.elements['gallery-section'].hidden, false);
  assert.equal(view.calls.some(call => /permission|request/i.test(call.route)), false);
});

test('gallery stays passive on another tab and releases every retained preview when leaving', async () => {
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page();
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  }, 'fr', null, 'fr-FR', { options: { active: false } });
  await view.ui.init(); await tick();
  assert.deepEqual(view.calls.map(call => call.route), ['/gallery/frames']);
  await view.ui.setActive(true); await tick();
  assert.equal(view.ui.cacheStats().entries, 1);
  view.ui.setActive(false);
  assert.deepEqual(view.ui.cacheStats(), { bytes: 0, pixels: 0, entries: 0 });
  assert.equal(view.tiles().length, 0);
});

test('retained previews obey aggregate byte and pixel budgets and revoke Blob URLs', async () => {
  const revoked = [], created = [];
  const threeMiB = Buffer.alloc(3 * 1024 * 1024).toString('base64');
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo('1'), photo('2'), photo('3')]);
    if (route === '/gallery/preview') return { mime: 'image/jpeg', data: threeMiB, bytes: 3 * 1024 * 1024, width: 100, height: 100 };
    assert.fail(route);
  }, 'fr', null, 'fr-FR', { window: { Blob, atob: value => Buffer.from(value, 'base64').toString('latin1'), URL: {
    createObjectURL() { const url = 'blob:preview-' + created.length; created.push(url); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  } } });
  await view.ui.init();
  for (let index = 0; index < 8; index++) await tick();
  assert.equal(created.length, 3);
  assert.deepEqual(view.ui.cacheStats(), { entries: 2, bytes: 6 * 1024 * 1024, pixels: 20000 });
  assert.equal(revoked.length, 1);
  view.ui.destroy();
  assert.equal(revoked.length, 3);
  assert.deepEqual(view.ui.cacheStats(), { entries: 0, bytes: 0, pixels: 0 });
});

test('only intersecting previews load, and offscreen previews are released', async () => {
  let observerCallback;
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo('1'), photo('2')]);
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  }, 'fr', null, 'fr-FR', { window: { IntersectionObserver: class {
    constructor(callback) { observerCallback = callback; }
    observe() {} disconnect() {}
  } } });
  await view.ui.init(); await tick();
  assert.equal(view.calls.filter(call => call.route === '/gallery/preview').length, 0);
  observerCallback([{ target: view.tiles()[0], isIntersecting: true }]);
  await tick(); await tick();
  assert.equal(view.ui.cacheStats().entries, 1);
  assert.equal(view.calls.filter(call => call.route === '/gallery/preview').length, 1);
  observerCallback([{ target: view.tiles()[0], isIntersecting: false }]);
  assert.equal(view.ui.cacheStats().entries, 0);
});

test('small encoded previews cannot bypass the aggregate decoded-pixel budget', async () => {
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo('1'), photo('2'), photo('3')]);
    if (route === '/gallery/preview') return { ...preview, width: 2000, height: 2000 };
    assert.fail(route);
  });
  await view.ui.init(); for (let index = 0; index < 5; index++) await tick();
  assert.deepEqual(view.ui.cacheStats(), { bytes: 2, pixels: 8000000, entries: 2 });
});

test('filters travel with the cursor and changing them restarts the first page', async () => {
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo()], { nextCursor: 'opaque-next' });
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  });
  await view.ui.init(); await tick();
  view.elements['filter-visibility'].value = 'hidden';
  await view.elements['filter-visibility'].dispatch('change'); await tick();
  const list = () => view.calls.filter(call => call.route === '/gallery/list').at(-1).body;
  assert.equal(list().visibility, 'hidden');
  assert.equal(list().cursor, undefined);
  await view.elements['next-page'].dispatch('click'); await tick();
  assert.equal(list().cursor, 'opaque-next');
  assert.equal(list().visibility, 'hidden');
  view.elements['filter-sort'].value = 'captured_asc';
  await view.elements['filter-sort'].dispatch('change'); await tick();
  assert.equal(list().cursor, undefined);
  assert.equal(list().sort, 'captured_asc');
});

test('hiding requires a decoded preview and an uncertain mutation cannot be repeated', async () => {
  const pending = deferred();
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page();
    if (route === '/gallery/preview') return preview;
    if (route === '/gallery/visibility') return pending.promise;
    assert.fail(route);
  });
  await view.ui.init(); await tick(); await view.open();
  assert.equal(view.elements['toggle-visibility'].disabled, true);
  view.decodeDialog();
  const mutation = view.elements['toggle-visibility'].dispatch('click');
  assert.equal(view.elements['toggle-visibility'].disabled, true);
  pending.reject(new Error('TIMEOUT')); await mutation;
  await view.elements['toggle-visibility'].dispatch('click', { force: true });
  assert.equal(view.calls.filter(call => call.route === '/gallery/visibility').length, 1);
  assert.equal(view.calls.find(call => call.route === '/gallery/visibility').body.visible, false);
  assert.equal(view.elements['delete-photo'].disabled, true);
});

test('read-only access supports viewing and never exposes deletion; frame names are rendered as text', async () => {
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame({ name: '<img src=x onerror=alert(1)>', mayManage: false })] };
    if (route === '/gallery/list') return page();
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  });
  await view.ui.init(); await tick(); await view.open(); view.decodeDialog();
  assert.equal(view.elements['dialog-title'].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(view.elements['dialog-read-only'].hidden, false);
  assert.equal(view.elements['delete-photo'].hidden, true);
  assert.equal(view.elements['delete-photo'].disabled, true);
  await view.elements['delete-photo'].dispatch('click', { force: true });
  assert.equal(view.calls.some(call => call.route === '/gallery/delete'), false);
});

test('deletion requires a decoded preview and explicit confirmation; uncertain outcomes never retry or relist', async () => {
  const deletion = deferred(); let revisionNumber = 0;
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo()], { revision: 'snapshot-' + (++revisionNumber) });
    if (route === '/gallery/preview') return preview;
    if (route === '/gallery/delete') return deletion.promise;
    assert.fail(route);
  });
  await view.ui.init(); await tick(); await view.open();
  assert.equal(view.elements['delete-photo'].disabled, true);
  await view.elements['delete-photo'].dispatch('click', { force: true });
  assert.equal(view.calls.some(call => call.route === '/gallery/delete'), false);
  view.decodeDialog();
  const deleting = view.elements['delete-photo'].dispatch('click'); await tick();
  await view.elements['delete-photo'].dispatch('click', { force: true });
  assert.equal(view.elements['dialog-close'].disabled, true);
  const mutation = view.calls.filter(call => call.route === '/gallery/delete');
  assert.equal(mutation.length, 1);
  assert.deepEqual(mutation[0].body, { id: 'frame-a', mediaId: '9007199254740993123', revision: 'snapshot-1', confirmation: 'delete' });
  deletion.reject(new Error('TIMEOUT')); await deleting; await tick();
  assert.equal(view.calls.filter(call => call.route === '/gallery/list').length, 1);
  assert.match(view.elements['dialog-status'].textContent, /n’a pas été confirmée/);
  assert.equal(view.elements['delete-photo'].disabled, true);
  await view.elements['dialog-close'].dispatch('click');
  await view.elements.refresh.dispatch('click'); await tick(); await view.open(); view.decodeDialog();
  assert.equal(view.elements['delete-photo'].disabled, false);
  assert.equal(view.calls.filter(call => call.route === '/gallery/delete').length, 1);
});

test('confirmed deletion refreshes the first page; modal close and Escape do not send anything', async () => {
  let deleted = false;
  const view = setup(({ route, body }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page(deleted ? [] : [photo()]);
    if (route === '/gallery/preview') return preview;
    if (route === '/gallery/delete') { deleted = true; return { deleted: true, mediaId: body.mediaId }; }
    assert.fail(route);
  });
  await view.ui.init(); await tick(); await view.open();
  await view.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(view.elements['photo-dialog'].hidden, true);
  assert.equal(view.document.activeElement, view.tiles()[0]);
  assert.equal(view.calls.some(call => call.route === '/gallery/delete'), false);
  await view.open(); view.decodeDialog(); await view.elements['delete-photo'].dispatch('click');
  assert.equal(view.elements['photo-dialog'].hidden, true);
  assert.equal(view.elements['empty-state'].hidden, false);
  assert.equal(view.calls.filter(call => call.route === '/gallery/list').length, 2);
  assert.match(view.elements['gallery-status'].textContent, /supprimée/);
});

test('at most two previews are in flight across frame changes; late responses never paint the next frame', async () => {
  const requests = []; let active = 0, peak = 0;
  const view = setup(({ route, body }) => {
    if (route === '/gallery/frames') return { frames: [frame(), frame({ id: 'frame-b', name: 'Cadre cuisine' })] };
    if (route === '/gallery/list') return body.id === 'frame-a' ? page(Array.from({ length: 24 }, (_, i) => photo(String(i + 1)))) : page([photo('99')]);
    if (route === '/gallery/preview') {
      const pending = deferred(); active++; peak = Math.max(peak, active); requests.push({ ...pending, body });
      return pending.promise.finally(() => active--);
    }
    assert.fail(route);
  });
  await view.ui.init(); await tick();
  assert.equal(requests.length, 2);
  view.elements['frame-selector'].value = 'frame-b';
  await view.elements['frame-selector'].dispatch('change'); await tick();
  assert.equal(view.tiles().length, 1);
  assert.equal(requests.length, 2);
  requests[0].resolve(preview); requests[1].reject(new Error('old frame')); await tick(); await tick();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].body.id, 'frame-b');
  assert.equal(view.tiles()[0].classList.contains('preview-error'), false);
  requests[2].resolve(preview); await tick();
  assert.equal(peak, 2);
  assert.equal(view.calls.filter(call => call.route === '/gallery/preview' && call.body.id === 'frame-a').length, 2);
  view.ui.destroy();
  assert.equal(view.tiles().length, 0);
});

test('page navigation forwards only the opaque cursor and keeps the page bound to 24', async () => {
  const view = setup(({ route, body }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return body.cursor ? page([photo('2')], { total: 25 }) : page([photo('1')], { total: 25, nextCursor: 'opaque:page/2' });
    if (route === '/gallery/preview') return preview;
    assert.fail(route);
  });
  await view.ui.init(); await tick();
  await view.elements['next-page'].dispatch('click'); await tick();
  const listing = view.calls.filter(call => call.route === '/gallery/list');
  assert.equal(listing[1].body.cursor, 'opaque:page/2');
  assert.equal(listing[1].body.limit, 24);
  assert.match(view.elements['page-label'].textContent, /2/);
  await view.elements['previous-page'].dispatch('click'); await tick();
  assert.equal(view.calls.filter(call => call.route === '/gallery/list')[2].body.cursor, undefined);
});

test('videos without image previews cannot be deleted; public or active image formats are rejected', async () => {
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([{ ...photo(), type: 'video' }]);
    if (route === '/gallery/preview') throw Object.assign(new Error('unsupported'), { code: 'MEDIA_TYPE_UNSUPPORTED' });
    assert.fail(route);
  });
  await view.ui.init(); await tick();
  assert.equal(view.calls.some(call => call.route === '/gallery/preview'), false);
  await view.open(); await tick();
  assert.equal(view.elements['dialog-preview-status'].textContent, 'Vignette vidéo indisponible');
  assert.equal(view.calls.filter(call => call.route === '/gallery/preview').length, 1);
  assert.equal(view.elements['delete-photo'].disabled, true);
  assert.throws(() => previewUrl({ ...preview, mime: 'image/svg+xml' }));
  assert.throws(() => previewUrl({ ...preview, data: 'https://example.com/photo.jpg' }));
  assert.throws(() => previewUrl({ ...preview, bytes: 5 * 1024 * 1024 }));
  assert.equal(previewUrl(preview), 'data:image/jpeg;base64,AA==');
});

test('a video opens as a still image with a text caption and read-only controls', async () => {
  const caption = '<img src=x onerror=alert(1)>';
  const view = setup(({ route }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([{ ...photo(), type: 'video' }]);
    if (route === '/gallery/preview') return { ...preview, caption };
    assert.fail(route);
  });
  await view.ui.init(); await tick();
  assert.equal(view.calls.some(call => call.route === '/gallery/preview'), false);
  await view.open(); await tick();
  assert.equal(view.elements['dialog-caption'].hidden, true);
  view.decodeDialog();
  assert.equal(view.elements['dialog-image'].hidden, false);
  assert.equal(view.elements['dialog-caption'].hidden, false);
  assert.equal(view.elements['dialog-caption'].textContent, caption);
  assert.equal(view.elements['delete-photo'].hidden, true);
  assert.equal(view.elements['toggle-visibility'].hidden, true);
  await view.elements['dialog-close'].dispatch('click');
  assert.equal(view.elements['dialog-caption'].hidden, true);
  assert.equal(view.elements['dialog-caption'].textContent, '');
});

test('settings show a recoverable error after startup failure, with complete FR/EN/NL/DE strings', async () => {
  const view = setup(() => { throw new Error('offline'); });
  await view.ui.init();
  assert.equal(view.ready(), 1);
  assert.equal(view.elements['gallery-error'].hidden, false);
  assert.equal(view.elements.refresh.disabled, false);
  await view.elements.refresh.dispatch('click');
  assert.equal(view.calls.length, 2);
  for (const language of ['fr', 'nl', 'de']) assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations[language]).sort());
  assert.match(html, /src="\/homey.js" data-origin="settings"/);
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//);
});


test('gallery follows Homey language before phone or fallback options and localizes recoverable errors', async () => {
  for (const language of ['fr', 'en', 'nl', 'de']) {
    const view = setup(() => { throw new Error('private backend content'); }, 'fr', language, 'en-US');
    await view.ui.init();
    assert.equal(view.document.documentElement.lang, language);
    assert.equal(view.elements['gallery-error'].textContent, translations[language].error);
    assert.doesNotMatch(view.elements['gallery-error'].textContent, /private backend/);
    assert.equal(view.elements.refresh.disabled, false);
    view.ui.destroy();
  }
  const browser = setup(() => ({ frames: [] }), null, null, 'de-DE');
  await browser.ui.init();
  assert.equal(browser.document.documentElement.lang, 'de');
  assert.equal(browser.elements['gallery-status'].textContent, translations.de.no_frames);
  browser.ui.destroy();
});

test('the selected preview can be displayed and named for a Flow without sharing its bytes', async () => {
  const id = '9007199254740993123';
  const view = setup(({ route, body }) => {
    if (route === '/gallery/frames') return { frames: [frame()] };
    if (route === '/gallery/list') return page([photo(id)]);
    if (route === '/gallery/preview') return preview;
    if (route === '/gallery/display') {
      assert.deepEqual(body, { id: 'frame-a', mediaId: id, revision: 'snapshot-a' });
      return { mediaId: id, requested: true };
    }
    if (route === '/gallery/flow-photo') {
      assert.deepEqual(body, { id: 'frame-a', mediaId: id, revision: 'snapshot-a', name: body.name === null ? null : 'Souvenir' });
      return { name: body.name };
    }
    assert.fail(route);
  });
  await view.ui.init(); await tick(); await view.open();
  assert.equal(view.elements['display-photo'].disabled, true);
  view.decodeDialog();
  await view.elements['display-photo'].dispatch('click');
  assert.equal(view.elements['dialog-status'].textContent, translations.fr.display_requested);
  assert.equal(view.calls.filter(call => call.route === '/gallery/preview').length, 1);
  view.elements['flow-photo-name'].value = 'Souvenir';
  await view.elements['flow-photo-name'].dispatch('input');
  await view.elements['flow-photo-save'].dispatch('click');
  assert.equal(view.elements['dialog-status'].textContent, translations.fr.flow_photo_saved);
  await view.elements['flow-photo-remove'].dispatch('click');
  assert.equal(view.elements['flow-photo-remove'].hidden, true);
  assert.equal(view.elements['dialog-status'].textContent, translations.fr.flow_photo_removed);
  view.ui.destroy();
});
