'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DevicePreview, PreviewCache } = require('../lib/device-preview');
const { FrameoWidget } = require('../lib/frameo-widget');
const { syncWidgetAssets } = require('../../scripts/widget-assets.cjs');

const WIDGETS = path.resolve(__dirname, '../widgets');
const LANGUAGES = ['de', 'en', 'fr', 'nl'];
const VARIANTS = [
  { id: 'frameo', format: 'square', height: '100%' },
  { id: 'frameo-compact', format: 'compact', height: '65%' },
  { id: 'frameo-portrait', format: 'portrait', height: '135%' },
];
const compose = id => JSON.parse(fs.readFileSync(path.join(WIDGETS, id, 'widget.compose.json'), 'utf8'));
const publicPath = (id, filename) => path.join(WIDGETS, id, 'public', filename);

test('the catalogue offers three distinct four-language widgets with native aspect-ratio heights', () => {
  const directories = fs.readdirSync(WIDGETS, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(directories, VARIANTS.map(variant => variant.id).sort());
  for (const language of LANGUAGES) {
    const names = VARIANTS.map(({ id }) => compose(id).name[language]);
    assert(names.every(name => typeof name === 'string' && name.trim() && name.includes('Frameo')));
    assert.equal(new Set(names).size, 3, `The catalogue must distinguish the three sizes in ${language}`);
  }
  for (const { id, height } of VARIANTS) {
    const manifest = compose(id);
    assert.equal(manifest.height, height);
    assert.deepEqual(Object.keys(manifest.name).sort(), LANGUAGES);
    assert.deepEqual(manifest.api, { getPhoto: { method: 'GET', path: '/photo' }, nextPhoto: { method: 'POST', path: '/next' } });
    assert.deepEqual(manifest.settings.map(setting => setting.id), ['frame', 'auto_change', 'interval_minutes']);
    assert.equal(manifest.settings.find(setting => setting.id === 'frame').type, 'autocomplete');
    assert.equal(manifest.settings.some(setting => setting.id === 'format'), false);
    assert.equal(manifest.settings.some(setting => setting.type === 'dropdown'), false);
    assert.equal(manifest.settings.find(setting => setting.id === 'auto_change').value, false);
    const interval = manifest.settings.find(setting => setting.id === 'interval_minutes');
    assert.equal(interval.type, 'number'); assert.deepEqual([interval.value, interval.min, interval.max], [5, 1, 1440]);
    for (const label of manifest.settings.flatMap(setting => [setting.title, setting.hint]).filter(Boolean)) {
      assert.deepEqual(Object.keys(label).sort(), LANGUAGES);
      assert(Object.values(label).every(value => typeof value === 'string' && value.trim()));
    }
  }
});

test('all sizes share the same public SDK controller, styles and artwork; synchronization is verifiable without writing', async () => {
  const sourceFiles = fs.readdirSync(path.join(WIDGETS, 'frameo/public')).sort();
  assert(sourceFiles.includes('widget.js')); assert(sourceFiles.includes('widget.css'));
  for (const { id, format } of VARIANTS) {
    assert.deepEqual(fs.readdirSync(path.join(WIDGETS, id, 'public')).sort(), sourceFiles);
    for (const filename of sourceFiles) {
      const source = fs.readFileSync(publicPath('frameo', filename));
      const actual = fs.readFileSync(publicPath(id, filename));
      if (filename === 'index.html') {
        assert.equal(actual.toString('utf8'), source.toString('utf8').replace("format: 'square'", `format: '${format}'`));
      } else assert(actual.equals(source), `${id}/${filename} diverged from the shared widget source`);
    }
  }
  const checked = await syncWidgetAssets({ check: true });
  assert.equal(checked.checked, true); assert.equal(checked.publicFiles, sourceFiles.length);
  assert.deepEqual(checked.widgets, VARIANTS.map(variant => variant.id));
});

function element() {
  return { dataset: {}, hidden: false, disabled: false, textContent: '',
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
}

test('each actual HTML entry selects its fixed size and leaves height control to its native manifest', async () => {
  for (const { id, format } of VARIANTS) {
    const html = fs.readFileSync(publicPath(id, 'index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], element()]));
    const document = Object.assign(element(), { documentElement: { lang: '' }, readyState: 'complete',
      visibilityState: 'visible', hidden: false, getElementById: key => elements.get(key) });
    const ready = [];
    const Homey = { __: key => key,
      // A retained old format setting must not override the new catalogue ID.
      getSettings: () => ({ format: format === 'portrait' ? 'compact' : 'portrait' }),
      ready: (...args) => ready.push(args), api: () => assert.fail('No selected frame must cause no API request') };
    const window = Object.assign(element(), { navigator: { language: 'en' },
      FrameoWidget: require(publicPath(id, 'widget.js')),
      setTimeout: () => assert.fail('No frame and disabled rotation must create no timer'), clearTimeout() {} });
    const context = vm.createContext({ window, document });
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) vm.runInContext(match[1], context);
    }
    assert.equal(typeof context.onHomeyReady, 'function');
    context.onHomeyReady(Homey);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('widget').dataset.format, format);
    assert.equal(elements.get('widget').dataset.state, 'no_frame');
    assert.equal(ready.length, 1);
    assert.equal(ready[0][0]?.height, undefined, 'Homey.ready must not override the catalogue height');
    window.frameoWidget.destroy();
  }
});

const PEER = 'ab'.repeat(32);
const JPEG = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);

