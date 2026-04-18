import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle } from './title.mjs';

test('case 1: 花譜 #NN「...」【...】 → 歌名【...】', () => {
  const r = parseTitle('花譜 #77「ソレカラ」【オリジナルMV】');
  assert.equal(r.title, 'ソレカラ【オリジナルMV】');
  assert.equal(r.matched, true);
});

test('case 2: 【音楽的同位体X】歌名 / 花譜 feat. X(Y) → 歌名【feat. X】', () => {
  const r = parseTitle('【音楽的同位体可不】モンスターガール / 花譜 feat. 可不(KAFU)');
  assert.equal(r.title, 'モンスターガール【feat. 可不】');
  assert.equal(r.matched, true);
});

test('case 3: 【組曲N】花譜×X # NN「...」【オリジナルMV】 → 歌名 /花譜×X【組曲】 (MV dropped)', () => {
  const r = parseTitle('【組曲2】花譜×崎山蒼志 # 139「抱きしめて」【オリジナルMV】');
  assert.equal(r.title, '抱きしめて /花譜×崎山蒼志【組曲】');
  assert.equal(r.matched, true);
});

test('case 4: 【歌ってみた】歌名 → 歌名【歌ってみた】', () => {
  const r = parseTitle('【歌ってみた】魔法');
  assert.equal(r.title, '魔法【歌ってみた】');
  assert.equal(r.matched, true);
});

test('trailing "covered by 花譜" is stripped before matching', () => {
  const r = parseTitle('【歌ってみた】夜に駆ける covered by 花譜');
  assert.equal(r.title, '夜に駆ける【歌ってみた】');
  assert.equal(r.matched, true);
});

test('unmatched title preserved as-is, matched=false', () => {
  const r = parseTitle('just some random title');
  assert.equal(r.title, 'just some random title');
  assert.equal(r.matched, false);
});

test('empty / whitespace input stays untouched, matched=false', () => {
  const r = parseTitle('   ');
  assert.equal(r.title, '   ');
  assert.equal(r.matched, false);
});
