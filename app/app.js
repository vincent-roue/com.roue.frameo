'use strict';
const Homey = require('homey');
const { FrameoEngine } = require('./lib/frameo-engine');
const { FrameoGallery } = require('./lib/frameo-gallery');
const { PreviewCache } = require('./lib/device-preview');
const { FrameoWidget } = require('./lib/frameo-widget');
const { FrameoGroups } = require('./lib/frameo-groups');
const { FrameoTransfers } = require('./lib/frameo-transfers');
const { FrameoUploads } = require('./lib/frameo-uploads');
const { FrameoMediaMonitor } = require('./lib/frameo-media-monitor');
const { FrameoDisplayPhotos } = require('./lib/frameo-display-photos');

const ERROR_KEYS = Object.freeze({
  ENGINE_NOT_READY: 'errors.not_ready', ENGINE_CONFIG_INVALID: 'errors.not_ready',
  UNSUPPORTED_RUNTIME: 'errors.unsupported_runtime',
  FRAME_UNAVAILABLE: 'errors.frame_unavailable', FRAME_UNKNOWN: 'errors.frame_unavailable',
  BUSY: 'errors.busy', QUEUE_FULL: 'errors.busy', TIMEOUT: 'errors.timeout', ABORTED: 'errors.aborted',
  URL_INVALID: 'errors.url_invalid', IMAGE_TOO_LARGE: 'errors.image_too_large',
  IMAGE_FORMAT_UNSUPPORTED: 'errors.image_invalid', DOWNLOAD_FAILED: 'errors.download_failed',
  SEND_UNCONFIRMED: 'errors.send_failed',
  SEND_UNVERIFIED: 'errors.send_uncertain', GROUP_EMPTY: 'errors.group_empty', GROUP_NOT_FOUND: 'errors.group_not_found',
  GROUP_INVALID: 'errors.group_invalid', GROUP_LIMIT: 'errors.group_limit', GROUP_FRAME_UNKNOWN: 'errors.group_frame_unknown',
  TRANSFER_TARGET_INVALID: 'errors.transfer_target_invalid', TRANSFER_SOURCE_INVALID: 'errors.transfer_source_invalid',
  TRANSFER_CANCELLED: 'errors.transfer_cancelled', TRANSFER_JOURNAL_FAILED: 'errors.transfer_journal_failed',
  DISPLAY_PHOTO_NOT_FOUND: 'errors.display_photo_not_found', DISPLAY_UNVERIFIED: 'gallery.errors.display_uncertain',
  MEDIA_NOT_FOUND: 'errors.display_media_missing', PERMISSION_REQUIRED: 'gallery.errors.permission',
  ACCESS_MODE_SEND: 'gallery.errors.send_only', CONNECTION_FAILED: 'errors.frame_unavailable',
});

