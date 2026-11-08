'use strict';

const { validateMediaId } = require('./frameo-engine');
const { publicName, coded } = require('./frameo-groups');
const JOURNAL_KEY = 'frameo_transfer_history';
const STATUSES = new Set(['queued', 'running', 'waiting', 'succeeded', 'failed', 'uncertain']);
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const REASONS = new Set(['URL_INVALID', 'IMAGE_TOO_LARGE', 'IMAGE_FORMAT_UNSUPPORTED', 'DOWNLOAD_FAILED', 'FRAME_UNKNOWN',
  'FRAME_UNAVAILABLE', 'CONNECTION_FAILED', 'CONNECTION_REFUSED', 'AUTHENTICATION_FAILED', 'TIMEOUT', 'BUSY', 'QUEUE_FULL',
  'ENGINE_NOT_READY', 'ENGINE_CONFIG_INVALID', 'INVALID_IMAGE', 'SEND_UNCONFIRMED', 'SEND_UNVERIFIED', 'UNKNOWN_ERROR',
  'ABORTED', 'TRANSFER_CANCELLED', 'TRANSFER_RESTART_QUEUED', 'TRANSFER_RESTART_RUNNING', 'TRANSFER_JOURNAL_FAILED',
  'TRANSFER_DEFERRED_LIMIT', 'TRANSFER_DEFERRED_EXPIRED']);
const REASON_KEYS = { URL_INVALID: 'errors.url_invalid', IMAGE_TOO_LARGE: 'errors.image_too_large',
  IMAGE_FORMAT_UNSUPPORTED: 'errors.image_invalid', INVALID_IMAGE: 'errors.image_invalid', DOWNLOAD_FAILED: 'errors.download_failed',
  FRAME_UNKNOWN: 'errors.frame_unavailable', FRAME_UNAVAILABLE: 'errors.frame_unavailable', CONNECTION_FAILED: 'errors.frame_unavailable',
  CONNECTION_REFUSED: 'errors.frame_unavailable', AUTHENTICATION_FAILED: 'errors.frame_unavailable', TIMEOUT: 'errors.timeout',
  BUSY: 'errors.busy', QUEUE_FULL: 'errors.busy', ENGINE_NOT_READY: 'errors.not_ready', ENGINE_CONFIG_INVALID: 'errors.not_ready',
  SEND_UNCONFIRMED: 'errors.send_uncertain', SEND_UNVERIFIED: 'errors.send_uncertain', ABORTED: 'errors.transfer_cancelled',
  TRANSFER_CANCELLED: 'errors.transfer_cancelled', TRANSFER_RESTART_QUEUED: 'errors.transfer_restart_queued',
  TRANSFER_RESTART_RUNNING: 'errors.transfer_restart_running', TRANSFER_JOURNAL_FAILED: 'errors.transfer_journal_failed',
  TRANSFER_DEFERRED_LIMIT: 'errors.transfer_deferred_limit', TRANSFER_DEFERRED_EXPIRED: 'errors.transfer_deferred_expired' };
const reasonCode = error => REASONS.has(error?.code || error) ? error?.code || error : 'UNKNOWN_ERROR';
const clone = value => JSON.parse(JSON.stringify(value));
function summary(results) {
  return { total: results.length, succeeded: results.filter(value => value.status === 'succeeded').length,
    failed: results.filter(value => value.status === 'failed').length, uncertain: results.filter(value => value.status === 'uncertain').length };
}
function jobStatus(results) {
  if (results.some(value => value.status === 'running')) return 'running';
  if (results.some(value => value.status === 'queued')) return results.some(value => value.status !== 'queued') ? 'running' : 'queued';
  if (results.some(value => value.status === 'waiting')) return 'waiting';
  const counts = summary(results);
  return counts.succeeded === counts.total ? 'succeeded' : counts.succeeded ? 'partial' : counts.uncertain ? 'uncertain' : 'failed';
}

