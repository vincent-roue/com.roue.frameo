'use strict';

const Homey = require('homey');
const { normalizeFrameInfo } = require('../../lib/frame-info');
const { DevicePreview } = require('../../lib/device-preview');
const { FrameoRefreshScheduler } = require('../../lib/frameo-refresh-scheduler');

const DETAIL_CAPABILITIES = Object.freeze([
  'measure_frameo_photos', 'measure_frameo_videos', 'measure_frameo_media',
  'measure_frameo_visible', 'measure_frameo_hidden', 'frameo_latest_received',
  'frameo_last_communication', 'frameo_frame_status', 'frameo_frame_name',
  'frameo_frame_placement', 'frameo_screen_resolution', 'frameo_connection_route', 'frameo_granted_permissions',
  'frameo_last_checked', 'frameo_name', 'frameo_placement',
  'frameo_resolution', 'frameo_connection', 'frameo_permissions',
  'frameo_photo_count', 'frameo_video_count', 'frameo_media_checked',
]);

// Keep established Flow capability IDs intact. A separate, ordered presentation
// avoids removing/re-adding existing capabilities just to move their UI cells.
const PRESENTATION_FIELDS = Object.freeze({
  frameo_status: 'frameo_frame_status', frameo_name: 'frameo_frame_name',
  frameo_placement: 'frameo_frame_placement', frameo_resolution: 'frameo_screen_resolution',
  frameo_connection: 'frameo_connection_route', frameo_permissions: 'frameo_granted_permissions',
});
const MOVABLE_PRESENTATION_FIELDS = Object.freeze(['frameo_latest_received', 'frameo_last_communication', ...Object.values(PRESENTATION_FIELDS)]);
const REACHABILITY_ERRORS = new Set(['FRAME_UNAVAILABLE', 'CONNECTION_FAILED', 'CONNECTION_REFUSED', 'TIMEOUT', 'ETIMEDOUT']);

const ERROR_KEYS = Object.freeze({
  ENGINE_NOT_READY: 'errors.not_ready',
  UNSUPPORTED_RUNTIME: 'errors.unsupported_runtime',
  FRAME_UNAVAILABLE: 'errors.frame_unavailable',
  CONNECTION_FAILED: 'errors.frame_unavailable',
  CONNECTION_REFUSED: 'errors.frame_unavailable',
  AUTHENTICATION_FAILED: 'errors.frame_unavailable',
  TIMEOUT: 'errors.timeout',
  ETIMEDOUT: 'errors.timeout',
  BUSY: 'errors.busy',
  URL_INVALID: 'errors.url_invalid',
  INVALID_URL: 'errors.url_invalid',
  IMAGE_TOO_LARGE: 'errors.image_too_large',
  FILE_TOO_LARGE: 'errors.image_too_large',
  IMAGE_INVALID: 'errors.image_invalid',
  INVALID_IMAGE: 'errors.image_invalid',
  IMAGE_FORMAT_UNSUPPORTED: 'errors.image_invalid',
  QUEUE_FULL: 'errors.busy',
  SEND_UNVERIFIED: 'errors.send_uncertain',
  FRAME_UNKNOWN: 'errors.frame_unavailable',
  INVALID_ACCESS: 'errors.permission_invalid',
  PERMISSION_DENIED: 'errors.permission_denied',
  PERMISSION_TIMEOUT: 'errors.permission_timeout',
  PERMISSION_NOT_GRANTED: 'errors.permission_not_granted',
  DOWNLOAD_FAILED: 'errors.download_failed',
  ABORTED: 'errors.aborted',
  PERMISSION_REQUIRED: 'gallery.errors.permission', ACCESS_MODE_SEND: 'gallery.errors.send_only',
  TOO_MANY_MEDIA: 'gallery.errors.too_many', MEDIA_MONITOR_STORE_FAILED: 'errors.media_monitor_store_failed',
});

function receiptTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

