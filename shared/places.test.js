import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOverpass } from './places.js';

test('fetchOverpass falls through busy or unreachable servers and retries', async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (calls < 5) return new Response('', { status: 504 });
    return new Response('{"elements":[]}');
  };
  assert.deepEqual(await fetchOverpass('q', { rounds: 2, retryDelayMs: 1 }), { elements: [] });
  assert.equal(calls, 5);

  globalThis.fetch = async () => new Response('', { status: 504 });
  await assert.rejects(fetchOverpass('q', { rounds: 2, retryDelayMs: 1 }), (e) => /overpass-api\.de: HTTP 504/.test(e.message) && /busy/.test(e.userMessage));
});
