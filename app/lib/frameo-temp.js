'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const APP = 'com.roue.frameo';
const MARKER = '.frameo-owner.json';
const PREFIXES = Object.freeze({
  upload: 'homey-frameo-upload-com.roue.frameo-',
  preview: 'homey-frameo-preview-com.roue.frameo-',
  source: 'homey-frameo-com.roue.frameo-source-',
});
const identityKey = Symbol.for('com.roue.frameo.temporary-process-token');
if (typeof globalThis[identityKey] !== 'string') globalThis[identityKey] = randomUUID();
const processToken = globalThis[identityKey];
const recovering = new Map();

function kindFor(name) {
  for (const [kind, prefix] of Object.entries(PREFIXES)) {
    if (name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) return kind;
  }
  return null;
}

function ownerAlive(owner) {
  // A new process can reuse the same PID after an app/container restart.
  // All instances in this process share a token, including duplicate requires.
  if (owner.pid === process.pid) return owner.processToken === processToken;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function createPrivateDirectory(kind, { tmpdir = os.tmpdir() } = {}) {
  if (!Object.hasOwn(PREFIXES, kind)) throw new TypeError('Unsupported temporary file kind');
  const root = path.resolve(tmpdir);
  const directory = await fs.mkdtemp(path.join(root, PREFIXES[kind]));
  if (path.dirname(path.resolve(directory)) !== root) throw new Error('Invalid temporary directory');
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, MARKER), JSON.stringify({
      app: APP, version: 1, kind, pid: process.pid, processToken, createdAt: Date.now(),
    }), { flag: 'wx', mode: 0o600 });
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }
}

async function recoverOne(root, { maxDirectories = 8, budgetMs = 250 } = {}) {
  const stats = { scanned: 0, removed: 0, failed: 0, live: 0, unknown: 0,
    budgetExhausted: false, remainingUnknown: false };
  const started = Date.now();
  let directory;
  try { directory = await fs.opendir(root); }
  catch (error) { if (error?.code === 'ENOENT') return stats; throw error; }
  try {
    for await (const entry of directory) {
      if (stats.removed >= maxDirectories || Date.now() - started >= budgetMs) {
        stats.budgetExhausted = true; stats.remainingUnknown = true; break;
      }
      stats.scanned++;
      const kind = kindFor(entry.name);
      if (!kind || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.resolve(root, entry.name);
      if (path.dirname(candidate) !== root) { stats.unknown++; continue; }
      let owner;
      try {
        const stat = await fs.lstat(candidate);
        const marker = path.join(candidate, MARKER), markerStat = await fs.lstat(marker);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !markerStat.isFile() || markerStat.isSymbolicLink()
          || markerStat.size < 1 || markerStat.size > 1024) { stats.unknown++; continue; }
        owner = JSON.parse(await fs.readFile(marker, 'utf8'));
        if (owner?.app !== APP || owner.version !== 1 || owner.kind !== kind
          || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647
          || typeof owner.processToken !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner.processToken)
          || !Number.isSafeInteger(owner.createdAt) || owner.createdAt < 0) { stats.unknown++; continue; }
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code) || error instanceof SyntaxError) stats.unknown++;
        else stats.failed++;
        continue;
      }
      if (ownerAlive(owner)) { stats.live++; continue; }
      try {
        // Both the app namespace and a valid ownership marker are mandatory.
        // Unmarked legacy folders, symlinks and all user files are preserved.
        const latest = await fs.lstat(candidate);
        if (!latest.isDirectory() || latest.isSymbolicLink()) { stats.unknown++; continue; }
        await fs.rm(candidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        stats.removed++;
      } catch (error) { if (error?.code !== 'ENOENT') stats.failed++; }
    }
  } finally { await directory.close().catch(() => {}); }
  return stats;
}

function recoverPrivateDirectories({ tmpdir = os.tmpdir(), maxDirectories = 8, budgetMs = 250 } = {}) {
  const root = path.resolve(tmpdir);
  if (!Number.isInteger(maxDirectories) || maxDirectories < 1 || maxDirectories > 8
    || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 250) return Promise.reject(new TypeError('Invalid recovery budget'));
  // Engine and uploader startup may overlap. Share this scan; never race two
  // recursive removals or count the same recovery twice within a pass.
  if (recovering.has(root)) return recovering.get(root);
  const task = recoverOne(root, { maxDirectories, budgetMs }).finally(() => {
    if (recovering.get(root) === task) recovering.delete(root);
  });
  recovering.set(root, task);
  return task;
}

module.exports = { createPrivateDirectory, recoverPrivateDirectories };
