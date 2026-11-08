'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const {
  create,
  translations,
  validateFile,
  imageDimensions,
  createThumbnail,
  MAX_BYTES,
  UPLOAD_CHUNK_BYTES,
} = require('../settings/app-ui');
const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
const { getReport } = require('../lib/frameo-diagnostics');
const { serialize: serializeDiagnostic } = require('../settings/diagnostic-report');
const diagnostic = () =>
  getReport(
    {
      homey: {
        manifest: { version: '0.10.0', sdk: 3 },
        version: '12.6.1',
        platform: 'local',
        platformVersion: 2,
      },
      runtimeStatus: { ready: true, platform: 'linux', architecture: 'arm64' },
      getDevices: () => [
        {
          lastInfo: { mayView: true, mayManage: false, route: 'local' },
          accessMode: () => 'manage',
          getAvailable: () => true,
        },
      ],
    },
    { now: () => Date.parse('2026-11-04T10:12:59.000Z'), memoryUsage: () => ({ rss: 20000000 }) },
  );
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const gate = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { resolve, reject, promise };
};
const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
const file = (name = 'photo.jpg', bytes = jpeg, type = 'image/jpeg') =>
  Object.assign(new Blob([bytes], { type }), { name });
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = new Map();
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
  }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  removeEventListener(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }
  async dispatch(name, extra = {}) {
    const event = {
      target: this,
      preventDefault() {
        this.prevented = true;
      },
      ...extra,
    };
    if (this.disabled && !extra.force) return event;
    for (const fn of this.listeners.get(name) || []) await fn(event);
    return event;
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  focus() {
    this.focused = true;
  }
  select() {
    this.selected = true;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  click() {
    this.clicked = true;
  }
  remove() {
    this.removed = true;
  }
  set innerHTML(_) {
    assert.fail('Never parse user names as HTML');
  }
}
function fixture({ handle, callbackOnly = false, language = 'fr', makeThumbnail } = {}) {
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const document = new Element();
  document.documentElement = { lang: '' };
  document.getElementById = (id) => elements[id];
  document.createElement = (tag) => new Element(tag);
  document.body = new Element('body');
  document.querySelectorAll = () => [];
  const window = new Element(),
    calls = [],
    live = new Set(),
    revoked = [],
    active = [];
  let next = 0;
  window.navigator = { language: 'en-GB' };
  window.Blob = Blob;
  window.btoa = globalThis.btoa;
  window.URL = {
    createObjectURL() {
      const url = 'blob:diagnostic-' + ++next;
      live.add(url);
      return url;
    },
    revokeObjectURL(url) {
      assert(live.delete(url), 'A preview may only be revoked once');
      revoked.push(url);
    },
  };
  window.setTimeout = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    if (ms > 1000) timer.unref();
    return timer;
  };
  window.clearTimeout = clearTimeout;
  const frames = [
    { id: 'a', name: 'Cadre salon' },
    { id: 'b', name: 'Cadre cuisine' },
  ];
  let groups = [
    { id: 'g', name: 'Famille', frameIds: ['a', 'b'] },
    { id: 'empty', name: 'Vide', frameIds: [] },
  ];
  const uploads = new Map();
  let uploadCounter = 0;
  let jobs = [],
    jobCounter = 0;
  const defaultHandler = async (call) => {
    const { route, body } = call;
    if (route === '/gallery/frames') return { frames };
    if (route === '/groups') return { groups };
    if (route === '/groups/save') {
      const group = { id: body.id || 'new', name: body.name, frameIds: body.frameIds };
      groups = groups.filter((item) => item.id !== group.id).concat(group);
      return { group };
    }
    if (route === '/groups/delete') {
      groups = groups.filter((item) => item.id !== body.id);
      return {};
    }
    if (route === '/transfers/start')
      return { batchId: 'batch', targets: [{ frameId: 'a', name: 'Cadre salon' }] };
    if (route === '/uploads/start') {
      const uploadId = 'upload-' + ++uploadCounter;
      uploads.set(uploadId, { ...body, offset: 0, chunks: [] });
      return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES };
    }
    if (route === '/uploads/chunk') {
      const upload = uploads.get(body.uploadId);
      assert(upload);
      assert.equal(body.offset, upload.offset);
      assert(body.data.length <= 256 * 1024);
      const bytes = Buffer.from(body.data, 'base64');
      assert(bytes.length <= UPLOAD_CHUNK_BYTES);
      upload.chunks.push(bytes);
      upload.offset += bytes.length;
      return { offset: upload.offset };
    }
    if (route === '/uploads/finish') {
      const upload = uploads.get(body.uploadId);
      assert(upload);
      assert.equal(upload.offset, upload.bytes);
      upload.finished = true;
      return defaultHandler({ route: '/transfers/manual', body });
    }
    if (route === '/uploads/abort') {
      uploads.delete(body.uploadId);
      return { aborted: true };
    }
    if (route === '/transfers/manual') {
      const id = 'job-' + ++jobCounter;
      jobs.unshift({
        id,
        status: 'succeeded',
        initiator: 'manual',
        results: [{ frameId: 'a', name: 'Cadre salon', status: 'succeeded' }],
        summary: { total: 1, succeeded: 1, failed: 0, uncertain: 0 },
      });
      return { jobId: id };
    }
    if (route.startsWith('/transfers/job?'))
      return {
        job: jobs.find((job) => job.id === new URLSearchParams(route.split('?')[1]).get('jobId')),
      };
    if (route === '/transfers/history') return { jobs };
    if (route === '/transfers/clear') {
      jobs = jobs.filter((job) => ['queued', 'running'].includes(job.status));
      return {};
    }
    if (route === '/transfers/finish') return {};
    assert.fail(route);
  };
  const Homey = {
    __: (key) => (key === 'settings_ui.language' ? language : key),
    api(method, route, body, done) {
      const call = { method, route, body: body ? structuredClone(body) : body };
      calls.push(call);
      const response = Promise.resolve().then(() =>
        handle ? handle(call, defaultHandler) : defaultHandler(call),
      );
      if (callbackOnly) {
        response.then((value) => done(null, value), done);
        return;
      }
      return response;
    },
  };
  const gallery = {
    setActive(value) {
      active.push(value);
    },
  };
  const ui = create({
    Homey,
    document,
    window,
    gallery,
    pollIntervalMs: 1,
    makeThumbnail:
      makeThumbnail ||
      (async () => {
        const url = 'blob:thumb-' + ++next;
        live.add(url);
        return { url, bytes: 2000, pixels: 16000 };
      }),
  });
  return {
    ui,
    elements,
    document,
    window,
    calls,
    live,
    revoked,
    active,
    frames,
    get groups() {
      return groups;
    },
    get jobs() {
      return jobs;
    },
    defaultHandler,
    uploads,
  };
}
test('four tabs preserve gallery ownership and settings callback transport works in the Homey language', async () => {
  const f = fixture({ callbackOnly: true, language: 'de' });
  await f.ui.init();
  assert.equal(f.document.documentElement.lang, 'de');
  assert.deepEqual(
    f.calls.map((call) => call.route),
    ['/gallery/frames', '/groups'],
  );
  assert.equal(f.elements['panel-send'].hidden, false);
  await f.elements['tab-gallery'].dispatch('click');
  assert.equal(f.elements['panel-gallery'].hidden, false);
  assert.equal(f.active.at(-1), true);
  await f.elements['tab-groups'].dispatch('click');
  assert.equal(f.active.at(-1), false);
  assert.equal(f.elements['panel-gallery'].hidden, true);
  f.ui.destroy();
});
test('unsupported iPhone HEIC, bad signatures and oversized files are rejected locally without any send', async () => {
  const f = fixture();
  await f.ui.init();
  await f.ui.addFiles([
    file('iphone.heic', jpeg, 'image/heic'),
    file('bad.jpg', Buffer.from('not jpeg')),
  ]);
  assert.equal(f.ui.stats().items, 0);
  assert.match(f.elements['send-error'].textContent, /HEIC/);
  assert.equal(
    f.calls.some((call) => call.route.startsWith('/transfers')),
    false,
  );
  await assert.rejects(
    validateFile({ name: 'large.jpg', type: 'image/jpeg', size: MAX_BYTES + 1 }),
    /IMAGE_TOO_LARGE/,
  );
  f.ui.destroy();
});
test('selected sources can be reordered and removed, remain temporary and release reduced thumbnail URLs', async () => {
  const f = fixture();
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg'), file('C.jpg')]);
  assert.equal(f.ui.stats().thumbnailPixels, 48000);
  await f.elements['send-selection'].children[0].children[2].children[1].dispatch('click');
  assert.equal(
    f.elements['send-selection'].children[0].children[1].children[0].textContent,
    'B.jpg',
  );
  await f.elements['send-selection'].children[2].children[2].children[2].dispatch('click');
  assert.equal(f.ui.stats().items, 2);
  assert.equal(f.revoked.length, 1);
  f.ui.destroy();
  assert.equal(f.live.size, 0);
  assert.equal(f.revoked.length, 3);
});
test('crop focus is chosen on each file preview and whole-image fit omits it from uploads', async () => {
  const f = fixture();
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  const row = index => f.elements['send-selection'].children[index];
  const [,, imageButton, reset] = row(0).children[3].children;
  imageButton.children[0].getBoundingClientRect = () => ({ left: 10, top: 10, width: 160, height: 80 });
  await imageButton.dispatch('click', { clientX: 50, clientY: 70 });
  assert.equal(imageButton.children[1].attributes.get('style'), 'left:25%;top:75%');
  await imageButton.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(imageButton.children[1].attributes.get('style'), 'left:30%;top:75%');
  assert.equal(reset.disabled, false);
  const other = row(1).children[3].children;
  await other[2].dispatch('keydown', { key: 'ArrowLeft' });
  await other[3].dispatch('click');
  assert.equal(other[2].children[1].attributes.get('style'), 'left:50%;top:50%');
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  let uploads = f.calls.filter(call => call.route === '/uploads/finish');
  assert.deepEqual(uploads[0].body.center, [0.3, 0.75]);
  assert.equal(Object.hasOwn(uploads[1].body, 'center'), false);
  await f.ui.addFiles([file('C.jpg')]);
  await row(0).children[3].children[2].dispatch('keydown', { key: 'ArrowUp' });
  f.elements['send-fit'].checked = true;
  await f.elements['send-fit'].dispatch('change');
  assert.equal(row(0).children.length, 3);
  await f.ui.sendSelection();
  uploads = f.calls.filter(call => call.route === '/uploads/finish');
  assert.equal(uploads[2].body.fit, true);
  assert.equal(Object.hasOwn(uploads[2].body, 'center'), false);
  f.ui.destroy();
});
test('manual sending prepares one photo at a time and waits for its terminal job before the next source', async () => {
  const first = gate();
  let enqueued = 0;
  const f = fixture({
    handle: async (call, next) => {
      if (call.route === '/uploads/finish') enqueued++;
      if (call.route === '/transfers/job?jobId=job-1') return first.promise;
      return next(call);
    },
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  f.elements['send-target'].value = 'group:g';
  f.elements['send-caption'].value = 'Un souvenir';
  f.elements['send-fit'].checked = true;
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 20 && !f.calls.some((call) => call.route.includes('job-1')); at++)
    await tick();
  assert.equal(enqueued, 1);
  assert.equal(f.ui.stats().items, 1);
  const warning = await f.window.dispatch('beforeunload');
  assert.equal(warning.prevented, true);
  assert.equal(typeof warning.returnValue, 'string');
  first.resolve({
    job: {
      id: 'job-1',
      status: 'succeeded',
      results: [
        { name: 'Cadre salon', status: 'succeeded' },
        { name: 'Cadre cuisine', status: 'succeeded' },
      ],
      summary: { uncertain: 0 },
    },
  });
  await sending;
  const sends = f.calls.filter((call) => call.route === '/uploads/finish');
  assert.equal(sends.length, 2);
  assert(
    sends.every(
      (call) =>
        typeof call.body.uploadId === 'string' &&
        call.body.caption === 'Un souvenir' &&
        call.body.fit === true,
    ),
  );
  for (const upload of f.uploads.values()) assert.deepEqual(Buffer.concat(upload.chunks), jpeg);
  assert.equal(
    f.calls.some((call) => call.route === '/transfers/manual'),
    false,
  );
  assert.deepEqual(f.calls.find((call) => call.route === '/transfers/start').body, {
    groupId: 'g',
  });
  assert.equal(f.calls.filter((call) => call.route === '/transfers/finish').length, 1);
  assert.equal(f.elements['send-results'].children.length, 2);
  assert.equal(f.ui.stats().sending, false);
  assert.equal(f.live.size, 0);
  f.ui.destroy();
});
test('a manual batch continues after an opted-in photo is parked for an offline frame', async () => {
  const f = fixture({
    handle: async (call, next) =>
      call.route === '/transfers/job?jobId=job-1'
        ? {
            job: {
              id: 'job-1',
              phase: 'waiting',
              status: 'waiting',
              summary: { uncertain: 0 },
              results: [{ name: 'Cadre salon', status: 'waiting' }],
            },
          }
        : next(call),
  });
  await f.ui.init();
  assert.equal(f.elements['send-defer'].checked, false);
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  f.elements['send-defer'].checked = true;
  await f.ui.sendSelection();
  const submissions = f.calls.filter((call) => call.route === '/uploads/finish');
  assert.equal(submissions.length, 2);
  assert.ok(submissions.every(({ body }) => body.defer === true));
  assert.equal(f.elements['send-defer'].checked, false);
  assert.match(f.elements['send-progress-title'].textContent, /attendent le retour/i);
  f.ui.destroy();
});
test('an uncertain result stops the batch and cannot automatically resubmit the uncertain photo', async () => {
  const f = fixture({
    handle: async (call, next) =>
      call.route.startsWith('/transfers/job?')
        ? {
            job: {
              id: 'job-1',
              status: 'uncertain',
              summary: { uncertain: 1 },
              results: [{ name: 'Cadre salon', status: 'uncertain', code: 'SEND_UNCONFIRMED' }],
            },
          }
        : next(call),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.equal(f.ui.stats().items, 1);
  assert.equal(
    f.elements['send-selection'].children[0].children[1].children[0].textContent,
    'B.jpg',
  );
  assert.match(f.elements['send-progress-title'].textContent, /vérifier/);
  f.ui.destroy();
});
test('a lost acceptance reply removes the submitted source and never retries the ambiguous request', async () => {
  const f = fixture({
    handle: async (call, next) => {
      if (call.route === '/uploads/finish') throw { code: 'TIMEOUT' };
      return next(call);
    },
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.equal(f.ui.stats().items, 0);
  assert.match(f.elements['send-error'].textContent, /Aucun renvoi/);
  await f.ui.sendSelection();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  f.ui.destroy();
});
test('a group may contain zero, one or multiple unique frames, and group removal never deletes frame photos', async () => {
  const f = fixture();
  await f.ui.init();
  f.elements['group-name'].value = 'Nouveau';
  await f.elements['group-form'].dispatch('submit');
  assert.deepEqual(f.calls.find((call) => call.route === '/groups/save').body, {
    name: 'Nouveau',
    frameIds: [],
  });
  f.elements['group-name'].value = 'Deux cadres';
  for (const input of f.elements['group-members'].querySelectorAll('input')) input.checked = true;
  await f.elements['group-form'].dispatch('submit');
  assert.deepEqual(f.calls.filter((call) => call.route === '/groups/save').at(-1).body.frameIds, [
    'a',
    'b',
  ]);
  await f.elements['group-list'].children[0].children[2].children[1].dispatch('click');
  assert.equal(f.elements['group-remove-panel'].hidden, false);
  await f.elements['group-remove-confirm'].dispatch('click');
  assert.equal(f.calls.filter((call) => call.route === '/groups/delete').length, 1);
  assert.equal(
    f.calls.some((call) => /gallery\/delete|pair|removeDevice/.test(call.route)),
    false,
  );
  f.ui.destroy();
});
test('activity renders safe per-frame reasons and distinguishes Flow entries; clearing preserves API ownership', async () => {
  const f = fixture({
    handle: async (call, next) =>
      call.route === '/transfers/history'
        ? {
            jobs: [
              {
                id: 'flow',
                initiator: 'flow',
                status: 'partial',
                results: [
                  { name: '<script>cadre</script>', status: 'succeeded' },
                  { name: 'Cuisine', status: 'failed', reason: 'Cadre indisponible.' },
                ],
              },
            ],
          }
        : next(call),
  });
  await f.ui.init();
  await f.ui.loadActivity();
  const card = f.elements['activity-list'].children[0];
  assert.equal(card.children[0].children[0].textContent, 'Flow');
  assert.equal(card.children[1].children[0].children[0].textContent, '<script>cadre</script>');
  assert.equal(card.children[1].children[1].children[2].textContent, 'Cadre indisponible.');
  await f.elements['activity-clear'].dispatch('click');
  assert.equal(f.calls.filter((call) => call.route === '/transfers/clear').length, 1);
  f.ui.destroy();
});
test('large original dimensions are readable from headers without decoding original image pixels', async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(8000, 16);
  png.writeUInt32BE(6000, 20);
  assert.deepEqual(await imageDimensions(file('48mp.png', png, 'image/png')), {
    width: 8000,
    height: 6000,
  });
  await assert.rejects(
    createThumbnail(
      file('48mp.png', png, 'image/png'),
      {
        createImageBitmap() {
          assert.fail('A 48 MP original must never decode for a thumbnail');
        },
      },
      {
        createElement() {
          assert.fail('No canvas should be allocated for an oversized original');
        },
      },
    ),
    /THUMBNAIL_SKIPPED/,
  );
  const sof = Buffer.from([
    255, 216, 255, 192, 0, 17, 8, 11, 184, 15, 160, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
  ]);
  assert.deepEqual(await imageDimensions(file('photo.jpg', sof)), { width: 4000, height: 3000 });
});
test('teardown removes warnings, aborts UI waits and cleans every thumbnail without fetching another source', async () => {
  const pending = gate();
  const f = fixture({
    handle: async (call, next) =>
      call.route.startsWith('/transfers/job?') ? pending.promise : next(call),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 20 && !f.calls.some((call) => call.route.includes('/job?')); at++)
    await tick();
  f.ui.destroy();
  pending.resolve({ job: { id: 'job-1', status: 'succeeded' } });
  await sending;
  assert.equal(f.live.size, 0);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.equal(f.window.listeners.get('beforeunload').size, 0);
});
test('stopping a batch finishes its current photo but never submits the next selected source', async () => {
  const current = gate();
  const f = fixture({
    handle: async (call, next) =>
      call.route.startsWith('/transfers/job?') ? current.promise : next(call),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg'), file('B.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 20 && !f.calls.some((call) => call.route.includes('/job?')); at++)
    await tick();
  await f.elements['send-stop'].dispatch('click');
  current.resolve({
    job: { id: 'job-1', status: 'succeeded', results: [], summary: { uncertain: 0 } },
  });
  await sending;
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/transfers/finish').length, 1);
  assert.equal(f.ui.stats().items, 1);
  f.ui.destroy();
});

test('an original that cannot be prepared never creates a failed transfer or a journal entry', async () => {
  const original = file('unreadable.jpg');
  const read = original.slice.bind(original);
  original.slice = (a, b) =>
    b === 16
      ? read(a, b)
      : {
          arrayBuffer: async () => {
            throw Error('LOCAL_READ_FAILED');
          },
        };
  const f = fixture();
  await f.ui.init();
  await f.ui.addFiles([original]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.elements['send-results'].children.length, 0);
  assert.equal(f.ui.stats().items, 1);
  assert.match(f.elements['send-error'].textContent, /non transmise/);
  f.ui.destroy();
});

test('the maximum selection keeps only reduced previews inside aggregate byte and pixel bounds', async () => {
  const f = fixture();
  await f.ui.init();
  await f.ui.addFiles(Array.from({ length: 25 }, (_, index) => file('photo-' + index + '.jpg')));
  const stats = f.ui.stats();
  assert.equal(stats.items, 24);
  assert(stats.thumbnailBytes <= 3 * 1024 * 1024);
  assert(stats.thumbnailPixels <= 1000000);
  assert.equal(f.live.size, 24);
  assert.match(f.elements['send-error'].textContent, /24/);
  for (const row of f.elements['send-selection'].children)
    assert.match(row.children[0].src, /^blob:thumb-/);
  f.ui.destroy();
  assert.equal(f.live.size, 0);
  assert.equal(f.ui.stats().thumbnailBytes, 0);
  assert.equal(f.ui.stats().thumbnailPixels, 0);
});

test('all settings UI fallback text is present in all four application locales', () => {
  for (const language of ['fr', 'en', 'nl', 'de']) {
    assert.deepEqual(
      Object.keys(translations[language]).sort(),
      Object.keys(translations.en).sort(),
    );
    assert.deepEqual(
      require('../locales/' + language + '.json').settings_ui,
      translations[language],
    );
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('an 8 MiB original is uploaded byte-for-byte through one 192 KiB slice and bounded JSON request at a time', async () => {
  const bytes = Buffer.alloc(MAX_BYTES, 42);
  jpeg.copy(bytes, 0);
  const original = file('large.jpg', bytes),
    read = original.slice.bind(original);
  let reading = 0,
    maxReading = 0,
    requests = 0,
    maxRequests = 0,
    finishItems;
  original.arrayBuffer = () => assert.fail('The complete original must never be read into base64');
  original.slice = (start, end) => {
    assert(end - start <= UPLOAD_CHUNK_BYTES, 'Every local read must stay inside the chunk bound');
    const part = read(start, end);
    return {
      arrayBuffer: async () => {
        reading++;
        maxReading = Math.max(reading, maxReading);
        await tick();
        try {
          return await part.arrayBuffer();
        } finally {
          reading--;
        }
      },
    };
  };
  const f = fixture({
    handle: async (call, next) => {
      if (call.route === '/uploads/chunk') {
        assert.equal(f.ui.stats().items, 1, 'Source stays selected until submission');
        requests++;
        maxRequests = Math.max(requests, maxRequests);
        await tick();
        try {
          return await next(call);
        } finally {
          requests--;
        }
      }
      if (call.route === '/uploads/finish') {
        finishItems = f.ui.stats().items;
        assert.match(f.elements['send-progress-text'].textContent, /100/);
      }
      return next(call);
    },
  });
  await f.ui.init();
  await f.ui.addFiles([original]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  const chunks = f.calls.filter((call) => call.route === '/uploads/chunk');
  assert.equal(chunks.length, Math.ceil(MAX_BYTES / UPLOAD_CHUNK_BYTES));
  assert.equal(maxReading, 1);
  assert.equal(maxRequests, 1);
  assert(
    chunks.every(
      (call) =>
        call.body.data.length <= 256 * 1024 &&
        Buffer.byteLength(JSON.stringify(call.body)) < 263000,
    ),
  );
  assert.deepEqual(Buffer.concat(f.uploads.get('upload-1').chunks), bytes);
  assert.equal(finishItems, 0);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.equal(
    f.calls.some((call) => call.route === '/transfers/manual'),
    false,
  );
  f.ui.destroy();
});

test('a wrong chunk acknowledgement aborts the temporary upload and keeps the unsubmitted original editable', async () => {
  const f = fixture({
    handle: async (call, next) => {
      const reply = await next(call);
      return call.route === '/uploads/chunk' ? { offset: reply.offset + 1 } : reply;
    },
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  await tick();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/chunk').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/abort').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  assert.equal(f.ui.stats().items, 1);
  assert.equal(f.elements['send-files'].disabled, false);
  assert.equal(f.jobs.length, 0);
  assert.match(f.elements['send-error'].textContent, /non transmise/);
  f.ui.destroy();
});

test('a failed chunk is not retried or submitted and the original stays selected', async () => {
  const f = fixture({
    handle: async (call, next) => {
      if (call.route === '/uploads/chunk') throw { code: 'TIMEOUT' };
      return next(call);
    },
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  await tick();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/start').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/chunk').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/abort').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  assert.equal(f.ui.stats().items, 1);
  assert.equal(f.jobs.length, 0);
  f.ui.destroy();
});

test('stop during an outstanding chunk aborts immediately without waiting for its late reply or submitting the photo', async () => {
  const chunk = gate();
  const f = fixture({
    handle: async (call, next) => (call.route === '/uploads/chunk' ? chunk.promise : next(call)),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 30 && !f.calls.some((call) => call.route === '/uploads/chunk'); at++)
    await tick();
  assert.equal(f.ui.stats().items, 1);
  await f.elements['send-stop'].dispatch('click');
  await sending;
  assert.equal(f.ui.stats().sending, false);
  assert.equal(f.ui.stats().items, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/abort').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  assert.match(f.elements['send-progress-title'].textContent, /annulée/);
  chunk.resolve({ offset: jpeg.length });
  await tick();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  f.ui.destroy();
});

test('destroy during a chunk cleans previews and aborts the temporary upload without a late finish', async () => {
  const chunk = gate();
  const f = fixture({
    handle: async (call, next) => (call.route === '/uploads/chunk' ? chunk.promise : next(call)),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 30 && !f.calls.some((call) => call.route === '/uploads/chunk'); at++)
    await tick();
  f.ui.destroy();
  await sending;
  chunk.resolve({ offset: jpeg.length });
  await tick();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/abort').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 0);
  assert.equal(f.live.size, 0);
});

test('an upload ID arriving after page removal is aborted rather than left as an orphaned preparation', async () => {
  const started = gate();
  const f = fixture({
    handle: async (call, next) => (call.route === '/uploads/start' ? started.promise : next(call)),
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  const sending = f.ui.sendSelection();
  for (let at = 0; at < 30 && !f.calls.some((call) => call.route === '/uploads/start'); at++)
    await tick();
  f.ui.destroy();
  await sending;
  started.resolve({ uploadId: 'late-upload', chunkBytes: UPLOAD_CHUNK_BYTES });
  await tick();
  assert.deepEqual(
    f.calls.filter((call) => call.route === '/uploads/abort').map((call) => call.body),
    [{ uploadId: 'late-upload' }],
  );
  assert.equal(
    f.calls.filter((call) => call.route === '/uploads/chunk' || call.route === '/uploads/finish')
      .length,
    0,
  );
});

test('the client refuses a server chunk limit larger than the proven transport bound', async () => {
  const f = fixture({
    handle: async (call, next) => {
      const result = await next(call);
      return call.route === '/uploads/start'
        ? { ...result, chunkBytes: UPLOAD_CHUNK_BYTES * 4 }
        : result;
    },
  });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  await tick();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/abort').length, 1);
  assert.equal(
    f.calls.filter((call) => call.route === '/uploads/chunk' || call.route === '/uploads/finish')
      .length,
    0,
  );
  assert.equal(f.ui.stats().items, 1);
  f.ui.destroy();
});

test('a one-off URL keeps the small manual API and never creates a local upload session', async () => {
  const f = fixture();
  await f.ui.init();
  f.elements['send-url'].value = 'https://example.invalid/photo.jpg';
  f.ui.addUrl();
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  assert.deepEqual(f.calls.find((call) => call.route === '/transfers/manual').body, {
    batchId: 'batch',
    url: 'https://example.invalid/photo.jpg',
    caption: '',
    fit: false,
  });
  assert.equal(
    f.calls.some((call) => call.route.startsWith('/uploads/')),
    false,
  );
  f.ui.destroy();
});

test('chunked photo submission also works with Homey callback-only settings transport', async () => {
  const f = fixture({ callbackOnly: true });
  await f.ui.init();
  await f.ui.addFiles([file('A.jpg')]);
  f.elements['send-target'].value = 'frame:a';
  await f.ui.sendSelection();
  assert.equal(f.calls.filter((call) => call.route === '/uploads/start').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/chunk').length, 1);
  assert.equal(f.calls.filter((call) => call.route === '/uploads/finish').length, 1);
  assert.deepEqual(Buffer.concat(f.uploads.get('upload-1').chunks), jpeg);
  assert.equal(f.ui.stats().items, 0);
  f.ui.destroy();
});

test('diagnostics is generated only by an explicit tap, previews a safe report and coalesces duplicate taps', async () => {
  const response = gate();
  const f = fixture({
    language: 'de',
    callbackOnly: true,
    handle: (call, fallback) => (call.route === '/diagnostics' ? response.promise : fallback(call)),
  });
  await f.ui.init();
  f.ui.switchTab('activity');
  await tick();
  assert.equal(
    f.calls.some((call) => call.route === '/diagnostics'),
    false,
  );
  const first = f.elements['diagnostic-load'].dispatch('click');
  await tick();
  await f.ui.loadDiagnostic();
  assert.equal(f.calls.filter((call) => call.route === '/diagnostics').length, 1);
  assert.equal(f.elements['diagnostic-load'].disabled, true);
  assert.equal(f.live.size, 0, 'Previewing JSON never creates an image or download URL');
  response.resolve({ report: diagnostic() });
  await first;
  assert.equal(f.elements['diagnostic-load'].disabled, false);
  assert.equal(f.elements['diagnostic-preview'].hidden, false);
  assert.equal(f.elements['diagnostic-json'].value, serializeDiagnostic(diagnostic()));
  assert.match(f.elements['diagnostic-summary'].textContent, /04\.11\.2026|04\.11\.26/);
  assert.match(f.elements['diagnostic-summary'].textContent, /1 Bilderrahmen/);
  assert.equal(f.elements['diagnostic-status'].textContent, translations.de.diagnostic_ready);
  assert.equal(f.window.navigator.clipboard, undefined);
  assert.equal(f.document.body.children.length, 0, 'The report is not automatically downloaded');
  f.ui.destroy();
});

test('diagnostic browser validation rejects unknown nested fields, private text, invalid dates and excess records', () => {
  assert.doesNotThrow(() => serializeDiagnostic(diagnostic()));
  const variants = [
    (report) => {
      report.privateKey = 'PRIVATE';
    },
    (report) => {
      report.frames[0].name = 'PRIVATE';
    },
    (report) => {
      report.performance.operations = [{ operation: 'send', caption: 'PRIVATE' }];
    },
    (report) => {
      report.errors.recent = [{ code: 'https://private.invalid', at: null }];
    },
    (report) => {
      report.generatedAt = '2026-11-04T10:12:59.000Z';
    },
    (report) => {
      report.versions.homey = '192.168.1.42';
    },
    (report) => {
      report.temporaryRecovery.path = 'PRIVATE';
    },
    (report) => {
      report.frames = Array.from({ length: 50 }, () => report.frames[0]);
      report.errors.counts = [{ code: 'TIMEOUT', count: 1 }];
    },
    (report) => {
      report.versions.app = 'PRIVATE'.repeat(30000);
    },
  ];
  for (const mutate of variants) {
    const report = diagnostic();
    mutate(report);
    assert.throws(() => serializeDiagnostic(report), /DIAGNOSTIC_INVALID/);
  }
});

test('invalid diagnostic responses show a generic error and cannot be copied or downloaded', async () => {
  const report = diagnostic();
  report.frames[0].senderName = 'PRIVATE-SENDER';
  const f = fixture({
    handle: (call, fallback) => (call.route === '/diagnostics' ? { report } : fallback(call)),
  });
  await f.ui.init();
  await f.elements['diagnostic-load'].dispatch('click');
  assert.equal(f.elements['diagnostic-preview'].hidden, true);
  assert.equal(f.elements['diagnostic-json'].value, '');
  assert.equal(f.elements['diagnostic-error'].textContent, translations.fr.diagnostic_failed);
  await f.elements['diagnostic-download'].dispatch('click');
  await f.elements['diagnostic-copy'].dispatch('click');
  assert.equal(f.live.size, 0);
  assert.equal(f.document.body.children.length, 0);
  assert.equal(
    Object.values(f.elements).some((element) => element.textContent.includes('PRIVATE')),
    false,
  );
  f.ui.destroy();
});

test('diagnostic downloads contain only the validated JSON, replace one Blob URL and revoke it on expiry or teardown', async () => {
  const f = fixture({
    handle: (call, fallback) =>
      call.route === '/diagnostics' ? { report: diagnostic() } : fallback(call),
  });
  await f.ui.init();
  await f.ui.loadDiagnostic();
  const blobs = [],
    timers = [];
  const createUrl = f.window.URL.createObjectURL;
  f.window.URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return createUrl(blob);
  };
  const setTimeout = f.window.setTimeout;
  f.window.setTimeout = (fn, ms) =>
    ms === 30000 ? (timers.push(fn), 'expiry-' + timers.length) : setTimeout(fn, ms);
  await f.elements['diagnostic-download'].dispatch('click');
  assert.equal(f.live.size, 1);
  assert.equal(blobs[0].type, 'application/json;charset=utf-8');
  assert.equal(await blobs[0].text(), serializeDiagnostic(diagnostic()));
  const anchor = f.document.body.children[0];
  assert.equal(anchor.download, 'frameo-diagnostic-20261104T1012.json');
  assert.equal(anchor.clicked, true);
  assert.equal(anchor.removed, true);
  await f.elements['diagnostic-download'].dispatch('click');
  assert.equal(f.live.size, 1);
  assert.equal(f.revoked.length, 1);
  timers.at(-1)();
  assert.equal(f.live.size, 0);
  await f.elements['diagnostic-download'].dispatch('click');
  assert.equal(f.live.size, 1);
  f.ui.destroy();
  assert.equal(f.live.size, 0);
  assert.equal(f.elements['diagnostic-json'].value, '');
});

test('copying a diagnostic uses the current click without a second API call and falls back to selected text if denied', async () => {
  const f = fixture({
    handle: (call, fallback) =>
      call.route === '/diagnostics' ? { report: diagnostic() } : fallback(call),
  });
  await f.ui.init();
  await f.ui.loadDiagnostic();
  const writes = [];
  f.window.navigator.clipboard = {
    writeText: (value) => {
      writes.push(value);
      return Promise.resolve();
    },
  };
  const priorCalls = f.calls.length;
  const clicked = f.elements['diagnostic-copy'].dispatch('click');
  assert.equal(writes.length, 1, 'Clipboard write starts synchronously in the click handler');
  await clicked;
  assert.equal(writes[0], serializeDiagnostic(diagnostic()));
  assert.equal(f.elements['diagnostic-status'].textContent, translations.fr.diagnostic_copied);
  f.window.navigator.clipboard.writeText = () => Promise.reject(Error('PRIVATE-CLIPBOARD-ERROR'));
  await f.elements['diagnostic-copy'].dispatch('click');
  assert.equal(f.elements['diagnostic-status'].textContent, translations.fr.diagnostic_manual_copy);
  assert.equal(f.elements['diagnostic-json'].selected, true);
  assert.equal(f.elements['diagnostic-json'].selectionStart, 0);
  assert.equal(f.elements['diagnostic-json'].selectionEnd, writes[0].length);
  assert.equal(f.calls.length, priorCalls);
  assert.equal(f.live.size, 0);
  f.ui.destroy();
});

test('diagnostic copy supports webviews without Clipboard API and leaves a manual selection when copy is unavailable', async () => {
  const f = fixture({
    language: 'nl',
    handle: (call, fallback) =>
      call.route === '/diagnostics' ? { report: diagnostic() } : fallback(call),
  });
  await f.ui.init();
  await f.ui.loadDiagnostic();
  const commands = [];
  f.document.execCommand = (command) => {
    commands.push(command);
    return true;
  };
  await f.elements['diagnostic-copy'].dispatch('click');
  assert.deepEqual(commands, ['copy']);
  assert.equal(f.elements['diagnostic-status'].textContent, translations.nl.diagnostic_copied);
  delete f.document.execCommand;
  await f.elements['diagnostic-copy'].dispatch('click');
  assert.equal(f.elements['diagnostic-status'].textContent, translations.nl.diagnostic_manual_copy);
  assert.equal(f.elements['diagnostic-json'].focused, true);
  assert.equal(f.calls.filter((call) => call.route === '/diagnostics').length, 1);
  f.ui.destroy();
});

test('page teardown ignores a late diagnostic response and never creates a download or clipboard write', async () => {
  const response = gate();
  const f = fixture({
    handle: (call, fallback) => (call.route === '/diagnostics' ? response.promise : fallback(call)),
  });
  await f.ui.init();
  const load = f.ui.loadDiagnostic();
  await tick();
  f.ui.destroy();
  await load;
  response.resolve({ report: diagnostic() });
  await tick();
  assert.equal(f.elements['diagnostic-json'].value, '');
  assert.equal(f.elements['diagnostic-preview'].hidden, true);
  assert.equal(f.live.size, 0);
  assert.equal(f.document.body.children.length, 0);
});
