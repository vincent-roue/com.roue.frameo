'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { normalizeFrameInfo } = require('./frame-info');
const { performance } = require('node:perf_hooks');
const { MediaIndexCache } = require('./media-index-cache');
const { EngineMetrics } = require('./engine-metrics');
const { createPrivateDirectory, recoverPrivateDirectories } = require('./frameo-temp');

const SETTINGS_KEY = 'frameo_config';
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_PROCESS_REQUEST = 512 * 1024;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const PEER = /^[0-9a-f]{64}$/i;
const OPERATION_TIMEOUTS = { probe: 5000, pair: 80000, info: 30000, permission: 80000, send: 155000,
  listMedia: 25000, getMedia: 30000, deleteMedia: 30000, setMediaVisible: 30000 };
class FrameoError extends Error {
  constructor(code, details) {
    super(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'FRAMEO_OPERATION_FAILED');
    this.name = 'FrameoError';
    this.code = code;
    if (details) this.details = details;
  }
}

function abortError() { return new FrameoError('ABORTED'); }
function validateMediaId(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/.test(value)) throw new FrameoError('INVALID_MEDIA_ID');
  const number = BigInt(value);
  if (number < -9223372036854775808n || number > 9223372036854775807n || number.toString() !== value) throw new FrameoError('INVALID_MEDIA_ID');
  return value;
}
function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : 'ENGINE_NOT_READY';
}
function cleanText(value, maximum = 80) {
  return typeof value === 'string'
    ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[0-9a-f]{64}/gi, '…').trim()).slice(0, maximum).join('')
    : '';
}
function validatePairCode(code) {
  const normalized = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{7,31}$/.test(normalized)) throw new FrameoError('PAIRING_CODE_INVALID');
  return normalized;
}
function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new FrameoError('URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || url.href.length > 8192) {
    throw new FrameoError('URL_INVALID');
  }
  return url;
}
function validateConfig(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new FrameoError('ENGINE_CONFIG_INVALID'); }
  if (!serialized || Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw new FrameoError('ENGINE_CONFIG_INVALID');
  const config = JSON.parse(serialized);
  if (!config || Array.isArray(config) || typeof config !== 'object' || !PEER.test(config.private_key || '')) {
    throw new FrameoError('ENGINE_CONFIG_INVALID');
  }
  if (!config.frames || Array.isArray(config.frames) || typeof config.frames !== 'object' || Object.keys(config.frames).length > 64) {
    throw new FrameoError('ENGINE_CONFIG_INVALID');
  }
  for (const [key, frame] of Object.entries(config.frames)) {
    if (key.length > 128 || !frame || typeof frame !== 'object' || Array.isArray(frame) || !PEER.test(frame.peer_id || '')) {
      throw new FrameoError('ENGINE_CONFIG_INVALID');
    }
  }
  return config;
}
function publicFrame(result) {
  if (!result || !PEER.test(result.peer || '')) throw new FrameoError('ENGINE_NOT_READY');
  return {
    peer: result.peer.toLowerCase(),
    ...normalizeFrameInfo(result),
    protocolConfirmed: result.protocolConfirmed === true,
  };
}