// A receipt contains public transfer metadata only, never native output,
// configuration, a URL or a temporary pathname. Preserve int64 IDs as strings.
function normalizeReceipt(value) {
  const at = receiptTimestamp(value?.at);
  if (value?.confirmed !== true || !at) return null;
  const receipt = { confirmed: true, at };
  if (typeof value.mediaId === 'string' && /^-?(?:0|[1-9]\d{0,18})$/.test(value.mediaId)) {
    try {
      const id = BigInt(value.mediaId);
      if (id >= -9223372036854775808n && id <= 9223372036854775807n && id.toString() === value.mediaId) receipt.mediaId = value.mediaId;
    } catch { /* Invalid IDs are omitted, never guessed or rounded. */ }
  }
  if (Number.isSafeInteger(value.bytes) && value.bytes > 0) receipt.bytes = value.bytes;
  if (value.route === 'local' || value.route === 'relay') receipt.route = value.route;
  return receipt;
}

class FrameoDevice extends Homey.Device {
  async onInit() {
    this.stopped = false;
    this.operation = null;
    this.preview = null;
    this.photoAccessMode = null;
    this.lastInventory = null; this.lastInventoryError = null;
    this.inventoryGeneration = 0; this.detailsRefreshPromise = null;
    this.inventoryPublication = Promise.resolve();
    this.communicationPublication = Promise.resolve();
    this.refreshScheduler = null; this.lastInfoReadAt = null;
    this.reachabilityKnown = false; this.reachabilityFailures = 0;
    const cached = this.getStoreValue('frame_metadata');
    const validCache = cached?.info && typeof cached.checkedAt === 'string' && Number.isFinite(Date.parse(cached.checkedAt));
    this.lastInfo = validCache ? normalizeFrameInfo(cached.info, this.getName()) : null;
    this.lastChecked = validCache ? new Date(cached.checkedAt).toISOString() : null;
    this.lastResult = normalizeReceipt(this.getStoreValue('last_result'));
    this.lastSent = receiptTimestamp(this.getStoreValue('last_sent'));
    this.lastCommunication = receiptTimestamp(this.getStoreValue('last_communication'));
    this.communicationSavedAt = this.lastCommunication;
    if (this.lastResult && (!this.lastSent || Date.parse(this.lastResult.at) > Date.parse(this.lastSent))) this.lastSent = this.lastResult.at;
    this.lastError = null;
    this.permissionRequest = null;
    await this.retireLegacyCapabilities();
    await this.prepareInventoryPresentation();
    // Homey keeps existing device capabilities across app upgrades. Add the new
    // read-only fields in place so pairing and Flows do not need to be recreated.
    for (const id of DETAIL_CAPABILITIES) {
      if (!this.hasCapability(id)) await this.addCapability(id);
    }
    await this.updateCapability('frameo_last_sent', this.lastSent ? this.displayTime(this.lastSent) : this.homey.__('device.never_sent'));
    await this.displayInfo();
    // The initial connection check is metadata-only. The scheduler below never
    // asks for an image, even when the gallery is enabled.
    try { await this.refreshInfo(); } catch { /* The translated failure is already reflected in the device. */ }
    if (this.getStoreValue('access_mode_initialized') !== true) {
      const mode = this.lastInfo?.mayView === true ? 'manage' : this.accessMode();
      await this.setAccessMode(mode);
    }
    this.preview = new DevicePreview(this, { cache: this.homey.app.previewCache });
    const defaults = {};
    if (typeof this.getSetting('auto_refresh_enabled') !== 'boolean') defaults.auto_refresh_enabled = true;
    const interval = this.getSetting('auto_refresh_interval');
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440) defaults.auto_refresh_interval = 30;
    if (Object.keys(defaults).length) await this.setSettings(defaults);
    if (this.accessMode() !== 'manage') await this.homey.app.mediaMonitor?.invalidate(this);
    this.lastInventory = await this.homey.app.mediaMonitor?.restore(this) || null;
    await this.displayInventory();
    if (this.homey.app.runtimeStatus?.error === 'UNSUPPORTED_RUNTIME') return;
    this.refreshScheduler = new FrameoRefreshScheduler(this, {
      refresh: ({ signal, initial }) => this.refreshDetails({ background: true, inventoryOnly: initial, signal }),
      isBusy: () => (this.homey.app.getDevices?.() || [this])
        .some(device => Boolean(device.preview?.loadingPromise || device.detailsRefreshPromise)),
    });
    this.configureAutoRefresh();
    const needsSummary = !this.lastInventory || this.lastInventory.counts.visibilityUnknown === null;
    if (needsSummary && this.homey.app.mediaMonitor && this.accessMode() === 'manage' && this.lastInfo?.mayView === true) {
      this.refreshScheduler.requestInitial();
    }
  }

  async retireLegacyCapabilities() {
    for (const id of ['frameo_request_view', 'frameo_request_manage', 'frameo_next_photo', 'frameo_refresh']) {
      if (this.hasCapability(id)) await this.removeCapability(id);
    }
  }

  async prepareInventoryPresentation() {
    if (typeof this.getCapabilities !== 'function' || typeof this.getCapabilityOptions !== 'function') return;
    const desired = DETAIL_CAPABILITIES.slice(0, 13);
    const current = this.getCapabilities().filter(id => desired.includes(id));
    if (current.every((id, index) => id === desired[index])) return;
    // Only move the app's text presentation aliases. They expose no tags,
    // Insights or Flow cards. Numeric tile indicators and all legacy Flow
    // capabilities keep their IDs, values and registrations throughout.
    const movable = MOVABLE_PRESENTATION_FIELDS.filter(id => this.hasCapability(id));
    if (!movable.every(id => {
      const options = this.getCapabilityOptions(id);
      return options?.preventTag === true && options?.preventInsights === true;
    })) return;
    for (const id of movable) await this.removeCapability(id);
  }

  configureAutoRefresh(values = {}) {
    return this.refreshScheduler?.configure({
      enabled: values.auto_refresh_enabled ?? this.getSetting('auto_refresh_enabled') ?? true,
      intervalMinutes: values.auto_refresh_interval ?? this.getSetting('auto_refresh_interval') ?? 30,
    });
  }

  displayInventory() {
    // An older SDK write can finish after access has been revoked. Serialize
    // publications so the queued reset always finishes last, and read the
    // current state only when its publication starts.
    const publication = (this.inventoryPublication || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.stopped || this.homey.app.stopping) return;
      const allowed = this.accessMode() === 'manage' && this.lastInfo?.mayView === true;
      const value = allowed ? this.lastInventory : null;
      await this.updateCapability('frameo_photo_count', value?.counts.photos ?? null);
      if (this.stopped || this.homey.app.stopping) return;
      await this.updateCapability('frameo_video_count', value?.counts.videos ?? null);
      if (this.stopped || this.homey.app.stopping) return;
      for (const [id, key] of [['measure_frameo_photos', 'photos'], ['measure_frameo_videos', 'videos'], ['measure_frameo_media', 'total']]) {
        await this.updateCapability(id, value?.counts[key] ?? null);
        if (this.stopped || this.homey.app.stopping) return;
      }
      const visibilityKnown = value?.counts.visibilityUnknown === 0;
      for (const [id, key] of [['measure_frameo_visible', 'visible'], ['measure_frameo_hidden', 'hidden']]) {
        await this.updateCapability(id, visibilityKnown ? value.counts[key] : null);
        if (this.stopped || this.homey.app.stopping) return;
      }
      const latest = receiptTimestamp(value?.latestReceivedAt);
      await this.updateCapability('frameo_latest_received', !value ? this.homey.__('device.inventory_unavailable')
        : value.counts.total === 0 ? this.homey.__('device.no_media')
          : latest ? this.displayTime(latest) : this.homey.__('device.media_receive_date_unknown'));
      if (this.stopped || this.homey.app.stopping) return;
      await this.updateCapability('frameo_media_checked', value?.checkedAt ? this.displayTime(value.checkedAt)
        : this.homey.__(allowed ? 'device.inventory_never_checked' : 'device.inventory_unavailable'));
      await this.displayCommunication();
    });
    this.inventoryPublication = publication;
    return publication;
  }

  communicationTime() {
    // A failed attempt must not look like a successful exchange. Keep the
    // underlying check/send dates separate for diagnostics and transfer history.
    return [this.lastCommunication, this.lastChecked, this.lastSent, this.lastInventory?.checkedAt]
      .map(receiptTimestamp).filter(Boolean).sort().at(-1) || null;
  }

  displayCommunication(timestamp) {
    const candidate = receiptTimestamp(timestamp);
    if (candidate && (!this.lastCommunication || candidate > this.lastCommunication)) this.lastCommunication = candidate;
    const publication = (this.communicationPublication || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.stopped || this.homey.app.stopping) return;
      const at = this.communicationTime();
      if (at) this.lastCommunication = at;
      if (at && at !== this.communicationSavedAt) {
        try { await this.setStoreValue('last_communication', at); this.communicationSavedAt = at; }
        catch { this.error('Frameo communication timestamp could not be saved.'); }
      }
      if (this.stopped || this.homey.app.stopping) return;
      await this.updateCapability('frameo_last_communication', at ? this.displayTime(at) : this.homey.__('device.never_communicated'));
    });
    this.communicationPublication = publication;
    return publication;
  }

  async resetInventory({ forget = false } = {}) {
    this.inventoryGeneration++; this.lastInventory = null; this.lastInventoryError = null;
    await this.homey.app.mediaMonitor?.invalidate(this, { forget });
    await this.displayInventory();
  }

  async refreshDetails({ signal, inventoryOnly = false } = {}) {
    if (this.detailsRefreshPromise) return this.detailsRefreshPromise;
    const generation = this.inventoryGeneration;
    const task = Promise.resolve().then(async () => {
      if (this.stopped || this.homey.app.stopping || signal?.aborted) throw Object.assign(new Error(this.homey.__('errors.aborted')), { code: 'ABORTED' });
      const recentInfo = this.lastInfoReadAt !== null && Date.now() - this.lastInfoReadAt < 30000;
      if (!inventoryOnly || !recentInfo) await this.refreshInfo({ signal });
      if (this.stopped || this.homey.app.stopping || signal?.aborted) throw Object.assign(new Error(this.homey.__('errors.aborted')), { code: 'ABORTED' });
      if (this.accessMode() !== 'manage' || this.lastInfo?.mayView !== true) {
        if (this.homey.app.mediaMonitor) await this.resetInventory();
        await this.displayInventory();
        return { info: this.lastInfo, inventory: null };
      }
      if (!this.homey.app.mediaMonitor) return { info: this.lastInfo, inventory: null };
      const inventory = await this.homey.app.mediaMonitor.check(this, { refreshInfo: false, signal });
      if (generation !== this.inventoryGeneration || this.stopped || this.homey.app.stopping || signal?.aborted) {
        throw Object.assign(new Error(this.homey.__('errors.aborted')), { code: 'ABORTED' });
      }
      this.lastInventory = { checkedAt: inventory.checkedAt, counts: { ...inventory.counts },
        latestReceivedAt: receiptTimestamp(inventory.latestReceivedAt),
        addedCount: inventory.addedCount, eventsSuppressed: inventory.eventsSuppressed };
      this.lastInventoryError = null;
      // Remember a successful scan before a concurrent mode/permission reset
      // can clear its inventory while an SDK publication is awaiting I/O.
      await this.displayCommunication(inventory.checkedAt);
      await this.displayInventory();
      this.refreshScheduler?.completeInitial?.();
      if (!inventory.baseline) for (const media of inventory.added) {
        // Consumer Flows cannot block a scan or cause an automatic retry. Check
        // again in the microtask so shutdown/revocation fences queued events.
        void Promise.resolve().then(() => {
          if (generation !== this.inventoryGeneration || this.stopped || this.homey.app.stopping || signal?.aborted
            || this.accessMode() !== 'manage' || this.lastInfo?.mayView !== true) return;
          return this.homey.app.mediaDetected?.trigger(this, { media_id: media.mediaId, type: media.type,
            received_at: media.receiveDate || '', detected_at: inventory.checkedAt,
            new_count: inventory.addedCount, events_truncated: inventory.eventsSuppressed });
        }).catch(() => this.error('Frameo media detection Flow could not be triggered.'));
      }
      return { info: this.lastInfo, inventory: this.lastInventory };
    }).catch(async error => {
      if (['PERMISSION_REQUIRED', 'ACCESS_MODE_SEND'].includes(error?.code) && !this.stopped) {
        try { await this.resetInventory(); } catch (resetError) { error = resetError; }
      }
      this.lastInventoryError = error?.code || 'ENGINE_NOT_READY';
      const safe = new Error(this.homey.__(ERROR_KEYS[error?.code] || 'errors.refresh_failed'));
      safe.code = ERROR_KEYS[error?.code] ? error.code : 'ENGINE_NOT_READY'; throw safe;
    }).finally(() => { if (this.detailsRefreshPromise === task) this.detailsRefreshPromise = null; });
    this.detailsRefreshPromise = task; return task;
  }

  accessMode() {
    const mode = this.photoAccessMode || this.getSetting('photo_access_mode');
    return ['send', 'manage'].includes(mode) ? mode : (this.lastInfo?.mayView === true ? 'manage' : 'send');
  }

  async setAccessMode(mode) {
    if (!['send', 'manage'].includes(mode)) throw new Error(this.homey.__('errors.access_mode_invalid'));
    this.homey.app.engine?.invalidateMediaIndex?.(this.getData().id);
    await this.setSettings({ photo_access_mode: mode });
    this.photoAccessMode = mode;
    await this.resetInventory();
    await this.setStoreValue('access_mode_initialized', true);
    this.homey.app.gallery?.snapshots.delete(this.getData().id);
    if (this.preview) await this.preview.invalidate();
    if (mode === 'manage' && this.lastInfo?.mayView === true) this.refreshScheduler?.requestInitial();
  }

  peer() {
    const peer = this.getStoreValue('peer') || this.getData().id;
    if (typeof peer !== 'string' || !/^[a-f0-9]{64}$/i.test(peer)) {
      const error = new Error(this.homey.__('errors.frame_unavailable'));
      error.code = 'FRAME_UNAVAILABLE';
      throw error;
    }
    return peer.toLowerCase();
  }

  async updateCapability(id, value) {
    for (const field of [id, PRESENTATION_FIELDS[id]].filter(Boolean)) {
      if (!this.stopped && this.hasCapability(field)) {
        await this.setCapabilityValue(field, value).catch(() => { this.error('Frameo display update failed:', field); });
      }
    }
  }

  displayTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(this.homey.i18n.getLanguage(), {
        timeZone: this.homey.clock.getTimezone(), dateStyle: 'short', timeStyle: 'short',
      }).format(new Date(timestamp));
    } catch { return timestamp; }
  }

  async refreshInfo({ signal } = {}) {
    if (this.operation?.kind === 'refresh') return this.operation.promise;
    return this.runOperation('refresh', async () => {
      const info = await this.homey.app.engine.info(this.peer(), { name: this.getSetting('sender_name') || 'Homey', ...(signal ? { signal } : {}) });
      if (this.stopped || signal?.aborted) return null;
      await this.recordInfo(info);
      return { ...this.lastInfo };
    });
  }

  async recordInfo(info) {
    if (this.stopped) return;
    const previousView = this.lastInfo?.mayView;
    this.lastInfo = normalizeFrameInfo(info, this.getName());
    this.lastInfoReadAt = Date.now();
    if (this.lastInfo.mayView !== true) this.homey.app.engine?.invalidateMediaIndex?.(this.getData().id);
    this.lastChecked = new Date().toISOString();
    await this.setStoreValue('frame_metadata', { info: this.lastInfo, checkedAt: this.lastChecked })
      .catch(() => { this.error('Frameo metadata could not be saved'); });
    await this.displayInfo();
    if (this.preview) {
      if (this.accessMode() !== 'manage' || this.lastInfo.mayView !== true) await this.preview.invalidate();
    }
    if (this.lastInfo.mayView !== true && this.homey.app.mediaMonitor) await this.resetInventory();
    if (previousView !== true && this.lastInfo.mayView === true && !this.lastInventory && this.accessMode() === 'manage') {
      this.refreshScheduler?.requestInitial();
    }
  }

  async requestPermission(access) {
    if (!['view', 'manage'].includes(access)) {
      throw Object.assign(new Error(this.homey.__('errors.permission_invalid')), { code: 'INVALID_ACCESS' });
    }
    if (this.stopped || this.operation || this.homey.app.permissionTask || this.homey.app.activeTransfer || this.homey.app.transferQueue?.length) {
      throw Object.assign(new Error(this.homey.__('errors.busy')), { code: 'BUSY' });
    }
    const request = { access, pending: true, granted: false };
    this.permissionRequest = request;
    // A native Homey button must return promptly while the user walks to the
    // frame. Keep the operation locked until the actual on-frame decision.
    const operation = this.runOperation('permission', async () => {
      const info = await this.homey.app.engine.permission(this.peer(), access, {
        name: this.getSetting('sender_name') || 'Homey',
      });
      if (this.stopped) return null;
      await this.recordInfo(info);
      request.granted = true;
      return { granted: true };
    });
    this.homey.app.permissionTask = operation;
    void operation.catch(() => { /* runOperation already exposes a safe translated status. */ })
      .finally(() => {
        request.pending = false;
        if (this.homey.app.permissionTask === operation) this.homey.app.permissionTask = null;
      });
    return { accepted: true, access };
  }

  async displayInfo() {
    const info = this.lastInfo;
    const unknown = this.homey.__('device.not_reported');
    const permissionKeys = [
      ['mayView', 'permission_view'], ['mayManage', 'permission_manage'],
      ['mayBackup', 'permission_backup'], ['maySharePairing', 'permission_share'],
    ];
    const granted = permissionKeys.filter(([field]) => info?.[field] === true)
      .map(([, key]) => this.homey.__('device.' + key));
    const knownPermissions = permissionKeys.every(([field]) => typeof info?.[field] === 'boolean');
    const values = {
      frameo_name: info?.name || unknown,
      frameo_placement: info?.placement || unknown,
      frameo_resolution: info?.width && info?.height ? `${info.width} × ${info.height} px` : unknown,
      frameo_connection: info?.route ? this.homey.__('device.route_' + info.route) : unknown,
      frameo_permissions: granted.length ? granted.join(' · ')
        : this.homey.__(knownPermissions ? 'device.permissions_none' : 'device.not_reported'),
      frameo_last_checked: this.lastChecked ? this.displayTime(this.lastChecked) : this.homey.__('device.never_checked'),
    };
    for (const [id, value] of Object.entries(values)) await this.updateCapability(id, value);
    await this.displayCommunication();
  }

  async sendUrl(url, options = {}) {
    return this.runOperation('send', async () => {
      const result = await this.homey.app.engine.sendUrl(this.peer(), url, this.sendOptions(options));
      return this.recordTransfer(result);
    });
  }

  async sendImage(image, options = {}) {
    return this.runOperation('send', async () => {
      const result = await this.homey.app.engine.sendImage(this.peer(), image, this.sendOptions(options));
      return this.recordTransfer(result);
    });
  }

  async sendPrepared(handle, options = {}) {
    return this.runOperation('send', async () => {
      const result = await this.homey.app.engine.sendPrepared(this.peer(), handle, this.sendOptions(options));
      return this.recordTransfer(result, options.onConfirmedReceipt);
    });
  }

  sendOptions(options) {
    return {
      caption: options?.caption || '',
      fit: options?.fit === true,
      ...(options?.center && options?.fit !== true ? { center: options.center } : {}),
      name: this.getSetting('sender_name') || 'Homey',
      ...(options?.signal ? { signal: options.signal } : {}),
    };
  }

  async recordTransfer(result, onConfirmedReceipt) {
    // Completion must mean the frame acknowledged receipt, not just a successful launch.
    if (result?.confirmed !== true) {
      const error = new Error(this.homey.__('errors.send_failed'));
      error.code = 'SEND_UNCONFIRMED';
      throw error;
    }
    const receipt = normalizeReceipt({ ...result, at: new Date().toISOString() });
    // Report this call's verified acknowledgement before asynchronous SDK
    // persistence. A shutdown during that persistence must not lose the ACK.
    if (typeof onConfirmedReceipt === 'function') {
      try { onConfirmedReceipt({ ...receipt }); }
      catch { this.error('Frameo receipt observer failed'); }
    }
    if (this.stopped) return receipt;
    this.lastResult = receipt;
    // Save the exact acknowledged ID before the separate historical timestamp,
    // so a restart can recover the receipt even if that later write fails.
    try { await this.setStoreValue('last_result', receipt); }
    catch { this.error('Frameo transfer receipt could not be saved'); }
    this.lastSent = receipt.at;
    try { await this.setStoreValue('last_sent', this.lastSent); }
    catch { this.error('Frameo last transfer timestamp could not be saved'); }
    await this.updateCapability('frameo_last_sent', this.displayTime(this.lastSent));
    await this.displayCommunication();
    this.homey.app.gallery?.snapshots.delete(this.getData().id);
    try { await this.homey.api?.realtime?.('gallery.changed', { id: this.getData().id }); } catch {}
    return { ...receipt };
  }

  async runOperation(kind, task) {
    if (this.stopped || this.operation) {
      const error = new Error(this.homey.__('errors.busy'));
      error.code = 'BUSY';
      throw error;
    }
    const operation = { kind, promise: null };
    this.operation = operation;
    operation.promise = (async () => {
      try {
        const startingKey = kind === 'permission' ? 'device.permission_waiting' : (kind === 'send' ? 'device.sending' : 'device.checking');
        await this.updateCapability('frameo_status', this.homey.__(startingKey));
        if (typeof this.homey.app.waitUntilReady === 'function') await this.homey.app.waitUntilReady();
        if (!this.homey.app.engine) {
          const error = new Error('Engine not ready');
          error.code = 'ENGINE_NOT_READY';
          throw error;
        }
        const result = await task();
        if (!this.stopped) {
          this.lastError = null;
          await this.setAvailable().catch(() => {});
          const doneKey = kind === 'permission' ? 'device.permission_granted' : (kind === 'send' ? 'device.received' : 'device.reachable');
          await this.updateCapability('frameo_status', this.homey.__(doneKey));
          if (kind === 'refresh' && result) this.onReachabilityConfirmed();
        }
        return result;
      } catch (error) {
        const fallbackKey = kind === 'permission' ? 'errors.permission_failed' : (kind === 'send' ? 'errors.send_failed' : 'errors.refresh_failed');
        const message = this.homey.__(ERROR_KEYS[error?.code] || fallbackKey);
        if (!this.stopped) {
          if (kind === 'refresh' && this.reachabilityKnown && REACHABILITY_ERRORS.has(error?.code) && error.details?.started !== false) {
            this.reachabilityFailures = Math.min(2, this.reachabilityFailures + 1);
          }
          this.lastError = message;
          await this.updateCapability('frameo_status', message).catch(() => {});
          // Invalid input does not prove that the frame itself is unavailable.
          const inputErrors = ['URL_INVALID', 'INVALID_URL', 'IMAGE_TOO_LARGE', 'FILE_TOO_LARGE', 'IMAGE_INVALID', 'INVALID_IMAGE', 'IMAGE_FORMAT_UNSUPPORTED', 'DOWNLOAD_FAILED', 'ABORTED', 'QUEUE_FULL', 'INVALID_ACCESS', 'PERMISSION_DENIED', 'PERMISSION_TIMEOUT', 'PERMISSION_NOT_GRANTED', 'SEND_UNVERIFIED'];
          const permissionTimedOut = kind === 'permission' && ['TIMEOUT', 'ETIMEDOUT'].includes(error?.code);
          if (!inputErrors.includes(error?.code) && !permissionTimedOut) await this.setUnavailable(message).catch(() => {});
        }
        const safeError = new Error(message);
        safeError.code = (ERROR_KEYS[error?.code] || error?.code === 'SEND_UNCONFIRMED') ? error.code : 'FRAMEO_OPERATION_FAILED';
        if (kind === 'send' && error?.details?.nativeResponse === true && error.details.attempted === false) safeError.beforeSend = true;
        throw safeError;
      } finally {
        if (this.operation === operation) this.operation = null;
      }
    })();
    return operation.promise;
  }

  onReachabilityConfirmed() {
    const recovered = this.reachabilityKnown && this.reachabilityFailures >= 2;
    this.reachabilityKnown = true;
    this.reachabilityFailures = 0;
    const checkedAt = this.lastChecked;
    // Let runOperation release the frame before consumers start other work.
    queueMicrotask(() => {
      if (this.stopped || this.homey.app.stopping) return;
      if (recovered) {
        void Promise.resolve().then(() => {
          if (!this.stopped && !this.homey.app.stopping) return this.homey.app.frameBackOnline?.trigger(this, { checked_at: checkedAt });
        })
          .catch(() => this.error('Frameo reachability Flow could not be triggered.'));
      }
      this.homey.app.transfers?.frameReachable?.(this.getData().id);
    });
  }

  publicStatus() {
    return {
      id: this.getData().id,
      name: this.getName(),
      busy: Boolean(this.operation),
      permissionRequest: this.permissionRequest ? { ...this.permissionRequest } : null,
      info: this.lastInfo ? { ...this.lastInfo } : null,
      lastChecked: this.lastChecked,
      lastSent: this.lastSent,
      lastCommunication: this.communicationTime(),
      lastResult: this.lastResult ? { ...this.lastResult } : null,
      inventory: this.lastInventory ? { ...this.lastInventory, counts: { ...this.lastInventory.counts } } : null,
      inventoryError: this.lastInventoryError,
      automaticRefresh: this.refreshScheduler?.stats() || null,
      error: this.lastError,
    };
  }

  async onSettings({ oldSettings, newSettings }) {
    const name = newSettings.sender_name;
    if (typeof name !== 'string' || !name.trim() || Array.from(name.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(this.homey.__('errors.sender_invalid'));
    }
    if (newSettings.photo_access_mode !== undefined && !['send', 'manage'].includes(newSettings.photo_access_mode)) {
      throw new Error(this.homey.__('errors.access_mode_invalid'));
    }
    if ((newSettings.auto_refresh_enabled !== undefined && typeof newSettings.auto_refresh_enabled !== 'boolean') ||
      (newSettings.auto_refresh_interval !== undefined && (!Number.isInteger(newSettings.auto_refresh_interval)
        || newSettings.auto_refresh_interval < 1 || newSettings.auto_refresh_interval > 1440))) {
      throw new Error(this.homey.__('errors.auto_refresh_invalid'));
    }
    const scopeChanged = name !== (oldSettings?.sender_name ?? this.getSetting('sender_name')) ||
      (newSettings.photo_access_mode !== undefined && newSettings.photo_access_mode !== (oldSettings?.photo_access_mode ?? this.accessMode()));
    if (newSettings.photo_access_mode !== undefined) this.photoAccessMode = newSettings.photo_access_mode;
    if (scopeChanged) {
      this.homey.app.gallery?.snapshots.delete(this.getData().id);
      this.homey.app.engine?.invalidateMediaIndex?.(this.getData().id);
      await this.resetInventory();
      if (this.preview) await this.preview.invalidate();
    }
    this.configureAutoRefresh(newSettings);
    if (scopeChanged && !this.lastInventory && this.accessMode() === 'manage' && this.lastInfo?.mayView === true) this.refreshScheduler?.requestInitial();
  }

  async onDeleted() {
    this.refreshScheduler?.close(); this.inventoryGeneration++;
    try { await this.homey.app.mediaMonitor?.invalidate(this, { forget: true }); }
    catch { this.error('Frameo media reference could not be cleared.'); }
    this.homey.app.engine?.invalidateMediaIndex?.(this.getData().id);
    this.stopped = true; await this.preview?.close();
    try { await this.homey.app.groups?.removeFrame(this.peer()); } catch { this.error('Frameo group references could not be removed.'); }
    try { await this.homey.app.displayPhotos?.remove(this.getData().id); } catch { this.error('Frameo display photo references could not be removed.'); }
  }
  async onUninit() {
    this.refreshScheduler?.close(); this.inventoryGeneration++;
    this.stopped = true; this.homey.app.engine?.invalidateMediaIndex?.(this.getData().id); await this.preview?.close();
  }
}

module.exports = FrameoDevice;
