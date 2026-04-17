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
