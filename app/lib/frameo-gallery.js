'use strict';
const crypto = require('node:crypto');
const { validateMediaId } = require('./frameo-engine');

const CODES = {
  ACCESS_MODE_SEND: 'gallery.errors.send_only', PERMISSION_REQUIRED: 'gallery.errors.permission',
  GALLERY_STALE: 'gallery.errors.stale', GALLERY_INVALID_REQUEST: 'gallery.errors.invalid',
  MEDIA_NOT_FOUND: 'gallery.errors.not_found', MEDIA_TYPE_UNSUPPORTED: 'gallery.errors.unsupported',
  INVALID_MEDIA_ID: 'gallery.errors.invalid', PREVIEW_REQUIRED: 'gallery.errors.preview_required',
  DELETE_UNVERIFIED: 'gallery.errors.delete_uncertain', VISIBILITY_UNVERIFIED: 'gallery.errors.visibility_uncertain',
  MEDIA_TOO_LARGE: 'gallery.errors.too_large', IMAGE_FORMAT_UNSUPPORTED: 'gallery.errors.unsupported',
  TOO_MANY_MEDIA: 'gallery.errors.too_many', BUSY: 'errors.busy', QUEUE_FULL: 'errors.busy',
  ENGINE_NOT_READY: 'errors.not_ready', TIMEOUT: 'errors.timeout', FRAME_UNAVAILABLE: 'errors.frame_unavailable',
  ABORTED: 'errors.aborted',
};

function listOptions({ type = 'all', visibility = 'all', sort = 'received_desc' }) {
  if (!['all', 'photo', 'video', 'greeting'].includes(type)
    || !['all', 'visible', 'hidden'].includes(visibility)
    || !['received_desc', 'received_asc', 'captured_desc', 'captured_asc'].includes(sort)) return null;
  return { type, visibility, sort };
}

