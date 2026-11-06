'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MediaIndexCache, MAX_BYTES, MAX_ENTRIES, TTL_MS } = require('../lib/media-index-cache');
const peer = n => n.toString(16).padStart(64, '0');

test('compact metadata expires at thirty seconds without extending its age on reads', () => {
  let now = 0; const cache = new MediaIndexCache({ now: () => now });
  cache.put(cache.capture(peer(1), 'Homey'), ['1', '-9223372036854775808']);
  const value = cache.get(peer(1), 'Homey'); assert(Object.isFrozen(value));
  now = TTL_MS - 1; assert.equal(cache.get(peer(1), 'Homey'), value);
  now = TTL_MS; assert.equal(cache.get(peer(1), 'Homey'), null); assert.equal(cache.stats().bytes, 0);
});

test('metadata has one sender scope per frame, LRU entry bounds and a conservative two-MiB budget', () => {
  const cache = new MediaIndexCache();
  for (let n = 1; n <= MAX_ENTRIES; n++) cache.put(cache.capture(peer(n), 'A'), ['1']);
  cache.get(peer(1), 'A'); cache.put(cache.capture(peer(9), 'A'), ['1']);
  assert.equal(cache.get(peer(2), 'A'), null); assert(cache.get(peer(1), 'A'));
  assert.equal(cache.get(peer(1), 'B'), null);
  cache.put(cache.capture(peer(1), 'B'), ['2']); assert.equal(cache.get(peer(1), 'A'), null);
  assert.equal(cache.stats().entries, MAX_ENTRIES);
  const many = Array.from({ length: 10000 }, (_, n) => String(n));
  for (let n = 10; n < 15; n++) {
    cache.put(cache.capture(peer(n), 'A'), many);
    assert(cache.stats().bytes <= MAX_BYTES); assert(cache.stats().entries <= MAX_ENTRIES);
  }
  assert(cache.stats().evictions > 0);
});

test('an invalidated or closed index cannot be refilled by a late native list response', () => {
  const cache = new MediaIndexCache(), token = cache.capture(peer(1), 'A');
  cache.invalidate(peer(1)); assert.equal(cache.put(token, ['1']), false);
  const second = cache.capture(peer(1), 'A'); cache.clear(); assert.equal(cache.put(second, ['1']), false);
  assert.equal(cache.stats().entries, 0);
  assert.deepEqual(Object.values(cache.stats()).every(value => typeof value === 'number'), true);
  assert(!JSON.stringify(cache.stats()).includes(peer(1)));
});
