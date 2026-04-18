#!/usr/bin/env node
// Dry-run title inspector. For each URL in the given list file, fetches only
// the YouTube title via yt-dlp (no audio download, no DB write, no analysis)
// and runs it through parseTitle(). Prints the rewrite result per row and a
// summary of unmatched titles at the end, so new 花譜 naming patterns can be
// spotted BEFORE committing to a full `batch.mjs --force` re-analysis.
//
// Usage:
//   node lint-titles.mjs [path-to-url-list]
//   node lint-titles.mjs urls-virtual_kaf.txt > titles-report.txt
//
// Default path: urls-virtual_kaf.txt
// Output markers:
//   [OK] rewritten    — parseTitle matched and changed the title
//   [==] no-op        — parseTitle matched but output equals input (already clean)
//   [!!] unmatched    — no rule fired; original title kept, needs a new rule
//   [ER] fetch error  — yt-dlp failed for this URL (private/removed/etc.)

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseVideoId, fetchMetadata } from './src/youtube.mjs';
import { parseTitle } from './src/title.mjs';

const CONCURRENCY = 4;

function parseUrlFile(path) {
  const text = readFileSync(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [url, tag] = line.split(/\s+/);
      return { url, tag: tag || null };
    });
}

async function inspectOne({ url, tag }) {
  const videoId = parseVideoId(url);
  if (!videoId) return { videoId: null, url, tag, error: 'could not parse video ID' };
  try {
    const info = await fetchMetadata(videoId);
    const parsed = parseTitle(info.title);
    return { videoId, url, tag, raw: info.title, parsed };
  } catch (err) {
    return { videoId, url, tag, error: err.message };
  }
}

async function mapConcurrent(items, concurrency, worker, onTick) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]);
      if (onTick) onTick(i + 1, items.length);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const path = process.argv[2] || 'urls-virtual_kaf.txt';
  const items = parseUrlFile(path);
  process.stderr.write(`fetching titles for ${items.length} URLs (concurrency ${CONCURRENCY})...\n`);

  let done = 0;
  const results = await mapConcurrent(items, CONCURRENCY, inspectOne, (n, total) => {
    done = n;
    if (n % 10 === 0 || n === total) {
      process.stderr.write(`  ${n}/${total}\n`);
    }
  });

  const unmatched = [];
  const errors = [];
  let rewritten = 0;
  let noop = 0;

  for (const r of results) {
    if (r.error) {
      errors.push(r);
      console.log(`[ER] ${(r.videoId ?? '???????????').padEnd(11)}  ${r.error}`);
      continue;
    }
    const { raw, parsed } = r;
    if (!parsed.matched) {
      unmatched.push(r);
      console.log(`[!!] ${r.videoId}  ${raw}`);
    } else if (parsed.title === raw) {
      noop++;
      console.log(`[==] ${r.videoId}  ${raw}`);
    } else {
      rewritten++;
      console.log(`[OK] ${r.videoId}  ${raw}  →  ${parsed.title}`);
    }
  }

  console.log('');
  console.log('--- summary ---');
  console.log(`  total:     ${results.length}`);
  console.log(`  rewritten: ${rewritten}`);
  console.log(`  no-op:     ${noop}`);
  console.log(`  unmatched: ${unmatched.length}`);
  console.log(`  errors:    ${errors.length}`);

  if (unmatched.length) {
    console.log('');
    console.log(`=== ${unmatched.length} unmatched titles (need a new rule or accept as-is) ===`);
    for (const r of unmatched) {
      console.log(`  [${r.videoId}] ${r.raw}`);
    }
  }

  if (errors.length) {
    console.log('');
    console.log(`=== ${errors.length} fetch errors ===`);
    for (const r of errors) {
      console.log(`  ${r.url}  —  ${r.error}`);
    }
  }

  process.exit(unmatched.length > 0 || errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`fatal: ${err.message}\n`);
  process.exit(2);
});
