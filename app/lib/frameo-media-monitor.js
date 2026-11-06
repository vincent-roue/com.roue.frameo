'use strict';

const { createHash } = require('node:crypto');
const { validateMediaId } = require('./frameo-engine');

const STORE_KEY = 'frameo_media_baseline';
const MAX_ITEMS = 10000;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_ADDED = 100;
const TYPES = new Set(['photo', 'video', 'greeting', 'unknown']);
const CODES = new Set(['ABORTED', 'BUSY', 'QUEUE_FULL', 'TIMEOUT', 'ENGINE_NOT_READY', 'FRAME_UNAVAILABLE', 'FRAME_UNKNOWN',
  'CONNECTION_FAILED', 'CONNECTION_REFUSED', 'AUTHENTICATION_FAILED', 'ACCESS_MODE_SEND', 'PERMISSION_REQUIRED',
  'TOO_MANY_MEDIA', 'MEDIA_MONITOR_STORE_FAILED']);

function coded(code) { const error = new Error(CODES.has(code) ? code : 'ENGINE_NOT_READY'); error.code = error.message; return error; }
function safeDate(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(value).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}
function scopeFor(device) {
  const name = typeof device.getSetting('sender_name') === 'string' ? device.getSetting('sender_name') : 'Homey';
  return createHash('sha256').update(device.peer()).update('\0').update(name).digest('hex');
}
function normalItems(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw coded('TOO_MANY_MEDIA');
  const seen = new Set();
  return raw.map(value => {
    let mediaId;
    try { mediaId = validateMediaId(value?.mediaId); } catch { throw coded('ENGINE_NOT_READY'); }
    if (seen.has(mediaId)) throw coded('ENGINE_NOT_READY');
    seen.add(mediaId);
    return { mediaId, type: TYPES.has(value.type) ? value.type : 'unknown', receiveDate: safeDate(value.receiveDate),
      visible: typeof value.visible === 'boolean' ? value.visible : null };
  });
}
function countItems(items) {
  const counts = { photos: 0, videos: 0, greetings: 0, unknown: 0, total: items.length, visible: 0, hidden: 0, visibilityUnknown: 0 };
  for (const item of items) {
    counts[{ photo: 'photos', video: 'videos', greeting: 'greetings', unknown: 'unknown' }[item.type]]++;
    counts[item.visible === true ? 'visible' : item.visible === false ? 'hidden' : 'visibilityUnknown']++;
  }
  return counts;
}
function latestReceipt(items) {
  let latest = null;
  for (const item of items) if (item.receiveDate && (latest === null || item.receiveDate > latest)) latest = item.receiveDate;
  return latest;
}
function baselineFor(value, scope) {
  try {
    if (!value || value.version !== 1 || value.scope !== scope || !safeDate(value.checkedAt) ||
      !Array.isArray(value.ids) || value.ids.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(value)) > MAX_STORE_BYTES) return null;
    const ids = value.ids.map(validateMediaId);
    if (new Set(ids).size !== ids.length) return null;
    return new Set(ids);
  } catch { return null; }
}
function storedCounts(value, total) {
  if (!value || ['photos', 'videos', 'greetings', 'unknown', 'total'].some(key => !Number.isInteger(value[key]) || value[key] < 0 || value[key] > MAX_ITEMS) ||
    value.total !== total || value.photos + value.videos + value.greetings + value.unknown !== total) return null;
  const visibilityKnown = ['visible', 'hidden', 'visibilityUnknown'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= MAX_ITEMS)
    && value.visible + value.hidden + value.visibilityUnknown === total;
  return { photos: value.photos, videos: value.videos, greetings: value.greetings, unknown: value.unknown, total,
    visible: visibilityKnown ? value.visible : null, hidden: visibilityKnown ? value.hidden : null,
    visibilityUnknown: visibilityKnown ? value.visibilityUnknown : null };
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(coded('ABORTED'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(coded('ABORTED')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

// This is a metadata comparison, not a receipt from the frame. It performs no
// image retrieval and never requests rights, pairs, sends or mutates a medium.
// Scheduling and Flow delivery belong to callers, after a successful check.
class FrameoMediaMonitor {
  constructor(app, { now = () => Date.now() } = {}) {
    this.app = app; this.now = now; this.states = new Map(); this.closed = false;
  }
  state(device) {
    let state = this.states.get(device);
    if (!state) {
      for (const [previous, value] of this.states) if (previous.stopped && !value.pending) this.states.delete(previous);
      if (this.states.size >= 64) throw coded('QUEUE_FULL');
      state = { generation: 0, pending: null, controller: null, writes: Promise.resolve() }; this.states.set(device, state);
    }
    return state;
  }
  guard(device, state, generation, signal, { permission = true, busy = true } = {}) {
    if (this.closed || this.app.stopping || device.stopped || signal?.aborted || state.generation !== generation) throw coded('ABORTED');
    if (!this.app.getDevices().includes(device)) throw coded('FRAME_UNKNOWN');
    if (device.accessMode() !== 'manage') throw coded('ACCESS_MODE_SEND');
    if (permission && device.lastInfo?.mayView !== true) throw coded('PERMISSION_REQUIRED');
    if (busy && (this.app.activeTransfer || this.app.transferQueue?.length || this.app.permissionTask || device.operation ||
      device.preview?.loadingPromise || this.app.gallery?.deleting?.has(device.peer()))) throw coded('BUSY');
  }
  write(state, task) {
    const next = state.writes.then(task); state.writes = next.catch(() => {}); return next;
  }
  async clearBaseline(device, state) {
    try { await this.write(state, () => device.setStoreValue(STORE_KEY, null)); }
    catch { throw coded('MEDIA_MONITOR_STORE_FAILED'); }
  }
  check(device, { refreshInfo = true, signal } = {}) {
    let state;
    try {
      if (!this.app.getDevices().includes(device)) throw coded('FRAME_UNKNOWN');
      state = this.state(device); this.guard(device, state, state.generation, signal, { permission: false, busy: false });
      if (state.pending) return state.pending;
      this.guard(device, state, state.generation, signal, { permission: false });
    } catch (error) {
      if (state && error?.code === 'ACCESS_MODE_SEND') return this.clearBaseline(device, state).then(() => { throw coded(error.code); });
      return Promise.reject(coded(error?.code));
    }
    const generation = state.generation, controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    state.controller = controller;
    const task = Promise.resolve().then(async () => {
      this.guard(device, state, generation, combined, { permission: false });
      // refreshInfo:false is only for internal callers that have just awaited
      // device.refreshInfo(). It must not be accepted from an external API.
      if (refreshInfo) await abortable(device.refreshInfo({ signal: combined }), combined);
      this.guard(device, state, generation, combined);
      const scope = scopeFor(device), saved = await device.getStoreValue(STORE_KEY);
      this.guard(device, state, generation, combined);
      const previous = baselineFor(saved, scope);
      const raw = await abortable(this.app.engine.listMedia(device.peer(), {
        name: device.getSetting('sender_name') || 'Homey', signal: combined,
      }), combined);
      this.guard(device, state, generation, combined);
      if (scopeFor(device) !== scope) throw coded('ABORTED');
      const items = normalItems(raw), counts = countItems(items), checkedAt = new Date(this.now()).toISOString(), latestReceivedAt = latestReceipt(items);
      const added = [], baseline = previous === null; let addedCount = 0;
      if (!baseline) for (const item of items) if (!previous.has(item.mediaId)) {
        addedCount++; if (added.length < MAX_ADDED) added.push({ mediaId: item.mediaId, type: item.type, receiveDate: item.receiveDate });
      }
      const next = { version: 1, scope, checkedAt, ids: items.map(item => item.mediaId), counts, latestReceivedAt };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_STORE_BYTES) throw coded('TOO_MANY_MEDIA');
      try {
        await this.write(state, () => {
          this.guard(device, state, generation, combined, { busy: false });
          return device.setStoreValue(STORE_KEY, next);
        });
      } catch (error) {
        if (['ABORTED', 'ACCESS_MODE_SEND', 'PERMISSION_REQUIRED', 'FRAME_UNKNOWN'].includes(error?.code)) throw error;
        throw coded('MEDIA_MONITOR_STORE_FAILED');
      }
      this.guard(device, state, generation, combined, { busy: false });
      if (scopeFor(device) !== scope) throw coded('ABORTED');
      return { checkedAt, baseline, counts, latestReceivedAt, added, addedCount, eventsSuppressed: addedCount > added.length };
    }).catch(async error => {
      if (['PERMISSION_REQUIRED', 'ACCESS_MODE_SEND'].includes(error?.code)) await this.clearBaseline(device, state);
      throw coded(error?.code);
    }).finally(() => {
      if (state.pending === task) state.pending = null;
      if (state.controller === controller) state.controller = null;
    });
    state.pending = task; return task;
  }
  async invalidate(device, { forget = false } = {}) {
    const state = this.state(device); state.generation++; state.controller?.abort();
    await this.clearBaseline(device, state);
    if (forget && !state.pending) this.states.delete(device);
  }
  async restore(device) {
    try {
      const state = this.state(device), generation = state.generation;
      this.guard(device, state, generation, undefined, { busy: false });
      const scope = scopeFor(device), saved = await device.getStoreValue(STORE_KEY);
      this.guard(device, state, generation, undefined, { busy: false });
      if (scopeFor(device) !== scope) return null;
      const ids = baselineFor(saved, scope), counts = ids && storedCounts(saved.counts, ids.size);
      return counts ? { checkedAt: safeDate(saved.checkedAt), counts, latestReceivedAt: counts.total > 0 ? safeDate(saved.latestReceivedAt) : null, restored: true } : null;
    } catch { return null; }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const states = [...this.states.values()];
    for (const state of states) { state.generation++; state.controller?.abort(); }
    await Promise.allSettled(states.map(async state => { await state.pending?.catch(() => {}); await state.writes; }));
    this.states.clear();
  }
}

module.exports = { FrameoMediaMonitor, STORE_KEY, MAX_ITEMS, MAX_STORE_BYTES, MAX_ADDED };
