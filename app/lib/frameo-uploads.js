'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { coded } = require('./frameo-groups');
const { createPrivateDirectory, recoverPrivateDirectories } = require('./frameo-temp');

const CHUNK_BYTES = 196608;
const MAX_BYTES = 8 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Files and paths are private implementation details. API responses contain
// only opaque IDs, offsets and the existing public transfer job ID.
class FrameoUploads {
  constructor(app, { now = () => Date.now(), tmpdir = os.tmpdir(), sweepMs = 30000 } = {}) {
    this.app = app; this.now = now; this.tmpdir = tmpdir;
    this.sessions = new Map(); this.receipts = new Map(); this.reservedBytes = 0;
    this.closed = false; this.starts = Promise.resolve(); this.recovery = null;
    this.ready = recoverPrivateDirectories({ tmpdir }).then(stats => { this.recovery = stats; return stats; })
      .catch(() => { throw coded('UPLOAD_FAILED'); });
    this.timer = sweepMs > 0 ? setInterval(() => { void this.sweep().catch(() => this.logCleanup()); }, sweepMs) : null;
    this.timer?.unref();
  }
  logCleanup() { this.app.log('Frameo upload cleanup failed.'); }
  assertOpen() { if (this.closed || this.app.stopping) throw coded('TRANSFER_CANCELLED'); }
  validId(value) { if (typeof value !== 'string' || !ID.test(value)) throw coded('UPLOAD_INVALID'); return value; }
  serial(session, task) {
    const next = session.writes.then(task);
    session.writes = next.catch(() => {}); return next;
  }
  start(input = {}) {
    const next = this.starts.then(() => this.startOne(input));
    this.starts = next.catch(() => {}); return next;
  }
  async startOne({ batchId, mime, bytes } = {}) {
    this.assertOpen(); await this.ready; this.assertOpen(); await this.sweep();
    await this.app.transfers.ready; this.app.transfers.requireBatch(batchId);
    if (!['image/jpeg', 'image/png'].includes(mime)) throw coded('IMAGE_FORMAT_UNSUPPORTED');
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) throw coded('IMAGE_TOO_LARGE');
    if (this.sessions.size >= 2 || this.reservedBytes + bytes > 2 * MAX_BYTES) throw coded('UPLOAD_LIMIT');
    let directory;
    try {
      directory = await createPrivateDirectory('upload', { tmpdir: this.tmpdir });
      await fs.chmod(directory, 0o700);
      const filename = path.join(directory, 'source');
      const file = await fs.open(filename, 'wx', 0o600);
      await file.close(); this.assertOpen();
      const uploadId = randomUUID();
      this.sessions.set(uploadId, { uploadId, batchId, mime, bytes, offset: 0, directory, filename,
        expiresAt: this.now() + TTL_MS, state: 'receiving', writes: Promise.resolve(), released: false });
      this.reservedBytes += bytes;
      return { uploadId, chunkBytes: CHUNK_BYTES };
    } catch (error) {
      if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => this.logCleanup());
      if (error?.code === 'TRANSFER_CANCELLED') throw error;
      throw coded('UPLOAD_FAILED');
    }
  }
  async session(uploadId) {
    this.assertOpen(); this.validId(uploadId); await this.sweep();
    const session = this.sessions.get(uploadId);
    if (!session) throw coded('UPLOAD_NOT_FOUND');
    return session;
  }
  async chunk({ uploadId, offset, data } = {}) {
    const session = await this.session(uploadId);
    return this.serial(session, async () => {
      this.assertOpen();
      if (session.released || session.state !== 'receiving') throw coded('UPLOAD_INVALID');
      if (!Number.isSafeInteger(offset) || offset !== session.offset || offset < 0) throw coded('UPLOAD_OFFSET_INVALID');
      if (typeof data !== 'string' || !data.length || data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw coded('UPLOAD_INVALID');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== data) throw coded('UPLOAD_INVALID');
      if (session.offset + bytes.length > session.bytes) throw coded('UPLOAD_OFFSET_INVALID');
      try { await fs.appendFile(session.filename, bytes); }
      catch { await this.release(session).catch(() => this.logCleanup()); throw coded('UPLOAD_FAILED'); }
      session.offset += bytes.length; session.expiresAt = this.now() + TTL_MS;
      return { offset: session.offset };
    });
  }
  async finish({ uploadId, caption, fit } = {}) {
    this.assertOpen(); this.validId(uploadId); await this.sweep();
    const receipt = this.receipts.get(uploadId);
    if (receipt) return { jobId: receipt.jobId };
    const session = this.sessions.get(uploadId);
    if (!session) throw coded('UPLOAD_NOT_FOUND');
    return this.serial(session, async () => {
      this.assertOpen();
      if (session.jobId) return { jobId: session.jobId };
      if (session.released || session.state !== 'receiving') throw coded('UPLOAD_INVALID');
      if (session.offset !== session.bytes) throw coded('UPLOAD_INCOMPLETE');
      let size;
      try { size = (await fs.stat(session.filename)).size; } catch { throw coded('UPLOAD_FAILED'); }
      if (size !== session.bytes) throw coded('UPLOAD_INCOMPLETE');
      this.app.transfers.requireBatch(session.batchId);
      session.state = 'finishing';
      const image = { contentType: session.mime, getStream: async () => createReadStream(session.filename) };
      try {
        const result = await this.app.transfers.enqueueUploadedFile({ batchId: session.batchId, caption, fit }, image,
          () => this.release(session));
        session.jobId = result.jobId; session.state = 'queued';
        this.remember(uploadId, result.jobId);
        return { jobId: result.jobId };
      } catch (error) { if (!session.released) session.state = 'receiving'; throw error; }
    });
  }
  remember(uploadId, jobId) {
    this.receipts.set(uploadId, { jobId, expiresAt: this.now() + TTL_MS });
    while (this.receipts.size > 32) this.receipts.delete(this.receipts.keys().next().value);
  }
  async abort({ uploadId } = {}) {
    this.assertOpen(); this.validId(uploadId); await this.sweep();
    const receipt = this.receipts.get(uploadId);
    if (receipt) return { aborted: false, jobId: receipt.jobId };
    const session = this.sessions.get(uploadId);
    if (!session) return { aborted: true };
    return this.serial(session, async () => {
      if (session.jobId) return { aborted: false, jobId: session.jobId };
      try { await this.release(session); } catch { throw coded('UPLOAD_FAILED'); }
      return { aborted: true };
    });
  }
  async release(session) {
    if (session.releasePromise) return session.releasePromise;
    session.released = true;
    session.releasePromise = (async () => {
      try {
        await fs.rm(session.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        this.sessions.delete(session.uploadId); this.reservedBytes -= session.bytes;
      } catch (error) { session.state = 'cleanup'; session.releasePromise = null; throw error; }
    })();
    return session.releasePromise;
  }
  async sweep() {
    for (const [id, receipt] of this.receipts) if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    try {
      await Promise.all([...this.sessions.values()].filter(session => session.state === 'cleanup' || session.state === 'receiving' && session.expiresAt <= this.now())
        .map(session => this.serial(session, async () => {
          if (session.state === 'cleanup' || session.state === 'receiving' && session.expiresAt <= this.now()) await this.release(session);
        })));
    } catch { throw coded('UPLOAD_FAILED'); }
  }
  stats() { return { sessions: this.sessions.size, bytes: this.reservedBytes, maxBytes: 2 * MAX_BYTES }; }
  async close() {
    this.closed = true; clearInterval(this.timer); await this.ready.catch(() => {}); await this.starts;
    await Promise.allSettled([...this.sessions.values()].map(session => this.serial(session, () => this.release(session))));
    this.receipts.clear();
  }
}

module.exports = { FrameoUploads, CHUNK_BYTES, MAX_BYTES, TTL_MS };
