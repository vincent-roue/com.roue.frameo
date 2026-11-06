'use strict';

const { randomInt: secureRandomInt } = require('node:crypto');
const { FrameoError, validateMediaId } = require('./frameo-engine');

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const CACHE_TTL = 10 * 60 * 1000;
const FAILURE_BACKOFF = 30 * 1000;
const PUBLIC_CODES = new Set(['ABORTED', 'BUSY', 'QUEUE_FULL', 'TIMEOUT', 'FRAME_UNAVAILABLE',
  'FRAME_UNKNOWN', 'ENGINE_NOT_READY', 'PERMISSION_REQUIRED', 'ACCESS_MODE_SEND',
  'MEDIA_NOT_FOUND', 'MEDIA_TOO_LARGE', 'TOO_MANY_MEDIA', 'IMAGE_FORMAT_UNSUPPORTED']);

function safeError(error) {
  return new FrameoError(PUBLIC_CODES.has(error?.code) ? error.code : 'ENGINE_NOT_READY');
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new FrameoError('ABORTED'));
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new FrameoError('ABORTED')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// Shared by devices; no image bytes are written to Homey settings or disk.
// Expiry is checked on access rather than through a background polling timer.
class PreviewCache {
  #entries = new Map();
  #bytes = 0;
  #now;

