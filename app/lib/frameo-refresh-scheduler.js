'use strict';

const DEFAULT_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 1440;
const MAX_JITTER_MS = 30000;
const DEFAULT_BUSY_RETRY_MS = 60000;
const backgroundOwners = new WeakMap();
const SAFE_ERROR_CODES = new Set(['TIMEOUT', 'ABORTED', 'BUSY', 'QUEUE_FULL',
  'ENGINE_NOT_READY', 'FRAME_UNAVAILABLE', 'FRAME_UNKNOWN', 'PERMISSION_REQUIRED',
  'PERMISSION_DENIED', 'MEDIA_MONITOR_STORE_FAILED', 'TRANSFER_CANCELLED']);

function normalizeSettings(input = {}) {
  const { enabled, intervalMinutes } = input && typeof input === 'object' ? input : {};
  const active = enabled === undefined || enabled === null ? true : enabled === true;
  const minutes = typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)
    ? Math.min(MAX_INTERVAL_MINUTES, Math.max(1, Math.trunc(intervalMinutes)))
    : DEFAULT_INTERVAL_MINUTES;
  return { enabled: active, intervalMinutes: minutes };
}

function deterministicJitter(key, cycle) {
  // Only the public pairing ID seeds this small scheduling offset.
  const value = String(key).slice(0, 128) + ':' + cycle;
  let hash = 2166136261;
  for (let at = 0; at < value.length; at++) hash = Math.imul(hash ^ value.charCodeAt(at), 16777619);
  return (hash >>> 0) % (MAX_JITTER_MS + 1);
}

class FrameoRefreshScheduler {
  constructor(device, { refresh, isBusy, now = () => Date.now(), timers,
    jitter = deterministicJitter, busyRetryMs = DEFAULT_BUSY_RETRY_MS } = {}) {
    if (!device || typeof refresh !== 'function') throw new TypeError('A device and read-only refresh callback are required');
    this.device = device; this.homey = device.homey; this.refresh = refresh;
    this.extraBusy = isBusy; this.now = now; this.jitter = jitter;
    this.busyRetryMs = Number.isFinite(busyRetryMs) && busyRetryMs > 0 ? Math.max(1000, busyRetryMs) : DEFAULT_BUSY_RETRY_MS;
    const provider = timers || (typeof this.homey?.setTimeout === 'function'
      && typeof this.homey?.clearTimeout === 'function' ? this.homey : globalThis);
    this.setTimer = provider.setTimeout.bind(provider);
    this.clearTimer = provider.clearTimeout.bind(provider);
    const app = this.homey?.app;
    this.app = app && typeof app === 'object' ? app : null;
    this.owner = this.app || (this.homey && typeof this.homey === 'object' ? this.homey : device);
    try { this.key = String(device.getData?.()?.id || '').slice(0, 128); } catch { this.key = ''; }
    this.closed = false; this.running = false; this.timer = null; this.nextRunAt = null;
    this.controller = null; this.generation = 0; this.cycle = 0; this.initialPending = false;
    this.settings = null; this.completed = 0; this.failed = 0; this.skippedBusy = 0; this.lastErrorCode = null;
    this.configure();
  }

  terminal() { return this.closed || this.device.stopped === true || this.app?.stopping === true; }

  cancelTimer() {
    if (this.timer !== null) {
      try { this.clearTimer(this.timer); } catch { /* The Homey timer may already have been removed during shutdown. */ }
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  offset() {
    let value;
    try { value = this.jitter(this.key, this.cycle++); } catch { value = 0; }
    return Number.isFinite(value) ? Math.min(MAX_JITTER_MS, Math.max(0, Math.trunc(value))) : 0;
  }

  arm({ busy = false } = {}) {
    this.cancelTimer();
    if (this.terminal() || !this.settings.enabled || this.running) return;
    const interval = this.settings.intervalMinutes * 60000;
    const delay = (busy ? Math.min(interval, this.busyRetryMs) : this.initialPending ? 0 : interval) + this.offset();
    const generation = this.generation;
    this.nextRunAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      if (generation !== this.generation) return;
      this.timer = null; this.nextRunAt = null;
      if (this.terminal()) return;
      void this.run();
    }, delay);
    this.timer?.unref?.();
  }