function orderedItems(items, options) {
  const field = options.sort.startsWith('captured_') ? 'captureDate' : 'receiveDate';
  const direction = options.sort.endsWith('_asc') ? 1 : -1;
  return items.filter(item => (options.type === 'all' || item.type === options.type)
    && (options.visibility === 'all' || item.visible === (options.visibility === 'visible')))
    .sort((a, b) => {
      const first = Date.parse(a[field] || ''), second = Date.parse(b[field] || '');
      if (Number.isFinite(first) !== Number.isFinite(second)) return Number.isFinite(first) ? -1 : 1;
      return (Number.isFinite(first) ? (first - second) * direction : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

class FrameoGallery {
  constructor(app, { now = () => Date.now(), ttl = 5 * 60 * 1000 } = {}) {
    this.app = app; this.now = now; this.ttl = ttl; this.closed = false;
    this.snapshots = new Map(); this.deleting = new Set();
    this.deleteAttempts = new Map(); this.visibilityAttempts = new Map(); this.epochs = new Map();
  }
  fail(code) {
    const error = new Error(this.app.homey.__(CODES[code] || 'gallery.errors.failed'));
    error.code = Object.hasOwn(CODES, code) ? code : 'GALLERY_FAILED';
    return error;
  }
  async safe(task) { try { return await task(); } catch (error) { throw this.fail(error?.code); } }
  frame(device) {
    const status = device.publicStatus();
    return { id: device.getData().id, name: device.getName(), senderName: device.getSetting('sender_name') || 'Homey',
      mode: device.accessMode(), mayView: status.info?.mayView === true, mayManage: status.info?.mayManage === true };
  }
  frames() { return { frames: this.app.getDevices().map(device => this.frame(device)) }; }
  device(id) {
    const device = this.app.getDevice(id);
    if (device.accessMode() !== 'manage') throw this.fail('ACCESS_MODE_SEND');
    return device;
  }
  async ready() {
    if (this.closed) throw this.fail('ABORTED');
    await this.app.waitUntilReady();
    if (this.closed) throw this.fail('ABORTED');
    if (this.app.stopping || this.app.activeTransfer || this.app.transferQueue?.length || this.app.permissionTask) throw this.fail('BUSY');
  }
  ensureReadable(device, id) {
    if (this.closed || this.app.stopping) throw this.fail('ABORTED');
    if (device.stopped || this.app.getDevice(id) !== device) throw this.fail('FRAME_UNAVAILABLE');
    if (device.accessMode() !== 'manage') throw this.fail('ACCESS_MODE_SEND');
    if (device.lastInfo?.mayView !== true) throw this.fail('PERMISSION_REQUIRED');
  }
  epoch(id) { return this.epochs.get(id) || 0; }
  changed(id) {
    // Bound this fence to the app's own paired frames, not arbitrary user IDs.
    const next = this.epoch(id) + 1;
    this.epochs.set(id, next);
    while (this.epochs.size > 64) this.epochs.delete(this.epochs.keys().next().value);
    this.snapshots.delete(id);
  }
  async setMode({ id, mode }) {
    return this.safe(async () => {
      if (!['send', 'manage'].includes(mode)) throw this.fail('GALLERY_INVALID_REQUEST');
      const device = this.app.getDevice(id);
      await device.setAccessMode(mode); this.changed(id);
      return { mode, frame: this.frame(device) };
    });
  }
  async checkAccess({ id }) {
    return this.safe(async () => {
      await this.ready(); const device = this.app.getDevice(id);
      if (this.deleting.has(id)) throw this.fail('BUSY');
      await device.refreshInfo();
      if (device.lastInfo?.mayView !== true) this.snapshots.delete(id);
      return this.frame(device);
    });
  }
  snapshot(id, revision) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot || this.now() - snapshot.at > this.ttl) {
      this.snapshots.delete(id); throw this.fail('GALLERY_STALE');
    }
    if (revision !== undefined && snapshot.revision !== revision) throw this.fail('GALLERY_STALE');
    return snapshot;
  }
  async list(input) {
    return this.safe(async () => {
      const { id, cursor, limit = 24 } = input;
      const options = listOptions(input);
      if (!options || !Number.isInteger(limit) || limit < 1 || limit > 24) throw this.fail('GALLERY_INVALID_REQUEST');
      await this.ready(); const device = this.device(id);
      if (this.deleting.has(id)) throw this.fail('BUSY');
      let snapshot, offset = 0;
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        if (typeof cursor !== 'string' || !/^[a-f0-9-]{36}:\d{1,5}$/.test(cursor)) throw this.fail('GALLERY_INVALID_REQUEST');
        const [revision, start] = cursor.split(':'); snapshot = this.snapshot(id, revision); offset = Number(start);
        if (JSON.stringify(snapshot.options) !== JSON.stringify(options) || offset > snapshot.items.length) throw this.fail('GALLERY_STALE');
      } else {
        const epoch = this.epoch(id);
        await device.refreshInfo(); this.ensureReadable(device, id);
        const raw = await this.app.engine.listMedia(id, { name: this.frame(device).senderName });
        this.ensureReadable(device, id);
        if (epoch !== this.epoch(id) || this.deleting.has(id)) throw this.fail('GALLERY_STALE');
        if (!Array.isArray(raw) || raw.length > 10000) throw this.fail('TOO_MANY_MEDIA');
        const seen = new Set();
        const items = raw.map(item => {
          validateMediaId(item.mediaId);
          if (seen.has(item.mediaId) || typeof item.visible !== 'boolean') throw this.fail('GALLERY_INVALID_REQUEST');
          seen.add(item.mediaId);
          return { id: item.mediaId, type: item.type, visible: item.visible,
            captureDate: item.captureDate, receiveDate: item.receiveDate };
        });
        snapshot = { revision: crypto.randomUUID(), items: orderedItems(items, options), options,
          at: this.now(), previewed: new Set() };
        this.snapshots.delete(id);
        while (this.snapshots.size >= 2) this.snapshots.delete(this.snapshots.keys().next().value);
        this.snapshots.set(id, snapshot);
      }
      this.ensureReadable(device, id);
      const next = offset + limit;
      return { items: snapshot.items.slice(offset, next), total: snapshot.items.length,
        revision: snapshot.revision, nextCursor: next < snapshot.items.length ? snapshot.revision + ':' + next : null };
    });
  }
  async preview({ id, mediaId, revision }) {
    return this.safe(async () => {
      await this.ready(); const device = this.device(id); validateMediaId(mediaId);
      if (this.deleting.has(id)) throw this.fail('BUSY');
      this.ensureReadable(device, id);
      const snapshot = this.snapshot(id, revision);
      const item = snapshot.items.find(item => item.id === mediaId);
      if (!item) throw this.fail('MEDIA_NOT_FOUND');
      if (!['photo', 'greeting'].includes(item.type)) throw this.fail('MEDIA_TYPE_UNSUPPORTED');
      const preview = await this.app.engine.previewMedia(id, mediaId, { name: this.frame(device).senderName });
      this.ensureReadable(device, id);
      if (this.snapshot(id, snapshot.revision) !== snapshot || this.deleting.has(id)) throw this.fail('GALLERY_STALE');
      snapshot.previewed.add(mediaId);
      return preview;
    });
  }
  notify(id, mediaId, kind, visible) {
    if (this.closed || this.app.stopping) return;
    try {
      const event = { id, mediaId, change: kind, ...(kind === 'visibility' ? { visible } : {}) };
      Promise.resolve(this.app.homey.api?.realtime?.('gallery.changed', event)).catch(() => {});
    } catch { /* Realtime delivery is best-effort; the cache fence is authoritative. */ }
  }
  async mutate({ id, mediaId, revision, confirmation, visible }, kind) {
    return this.safe(async () => {
      validateMediaId(mediaId);
      if (confirmation !== kind || typeof revision !== 'string' || (kind === 'visibility' && typeof visible !== 'boolean')) {
        throw this.fail('GALLERY_INVALID_REQUEST');
      }
      await this.ready(); const device = this.device(id);
      const attempts = kind === 'delete' ? this.deleteAttempts : this.visibilityAttempts;
      const uncertain = kind === 'delete' ? 'DELETE_UNVERIFIED' : 'VISIBILITY_UNVERIFIED';
      const key = id + ':' + revision + ':' + mediaId + (kind === 'visibility' ? ':' + visible : '');
      const previous = attempts.get(key);
      if (previous?.verified) return { ...previous.result };
      if (previous) throw this.fail(uncertain);
      const snapshot = this.snapshot(id, revision);
      const item = snapshot.items.find(item => item.id === mediaId);
      if (!item) throw this.fail('MEDIA_NOT_FOUND');
      if (!['photo', 'greeting'].includes(item.type)) throw this.fail('MEDIA_TYPE_UNSUPPORTED');
      if (!snapshot.previewed.has(mediaId)) throw this.fail('PREVIEW_REQUIRED');
      if (this.deleting.has(id)) throw this.fail('BUSY');
      this.deleting.add(id);
      let attempted = false;
      try {
        await device.refreshInfo(); this.ensureReadable(device, id);
        if (device.lastInfo?.mayManage !== true) throw this.fail('PERMISSION_REQUIRED');
        if (this.snapshot(id, revision) !== snapshot) throw this.fail('GALLERY_STALE');
        this.changed(id);
        await device.preview?.invalidateMedia?.(mediaId);
        while (attempts.size >= 64) attempts.delete(attempts.keys().next().value);
        attempts.set(key, { verified: false }); attempted = true;
        const native = kind === 'delete'
          ? await this.app.engine.deleteMedia(id, mediaId, { name: this.frame(device).senderName })
          : await this.app.engine.setMediaVisible(id, mediaId, visible, { name: this.frame(device).senderName });
        const valid = native?.mediaId === mediaId && (kind === 'delete' ? native.deleted === true
          : native.visible === visible && native.acknowledged === true && native.verified === true);
        if (!valid) throw this.fail(uncertain);
        const result = kind === 'delete' ? { mediaId, deleted: true }
          : { mediaId, visible, acknowledged: true, verified: true };
        attempts.set(key, { verified: true, result });
        return { ...result };
      } finally {
        try {
          if (attempted) {
            this.snapshots.delete(id);
            try { await device.preview?.invalidateMedia?.(mediaId); } catch { /* The device may have been removed meanwhile. */ }
            this.notify(id, mediaId, kind, visible);
          }
        } finally { this.deleting.delete(id); }
      }
    });
  }
  delete(input) { return this.mutate(input, 'delete'); }
  visibility(input) { return this.mutate(input, 'visibility'); }
  close() { this.closed = true; this.snapshots.clear(); this.deleteAttempts.clear(); this.visibilityAttempts.clear(); this.epochs.clear(); }
}

module.exports = { FrameoGallery };