  constructor({ now = () => Date.now() } = {}) { this.#now = now; }

  #prune() {
    const now = this.#now();
    for (const [peer, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.delete(peer);
    }
  }

  get size() { this.#prune(); return this.#entries.size; }
  get bytes() { this.#prune(); return this.#bytes; }

  get(peer) {
    this.#prune();
    const entry = this.#entries.get(peer);
    if (!entry) return null;
    this.#entries.delete(peer);
    this.#entries.set(peer, entry);
    return entry.value;
  }

  set(peer, value) {
    if (typeof peer !== 'string' || !peer || peer.length > 128 || !Buffer.isBuffer(value?.buffer) ||
      value.buffer.length === 0 || value.buffer.length > MAX_IMAGE_BYTES) throw new FrameoError('MEDIA_TOO_LARGE');
    this.#prune(); this.delete(peer);
    while (this.#entries.size >= MAX_CACHE_ENTRIES || this.#bytes + value.buffer.length > MAX_CACHE_BYTES) {
      this.delete(this.#entries.keys().next().value);
    }
    this.#entries.set(peer, { value, expiresAt: this.#now() + CACHE_TTL });
    this.#bytes += value.buffer.length;
    return value;
  }

  delete(peer) {
    const entry = this.#entries.get(peer);
    if (!entry) return;
    this.#bytes -= entry.value.buffer.length;
    this.#entries.delete(peer);
  }

  clear() { this.#entries.clear(); this.#bytes = 0; }
}

function imageContent(value, mediaId) {
  const direct = Buffer.isBuffer(value?.buffer);
  if (!value || !['image/jpeg', 'image/png'].includes(value.mime) || (!direct && typeof value.data !== 'string') ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_IMAGE_BYTES ||
    (!direct && value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) || (direct && value.data !== undefined) ||
    !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 ||
    value.width > 2048 || value.height > 2048 || value.width * value.height > 4000000) {
    throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
  }
  const buffer = direct ? value.buffer : Buffer.from(value.data, 'base64');
  const mime = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg'
    : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : null;
  if (buffer.length !== value.bytes || (!direct && buffer.toString('base64') !== value.data) || mime !== value.mime) {
    throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
  }
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png' }[mime];
  return { buffer, mediaId, mime, width: value.width, height: value.height, filename: `frameo-preview.${extension}` };
}

function listedPhotoIds(items) {
  if (!Array.isArray(items) || items.length > 10000) throw new FrameoError('TOO_MANY_MEDIA');
  return [...new Set(items.filter(item => item?.type === 'photo' && item.visible === true).map(item => validateMediaId(item.mediaId)))];
}

function choosePhoto(ids, previousId, missingId, randomInt) {
  if (!Array.isArray(ids) || ids.length > 10000) throw new FrameoError('TOO_MANY_MEDIA');
  const excluded = [], missing = missingId === null ? -1 : ids.indexOf(missingId);
  if (missing >= 0) excluded.push(missing);
  const previous = ids.indexOf(previousId);
  if (ids.length - excluded.length > 1 && previous >= 0 && previous !== missing) excluded.push(previous);
  const count = ids.length - excluded.length;
  if (!count) throw new FrameoError('MEDIA_NOT_FOUND');
  let index = randomInt(count);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new FrameoError('ENGINE_NOT_READY');
  for (const skip of excluded.sort((a, b) => a - b)) if (index >= skip) index++;
  return validateMediaId(ids[index]);
}

class DevicePreview {
  constructor(device, { cache, now = () => Date.now(), randomInt = secureRandomInt } = {}) {
    this.device = device;
    this.cache = cache || new PreviewCache({ now });
    this.now = now; this.randomInt = randomInt;
    this.loadingPromise = null; this.controller = null;
    this.generation = 0; this.closed = false; this.lastMediaId = null;
    this.failure = null; this.loadingMediaId = null;
  }

  // Per-frame widget source only. No SDK Image, camera slot or public URL.
  peer() { return this.device.peer(); }

  cancelLoad() {
    this.generation++;
    this.controller?.abort(); this.controller = null; this.loadingPromise = null;
    this.failure = null; this.lastMediaId = null; this.loadingMediaId = null;
    try { this.cache.delete(this.peer()); } catch {}
    this.device.homey.app.engine.invalidateMediaIndex?.(this.peer());
  }

  checkAllowed(generation = this.generation, signal) {
    if (this.closed || this.device.stopped || generation !== this.generation || signal?.aborted) throw new FrameoError('ABORTED');
    if (this.device.accessMode() !== 'manage') throw new FrameoError('ACCESS_MODE_SEND');
    if (this.device.lastInfo?.mayView !== true) throw new FrameoError('PERMISSION_REQUIRED');
  }

  checkBusy() {
    const app = this.device.homey.app;
    if (app.activeTransfer || app.transferQueue?.length || app.permissionTask || this.device.operation || app.gallery?.deleting?.has(this.peer())) throw new FrameoError('BUSY');
  }

  load() { return this.startLoad(false); }

  startLoad(force) {
    try {
      this.checkAllowed();
      if (this.loadingPromise) return this.loadingPromise;
      const peer = this.peer();
      if (!force) {
        const cached = this.cache.get(peer);
        if (cached) { this.lastMediaId = cached.mediaId; return Promise.resolve(cached); }
        if (this.failure && this.now() - this.failure.at < FAILURE_BACKOFF) throw new FrameoError(this.failure.code);
      }
      this.checkBusy();
      const generation = this.generation;
      const controller = new AbortController();
      this.controller = controller;
      const signal = controller.signal;
      // Defer work until loadingPromise is assigned so concurrent widgets join
      // before the information check obtains its device operation lock.
      const task = Promise.resolve().then(async () => {
        this.checkAllowed(generation, signal); this.checkBusy();
        await abortable(this.device.refreshInfo({ signal }), signal);
        this.checkAllowed(generation, signal); this.checkBusy();
        const engine = this.device.homey.app.engine;
        const options = { name: this.device.getSetting('sender_name') || 'Homey', signal };
        const readIds = async fresh => {
          // A gallery list is always fresh. Normal widget reads can reuse its
          // compact index, but a vanished photo requires one new native list.
          const ids = !fresh && typeof engine.visiblePhotoIds === 'function'
            ? await abortable(engine.visiblePhotoIds(peer, options), signal)
            : listedPhotoIds(await abortable(engine.listMedia(peer, options), signal));
          this.checkAllowed(generation, signal); this.checkBusy(); return ids;
        };
        let ids = await readIds(false), missingId = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const mediaId = choosePhoto(ids, this.lastMediaId, missingId, this.randomInt); this.loadingMediaId = mediaId;
          let result;
          try {
            // Decode/convert only the selected thumbnail inside the bounded engine.
            result = await abortable(engine.previewMedia(peer, mediaId, { ...options, encoding: 'jpeg', output: 'buffer' }), signal);
          } catch (error) {
            if (error?.code !== 'MEDIA_NOT_FOUND' || attempt !== 0) throw error;
            this.checkAllowed(generation, signal); this.checkBusy();
            engine.invalidateMediaIndex?.(peer);
            if (this.cache.get(peer)?.mediaId === mediaId) this.cache.delete(peer);
            missingId = mediaId; this.loadingMediaId = null;
            // This is one read-only recovery, never a mutation retry. Recheck
            // the current grant and all lifecycle fences before another photo.
            await abortable(this.device.refreshInfo({ signal }), signal);
            this.checkAllowed(generation, signal); this.checkBusy();
            ids = await readIds(true); continue;
          }
          this.checkAllowed(generation, signal);
          const content = imageContent(result, mediaId);
          this.cache.set(peer, content); this.lastMediaId = mediaId; this.failure = null;
          return content;
        }
        throw new FrameoError('MEDIA_NOT_FOUND');
      }).catch(error => {
        const safe = safeError(error);
        if (['MEDIA_NOT_FOUND', 'PERMISSION_REQUIRED'].includes(safe.code)) this.device.homey.app.engine.invalidateMediaIndex?.(peer);
        if (safe.code === 'PERMISSION_REQUIRED') this.cache.delete(peer);
        if (generation === this.generation && !signal.aborted && safe.code !== 'ABORTED') {
          this.failure = { at: this.now(), code: safe.code };
        }
        throw safe;
      }).finally(() => {
        if (this.loadingPromise === task) this.loadingPromise = null;
        if (this.controller === controller) { this.controller = null; this.loadingMediaId = null; }
      });
      this.loadingPromise = task;
      return task;
    } catch (error) { return Promise.reject(safeError(error)); }
  }

  async refresh() {
    // Explicit changes bypass the cached photo and failure backoff. Only a
    // currently running request is shared; a completed click always starts a
    // new selection rather than silently returning the previous photo.
    const generation = this.generation;
    const content = await this.startLoad(true);
    this.checkAllowed(generation);
    return content;
  }

  isCurrent(value) {
    return !this.closed && this.cache.get(this.peer()) === value;
  }

  invalidateMedia(mediaId) {
    validateMediaId(mediaId);
    const peer = this.peer(), cached = this.cache.get(peer);
    this.device.homey.app.engine.invalidateMediaIndex?.(peer);
    if (cached?.mediaId === mediaId) this.cache.delete(peer);
    if (this.lastMediaId === mediaId) this.lastMediaId = null;
    // Before selection, an outstanding index may still contain this item.
    // Once another ID was selected, keep its independent preview and cache.
    if (this.loadingPromise && (!this.loadingMediaId || this.loadingMediaId === mediaId)) {
      this.generation++;
      this.controller?.abort(); this.controller = null;
      this.loadingPromise = null; this.loadingMediaId = null;
    }
    this.failure = null;
  }

  async invalidate() { this.cancelLoad(); }

  async close() { this.closed = true; this.cancelLoad(); }
}

module.exports = { DevicePreview, PreviewCache };