  configure(input = {}) {
    if (this.closed) return this.stats();
    const settings = normalizeSettings(input);
    const changed = !this.settings || settings.enabled !== this.settings.enabled
      || settings.intervalMinutes !== this.settings.intervalMinutes;
    this.settings = settings;
    if (changed) {
      this.generation++; this.cancelTimer();
      if (!settings.enabled) { this.initialPending = false; this.controller?.abort(); }
      else if (!this.running) this.arm();
    } else if (settings.enabled && this.timer === null && !this.running) this.arm();
    return this.stats();
  }

  requestInitial() {
    if (this.terminal() || !this.settings.enabled || this.initialPending || this.running) return false;
    this.initialPending = true; this.generation++; this.arm();
    return true;
  }

  completeInitial() {
    if (this.terminal() || !this.settings.enabled || !this.initialPending) return false;
    this.initialPending = false; this.generation++;
    if (!this.running) this.arm();
    return true;
  }

  busy() {
    if (backgroundOwners.has(this.owner) || this.device.operation) return true;
    const app = this.app;
    if (app?.activeTransfer || app?.transferQueue?.length || app?.permissionTask || app?.gallery?.deleting?.size) return true;
    try {
      if (typeof app?.getDevices === 'function') {
        const devices = app.getDevices();
        if (!Array.isArray(devices) || devices.some(device => device !== this.device && device?.operation)) return true;
      }
      return typeof this.extraBusy === 'function' ? this.extraBusy() === true : false;
    } catch { return true; }
  }

  async run() {
    if (this.terminal() || !this.settings.enabled || this.running) return;
    if (this.busy()) { this.skippedBusy++; this.arm({ busy: true }); return; }
    const controller = new AbortController();
    const initial = this.initialPending;
    this.initialPending = false; this.running = true; this.controller = controller;
    backgroundOwners.set(this.owner, this);
    let retryBusy = false;
    try {
      // Callback code owns info/list validation and fences any late device outputs.
      // The scheduler never sends, deletes, fetches an image or changes availability.
      await this.refresh({ signal: controller.signal, initial });
      if (!controller.signal.aborted && !this.terminal()) { this.completed++; this.lastErrorCode = null; }
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) {
        const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : 'REFRESH_FAILED';
        this.lastErrorCode = code;
        if (['BUSY', 'QUEUE_FULL'].includes(code)) {
          this.skippedBusy++; retryBusy = true; this.initialPending = initial;
        } else this.failed++;
      }
    } finally {
      if (backgroundOwners.get(this.owner) === this) backgroundOwners.delete(this.owner);
      if (this.controller === controller) this.controller = null;
      this.running = false;
      // No catch-up queue. A real failure waits a whole configured interval.
      // Busy admission only checks flags again after a minute; no RPC is queued.
      if (!this.terminal() && this.settings.enabled) this.arm({ busy: retryBusy });
    }
  }

  stats() {
    return { enabled: this.settings?.enabled === true,
      intervalMinutes: this.settings?.intervalMinutes || DEFAULT_INTERVAL_MINUTES,
      running: this.running, scheduled: this.timer !== null, nextRunAt: this.nextRunAt,
      completed: this.completed, failed: this.failed, skippedBusy: this.skippedBusy,
      lastErrorCode: this.lastErrorCode, closed: this.closed };
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.initialPending = false;
    this.cancelTimer(); this.controller?.abort();
    // Keep the global admission slot until the existing callback settles.
    // Closing a scheduler must never make another background RPC overlap it.
  }
}

module.exports = { FrameoRefreshScheduler, normalizeSettings, deterministicJitter };