// The child receives credentials only through stdin, never arguments or the environment.
// Its stdout is an internal response; neither stdout nor stderr may enter user logs.
async function runEngineProcess({ binaryPath, request, signal, timeoutMs, args = [], onMetrics, memoryUsage = () => process.memoryUsage() }) {
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > MAX_PROCESS_REQUEST) throw new FrameoError('ENGINE_CONFIG_INVALID');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let child;
    let settled = false;
    let outputBytes = 0;
    const output = [];
    let errorBytes = 0;
    let spawned = false;
    let killTimer;
    let timer;
    let sampleTimer, readingSample = false, samplingClosed = false;
    const sampled = { sampledChildRssBytes: null, sampledChildHwmBytes: null, sampledNodeRssBytes: null };
    const sample = async () => {
      if (samplingClosed || readingSample) return;
      try {
        const rss = memoryUsage()?.rss;
        if (Number.isSafeInteger(rss) && rss > 0) sampled.sampledNodeRssBytes = Math.max(sampled.sampledNodeRssBytes || 0, rss);
      } catch { /* RSS can be unavailable in Homey's jail. */ }
      if (process.platform !== 'linux' || !Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
      readingSample = true;
      try {
        const status = await fs.readFile(`/proc/${child.pid}/status`, 'utf8');
        if (samplingClosed) return;
        for (const [field, key] of [['VmRSS', 'sampledChildRssBytes'], ['VmHWM', 'sampledChildHwmBytes']]) {
          const match = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm'));
          const bytes = match ? Number(match[1]) * 1024 : null;
          if (Number.isSafeInteger(bytes) && bytes > 0) sampled[key] = Math.max(sampled[key] || 0, bytes);
        }
      } catch { /* A short-lived child can exit before /proc is read. */ }
      finally { readingSample = false; }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      samplingClosed = true; clearInterval(sampleTimer);
      if (typeof onMetrics === 'function') {
        try { onMetrics({ ...sampled }); } catch { /* Metrics cannot alter an operation result. */ }
      }
      signal?.removeEventListener('abort', aborted);
      if (error) {
        try { child?.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 500);
        killTimer.unref?.();
        reject(error);
      } else resolve(value);
    };
    const aborted = () => finish(new FrameoError('ABORTED', { started: spawned }));
    try {
      child = spawn(binaryPath, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return finish(new FrameoError('ENGINE_NOT_READY', { started: false })); }
    child.on('spawn', () => {
      spawned = true;
      if (typeof onMetrics === 'function' && !settled) {
        void sample().catch(() => {});
        sampleTimer = setInterval(() => { void sample().catch(() => {}); }, 200); sampleTimer.unref();
      }
    });
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new FrameoError('TIMEOUT')), timeoutMs);
    child.on('error', () => finish(new FrameoError('ENGINE_NOT_READY', { started: spawned })));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT) return finish(new FrameoError('ENGINE_NOT_READY'));
      output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errorBytes += chunk.length;
      if (errorBytes > 32768) finish(new FrameoError('ENGINE_NOT_READY'));
    });
    child.on('close', () => {
      clearTimeout(killTimer);
      if (settled) return;
      let response;
      try { response = JSON.parse(Buffer.concat(output).toString('utf8').trim()); }
      catch { return finish(new FrameoError('ENGINE_NOT_READY')); }
      if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') return finish(new FrameoError('ENGINE_NOT_READY'));
      finish(null, response);
    });
    child.stdin.end(serialized + '\n');
  });
}

