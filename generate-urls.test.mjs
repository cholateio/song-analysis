import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, shouldSkip } from './generate-urls.mjs';

test('classify: 歌ってみた → cover', () => {
  assert.equal(classify('【可不】ロキ 歌ってみた'), 'cover');
});

test('classify: 試著唱了 → cover', () => {
  assert.equal(classify('某曲 試著唱了'), 'cover');
});

test('classify: 可不 alone → kafu', () => {
  assert.equal(classify('【可不】新曲MV'), 'kafu');
});

test('classify: 組曲 alone → collab', () => {
  assert.equal(classify('VOCALOID組曲'), 'collab');
});

test('classify: no keyword → album', () => {
  assert.equal(classify('Just a song'), 'album');
});

test('classify priority: 歌ってみた + 可不 → cover (cover wins)', () => {
  assert.equal(classify('可不 歌ってみた'), 'cover');
});

test('classify priority: 可不 + 組曲 → kafu (kafu wins over collab)', () => {
  assert.equal(classify('可不組曲'), 'kafu');
});

test('classify priority: 歌ってみた + 組曲 → cover', () => {
  assert.equal(classify('歌ってみた組曲'), 'cover');
});

test('shouldSkip: duration < 120s → skip (short)', () => {
  assert.deepEqual(shouldSkip({ duration: 60, title: 'x' }), { skip: true, reason: 'short' });
});

test('shouldSkip: duration exactly 120s → keep', () => {
  assert.deepEqual(shouldSkip({ duration: 120, title: 'x' }), { skip: false });
});

test('shouldSkip: duration null → skip (no-duration)', () => {
  assert.deepEqual(shouldSkip({ duration: null, title: 'x' }), { skip: true, reason: 'no-duration' });
});

test('shouldSkip: title contains Trailer → skip', () => {
  assert.deepEqual(shouldSkip({ duration: 300, title: 'New Album Trailer' }), { skip: true, reason: 'trailer' });
});

test('shouldSkip: title contains Live Ver → skip', () => {
  assert.deepEqual(shouldSkip({ duration: 300, title: 'Song (Live Ver.)' }), { skip: true, reason: 'live' });
});

test('shouldSkip: normal long video → keep', () => {
  assert.deepEqual(shouldSkip({ duration: 300, title: 'Normal Song' }), { skip: false });
});
