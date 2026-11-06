'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameoGallery } = require('../lib/frameo-gallery');
const fr = require('../locales/fr.json');
const PEER = 'ab'.repeat(32), ID = '9223372036854775807';
function fixture({ mode = 'manage', mayView = true, mayManage = true, count = 30 } = {}) {
  let now = 1000;
  const calls = [];
  const items = Array.from({ length: count }, (_, index) => ({ mediaId: (9223372036854775807n - BigInt(index)).toString(),
    type: 'photo', visible: true, captureDate: null, receiveDate: new Date(1700000000000 - index * 1000).toISOString() }));
  const device = { lastInfo: { mayView, mayManage }, getData: () => ({ id: PEER }), getName: () => 'Cadre famille',
    getSetting: () => 'Homey du salon', accessMode: () => mode,
    publicStatus() { return { info: this.lastInfo }; },
    async refreshInfo() { calls.push('info'); return this.lastInfo; },
    async setAccessMode(value) { mode = value; },
  };
  const app = { activeTransfer: false, transferQueue: [], permissionTask: null,
    homey: { __: key => key.split('.').reduce((value, field) => value?.[field], fr) || key },
    async waitUntilReady() {}, getDevices: () => [device], getDevice(id) { assert.equal(id, PEER); return device; },
    engine: { async listMedia() { calls.push('list'); return structuredClone(items); },
      async previewMedia(peer, id) { calls.push(['preview', peer, id]); return { mime: 'image/png', data: 'iVBORw0KGgo=', bytes: 8, width: 1, height: 1 }; },
      async deleteMedia(peer, id) { calls.push(['delete', peer, id]); return { mediaId: id, deleted: true }; } },
  };
  const gallery = new FrameoGallery(app, { now: () => now, ttl: 5000 });
  return { gallery, app, device, calls, items, advance(ms) { now += ms; } };
}

test('gallery mode is explicit and permission checks never request a popup or read media', async () => {
  const f = fixture({ mode: 'send' });
  assert.equal(f.gallery.frames().frames[0].mode, 'send');
  await assert.rejects(f.gallery.list({ id: PEER }), { code: 'ACCESS_MODE_SEND' });
  assert.deepEqual(f.calls, []);
  await f.gallery.setMode({ id: PEER, mode: 'manage' });
  await f.gallery.checkAccess({ id: PEER });
  assert.deepEqual(f.calls, ['info']);
  assert.equal(f.gallery.frames().frames[0].senderName, 'Homey du salon');
});

test('gallery pages contain at most 24 exact string IDs and reuse one bounded index', async () => {
  const f = fixture();
  const first = await f.gallery.list({ id: PEER });
  assert.equal(first.items.length, 24); assert.equal(first.items[0].id, ID); assert.equal(first.total, 30);
  const second = await f.gallery.list({ id: PEER, cursor: first.nextCursor });
  assert.equal(second.items.length, 6); assert.equal(second.nextCursor, null);
  assert.deepEqual(f.calls, ['info', 'list']);
  f.advance(5001);
  await assert.rejects(f.gallery.list({ id: PEER, cursor: first.nextCursor }), { code: 'GALLERY_STALE' });
});

test('send-only or revoked permissions cannot expose an index', async () => {
  const f = fixture({ mayView: false });
  await assert.rejects(f.gallery.list({ id: PEER }), { code: 'PERMISSION_REQUIRED' });
  assert.deepEqual(f.calls, ['info']); assert.equal(f.gallery.snapshots.size, 0);
});

test('delete requires current index, actual preview and explicit confirmation before touching frame media', async () => {
  const f = fixture(), page = await f.gallery.list({ id: PEER });
  await assert.rejects(f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision }), { code: 'GALLERY_INVALID_REQUEST' });
  await assert.rejects(f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' }), { code: 'PREVIEW_REQUIRED' });
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === 'delete'));
  await f.gallery.preview({ id: PEER, mediaId: ID });
  const result = await f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' });
  assert.deepEqual(result, { mediaId: ID, deleted: true });
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'delete').length, 1);
  assert.equal(f.gallery.snapshots.size, 0);
  assert.deepEqual(await f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' }), result);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'delete').length, 1, 'Repeated successful HTTP request must not repeat native delete');
});

test('read-only access permits viewing but blocks deletion even after a valid preview', async () => {
  const f = fixture({ mayManage: false }), page = await f.gallery.list({ id: PEER });
  await f.gallery.preview({ id: PEER, mediaId: ID });
  await assert.rejects(f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' }), { code: 'PERMISSION_REQUIRED' });
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === 'delete'));
});

test('uncertain deletion is never repeated for the same snapshot and never leaks native diagnostics', async () => {
  const f = fixture(), page = await f.gallery.list({ id: PEER });
  await f.gallery.preview({ id: PEER, mediaId: ID });
  let deletes = 0;
  f.app.engine.deleteMedia = async () => { deletes++; throw Object.assign(Error('private native trace'), { code: 'DELETE_UNVERIFIED' }); };
  const request = { id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' };
  await assert.rejects(f.gallery.delete(request), error => { assert.equal(error.code, 'DELETE_UNVERIFIED'); assert(!error.message.includes('native')); return true; });
  await assert.rejects(f.gallery.delete(request), { code: 'DELETE_UNVERIFIED' }); assert.equal(deletes, 1);
});

test('a failed or unsupported preview cannot authorize deletion and an expired snapshot must be refreshed', async () => {
  const f = fixture(); f.items[0].type = 'video';
  const page = await f.gallery.list({ id: PEER });
  await assert.rejects(f.gallery.preview({ id: PEER, mediaId: ID }), { code: 'MEDIA_TYPE_UNSUPPORTED' });
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === 'preview'));
  f.advance(5001);
  await assert.rejects(f.gallery.delete({ id: PEER, mediaId: ID, revision: page.revision, confirmation: 'delete' }), { code: 'GALLERY_STALE' });
});

test('gallery reads yield to photo transfers and cannot silently switch a frame mode', async () => {
  const f = fixture(); f.app.activeTransfer = true;
  await assert.rejects(f.gallery.list({ id: PEER }), { code: 'BUSY' }); assert.deepEqual(f.calls, []);
  f.app.activeTransfer = false;
  await assert.rejects(f.gallery.setMode({ id: PEER, mode: 'invalid' }), { code: 'GALLERY_INVALID_REQUEST' });
  assert.equal(f.device.accessMode(), 'manage');
});