async function deadline(operation, timeoutMs, signal) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  if (combined.aborted) throw abortError();
  let timer;
  let abortListener;
  const interruption = new Promise((_, reject) => {
    abortListener = () => reject(abortError());
    signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => {
      reject(new FrameoError('TIMEOUT'));
      controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([operation(combined), interruption]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abortListener); }
}

class FrameoEngine {
  #homey;
  #binaryPath;
  #runner;
  #fetch;
  #config;
  #loaded = false;
  #queue = [];
  #running = false;
  #closed = false;
  #activeController;
  #maxBytes;
  #maxQueued;
  #queueWaitMs;
  #downloadTimeoutMs;
  #timeouts;
  #prepared = new Map();
  #mediaIndex;
  #metrics;
  #idle = Promise.resolve();
  #closing;

  constructor({ homey, binaryPath, runner = runEngineProcess, fetch: fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_BYTES, maxQueued = 8, queueWaitMs = 30000, downloadTimeoutMs = 30000, timeouts = {},
    mediaIndexCache = new MediaIndexCache(), metrics = new EngineMetrics() } = {}) {
    if (!homey?.settings?.get || !homey?.settings?.set) throw new TypeError('Homey settings required');
    this.#homey = homey;
    this.#binaryPath = binaryPath || path.join(__dirname, '..', 'bin', 'homey-frameo-linux-arm64');
    this.#runner = runner;
    this.#fetch = fetchImpl;
    this.#maxBytes = maxBytes;
    this.#maxQueued = maxQueued;
    this.#queueWaitMs = queueWaitMs;
    this.#downloadTimeoutMs = downloadTimeoutMs;
    this.#timeouts = { ...OPERATION_TIMEOUTS, ...timeouts };
    this.#mediaIndex = mediaIndexCache; this.#metrics = metrics;
    this.ready = recoverPrivateDirectories();
  }

  async #load() {
    if (this.#loaded) return;
    const saved = await this.#homey.settings.get(SETTINGS_KEY);
    this.#config = saved === undefined || saved === null ? null : validateConfig(saved);
    this.#loaded = true;
  }
  async #save(value) {
    const config = validateConfig(value);
    await this.#homey.settings.set(SETTINGS_KEY, config);
    this.#config = config;
    this.#loaded = true;
  }
  #ensurePeer(peer) {
    if (!PEER.test(peer || '') || !this.#config || !Object.values(this.#config.frames).some(frame => frame.peer_id.toLowerCase() === peer.toLowerCase())) {
      throw new FrameoError('FRAME_UNKNOWN');
    }
    return peer.toLowerCase();
  }
  #enqueue(operation, signal) {
    if (this.#closed || signal?.aborted) return Promise.reject(abortError());
    if (this.#queue.length >= this.#maxQueued) return Promise.reject(new FrameoError('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const task = { operation, signal, resolve, reject, expired: false };
      task.aborted = () => {
        task.expired = true;
        clearTimeout(task.timer);
        this.#queue = this.#queue.filter(item => item !== task);
        task.reject(abortError());
      };
      signal?.addEventListener('abort', task.aborted, { once: true });
      task.timer = setTimeout(() => {
        task.expired = true;
        signal?.removeEventListener('abort', task.aborted);
        task.reject(new FrameoError('QUEUE_FULL'));
        this.#queue = this.#queue.filter(item => item !== task);
      }, this.#queueWaitMs);
      this.#queue.push(task);
      this.#drain();
    });
  }
  async #drain() {
    if (this.#running) return;
    this.#running = true;
    let resolveIdle;
    this.#idle = new Promise(resolve => { resolveIdle = resolve; });
    try {
      while (this.#queue.length) {
        const task = this.#queue.shift();
        clearTimeout(task.timer);
        task.signal?.removeEventListener('abort', task.aborted);
        if (task.expired) continue;
        if (this.#closed || task.signal?.aborted) { task.reject(abortError()); continue; }
        this.#activeController = new AbortController();
        const signal = task.signal ? AbortSignal.any([task.signal, this.#activeController.signal]) : this.#activeController.signal;
        try { task.resolve(await task.operation(signal)); }
        catch (error) { task.reject(error instanceof FrameoError ? error : new FrameoError(errorCode(error))); }
        this.#activeController = null;
      }
    } finally { this.#running = false; resolveIdle(); }
  }

  async #request(operation, fields, signal) {
    if (operation !== 'probe') await this.#load();
    const request = { operation, ...fields };
    if (operation !== 'probe' && this.#config) request.config = validateConfig(this.#config);
    const started = performance.now(); let response, metricsActive = true, sample = {}, failure = null;
    try {
      response = await deadline(innerSignal => this.#runner({ binaryPath: this.#binaryPath, request,
        signal: innerSignal, timeoutMs: this.#timeouts[operation], onMetrics: value => { if (metricsActive) sample = value; } }), this.#timeouts[operation], signal);
      if (!response || typeof response.ok !== 'boolean') failure = 'ENGINE_NOT_READY';
      else if (!response.ok) failure = errorCode(response.error);
    } catch (error) { failure = errorCode(error); throw error; }
    finally {
      metricsActive = false;
      try { this.#metrics.record(operation, performance.now() - started, failure, sample); } catch { /* Observability cannot change delivery. */ }
    }
    if (!response || typeof response.ok !== 'boolean') throw new FrameoError('ENGINE_NOT_READY');
    if (!response.ok) {
      const code = errorCode(response.error);
      const partial = code === 'PAIR_CONFIRMATION_FAILED' && operation === 'pair' &&
        response.result?.paired === true && response.result?.confirmed === false && PEER.test(response.result.peer || '');
      if (partial && response.config) {
        const config = validateConfig(response.config);
        if (!Object.values(config.frames).some(frame => frame.peer_id.toLowerCase() === response.result.peer.toLowerCase())) throw new FrameoError('ENGINE_CONFIG_INVALID');
        await this.#save(config);
      }
      throw new FrameoError(code, partial ? { paired: true, confirmed: false, peer: response.result.peer.toLowerCase() }
        : operation === 'send' ? { nativeResponse: true, attempted: code === 'SEND_UNVERIFIED' } : undefined);
    }
    if (response.config && operation === 'pair') await this.#save(response.config);
    return response.result;
  }

  probe({ signal } = {}) {
    return this.#enqueue(async innerSignal => {
      await this.ready;
      const result = await this.#request('probe', {}, innerSignal);
      if (result?.protocolVersion !== 1) throw new FrameoError('ENGINE_NOT_READY');
      return { engine: cleanText(result.engine), protocolVersion: 1, goos: cleanText(result.goos, 20),
        goarch: cleanText(result.goarch, 20), revision: cleanText(result.revision, 48) };
    }, signal);
  }
  pair(code, { name = 'Homey', signal } = {}) {
    let normalized;
    try { normalized = validatePairCode(code); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async innerSignal => {
      const result = publicFrame(await this.#request('pair', {
        code: normalized, name: cleanText(name) || 'Homey' }, innerSignal));
      if (!result.protocolConfirmed) throw new FrameoError('PAIR_CONFIRMATION_FAILED');
      this.#ensurePeer(result.peer);
      return result;
    }, signal);
  }
  info(peer, { name, network = 'auto', signal } = {}) {
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      const result = publicFrame(await this.#request('info', { peer: expected,
        name: cleanText(name), network: this.#network(network) }, innerSignal));
      if (result.mayView !== true) this.invalidateMediaIndex(expected);
      return result;
    }, signal);
  }
  permission(peer, access, { name = 'Homey', network = 'auto', signal } = {}) {
    if (!['view', 'manage'].includes(access)) return Promise.reject(new FrameoError('INVALID_ACCESS'));
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      const raw = await this.#request('permission', { peer: expected, access,
        name: cleanText(name) || 'Homey', network: this.#network(network) }, innerSignal);
      const result = publicFrame(raw);
      if (raw?.granted !== true || !result.protocolConfirmed || raw?.access !== access || result.peer !== expected ||
        result.mayView !== true || (access === 'manage' && result.mayManage !== true)) {
        throw new FrameoError('PERMISSION_NOT_GRANTED');
      }
      return result;
    }, signal);
  }
  listMedia(peer, { name, signal } = {}) {
    const scope = cleanText(name);
    let token;
    if (typeof peer === 'string' && PEER.test(peer)) token = this.#mediaIndex.capture(peer.toLowerCase(), scope);
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      const raw = await this.#request('listMedia', { peer: expected, name: scope }, innerSignal);
      if (raw?.peer !== expected || !Array.isArray(raw.items) || raw.items.length > 10000) throw new FrameoError('ENGINE_NOT_READY');
      const seen = new Set();
      const items = raw.items.map(item => {
        const mediaId = validateMediaId(item?.mediaId);
        if (seen.has(mediaId)) throw new FrameoError('ENGINE_NOT_READY');
        seen.add(mediaId);
        const date = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
          ? new Date(value).toISOString() : null;
        return { mediaId, type: ['photo', 'video', 'greeting'].includes(item.type) ? item.type : 'unknown',
          visible: typeof item.visible === 'boolean' ? item.visible : null, captureDate: date(item.captureDate), receiveDate: date(item.receiveDate) };
      });
      if (!this.#mediaIndex.put(token, items.filter(item => item.type === 'photo' && item.visible).map(item => item.mediaId))) throw abortError();
      return items;
    }, signal);
  }
  async visiblePhotoIds(peer, { name, signal } = {}) {
    if (this.#closed || signal?.aborted) throw abortError();
    await this.#load(); const expected = this.#ensurePeer(peer), scope = cleanText(name);
    if (this.#closed || signal?.aborted) throw abortError();
    const cached = this.#mediaIndex.get(expected, scope);
    if (cached) return cached;
    await this.listMedia(expected, { name, signal });
    if (this.#closed || signal?.aborted) throw abortError();
    const ids = this.#mediaIndex.get(expected, scope);
    if (!ids) throw abortError();
    return ids;
  }
  invalidateMediaIndex(peer) { this.#mediaIndex.invalidate(peer); }
  mediaIndexStats() { return this.#mediaIndex.stats(); }
  performanceStats() { return this.#metrics.snapshot(); }
  previewMedia(peer, mediaId, { name, signal, encoding, output = 'base64' } = {}) {
    try { validateMediaId(mediaId); } catch (error) { return Promise.reject(error); }
    if (encoding !== undefined && encoding !== 'jpeg') return Promise.reject(new FrameoError('IMAGE_FORMAT_UNSUPPORTED'));
    if (!['base64', 'buffer'].includes(output)) return Promise.reject(new FrameoError('IMAGE_FORMAT_UNSUPPORTED'));
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      await this.ready;
      const directory = await createPrivateDirectory('preview');
      try {
        await fs.chmod(directory, 0o700);
        const filename = path.join(directory, 'preview');
        const file = await fs.open(filename, 'wx', 0o600); await file.close();
        const raw = await this.#request('getMedia', { peer: expected, mediaId, path: filename,
          size: 'preview', name: cleanText(name), ...(encoding === 'jpeg' ? { encoding } : {}) }, innerSignal);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 8 || stat.size > 4 * 1024 * 1024 ||
          raw?.peer !== expected || raw.mediaId !== mediaId || raw.bytes !== stat.size) throw new FrameoError('MEDIA_TOO_LARGE');
        const bytes = await fs.readFile(filename);
        const mime = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
            : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
        if (!mime || raw.mime !== mime || (encoding === 'jpeg' && mime !== 'image/jpeg') || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) ||
          raw.width < 1 || raw.height < 1 || raw.width > 2048 || raw.height > 2048 || raw.width * raw.height > 4000000) {
          throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
        }
        return { mime, ...(output === 'buffer' ? { buffer: bytes } : { data: bytes.toString('base64') }),
          bytes: bytes.length, width: raw.width, height: raw.height };
      } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    }, signal).catch(error => {
      if (['MEDIA_NOT_FOUND', 'PERMISSION_REQUIRED'].includes(error?.code)) this.invalidateMediaIndex(peer);
      throw error;
    });
  }
  deleteMedia(peer, mediaId, { name, signal } = {}) {
    try { validateMediaId(mediaId); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      this.invalidateMediaIndex(expected);
      let raw;
      try { raw = await this.#request('deleteMedia', { peer: expected, mediaId, name: cleanText(name) }, innerSignal); }
      catch (error) {
        if (['TIMEOUT', 'ABORTED', 'ENGINE_NOT_READY'].includes(error?.code)) throw new FrameoError('DELETE_UNVERIFIED');
        throw error;
      }
      finally { this.invalidateMediaIndex(expected); }
      if (raw?.peer !== expected || raw.mediaId !== mediaId || raw.acknowledged !== true || raw.deleted !== true) {
        throw new FrameoError('DELETE_UNVERIFIED');
      }
      return { mediaId, deleted: true };
    }, signal);
  }
  setMediaVisible(peer, mediaId, visible, { name, signal } = {}) {
    try { validateMediaId(mediaId); } catch (error) { return Promise.reject(error); }
    if (typeof visible !== 'boolean') return Promise.reject(new FrameoError('INVALID_VISIBILITY'));
    return this.#enqueue(async innerSignal => {
      await this.#load();
      const expected = this.#ensurePeer(peer);
      this.invalidateMediaIndex(expected);
      let raw;
      try {
        raw = await this.#request('setMediaVisible', { peer: expected, mediaId, visible, name: cleanText(name) }, innerSignal);
      } catch (error) {
        if (['TIMEOUT', 'ABORTED', 'ENGINE_NOT_READY'].includes(error?.code)) throw new FrameoError('VISIBILITY_UNVERIFIED');
        throw error;
      } finally { this.invalidateMediaIndex(expected); }
      if (raw?.peer !== expected || raw.mediaId !== mediaId || raw.visible !== visible
        || raw.acknowledged !== true || raw.verified !== true) throw new FrameoError('VISIBILITY_UNVERIFIED');
      return { mediaId, visible, acknowledged: true, verified: true };
    }, signal);
  }
  async frames() {
    await this.#load();
    return this.#config ? Object.entries(this.#config.frames).map(([key, frame]) => ({
      peer: frame.peer_id.toLowerCase(), name: cleanText(frame.name) || 'Frameo' })) : [];
  }
  #network(value) {
    if (!['auto', 'local', 'relay'].includes(value)) throw new FrameoError('FRAME_UNAVAILABLE');
    return value;
  }
  #sendResult(result, peer) {
    if (!result || result.confirmed !== true || !/^-?\d{1,20}$/.test(String(result.mediaId)) ||
      !Number.isInteger(result.bytes) || result.bytes <= 0 || result.bytes > this.#maxBytes) throw new FrameoError('ENGINE_NOT_READY');
    return { peer, mediaId: String(result.mediaId), bytes: result.bytes, confirmed: true,
      ...(['local', 'relay'].includes(result.route) ? { route: result.route } : {}) };
  }
  sendUrl(peer, url, options = {}) {
    let address;
    try { address = validateUrl(url); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(innerSignal => this.#sendSource(peer, async downloadSignal => this.#download(address, downloadSignal), options, innerSignal), options.signal);
  }
  sendImage(peer, image, options = {}) {
    return this.#enqueue(innerSignal => this.#sendSource(peer, async () => {
      if (!image || typeof image.getStream !== 'function') throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
      const stream = await image.getStream();
      return { stream, contentType: stream.contentType || image.contentType };
    }, options, innerSignal), options.signal);
  }

  prepareUrl(url, { signal } = {}) {
    let address;
    try { address = validateUrl(url); } catch (error) { return Promise.reject(error); }
    return this.#enqueue(inner => this.#prepareSource(value => this.#download(address, value), inner), signal);
  }

  prepareImage(image, { signal } = {}) {
    return this.#enqueue(inner => this.#prepareSource(async () => {
      if (!image || typeof image.getStream !== 'function') throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
      const stream = await image.getStream();
      return { stream, contentType: stream.contentType || image.contentType };
    }, inner), signal);
  }

  prepareBase64(data, mime, { signal } = {}) {
    if (!['image/jpeg', 'image/png'].includes(mime) || typeof data !== 'string' || !data.length ||
      data.length > Math.ceil(this.#maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      return Promise.reject(new FrameoError('IMAGE_FORMAT_UNSUPPORTED'));
    }
    return this.#enqueue(inner => this.#prepareSource(async () => {
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > this.#maxBytes) throw new FrameoError('IMAGE_TOO_LARGE');
      if (!bytes.length || bytes.toString('base64') !== data) throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
      return { stream: Readable.from([bytes]), contentType: mime };
    }, inner), signal);
  }

  async #prepareSource(sourceFactory, signal) {
    if (this.#prepared.size >= 8) throw new FrameoError('QUEUE_FULL');
    await this.ready;
    const directory = await createPrivateDirectory('source');
    try {
      await fs.chmod(directory, 0o700);
      const filename = await deadline(async inner => this.#writeImage(await sourceFactory(inner), directory, inner), this.#downloadTimeoutMs, signal);
      if (this.#closed || signal.aborted) throw abortError();
      const handle = Object.freeze({});
      this.#prepared.set(handle, { directory, filename });
      return handle;
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      throw error;
    }
  }

  sendPrepared(peer, handle, options = {}) {
    return this.#enqueue(async signal => {
      await this.#load();
      const selected = this.#ensurePeer(peer);
      const prepared = this.#prepared.get(handle);
      if (!prepared) throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
      return this.#sendFile(selected, prepared.filename, options, signal);
    }, options.signal);
  }

  async disposePrepared(handle) {
    const prepared = this.#prepared.get(handle);
    if (!prepared) return;
    this.#prepared.delete(handle);
    await fs.rm(prepared.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  async #sendFile(peer, filename, options, signal) {
    this.invalidateMediaIndex(peer);
    try {
      const result = await this.#request('send', { peer, path: filename, name: cleanText(options.name),
        caption: cleanText(options.caption, 1000), fit: options.fit === true, network: this.#network(options.network || 'auto') }, signal);
      return this.#sendResult(result, peer);
    } catch (error) {
      // A native refusal before SendPhoto is settled. A parent deadline,
      // interruption or unreadable process response may hide an actual send.
      if (!error?.details?.nativeResponse && error?.details?.started !== false &&
        ['TIMEOUT', 'ABORTED', 'ENGINE_NOT_READY'].includes(error?.code)) throw new FrameoError('SEND_UNVERIFIED');
      throw error;
    } finally { this.invalidateMediaIndex(peer); }
  }

  async #download(initialUrl, signal) {
    let url = initialUrl;
    for (let redirects = 0; redirects <= 3; redirects++) {
      let response;
      try { response = await this.#fetch(url.href, { redirect: 'manual', signal, headers: { Accept: 'image/jpeg, image/png' } }); }
      catch { if (signal.aborted) throw abortError(); throw new FrameoError('DOWNLOAD_FAILED'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects === 3) throw new FrameoError('DOWNLOAD_FAILED');
        url = validateUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new FrameoError('DOWNLOAD_FAILED'); }
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) > this.#maxBytes) {
        await response.body.cancel().catch(() => {});
        throw new FrameoError('IMAGE_TOO_LARGE');
      }
      return { stream: response.body, contentType: response.headers.get('content-type') };
    }
    throw new FrameoError('DOWNLOAD_FAILED');
  }

  async #writeImage(source, directory, signal) {
    const type = (source.contentType || '').split(';')[0].trim().toLowerCase();
    if (type && !['image/jpeg', 'image/jpg', 'image/png', 'application/octet-stream'].includes(type)) {
      await source.stream?.cancel?.().catch(() => {});
      source.stream?.destroy?.();
      throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
    }
    let stream = source.stream;
    if (typeof stream?.getReader === 'function') stream = Readable.fromWeb(stream);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
    // Abort can arrive while fs.open is pending, before the async iterator has
    // installed its own error listener. Keep that race from becoming uncaught.
    stream.once?.('error', () => {});
    if (signal.aborted) { stream.destroy?.(); throw abortError(); }
    const aborted = () => stream.destroy?.(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    const temporary = path.join(directory, 'upload');
    let file;
    let total = 0;
    let signature = Buffer.alloc(0);
    try {
      file = await fs.open(temporary, 'wx', 0o600);
      for await (const chunk of stream) {
        if (signal.aborted) throw abortError();
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        total += bytes.length;
        if (total > this.#maxBytes) throw new FrameoError('IMAGE_TOO_LARGE');
        if (signature.length < 8) signature = Buffer.concat([signature, bytes.subarray(0, 8 - signature.length)]);
        await file.writeFile(bytes);
      }
    } finally {
      signal.removeEventListener('abort', aborted);
      await file?.close();
      stream.destroy?.();
    }
    const jpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const png = signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((!jpeg && !png) || (type === 'image/png' && !png) || (['image/jpeg', 'image/jpg'].includes(type) && !jpeg)) {
      throw new FrameoError('IMAGE_FORMAT_UNSUPPORTED');
    }
    const filename = path.join(directory, jpeg ? 'photo.jpg' : 'photo.png');
    await fs.rename(temporary, filename);
    return filename;
  }
  async #sendSource(peer, sourceFactory, options, signal) {
    await this.#load();
    peer = this.#ensurePeer(peer);
    await this.ready;
    const directory = await createPrivateDirectory('source');
    try {
      await fs.chmod(directory, 0o700);
      const filename = await deadline(async downloadSignal => {
        const source = await sourceFactory(downloadSignal);
        return this.#writeImage(source, directory, downloadSignal);
      }, this.#downloadTimeoutMs, signal);
      return await this.#sendFile(peer, filename, options, signal);
    } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#mediaIndex.clear();
    this.#activeController?.abort();
    for (const task of this.#queue.splice(0)) { clearTimeout(task.timer); task.signal?.removeEventListener('abort', task.aborted); task.reject(abortError()); }
    this.#closing = (async () => {
      await this.ready.catch(() => {});
      await this.#idle;
      await Promise.allSettled([...this.#prepared.keys()].map(handle => this.disposePrepared(handle)));
    })();
    return this.#closing;
  }
}

module.exports = { FrameoEngine, FrameoError, SETTINGS_KEY, validatePairCode, validateMediaId, runEngineProcess };
