import assert from 'node:assert/strict';
import { BoundedTTLCache } from '../src/main/gateway/BoundedTTLCache';

let now = 0;
const cache = new BoundedTTLCache<string, number | undefined>({ maxEntries: 2, ttlMs: 10, now: () => now });
for (const maxEntries of [0, -1, 1.5, Infinity, NaN]) {
  assert.throws(() => new BoundedTTLCache({ maxEntries, ttlMs: 10 }), RangeError);
}
for (const ttlMs of [0, -1, Infinity, NaN]) {
  assert.throws(() => new BoundedTTLCache({ maxEntries: 1, ttlMs }), RangeError);
}
cache.set('one', 1).set('two', undefined);
assert.equal(cache.get('one'), 1);
assert.equal(cache.has('two'), true, 'undefined is a legitimate cached value');
assert.equal(cache.size, 2);
cache.set('three', 3);
assert.equal(cache.has('one'), false, 'reads do not promote old entries or prevent capacity eviction');
assert.equal(cache.has('two'), true);
assert.equal(cache.get('three'), 3);
now = 5;
cache.set('two', 2); // Updating renews lifetime and moves to the newest insertion.
cache.set('four', 4);
assert.equal(cache.has('three'), false);
assert.equal(cache.get('two'), 2);
now = 15;
assert.equal(cache.has('two'), true, 'the TTL boundary remains inclusive for the existing gateway guard');
now = 16;
assert.equal(cache.get('two'), undefined);
assert.equal(cache.has('two'), false);
assert.equal(cache.has('four'), false);
assert.equal(cache.size, 0);
cache.set('recent', 9);
now = 20;
assert.equal(cache.get('recent'), 9);
now = 27;
assert.equal(cache.has('recent'), false, 'reads do not extend TTL');
cache.set('deleted', 1);
assert.equal(cache.delete('deleted'), true);
assert.equal(cache.delete('deleted'), false);
cache.set('clear', 1); cache.clear();
assert.equal(cache.size, 0);
const bounded = new BoundedTTLCache<number, number>({ maxEntries: 1024, ttlMs: 10, now: () => now });
for (let i = 0; i < 100_000; i++) bounded.set(i, i);
assert.equal(bounded.size, 1024);
assert.equal(bounded.has(98_975), false);
assert.equal(bounded.get(98_976), 98_976);
now += 11;
assert.equal(bounded.get(99_999), undefined);
for (let i = 100_000; i < 102_000; i++) bounded.set(i, i);
assert.equal(bounded.size, 1024, 'idle expiry followed by new arrivals cannot exceed resident bounds');
assert.equal(bounded.get(101_999), 101_999);
console.log('PASS BoundedTTLCache: bounded residence, FIFO, renewal order, inclusive TTL, lazy expiry and sustained ingress');
