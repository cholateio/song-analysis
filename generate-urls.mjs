#!/usr/bin/env node
// Generates a <url> <genre> text file for batch.mjs by scraping a YouTube
// channel with yt-dlp. See docs/superpowers/specs/2026-04-17-generate-urls-design.md

export function classify(title) {
  if (title.includes('歌ってみた') || title.includes('試著唱了')) return 'cover';
  if (title.includes('可不')) return 'kafu';
  if (title.includes('組曲')) return 'collab';
  return 'album';
}

export function shouldSkip({ duration, title }) {
  if (duration == null) return { skip: true, reason: 'no-duration' };
  if (duration < 120) return { skip: true, reason: 'short' };
  if (title.includes('Trailer')) return { skip: true, reason: 'trailer' };
  if (title.includes('Live Ver')) return { skip: true, reason: 'live' };
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

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import minimist from 'minimist';

const DEFAULT_CHANNEL = 'https://www.youtube.com/@virtual_kaf/videos';
const DEFAULT_OUT = 'urls-virtual_kaf.txt';

function runYtDlp(channelUrl) {
  const result = spawnSync(
    'yt-dlp',
    ['--flat-playlist', '--dump-json', channelUrl],
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
  const reasons = { short: 0, 'no-duration': 0, trailer: 0, live: 0 };
  for (const e of entries) {
    const s = shouldSkip({ duration: e.duration, title: e.title ?? '' });
    if (s.skip) {
      reasons[s.reason]++;
      continue;
    }
    const genre = classify(e.title ?? '');
    kept.push(`https://www.youtube.com/watch?v=${e.id} ${genre}`);
  }

  writeFileSync(args.out, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');

  const skipped = reasons.short + reasons['no-duration'] + reasons.trailer + reasons.live;
  process.stderr.write(
    `Done: kept ${kept.length}, skipped ${skipped} ` +
    `(short: ${reasons.short}, no-duration: ${reasons['no-duration']}, ` +
    `trailer: ${reasons.trailer}, live: ${reasons.live}), ` +
    `total fetched ${entries.length}. Wrote ${args.out}.\n`,
  );
}

// Run main only when invoked as a script, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