class TransferJournal {
  constructor(app, { now = () => Date.now() } = {}) {
    this.app = app; this.now = now; this.jobs = []; this.writes = Promise.resolve(); this.ready = this.load();
  }
  stamp() { return new Date(this.now()).toISOString(); }
  async load() {
    const saved = await this.app.homey.settings.get(JOURNAL_KEY);
    if (saved == null) return;
    if (!saved || saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 50 || Buffer.byteLength(JSON.stringify(saved)) > 512 * 1024) throw coded('TRANSFER_JOURNAL_FAILED');
    this.jobs = saved.jobs.filter(job => typeof job?.id === 'string' && /^[a-f0-9-]{36}$/i.test(job.id) && Array.isArray(job.results) && job.results.length > 0 && job.results.length <= 64).map(job => {
      const results = job.results.filter(value => typeof value?.frameId === 'string' && /^[a-f0-9]{64}$/i.test(value.frameId)).map(value => {
        let status = STATUSES.has(value.status) ? value.status : 'failed';
        let code = value.code ? reasonCode(value.code) : undefined;
        if (status === 'queued' || status === 'waiting') { status = 'failed'; code = 'TRANSFER_RESTART_QUEUED'; }
        if (status === 'running') { status = 'uncertain'; code = 'TRANSFER_RESTART_RUNNING'; }
        const result = { frameId: value.frameId, name: publicName(value.name) || 'Frameo', status };
        if (code) result.code = code;
        if (value.completedAt) result.completedAt = validTime(value.completedAt, this.stamp());
        try { if (value.mediaId) result.mediaId = validateMediaId(value.mediaId); } catch {}
        return result;
      });
      return { id: job.id, createdAt: validTime(job.createdAt, this.stamp()), completedAt: validTime(job.completedAt, this.stamp()),
        ...(job.startedAt ? { startedAt: validTime(job.startedAt, this.stamp()) } : {}),
        initiator: job.initiator === 'manual' ? 'manual' : 'flow', source: job.source === 'image' ? 'image' : 'url',
        targetName: publicName(job.targetName) || 'Frameo', status: jobStatus(results), phase: 'done', results };
    }).filter(job => job.results.length);
    await this.persist();
  }
  async persist() {
    while (this.jobs.length > 50 || Buffer.byteLength(JSON.stringify({ version: 1, jobs: this.jobs })) > 512 * 1024) {
      let index = this.jobs.length - 1;
      while (index >= 0 && ACTIVE.has(this.jobs[index].status)) index--;
      if (index < 0) throw coded('TRANSFER_JOURNAL_FAILED');
      this.jobs.splice(index, 1);
    }
    const snapshot = clone({ version: 1, jobs: this.jobs });
    const task = this.writes.catch(() => {}).then(() => this.app.homey.settings.set(JOURNAL_KEY, snapshot)).catch(() => { throw coded('TRANSFER_JOURNAL_FAILED'); });
    this.writes = task; return task;
  }
  async create(job) {
    await this.ready; this.jobs.unshift(job);
    try { await this.persist(); } catch (error) { this.jobs = this.jobs.filter(value => value !== job); throw error; }
    return job;
  }
  async update(job) { job.status = jobStatus(job.results); await this.persist(); }
  public(job) {
    const value = clone(job); value.summary = summary(value.results);
    value.results = value.results.map(result => result.code ? { ...result, reason: this.app.homey.__(REASON_KEYS[result.code] || 'errors.send_failed') } : result);
    return value;
  }
  async get(id) {
    await this.ready; const job = this.jobs.find(value => value.id === id);
    if (!job) throw coded('TRANSFER_NOT_FOUND');
    return { job: this.public(job) };
  }
  async history() { await this.ready; return { jobs: this.jobs.map(job => this.public(job)) }; }
  async clear() {
    await this.ready; const previous = this.jobs.length;
    this.jobs = this.jobs.filter(job => ACTIVE.has(job.status));
    await this.persist(); return { cleared: previous - this.jobs.length };
  }
}
function validTime(value, fallback) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback; }

module.exports = { TransferJournal, JOURNAL_KEY, reasonCode, REASON_KEYS, summary, jobStatus };
