import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkip, classify, KEEP_IDS, DROP_IDS } from './generate-urls.mjs';

test('allowlisted id survives the Live Ver title filter', () => {
  const r = shouldSkip({
    id: 'NDOJZSG9SPU',
    duration: 288,
    title: '花譜 #36「不可解」【オリジナルMV「不可解」Live Ver.】',
  });
  assert.equal(r.skip, false);
});

test('allowlisted id survives a localized title the filter would not match', () => {
  const r = shouldSkip({ id: 'g8NbvGE8w6s', duration: 208, title: 'KAF #69 - Mahou' });
  assert.equal(r.skip, false);
});

test('allowlisted id survives a missing duration field', () => {
  const r = shouldSkip({ id: '9BPNC-SkOd8', duration: null, title: 'whatever' });
  assert.equal(r.skip, false);
});

test('every allowlisted id is kept', () => {
  for (const id of KEEP_IDS) {
    assert.equal(shouldSkip({ id, duration: 300, title: 'Live Ver' }).skip, false, id);
  }
});

test('non-allowlisted Live Ver is still skipped', () => {
  const r = shouldSkip({ id: 'someOtherId', duration: 288, title: 'KAF「x」【Live Ver.】' });
  assert.deepEqual(r, { skip: true, reason: 'live' });
});

test('other filters are unaffected by the allowlist parameter', () => {
  assert.equal(shouldSkip({ id: 'x', duration: 60, title: 'ok' }).reason, 'short');
  assert.equal(shouldSkip({ id: 'x', duration: null, title: 'ok' }).reason, 'no-duration');
  assert.equal(shouldSkip({ id: 'x', duration: 300, title: 'Trailer' }).reason, 'trailer');
});

test('every droplisted id is skipped despite passing all other filters', () => {
  for (const id of DROP_IDS) {
    assert.deepEqual(
      shouldSkip({ id, duration: 300, title: '花譜 #NN「御礼」' }),
      { skip: true, reason: 'dropped' },
      id,
    );
  }
});

test('keep and drop lists are disjoint', () => {
  for (const id of DROP_IDS) assert.equal(KEEP_IDS.has(id), false, id);
});

test('allowlisted Live Ver titles classify as album', () => {
  assert.equal(classify('花譜 #36「不可解」【オリジナルMV「不可解」Live Ver.】'), 'album');
});
