'use strict';

const { validateMediaId } = require('./frameo-engine');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PEER = /^[a-f0-9]{64}$/i;
const ERROR_CODES = new Set(['WIDGET_DEVICE_INVALID', 'ACCESS_MODE_SEND', 'PERMISSION_REQUIRED',
  'FRAME_UNAVAILABLE', 'ENGINE_NOT_READY', 'BUSY', 'QUEUE_FULL', 'TIMEOUT', 'ABORTED',
  'MEDIA_NOT_FOUND', 'MEDIA_TOO_LARGE', 'TOO_MANY_MEDIA', 'IMAGE_FORMAT_UNSUPPORTED']);

// This service is called only by the widget-scoped Homey API. It never exposes
// native image URLs, accepts a remote URL, or holds another image cache.
class FrameoWidget {
  constructor(app) { this.app = app; this.pending = new Map(); }

  static errorCode(code) { return ERROR_CODES.has(code) ? code : 'FRAME_UNAVAILABLE'; }

  fail(code) {
    const safeCode = FrameoWidget.errorCode(code);
    // The view translates this fixed code. Some SDK transports keep only the
    // message, so keep both fields safe and stable rather than forwarding text.
    const error = new Error(safeCode);
    error.code = safeCode;
    return error;
  }

  async safe(task) {
    try { return await task(); } catch (error) { throw this.fail(error?.code); }
  }

  device(deviceId) {
    if (typeof deviceId !== 'string' || !PEER.test(deviceId)) throw this.fail('WIDGET_DEVICE_INVALID');
    const id = deviceId.toLowerCase();
    const device = this.app.getDevices().find(item => {
      const candidate = item.getData()?.id;
      return typeof candidate === 'string' && candidate.toLowerCase() === id;
    });
    if (!device) throw this.fail('WIDGET_DEVICE_INVALID');
    return device;
  }

  guard(device, id) {
    if (this.app.stopping || device.stopped || device.preview?.closed) throw this.fail('ABORTED');
    if (this.device(id) !== device) throw this.fail('WIDGET_DEVICE_INVALID');
    if (device.stopped !== false || !device.preview || typeof device.preview.load !== 'function' || typeof device.preview.refresh !== 'function') throw this.fail('ENGINE_NOT_READY');
    if (device.accessMode() !== 'manage') throw this.fail('ACCESS_MODE_SEND');
    if (device.lastInfo?.mayView !== true) throw this.fail('PERMISSION_REQUIRED');
  }

  busy(device) {
    if (this.app.activeTransfer || this.app.transferQueue?.length || this.app.permissionTask || device.operation || this.app.gallery?.deleting?.has(device.peer())) throw this.fail('BUSY');
  }

  content(device, value) {
    try { validateMediaId(value?.mediaId); } catch { throw this.fail('IMAGE_FORMAT_UNSUPPORTED'); }
    const buffer = value?.buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length < 3 || buffer.length > MAX_IMAGE_BYTES || value.mime !== 'image/jpeg' ||
      buffer[0] !== 255 || buffer[1] !== 216 || buffer[2] !== 255 ||
      !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 ||
      value.width > 2048 || value.height > 2048 || value.width * value.height > 4000000) {
      throw this.fail('IMAGE_FORMAT_UNSUPPORTED');
    }
    const rawName = device.getName();
    const name = typeof rawName === 'string'
      ? Array.from(rawName.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[a-f0-9]{64}/gi, '…').trim()).slice(0, 80).join('') : '';
    return { name: name || 'Frameo', mediaId: value.mediaId, mime: 'image/jpeg', data: buffer.toString('base64'),
      width: value.width, height: value.height, bytes: buffer.length };
  }

  async ready(deviceId) {
    if (this.app.stopping) throw this.fail('ABORTED');
    // Validate the selection before waiting or invoking any device work.
    const device = this.device(deviceId);
    await this.app.waitUntilReady();
    this.guard(device, deviceId);
    return device;
  }

  prepare(device, id, changePhoto = false) {
    if (this.pending.has(device)) return this.pending.get(device);
    this.guard(device, id);
    // Another authenticated widget can already be preparing
    // this same one-photo preview. Reuse it before examining its info lock.
    if (!device.preview.loadingPromise) this.busy(device);
    const task = Promise.resolve().then(async () => {
      this.guard(device, id);
      if (!device.preview.loadingPromise) this.busy(device);
      // Initial reads use the normal cache/failure backoff. Only an explicit
      // next action forces a new selection after the previous one completed.
      const value = await (changePhoto ? device.preview.refresh() : device.preview.load());
      this.guard(device, id);
      if (!device.preview.isCurrent(value)) throw this.fail('ABORTED');
      return this.content(device, value);
    }).finally(() => { if (this.pending.get(device) === task) this.pending.delete(device); });
    this.pending.set(device, task);
    return task;
  }

  async state({ deviceId } = {}) {
    return this.safe(async () => {
      const device = await this.ready(deviceId);
      if (this.pending.has(device)) return this.pending.get(device);
      const cached = this.app.previewCache?.get(device.peer());
      if (cached) return this.content(device, cached);
      return this.prepare(device, deviceId);
    });
  }

  async next({ deviceId } = {}) {
    return this.safe(async () => {
      const device = await this.ready(deviceId);
      return this.prepare(device, deviceId, true);
    });
  }
}

module.exports = { FrameoWidget };