module.exports = class FrameoApp extends Homey.App {
  async onInit() {
    this.startedAt = new Date().toISOString();
    this.runtimeStatus = { ready: false, architecture: process.arch, platform: process.platform, error: null };
    this.transferQueue = [];
    this.activeTransfer = false;
    this.permissionTask = null;
    this.stopping = false;
    this.engine = new FrameoEngine({ homey: this.homey });
    this.gallery = new FrameoGallery(this);
    this.displayPhotos = new FrameoDisplayPhotos(this);
    this.displayPhotos.ready.catch(() => this.log('Saved Frameo display photos could not be loaded.'));
    this.previewCache = new PreviewCache();
    this.widget = new FrameoWidget(this);
    this.groups = new FrameoGroups(this);
    this.transfers = new FrameoTransfers(this);
    this.uploads = new FrameoUploads(this);
    this.mediaMonitor = new FrameoMediaMonitor(this);
    this.registerWidgets();
    this.registerFlows();
    this.readyPromise = Promise.all([this.engine.probe(), this.groups.ready, this.transfers.ready, this.uploads.ready]).then(([probe]) => {
      this.runtimeStatus.ready = true;
      this.runtimeStatus.engine = probe;
      this.log('Frameo engine ready.');
    }).catch(error => {
      this.runtimeStatus.error = error.code || 'ENGINE_NOT_READY';
      this.log('Frameo engine unavailable:', this.runtimeStatus.error);
    });
    await this.readyPromise;
  }
  registerWidgets() {
    const suggestFrames = async query => {
      if (this.stopping) return [];
      let devices;
      try { devices = this.getDevices(); } catch { return []; }
      const search = typeof query === 'string' ? query.trim().slice(0, 80).toLocaleLowerCase() : '';
      return devices.map(device => ({ id: device.getData().id,
        name: String(device.getName() || 'Frameo').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) }))
        .filter(frame => typeof frame.id === 'string' && /^[a-f0-9]{64}$/i.test(frame.id) && frame.name.toLocaleLowerCase().includes(search))
        .slice(0, 20);
    };
    for (const id of ['frameo', 'frameo-compact', 'frameo-portrait']) {
      this.homey.dashboards.getWidget(id).registerSettingAutocompleteListener('frame', suggestFrames);
    }
  }
  async waitUntilReady() {
    await this.readyPromise;
    if (!this.runtimeStatus.ready) {
      const code = this.runtimeStatus.error === 'UNSUPPORTED_RUNTIME' ? 'UNSUPPORTED_RUNTIME' : 'ENGINE_NOT_READY';
      const error = new Error(this.homey.__(ERROR_KEYS[code]));
      error.code = code; throw error;
    }
  }
  localizedError(error, fallback = 'errors.send_failed') {
    const safe = new Error(this.homey.__(ERROR_KEYS[error?.code] || fallback));
    safe.code = Object.hasOwn(ERROR_KEYS, error?.code) ? error.code : 'FRAMEO_OPERATION_FAILED';
    return safe;
  }
  registerFlows() {
    this.photoReceived = this.homey.flow.getDeviceTriggerCard('photo_received');
    this.photoFailed = this.homey.flow.getDeviceTriggerCard('photo_failed');
    this.mediaDetected = this.homey.flow.getDeviceTriggerCard('media_detected');
    this.frameBackOnline = this.homey.flow.getDeviceTriggerCard('frame_back_online');
    const display = this.homey.flow.getActionCard('display_saved_photo');
    display.registerArgumentAutocompleteListener('photo', async (query, args) => {
      const frameId = args?.device?.getData?.()?.id;
      if (!frameId || this.stopping) return [];
      return this.displayPhotos.suggest(frameId, query);
    });
    display.registerRunListener(async args => {
      try {
        await this.waitUntilReady();
        const frameId = args?.device?.getData?.()?.id;
        const mediaId = await this.displayPhotos.resolve(frameId, args.photo?.id);
        try {
          await this.gallery.displayPhoto(frameId, mediaId);
        } catch (error) {
          if (error?.code === 'MEDIA_NOT_FOUND') await this.displayPhotos.remove(frameId, mediaId).catch(() => {});
          throw error;
        }
        return true;
      } catch (error) { throw this.localizedError(error, 'errors.display_failed'); }
    });
    this.homey.flow.getActionCard('send_photo_url').registerRunListener(async args => {
      await this.queueTransfer(args.device, 'url', args.url, args); return true;
    });
    this.homey.flow.getActionCard('send_photo_image').registerRunListener(async args => {
      await this.queueTransfer(args.device, 'image', args.droptoken, args); return true;
    });
    for (const [id, kind] of [['send_group_photo_url', 'url'], ['send_group_photo_image', 'image']]) {
      const card = this.homey.flow.getActionCard(id);
      card.registerArgumentAutocompleteListener('group', async query => {
        const search = typeof query === 'string' ? query.trim().slice(0, 80).toLocaleLowerCase() : '';
        return (await this.groups.list()).groups.filter(group => group.name.toLocaleLowerCase().includes(search))
          .map(group => ({ id: group.id, name: group.name }));
      });
      card.registerRunListener(async args => {
        await this.queueGroupTransfer(args.group?.id, kind, kind === 'url' ? args.url : args.droptoken, args); return true;
      });
    }
    this.homey.flow.getActionCard('refresh_frame').registerRunListener(async args => {
      await (args.device.refreshDetails ? args.device.refreshDetails() : args.device.refreshInfo()); return true;
    });
    this.homey.flow.getConditionCard('frame_reachable').registerRunListener(async args => {
      try { await args.device.refreshInfo(); return true; }
      catch (error) {
        if (['BUSY', 'QUEUE_FULL', 'ENGINE_NOT_READY', 'UNSUPPORTED_RUNTIME', 'ABORTED'].includes(error.code)) throw this.localizedError(error, 'errors.refresh_failed');
        return false;
      }
    });
  }
  async pairFrame(code, senderName = 'Homey', mode = 'send') {
    await this.waitUntilReady();
    const frame = await this.engine.pair(code, { name: senderName });
    return { name: frame.name, data: { id: frame.peer }, store: { peer: frame.peer, access_mode_initialized: true },
      settings: { sender_name: senderName, photo_access_mode: mode === 'manage' ? 'manage' : 'send' } };
  }
  async transfer(device, kind, source, args = {}) {
    return this.queueTransfer(device, kind, source, args);
  }
  async queueTransfer(device, kind, source, args = {}) {
    return this.runTransfer({ frameId: device?.getData()?.id }, kind, source, args);
  }
  async queueGroupTransfer(groupId, kind, source, args = {}) {
    return this.runTransfer({ groupId }, kind, source, args);
  }
  async runTransfer(target, kind, source, args) {
    try {
      await this.waitUntilReady();
      const { jobId } = await this.transfers.enqueueFlow(target, kind, source, args);
      return await this.transfers.waitFor(jobId);
    } catch (error) {
      if (['TRANSFER_STILL_RUNNING', 'TRANSFER_INCOMPLETE'].includes(error?.code)) throw error;
      throw this.localizedError(error);
    }
  }
  async drainTransfers() { return this.transfers.drain(); }
  getDevices() { return this.homey.drivers.getDriver('frameo').getDevices(); }
  getDevice(id) {
    const device = this.getDevices().find(item => item.getData().id === id);
    if (!device) throw new Error(this.homey.__('errors.frame_unavailable'));
    return device;
  }
  getPublicStatus() {
    return { version: this.homey.manifest.version, startedAt: this.startedAt, ...this.runtimeStatus,
      autonomous: true, requiresNas: false, pairingSendsPhoto: false,
      previewCache: { bytes: this.previewCache?.bytes || 0, frames: this.previewCache?.size || 0, maxBytes: 8 * 1024 * 1024 },
      uploads: this.uploads?.stats() || { sessions: 0, bytes: 0, maxBytes: 16 * 1024 * 1024 },
      mediaIndex: this.engine.mediaIndexStats?.() || null,
      performance: this.engine.performanceStats?.() || null,
      pendingTransfers: this.transferQueue.length + Number(this.activeTransfer),
      devices: this.getDevices().map(device => device.publicStatus()) };
  }
  async onUninit() {
    this.stopping = true;
    let devices = [];
    try { devices = this.getDevices(); } catch { /* The driver can already be gone during shutdown. */ }
    for (const device of devices) device.refreshScheduler?.close();
    const monitorClosing = this.mediaMonitor?.close();
    const engineClosing = this.engine?.close();
    await this.transfers?.close(); await this.uploads?.close(); this.gallery?.close();
    await Promise.allSettled(devices.map(device => device.preview?.close()));
    this.previewCache?.clear();
    await engineClosing;
    await monitorClosing;
  }
};