function backend(t) {
  const calls = [], cache = new PreviewCache();
  const device = { stopped: false, operation: null, lastInfo: { mayView: true },
    getData: () => ({ id: PEER }), peer: () => PEER, getName: () => 'Synthetic frame',
    accessMode: () => 'manage', getSetting: () => 'Synthetic sender',
    async refreshInfo() { calls.push('info'); return this.lastInfo; } };
  const app = { stopping: false, activeTransfer: false, transferQueue: [], permissionTask: null,
    previewCache: cache, getDevices: () => [device], async waitUntilReady() {},
    engine: {
      async listMedia() { calls.push('list'); return [{ mediaId: '1', type: 'photo', visible: true }, { mediaId: '2', type: 'photo', visible: true }]; },
      async previewMedia(peer, mediaId, options) {
        calls.push('preview:' + mediaId); assert.equal(options.encoding, 'jpeg');
        const bytes = Buffer.concat([JPEG, Buffer.from(mediaId)]);
        return { mime: 'image/jpeg', data: bytes.toString('base64'), bytes: bytes.length, width: 1, height: 1 };
      },
    } };
  const homey = { app }; device.homey = homey;
  device.preview = new DevicePreview(device, { cache, randomInt: () => 0 });
  app.widget = new FrameoWidget(app);
  t.after(async () => { await device.preview.close(); cache.clear(); });
  return { app, homey, device, calls, cache };
}

test('all three widget API aliases coalesce into one backend operation and one shared image cache', async t => {
  const apis = VARIANTS.map(({ id }) => require(path.join(WIDGETS, id, 'api.js')));
  for (const api of apis) assert.equal(api, apis[0], 'Variants must reuse the canonical API rather than initialize another backend');
  const f = backend(t);
  const initial = await Promise.all(apis.map(api => api.getPhoto({ homey: f.homey, query: { deviceId: PEER } })));
  assert(initial.every(value => value.data === initial[0].data));
  assert.deepEqual(f.calls, ['info', 'list', 'preview:1']);
  assert.equal(f.cache.size, 1); assert.equal(f.cache.bytes, JPEG.length + 1);
  assert.equal(f.device.preview.cache, f.app.previewCache);
  const changed = await Promise.all(apis.map(api => api.nextPhoto({ homey: f.homey, body: { deviceId: PEER } })));
  assert(changed.every(value => value.data === changed[0].data)); assert.notEqual(changed[0].data, initial[0].data);
  assert.deepEqual(f.calls, ['info', 'list', 'preview:1', 'info', 'list', 'preview:2']);
  assert.equal(f.cache.size, 1); assert.equal(f.cache.bytes, JPEG.length + 1); assert.equal(f.app.widget.pending.size, 0);
});

test('each catalogue API preserves the same permission, busy and JPEG size boundaries', async t => {
  const f = backend(t);
  const apis = VARIANTS.map(({ id }) => require(path.join(WIDGETS, id, 'api.js')));
  f.device.lastInfo.mayView = false;
  for (const api of apis) assert.deepEqual(await api.getPhoto({ homey: f.homey, query: { deviceId: PEER } }), { error: { code: 'PERMISSION_REQUIRED' } });
  f.device.lastInfo.mayView = true; f.app.activeTransfer = true;
  for (const api of apis) assert.deepEqual(await api.nextPhoto({ homey: f.homey, body: { deviceId: PEER } }), { error: { code: 'BUSY' } });
  f.app.activeTransfer = false;
  // Even an invalid cache injection cannot bypass the shared service's output
  // guard through one of the alternate catalogue routes.
  const excessive = { buffer: Buffer.alloc(4 * 1024 * 1024 + 1), mime: 'image/jpeg', width: 1, height: 1 };
  f.app.previewCache = { get: () => excessive };
  for (const api of apis) assert.deepEqual(await api.getPhoto({ homey: f.homey, query: { deviceId: PEER } }), { error: { code: 'IMAGE_FORMAT_UNSUPPORTED' } });
  assert.deepEqual(f.calls, []);
});
