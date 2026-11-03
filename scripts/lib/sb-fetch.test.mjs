import test from 'node:test';
import assert from 'node:assert/strict';
import { sbFetch, RETRYABLE_STATUS, DEFAULT_BACKOFF_MS } from './sb-fetch.mjs';

const res = (status, body = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body || '{}'),
});

// Never sleep for real in tests; record the backoff schedule instead.
function harness(responses, opts = {}) {
  const calls = [], delays = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls, delays,
    run: () => sbFetch('https://x/rest/v1/t', {}, {
      fetchImpl, sleep: async ms => { delays.push(ms); }, onRetry: null, ...opts,
    }),
  };
}

test('returns a 2xx on the first try without retrying', async () => {
  const h = harness([res(200, '[]')]);
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.delays, []);
});

test('retries a PGRST002 503 and returns the eventual success', async () => {
  const pgrst002 = '{"code":"PGRST002","message":"Could not query the database for the schema cache. Retrying."}';
  const h = harness([res(503, pgrst002), res(503, pgrst002), res(200, '[]')]);
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [1000, 4000]);   // fast first, then a long tail
});

test('retries transport errors too', async () => {
  const h = harness([new Error('fetch failed'), res(200, '[]')]);
  const r = await h.run();
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 2);
});

test('gives up after `attempts` and returns the last response for the caller to report', async () => {
  const h = harness([res(503), res(503), res(503)], { attempts: 3 });
  const r = await h.run();
  assert.equal(r.status, 503);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.delays, [1000, 4000]);
});

test('rethrows when every attempt failed at the transport layer', async () => {
  const h = harness([new Error('ECONNRESET'), new Error('ECONNRESET')], { attempts: 2 });
  await assert.rejects(h.run(), /ECONNRESET/);
});

test('does not retry a 4xx — a bad request will never succeed', async () => {
  const h = harness([res(400, 'bad filter')]);
  const r = await h.run();
  assert.equal(r.status, 400);
  assert.equal(h.calls.length, 1);
  assert.equal(RETRYABLE_STATUS.has(400), false);
});

test('a 409 upsert conflict is not retried', async () => {
  const h = harness([res(409, 'duplicate key')]);
  const r = await h.run();
  assert.equal(r.status, 409);
  assert.equal(h.calls.length, 1);
});

test('the backoff outlasts a multi-minute stall, not just a schema-cache reload', () => {
  // 2026-09-05: the shared instance was unreachable for ~8 minutes and answered
  // every request with a 504 after 135-180 s. The original 1/2/4/8 s schedule
  // spent its whole budget inside that and gave up. Anything under two minutes
  // is not a retry policy against this instance, it's a shrug.
  const total = DEFAULT_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.ok(total >= 120_000, `backoff totals ${total}ms, too short to cross a stall`);
  // The first wait still has to be short: a PGRST002 schema-cache reload really
  // does clear in a second or two, and that is the common case.
  assert.ok(DEFAULT_BACKOFF_MS[0] <= 2_000);
});

test('every request carries a timeout so a hung socket cannot hold the job open', async () => {
  const h = harness([res(200, '[]')]);
  await h.run();
  assert.ok(h.calls[0].init.signal instanceof AbortSignal);
});
