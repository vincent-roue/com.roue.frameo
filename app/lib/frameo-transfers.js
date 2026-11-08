'use strict';

const { randomUUID } = require('node:crypto');
const { publicName, coded } = require('./frameo-groups');
const { TransferJournal, reasonCode, REASON_KEYS, summary } = require('./transfer-journal');
const { validateMediaId } = require('./frameo-engine');

const PEER = /^[a-f0-9]{64}$/i;
const MAX_MANUAL_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_MEMORY = 20 * 1024 * 1024;
const MAX_DEFERRED_JOBS = 4;
const MAX_DEFERRED_BYTES = 16 * 1024 * 1024;
const DEFERRED_TTL_MS = 24 * 60 * 60 * 1000;
const OFFLINE_BEFORE_SEND = new Set(['FRAME_UNAVAILABLE', 'CONNECTION_FAILED', 'CONNECTION_REFUSED', 'TIMEOUT']);
function interruptible(promise, signal) {
  if (signal.aborted) return Promise.reject(coded('TRANSFER_CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(coded('TRANSFER_CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

class FrameoTransfers {
  constructor(app, { now = () => Date.now(), flowTimeoutMs = 25000, retryMs = 60000, deferredTtlMs = DEFERRED_TTL_MS } = {}) {
    this.app = app; this.now = now; this.flowTimeoutMs = flowTimeoutMs;
    this.journal = new TransferJournal(app, { now }); this.ready = this.journal.ready;
    this.queue = []; this.runtime = new Map(); this.batches = new Map(); this.sourceMemory = 0;
    this.closed = false; this.draining = false; this.active = null;
    this.retryMs = retryMs; this.deferredTtlMs = deferredTtlMs; this.retryTimer = null;
    this.deferredCleanupFailed = false;
    this.app.transferQueue = this.queue;
  }
  stamp() { return new Date(this.now()).toISOString(); }
  devices() { return this.app.getDevices(); }
  assertOpen() { if (this.closed || this.app.stopping) throw coded('TRANSFER_CANCELLED'); }
  async targets({ frameId, groupId } = {}) {
    this.assertOpen();
    if (Boolean(frameId) === Boolean(groupId)) throw coded('TRANSFER_TARGET_INVALID');
    let ids, targetName;
    if (groupId) {
      const group = await this.app.groups.get(groupId);
      ids = group.frameIds; targetName = group.name;
      if (!ids.length) throw coded('GROUP_EMPTY');
    } else {
      if (typeof frameId !== 'string' || !PEER.test(frameId)) throw coded('TRANSFER_TARGET_INVALID');
      const device = this.devices().find(value => String(value.getData().id).toLowerCase() === frameId.toLowerCase());
      if (!device) throw coded('TRANSFER_TARGET_INVALID');
      ids = [frameId.toLowerCase()]; targetName = publicName(device.getName()) || 'Frameo';
    }
    const devices = this.devices();
    return { targetName, targets: [...new Set(ids)].map(frameId => {
      const device = devices.find(value => String(value.getData().id).toLowerCase() === frameId);
      return { frameId, name: publicName(device?.getName()) || 'Frameo' };
    }) };
  }
  async start(target) {
    await this.ready;
    const snapshot = await this.targets(target);
    for (const [id, batch] of this.batches) if (batch.expiresAt < this.now() && ![...this.runtime.values()].some(value => value.batchId === id)) this.batches.delete(id);
    if (this.batches.size >= 8) throw coded('QUEUE_FULL');
    const batchId = randomUUID();
    this.batches.set(batchId, { ...snapshot, expiresAt: this.now() + 60 * 60 * 1000 });
    return { batchId, ...JSON.parse(JSON.stringify(snapshot)) };
  }
  async finishBatch(batchId) { this.batches.delete(batchId); return { closed: true }; }
  requireBatch(batchId) {
    this.assertOpen();
    const batch = typeof batchId === 'string' && this.batches.get(batchId);
    if (!batch || batch.expiresAt < this.now()) throw coded('TRANSFER_BATCH_EXPIRED');
    if (!batch.targets.length) throw coded('GROUP_EMPTY');
    batch.expiresAt = this.now() + 60 * 60 * 1000;
    return batch;
  }
  enqueueUploadedFile(input, image, cleanup) {
    if (typeof image?.getStream !== 'function' || typeof cleanup !== 'function') return Promise.reject(coded('TRANSFER_SOURCE_INVALID'));
    return this.enqueue(input, { kind: 'upload', value: image, cleanup }, 'manual');
  }
  async enqueueManual(input = {}) {
    const hasUrl = typeof input.url === 'string';
    const hasData = typeof input.data === 'string';
    if (hasUrl === hasData) throw coded('TRANSFER_SOURCE_INVALID');
    if (hasData && (input.data.length > Math.ceil(MAX_MANUAL_BYTES / 3) * 4 || !['image/jpeg', 'image/png'].includes(input.mime))) throw coded('IMAGE_TOO_LARGE');
    return this.enqueue(input, hasUrl ? { kind: 'url', value: input.url } : { kind: 'base64', value: input.data, mime: input.mime }, 'manual');
  }
  async enqueueFlow(target, kind, source, options = {}) {
    if (!['url', 'image'].includes(kind) || (kind === 'url' && typeof source !== 'string') || (kind === 'image' && typeof source?.getStream !== 'function')) throw coded('TRANSFER_SOURCE_INVALID');
    return this.enqueue({ ...target, caption: options.caption, fit: options.scale ? options.scale !== 'fill' : options.fit === true }, { kind, value: source }, 'flow');
  }
  async enqueue(input, source, initiator) {
    await this.ready; this.assertOpen();
    let center;
    if (input.center !== undefined && input.fit !== true) {
      if (initiator !== 'manual' || source.kind === 'url' || !Array.isArray(input.center) || input.center.length !== 2
        || !Array.from(input.center).every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw coded('TRANSFER_SOURCE_INVALID');
      center = input.center.slice();
    }
    if (this.runtime.size >= 8) throw coded('QUEUE_FULL');
    let snapshot;
    if (input.batchId) {
      const batch = this.requireBatch(input.batchId);
      snapshot = { targetName: batch.targetName, targets: batch.targets.map(value => ({ ...value })) };
    } else snapshot = await this.targets(input);
    this.assertOpen();
    if (this.runtime.size >= 8) throw coded('QUEUE_FULL');
    const reserved = source.kind === 'base64' ? source.value.length : 0;
    if (this.sourceMemory + reserved > MAX_SOURCE_MEMORY) throw coded('QUEUE_FULL');
    this.sourceMemory += reserved;
    const job = { id: randomUUID(), initiator, source: source.kind === 'url' ? 'url' : 'image', createdAt: this.stamp(),
      targetName: snapshot.targetName, status: 'queued', phase: 'queued', results: snapshot.targets.map(value => ({ ...value, status: 'queued' })) };
    let resolve;
    const done = new Promise(value => { resolve = value; });
    const runtime = { job, source, caption: typeof input.caption === 'string' ? Array.from(input.caption).slice(0, 1000).join('') : '',
      fit: input.fit === true, center, reserved, controller: new AbortController(), done, resolve, notified: new Set(), batchId: input.batchId || null,
      defer: initiator === 'manual' && input.defer === true, prepared: null, waitingBytes: 0, retryAt: null, retryIndex: 0 };
    this.runtime.set(job.id, runtime);
    try { await this.journal.create(job); }
    catch (error) { this.runtime.delete(job.id); this.sourceMemory -= reserved; throw error; }
    if (this.closed || this.app.stopping) {
      await this.cancelRuntime(runtime); return { jobId: job.id };
    }
    this.queue.push(runtime); void this.drain();
    return { jobId: job.id };
  }
  async checkpoint(job) { await this.journal.update(job); }
  async drain() {
    if (this.draining || this.closed) return;
    this.draining = true; this.app.activeTransfer = true;
    try {
      while (this.queue.length && !this.closed) {
        const runtime = this.queue.shift(); this.active = runtime;
        try {
          await this.run(runtime);
          if (runtime.job.results.some(result => result.status === 'waiting')) {
            if (this.closed || this.app.stopping || runtime.controller.signal.aborted) throw coded('TRANSFER_CANCELLED');
            runtime.job.phase = 'waiting';
            await this.checkpoint(runtime.job);
            if (this.closed || this.app.stopping || runtime.controller.signal.aborted) throw coded('TRANSFER_CANCELLED');
            runtime.retryAt = Math.min(this.now() + this.retryMs, runtime.expiresAt);
            this.scheduleRetry();
          }
        } catch (error) {
          for (const result of runtime.job.results) {
            if (result.status === 'running') { result.status = 'uncertain'; result.code = 'SEND_UNVERIFIED'; }
            else if (['queued', 'waiting'].includes(result.status)) { result.status = 'failed'; result.code = reasonCode(error); }
            if (!result.completedAt) result.completedAt = this.stamp();
          }
        }
        if (runtime.retryAt === null) await this.settle(runtime);
        this.active = null;
      }
    } finally { this.draining = false; this.app.activeTransfer = false; this.scheduleRetry(); }
  }
  async run(runtime) {
    const { job, controller } = runtime;
    const resuming = runtime.prepared !== null;
    if (resuming) {
      if (this.app.permissionTask) await interruptible(this.app.permissionTask.catch(() => {}), controller.signal);
      if (this.expireWaiting(runtime)) return;
    }
    if (!resuming) {
      job.phase = 'preparing'; job.startedAt = this.stamp(); await this.checkpoint(job);
      if (this.app.permissionTask) await interruptible(this.app.permissionTask.catch(() => {}), controller.signal);
      if (controller.signal.aborted) throw coded('TRANSFER_CANCELLED');
      const source = runtime.source;
      try {
        if (source.kind === 'url') runtime.prepared = await this.app.engine.prepareUrl(source.value, { signal: controller.signal });
        else if (source.kind === 'base64') runtime.prepared = await this.app.engine.prepareBase64(source.value, source.mime, { signal: controller.signal });
        else runtime.prepared = await this.app.engine.prepareImage(source.value, { signal: controller.signal });
      } finally {
        await this.releaseSource(runtime);
      }
    }
    job.phase = 'sending';
    const results = resuming ? [this.retryRecipient(runtime)].filter(Boolean) : job.results;
    for (const result of results) {
      if (controller.signal.aborted || this.closed || this.app.stopping) throw coded('TRANSFER_CANCELLED');
      const device = this.devices().find(value => String(value.getData().id).toLowerCase() === result.frameId);
      if (!device || device.stopped) { result.status = 'failed'; result.code = 'FRAME_UNKNOWN'; result.completedAt = this.stamp(); await this.checkpoint(job); continue; }
      if (['refresh', 'permission'].includes(device.operation?.kind)) await interruptible(device.operation.promise.catch(() => {}), controller.signal);
      if (controller.signal.aborted) throw coded('TRANSFER_CANCELLED');
      if (resuming && this.expireWaiting(runtime)) break;
      result.status = 'running';
      try { await this.checkpoint(job); }
      catch (error) { result.status = 'failed'; result.code = 'TRANSFER_JOURNAL_FAILED'; throw error; }
      if (resuming && this.now() >= runtime.expiresAt) {
        result.status = 'waiting'; this.expireWaiting(runtime); break;
      }
      if (controller.signal.aborted || this.closed || this.app.stopping) {
        result.status = 'failed'; result.code = 'TRANSFER_CANCELLED'; throw coded('TRANSFER_CANCELLED');
      }
      let confirmedReceipt = null, acceptingReceipt = true;
      const onConfirmedReceipt = receipt => {
        // This closure belongs to this exact job, frame and sendPrepared call.
        // Never infer success from the device's unrelated historical receipt.
        if (!acceptingReceipt || receipt?.confirmed !== true) return;
        try {
          const mediaId = validateMediaId(receipt.mediaId);
          const at = typeof receipt.at === 'string' && receipt.at.length <= 40
            && Number.isFinite(Date.parse(receipt.at)) ? receipt.at : this.stamp();
          confirmedReceipt = { confirmed: true, mediaId, at };
        } catch { /* An incomplete callback cannot establish this exact receipt. */ }
      };
      const received = receipt => {
        result.status = 'succeeded'; result.completedAt = this.stamp(); delete result.code;
        try { if (receipt.mediaId) result.mediaId = validateMediaId(receipt.mediaId); } catch {}
        runtime.notified.add(result.frameId);
        this.emit(this.app.photoReceived, device, { received_at: receipt.at || this.stamp() });
      };
      try {
        const receipt = await interruptible(device.sendPrepared(runtime.prepared, { caption: runtime.caption,
          fit: runtime.fit, ...(runtime.center ? { center: runtime.center } : {}), signal: controller.signal, onConfirmedReceipt }), controller.signal);
        if (receipt?.confirmed !== true) throw coded('SEND_UNCONFIRMED');
        received(confirmedReceipt || receipt);
      } catch (error) {
        if (confirmedReceipt) received(confirmedReceipt);
        else {
          const canDefer = runtime.defer && !controller.signal.aborted && error?.beforeSend === true && OFFLINE_BEFORE_SEND.has(error.code);
          if (canDefer && await this.retain(runtime)) {
            result.status = 'waiting'; delete result.code; delete result.completedAt;
          } else {
            result.code = controller.signal.aborted ? 'SEND_UNVERIFIED' : canDefer ? 'TRANSFER_DEFERRED_LIMIT' : reasonCode(error);
            result.status = ['SEND_UNVERIFIED', 'SEND_UNCONFIRMED'].includes(result.code) ? 'uncertain' : 'failed';
            result.completedAt = this.stamp();
            runtime.notified.add(result.frameId);
            this.emit(this.app.photoFailed, device, { reason: this.app.homey.__(REASON_KEYS[result.code] || 'errors.send_failed') });
          }
        }
      } finally {
        // A receipt arriving after the terminal decision cannot rewrite it.
        acceptingReceipt = false;
      }
      await this.checkpoint(job);
    }
  }
  async retain(runtime) {
    if (runtime.waitingBytes) return true;
    if (this.deferredCleanupFailed) return false;
    const retained = [...this.runtime.values()].filter(value => value.waitingBytes);
    if (retained.length >= MAX_DEFERRED_JOBS) return false;
    let size;
    try { size = await this.app.engine.preparedSize(runtime.prepared); } catch { return false; }
    if (this.closed || this.app.stopping || !Number.isSafeInteger(size) || size < 1 || size > MAX_MANUAL_BYTES
      || retained.reduce((total, value) => total + value.waitingBytes, size) > MAX_DEFERRED_BYTES) return false;
    runtime.waitingBytes = size;
    runtime.expiresAt = this.now() + this.deferredTtlMs;
    runtime.job.expiresAt = new Date(runtime.expiresAt).toISOString();
    return true;
  }
  expireWaiting(runtime) {
    if (this.now() < runtime.expiresAt) return false;
    for (const result of runtime.job.results) if (result.status === 'waiting') {
      result.status = 'failed'; result.code = 'TRANSFER_DEFERRED_EXPIRED'; result.completedAt = this.stamp();
    }
    return true;
  }
  retryRecipient(runtime) {
    const { results } = runtime.job;
    const preferred = results.findIndex(result => result.status === 'waiting' && result.frameId === runtime.reachableFrame);
    runtime.reachableFrame = null;
    for (let offset = 0; offset < results.length; offset++) {
      const index = (preferred >= 0 ? preferred : runtime.retryIndex + offset) % results.length;
      if (results[index].status !== 'waiting') continue;
      runtime.retryIndex = (index + 1) % results.length;
      return results[index];
    }
    return null;
  }
  scheduleRetry() {
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.closed || this.app.stopping) return;
    const busy = this.draining || this.queue.length;
    const due = Math.min(...[...this.runtime.values()].filter(value => value.retryAt !== null)
      .map(value => busy ? value.expiresAt : value.retryAt));
    if (!Number.isFinite(due)) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.resumeWaiting(); }, Math.max(0, due - this.now()));
    this.retryTimer.unref();
  }
  resumeWaiting() {
    if (this.closed || this.app.stopping) return;
    for (const runtime of this.runtime.values()) if (runtime.retryAt !== null && this.expireWaiting(runtime)) {
      runtime.retryAt = null;
      runtime.expiring = true;
      void this.settle(runtime);
    }
    if (this.draining || this.queue.length) { this.scheduleRetry(); return; }
    const now = this.now();
    const runtime = [...this.runtime.values()].find(value => value.retryAt !== null && value.retryAt <= now);
    if (!runtime) { this.scheduleRetry(); return; }
    runtime.retryAt = null;
    this.queue.push(runtime);
    void this.drain();
  }
  frameReachable(frameId) {
    for (const runtime of this.runtime.values()) if (runtime.retryAt !== null
      && runtime.job.results.some(result => result.frameId === frameId && result.status === 'waiting')) {
      runtime.retryAt = this.now(); runtime.reachableFrame = frameId;
    }
    this.scheduleRetry();
  }
  emit(card, device, tokens) {
    // Delivery is already confirmed; a consumer Flow must not change or delay
    // that receipt, including when its trigger Promise never settles.
    if (this.closed || this.app.stopping) return;
    void Promise.resolve().then(() => {
      if (!this.closed && !this.app.stopping) return card?.trigger(device, tokens);
    }).catch(() => this.app.log('Frameo transfer Flow trigger failed.'));
  }
  async releaseSource(runtime) {
    const source = runtime.source; runtime.source = null;
    this.sourceMemory -= runtime.reserved; runtime.reserved = 0;
    if (source?.cleanup) {
      try { await source.cleanup(); } catch { this.app.log('Frameo uploaded source cleanup failed.'); }
    }
  }
  async settle(runtime) {
    await this.releaseSource(runtime); runtime.caption = '';
    if (runtime.prepared) {
      try { await this.app.engine.disposePrepared(runtime.prepared); }
      catch {
        if (runtime.waitingBytes) this.deferredCleanupFailed = true;
        this.app.log('Frameo temporary source cleanup failed.');
      }
      runtime.prepared = null; runtime.waitingBytes = 0;
    }
    runtime.job.phase = 'done'; runtime.job.completedAt = this.stamp();
    try { await this.checkpoint(runtime.job); } catch { runtime.job.journalError = true; this.app.log('Frameo transfer journal could not be saved.'); }
    // Source preparation can fail before the per-frame loop. Preserve the
    // failure Flow for every affected frame without emitting it twice or
    // starting new consumer Flows during shutdown/restart recovery.
    if (!this.closed && !this.app.stopping) for (const result of runtime.job.results) {
      if (!['failed', 'uncertain'].includes(result.status) || runtime.notified.has(result.frameId)) continue;
      const device = this.devices().find(value => !value.stopped && String(value.getData().id).toLowerCase() === result.frameId);
      if (!device) continue;
      runtime.notified.add(result.frameId);
      this.emit(this.app.photoFailed, device, { reason: this.app.homey.__(REASON_KEYS[result.code] || 'errors.send_failed') });
    }
    this.runtime.delete(runtime.job.id);
    if (runtime.batchId && this.batches.has(runtime.batchId)) this.batches.get(runtime.batchId).expiresAt = this.now() + 60 * 60 * 1000;
    runtime.resolve(this.journal.public(runtime.job));
  }
  async cancelRuntime(runtime) {
    runtime.controller.abort();
    for (const result of runtime.job.results) {
      if (result.status === 'running') { result.status = 'uncertain'; result.code = 'SEND_UNVERIFIED'; }
      else if (['queued', 'waiting'].includes(result.status)) { result.status = 'failed'; result.code = 'TRANSFER_CANCELLED'; }
    }
    await this.releaseSource(runtime);
    await this.settle(runtime);
  }
  get(jobId) { return this.journal.get(jobId); }
  history() { return this.journal.history(); }
  clear() { return this.journal.clear(); }
  async waitFor(jobId, { timeoutMs = this.flowTimeoutMs } = {}) {
    const runtime = this.runtime.get(jobId);
    let timer;
    const finished = runtime ? runtime.done : this.get(jobId).then(value => value.job);
    const limit = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = coded('TRANSFER_STILL_RUNNING'); error.jobId = jobId;
        error.message = this.app.homey.__('errors.transfer_pending', { job: jobId.slice(0, 8) }); reject(error);
      }, timeoutMs);
    });
    let job;
    try { job = await Promise.race([finished, limit]); } finally { clearTimeout(timer); }
    if (job.status === 'succeeded') return job;
    const counts = summary(job.results);
    const failures = job.results.filter(value => value.status !== 'succeeded').slice(0, 3).map(value =>
      `${publicName(value.name, 32)}: ${this.app.homey.__(REASON_KEYS[value.code] || 'errors.send_failed')}`).join(' · ');
    const error = coded('TRANSFER_INCOMPLETE'); error.jobId = job.id;
    error.message = this.app.homey.__('errors.transfer_incomplete', { success: counts.succeeded, total: counts.total,
      failed: counts.failed, uncertain: counts.uncertain }) + ' ' + Array.from(failures).slice(0, 300).join('');
    throw error;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    if (this.active) this.active.controller.abort();
    const waiting = [...this.runtime.values()].filter(runtime => runtime.retryAt !== null);
    const expiring = [...this.runtime.values()].filter(runtime => runtime.expiring);
    for (const runtime of [...this.queue.splice(0), ...waiting]) await this.cancelRuntime(runtime);
    this.batches.clear();
    if (this.active) await this.active.done;
    await Promise.all(expiring.map(runtime => runtime.done));
  }
}

module.exports = { FrameoTransfers };
