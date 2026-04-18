#!/usr/bin/env node
// Reads a text file of YouTube URLs (one per line) and runs analyzer.mjs on
// each sequentially. Each line can optionally include a genre tag after the URL,
// separated by whitespace:
//
//   https://www.youtube.com/watch?v=jpwy7kP8Pps cover
//   https://www.youtube.com/watch?v=y4sHBySTCzk album1
//   https://youtu.be/abc12345678
//
// Blank lines and lines starting with # are skipped.
//
// Usage:  node batch.mjs urls.txt [--force] [--dry-run] [--sleep <sec>] [--no-retry]
//
// Rate-limit resilience (geared toward unattended overnight runs):
//   --sleep <sec>   Sleep this many seconds between songs. Default 15, ±5s
//                   random jitter. Set 0 to disable.
//   --no-retry      Disable the automatic single retry after a failed song.
//                   By default, any failed song sleeps 90s and is retried
//                   once before giving up.
//
// Failed URLs (after all retries) are appended to batch-failed-<ts>.txt in
// the cwd so you can re-run them later without editing the main list.
//
// Any flag not recognized here is forwarded to analyzer.mjs as-is.

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BATCH_FLAGS = new Set(['--sleep', '--no-retry']);

function parseArgs(argv) {
  const out = { txtFile: null, sleep: 15, retry: true, forward: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sleep') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) {
        console.error('--sleep requires a non-negative number');
        process.exit(1);
      }
      out.sleep = v;
    } else if (a === '--no-retry') {
      out.retry = false;
    } else if (a.startsWith('-')) {
      out.forward.push(a);
    } else if (!out.txtFile) {
      out.txtFile = a;
    } else {
      console.error(`unexpected positional arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise(r => setTimeout(r, ms));
}

function jitter(seconds) {
  if (seconds <= 0) return 0;
  const ms = seconds * 1000;
  return ms + (Math.random() - 0.5) * Math.min(10_000, ms * 0.6);
}

function runAnalyzer(url, genre, forwardFlags) {
  const cmdArgs = ['analyzer.mjs', '--url', url, ...forwardFlags];
  if (genre) cmdArgs.push('--genre', genre);
  execFileSync('node', cmdArgs, {
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
}

async function main() {
  const { txtFile, sleep: sleepSec, retry, forward } = parseArgs(process.argv.slice(2));
  if (!txtFile) {
    console.error('Usage: node batch.mjs <urls.txt> [--force] [--dry-run] [--sleep <sec>] [--no-retry]');
    process.exit(1);
  }

  const lines = readFileSync(txtFile, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  console.log(`Found ${lines.length} entries in ${txtFile}`);
  console.log(`Sleep between songs: ${sleepSec}s (±jitter); retry-on-fail: ${retry ? 'on (90s pause)' : 'off'}\n`);

  const failedLog = `batch-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    const url = parts[0];
    const genre = parts[1] || null;

    const label = genre ? `${url}  [${genre}]` : url;
    console.log(`[${i + 1}/${lines.length}] ${label}`);

    let succeeded = false;
    try {
      runAnalyzer(url, genre, forward);
      succeeded = true;
    } catch {
      if (retry) {
        console.error(`  ↑ failed, sleeping 90s then retrying once...\n`);
        await sleep(90_000);
        try {
          runAnalyzer(url, genre, forward);
          succeeded = true;
        } catch {
          // fall through to failure branch
        }
      }
    }

    if (succeeded) {
      ok++;
    } else {
      fail++;
      console.error(`  ↑ failed, recording to ${failedLog}\n`);
      appendFileSync(failedLog, `${lines[i]}\n`);
    }
    console.log();

    const isLast = i === lines.length - 1;
    if (!isLast && sleepSec > 0) {
      const ms = jitter(sleepSec);
      await sleep(ms);
    }
  }

  console.log(`Done: ${ok} succeeded, ${fail} failed out of ${lines.length}`);
  if (fail > 0) console.log(`Failed URLs written to ${failedLog} — retry with: node batch.mjs ${failedLog} --force`);
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(2);
});
