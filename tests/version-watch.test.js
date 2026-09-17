// Tests for the deploy watcher.
//
// The whole point is that it reloads a kiosk nobody ever touches — so the two
// things worth pinning are that it DOES reload when a deploy lands, and that it
// never does so at a moment that would throw away somebody's half-finished
// checkout.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readVersionTag, createVersionWatcher } from '../js/version-watch.js';

function fakeFetch(sequence) {
  const calls = [];
  const queue = [...sequence];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next.ok ?? true,
      headers: { get: (name) => next.headers?.[name.toLowerCase()] ?? null },
    };
  };
  return { impl, calls };
}

function setup(sequence, { safe = true } = {}) {
  const { impl, calls } = fakeFetch(sequence);
  const reloads = [];
  const watcher = createVersionWatcher({
    url: 'index.html',
    fetchImpl: impl,
    reload: () => reloads.push(true),
    isSafeToReload: () => (typeof safe === 'function' ? safe() : safe),
  });
  return { watcher, reloads, calls };
}

// ---------------------------------------------------------------------------
// reading the tag
// ---------------------------------------------------------------------------
test('readVersionTag asks for headers only and bypasses the cache', async () => {
  const { impl, calls } = fakeFetch([{ headers: { etag: '"abc"' } }]);

  await readVersionTag('index.html', impl);

  assert.equal(calls[0].options.method, 'HEAD', 'the body is never needed');
  assert.equal(
    calls[0].options.cache,
    'no-store',
    'a cached answer would defeat the only thing this check does',
  );
});

test('readVersionTag falls back to Last-Modified when there is no ETag', async () => {
  const { impl } = fakeFetch([{ headers: { 'last-modified': 'Wed, 17 Sep 2026 10:00:00 GMT' } }]);
  assert.equal(await readVersionTag('index.html', impl), 'Wed, 17 Sep 2026 10:00:00 GMT');
});

test('readVersionTag returns null when the server stamps neither header', async () => {
  const { impl } = fakeFetch([{ headers: {} }]);
  assert.equal(await readVersionTag('index.html', impl), null);
});

test('readVersionTag returns null on a non-ok response', async () => {
  const { impl } = fakeFetch([{ ok: false, headers: { etag: '"abc"' } }]);
  assert.equal(await readVersionTag('index.html', impl), null);
});

// ---------------------------------------------------------------------------
// the watcher
// ---------------------------------------------------------------------------
test('the first check records the running version and reloads nothing', async () => {
  const { watcher, reloads } = setup([{ headers: { etag: '"v1"' } }]);

  assert.equal(await watcher.check(), 'first-seen');
  assert.equal(reloads.length, 0, 'booting is not a deploy');
});

test('an unchanged tag does nothing, however often it is polled', async () => {
  const { watcher, reloads } = setup([{ headers: { etag: '"v1"' } }]);

  await watcher.check();
  assert.equal(await watcher.check(), 'unchanged');
  assert.equal(await watcher.check(), 'unchanged');
  assert.equal(reloads.length, 0);
});

test('a changed tag reloads when the kiosk is idle', async () => {
  const { watcher, reloads } = setup([{ headers: { etag: '"v1"' } }, { headers: { etag: '"v2"' } }]);

  await watcher.check();
  assert.equal(await watcher.check(), 'reloaded');
  assert.equal(reloads.length, 1);
});

test('a changed tag NEVER reloads mid-flow, and stays pending until it can', async () => {
  // Reloading during a checkout throws away a half-typed name; during a return
  // it throws away ticked items. Both are worse than running old code briefly.
  let safe = false;
  const { watcher, reloads } = setup(
    [{ headers: { etag: '"v1"' } }, { headers: { etag: '"v2"' } }],
    { safe: () => safe },
  );

  await watcher.check();
  assert.equal(await watcher.check(), 'deferred');
  assert.equal(reloads.length, 0, 'must not interrupt somebody mid-task');

  safe = true;
  assert.equal(await watcher.check(), 'reloaded');
  assert.equal(reloads.length, 1);
});

test('a deferred deploy is remembered even once the tag reads as current again', async () => {
  // The kiosk booted on v1 and v2 is live. If the check that spots it lands
  // during a checkout, the watcher must not forget: `booted` still says v1, so
  // every later poll keeps reporting a pending reload rather than settling.
  let safe = false;
  const { watcher, reloads } = setup(
    [{ headers: { etag: '"v1"' } }, { headers: { etag: '"v2"' } }],
    { safe: () => safe },
  );

  await watcher.check();
  await watcher.check();
  assert.equal(await watcher.check(), 'deferred');

  safe = true;
  assert.equal(await watcher.check(), 'reloaded');
});

test('a network failure is not a deploy', async () => {
  // A kiosk on flaky back-of-house wifi must not reload itself every time a
  // request fails — it should just keep running.
  const { impl } = fakeFetch([new Error('offline')]);
  const reloads = [];
  const watcher = createVersionWatcher({
    fetchImpl: impl,
    reload: () => reloads.push(true),
    isSafeToReload: () => true,
  });

  assert.equal(await watcher.check(), 'unreachable');
  assert.equal(reloads.length, 0);
});

test('a server that stamps no validator is a no-op rather than a reload loop', async () => {
  const { watcher, reloads } = setup([{ headers: {} }]);

  assert.equal(await watcher.check(), 'no-tag');
  assert.equal(await watcher.check(), 'no-tag');
  assert.equal(reloads.length, 0);
});
