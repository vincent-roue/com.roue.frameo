'use strict';

const TTL_MS = 30000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 8;
const PEER = /^[a-f0-9]{64}$/;

// Only immutable decimal IDs of visible photos are retained. The conservative
// budget includes string/array overhead; it is not a measurement of total RAM.
class MediaIndexCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now; this.entries = new Map(); this.epochs = new Map(); this.bytes = 0;
    this.counters = { hits: 0, misses: 0, loads: 0, evictions: 0, invalidations: 0 };
  }
  drop(peer) {
    const entry = this.entries.get(peer);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(peer); }
  }
  prune() { for (const [peer, entry] of this.entries) if (entry.expiresAt <= this.now()) this.drop(peer); }
  capture(peer, scope) {
    if (typeof peer !== 'string' || !PEER.test(peer) || typeof scope !== 'string' || scope.length > 160) throw new TypeError('Invalid media index scope');
    let epoch = this.epochs.get(peer);
    if (!epoch) {
      epoch = {}; this.epochs.set(peer, epoch);
      while (this.epochs.size > 64) this.epochs.delete(this.epochs.keys().next().value);
    }
    return { peer, scope, epoch };
  }
  current(token) { return this.epochs.get(token.peer) === token.epoch; }
  get(peer, scope) {
    this.prune(); const entry = this.entries.get(peer);
    if (!entry || entry.scope !== scope) { this.counters.misses++; return null; }
    this.entries.delete(peer); this.entries.set(peer, entry); this.counters.hits++;
    return entry.ids;
  }
  put(token, ids) {
    if (!this.current(token)) return false;
    this.counters.loads++; this.prune(); this.drop(token.peer);
    const bytes = 512 + token.scope.length * 2 + ids.length * 96;
    if (bytes > MAX_BYTES || ids.length > 10000) return false;
    while (this.entries.size >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) {
      this.drop(this.entries.keys().next().value); this.counters.evictions++;
    }
    this.entries.set(token.peer, { scope: token.scope, ids: Object.freeze(ids.slice()), bytes, expiresAt: this.now() + TTL_MS });
    this.bytes += bytes; return true;
  }
  invalidate(peer) {
    if (typeof peer !== 'string' || !PEER.test(peer.toLowerCase())) return;
    peer = peer.toLowerCase(); this.drop(peer); this.epochs.set(peer, {}); this.counters.invalidations++;
    while (this.epochs.size > 64) this.epochs.delete(this.epochs.keys().next().value);
  }
  clear() { this.entries.clear(); this.epochs.clear(); this.bytes = 0; }
  stats() {
    this.prune();
    return { entries: this.entries.size, bytes: this.bytes, maxBytes: MAX_BYTES, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS, ...this.counters };
  }
}

module.exports = { MediaIndexCache, TTL_MS, MAX_BYTES, MAX_ENTRIES };
