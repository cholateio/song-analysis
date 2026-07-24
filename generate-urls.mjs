#!/usr/bin/env node
// Generates a <url> <genre> text file for batch.mjs by scraping a YouTube
// channel with yt-dlp.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import minimist from 'minimist';

export function classify(title) {
  if (title.includes('歌ってみた') || title.includes('Cover') || title.includes('covered')) return 'cover';
  if (title.includes('可不')) return 'kafu';
  if (title.includes('組曲') || title.includes('Suite')) return 'suite';
  return 'album';
}

// These clips have no studio version on the channel, so the 'Live Ver' title
// filter below would drop the song from the DB entirely. Keyed by video id
// because the channel scan and the single-video query return different-language
// titles for the same video (see docs/LESSONS.md 2026-07-20).
export const KEEP_IDS = new Set([
  'NDOJZSG9SPU', // 花譜 #36「不可解」Live Ver.
  'g8NbvGE8w6s', // 花譜 #69「まほう feat.理芽」Live Ver.
  '9BPNC-SkOd8', // 花譜 #71「雛鳥 with ヰ世界情緒」Live Ver.
  'GMK3nurbnWc', // 花譜 #73「命に嫌われている。 with 春猿火」Live Ver.
]);

// Announcement / anniversary clips, not songs. They pass every filter below
// (125-600s, no Trailer/Live Ver in the title), so without this list every
// rescan resurrects them and batch.mjs ingests them as songs.
export const DROP_IDS = new Set([
  '4il0GPyK6zg', // 花譜 #35「観測-御披露目篇-」
  'QqCM53KSLzw', // 花譜 #52「深化」
  'Z7qLxHSmKEw', // 花譜 #66「不可解弐Q1御礼」
  'YmzoLsHPgbc', // 花譜 #72「新年」
  'IpYrEWRfRbo', // 花譜 #74「1億回御礼」
  'eJ4YS4Cxg6k', // 花譜 #78「不可解弐REBUILDING -御願編-」
  '8BrhlBCIbko', // 花譜 #104「不可解参狂開催」
  '99KCXIhAS9U', // 花譜 #121「不可解参(想) -御礼-」
  'vqGo8rPOqfg', // 花譜 7周年記念動画 - メモリアル編 -
  'DH5ZzhtV2_I', // 花譜 #157「新年」
]);

export function shouldSkip({ id, duration, title }) {
  if (id != null && DROP_IDS.has(id)) return { skip: true, reason: 'dropped' };
  if (id != null && KEEP_IDS.has(id)) return { skip: false };
  if (duration == null) return { skip: true, reason: 'no-duration' };
  if (duration < 125 || duration > 600) return { skip: true, reason: 'short' };
  if (title.includes('Trailer')) return { skip: true, reason: 'trailer' };
  if (title.includes('Live Ver') || title.includes('前夜')) return { skip: true, reason: 'live' };
  return { skip: false };
}

// Converts YYYYMMDD string to a numeric sortable epoch-ish value.
function uploadDateToNum(s) {
  if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return null;
  return Number(s); // 20240101 > 20230101 works numerically.
}

function orderKey(entry) {
  if (typeof entry.timestamp === 'number') return entry.timestamp;
  const d = uploadDateToNum(entry.upload_date);
  if (d != null) return d;
  return null;
}

export function parseEntries(ndjson) {
  const raw = [];
  for (const line of ndjson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      raw.push(JSON.parse(trimmed));
    } catch {
      process.stderr.write(`warn: skipping malformed JSON line: ${trimmed.slice(0, 80)}\n`);
    }
  }
  // Stable sort: items with a key come first, sorted ascending. Items without
  // a key keep their original relative order at the end.
  const keyed = raw
    .map((e, i) => ({ e, i, k: orderKey(e) }))
    .filter(x => x.k != null)
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map(x => x.e);
  const unkeyed = raw.filter(e => orderKey(e) == null);
  if (unkeyed.length > 0) {
    process.stderr.write(`warn: ${unkeyed.length} entries lack timestamp/upload_date; appended at end\n`);
  }
  return [...keyed, ...unkeyed];
}

const DEFAULT_CHANNEL = 'https://www.youtube.com/@virtual_kaf/videos';
const DEFAULT_OUT = 'urls-virtual_kaf.txt';

function runYtDlp(channelUrl) {
  const result = spawnSync(
    'yt-dlp',
    ['--flat-playlist', '--playlist-reverse', '--dump-json', channelUrl],
    { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 },
  );
  if (result.error && result.error.code === 'ENOENT') {
    process.stderr.write('error: yt-dlp not found on PATH. Install it first.\n');
    process.exit(1);
  }
  if (result.status !== 0) {
    const tail = (result.stderr || '').split('\n').slice(-10).join('\n');
    process.stderr.write(`error: yt-dlp exited with status ${result.status}\n${tail}\n`);
    process.exit(1);
  }
  return result.stdout;
}

function main(argv) {
  const args = minimist(argv, {
    string: ['channel', 'out'],
    default: { channel: DEFAULT_CHANNEL, out: DEFAULT_OUT },
  });

  process.stderr.write(`Fetching entries from ${args.channel}...\n`);
  const ndjson = runYtDlp(args.channel);
  const entries = parseEntries(ndjson);
  process.stderr.write(`Fetched ${entries.length} entries.\n`);

  const kept = [];
  const reasons = { short: 0, 'no-duration': 0, trailer: 0, live: 0, dropped: 0 };
  for (const e of entries) {
    const s = shouldSkip({ id: e.id, duration: e.duration, title: e.title ?? '' });
    if (s.skip) {
      if (s.reason === 'no-duration') {
        process.stderr.write(`warn: skipping entry id=${e.id} (no duration field)\n`);
      }
      reasons[s.reason]++;
      continue;
    }
    const genre = classify(e.title ?? '');
    kept.push(`https://www.youtube.com/watch?v=${e.id} ${genre}`);
  }

  writeFileSync(args.out, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');

  const skipped = reasons.short + reasons['no-duration'] + reasons.trailer + reasons.live + reasons.dropped;
  process.stderr.write(
    `Done: kept ${kept.length}, skipped ${skipped} ` +
    `(short: ${reasons.short}, no-duration: ${reasons['no-duration']}, ` +
    `trailer: ${reasons.trailer}, live: ${reasons.live}, dropped: ${reasons.dropped}), ` +
    `total fetched ${entries.length}. Wrote ${args.out}.\n`,
  );
}

// Run main only when invoked as a script, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
