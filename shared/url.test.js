import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVenueUrl, venueIdFor } from './url.js';

test('normalizes and dedupes equivalent venue URLs', async () => {
  const a = normalizeVenueUrl('www.finnriver.com/farm-music-event-calendar/');
  const b = normalizeVenueUrl('https://finnriver.com/farm-music-event-calendar?utm_source=x#top');
  assert.equal(a, 'https://www.finnriver.com/farm-music-event-calendar');
  assert.equal(await venueIdFor(a), await venueIdFor(b));
});

test('rejects junk', () => {
  assert.equal(normalizeVenueUrl('javascript:alert(1)'), null);
  assert.equal(normalizeVenueUrl('localhost'), null);
  assert.equal(normalizeVenueUrl(''), null);
});
