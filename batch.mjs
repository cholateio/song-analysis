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
// Usage:  node batch.mjs urls.txt [--force] [--dry-run]
//
// Extra flags are forwarded to analyzer.mjs as-is.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const txtFile = args.find(a => !a.startsWith('-'));
const flags = args.filter(a => a.startsWith('-'));

if (!txtFile) {
  console.error('Usage: node batch.mjs <urls.txt> [--force] [--dry-run]');
  process.exit(1);
}

const lines = readFileSync(txtFile, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

console.log(`Found ${lines.length} entries in ${txtFile}\n`);

let ok = 0;
let fail = 0;

for (let i = 0; i < lines.length; i++) {
  const parts = lines[i].split(/\s+/);
  const url = parts[0];
  const genre = parts[1] || null;

  const label = genre ? `${url}  [${genre}]` : url;
  console.log(`[${i + 1}/${lines.length}] ${label}`);

  const cmdArgs = ['analyzer.mjs', '--url', url, ...flags];
  if (genre) cmdArgs.push('--genre', genre);

  try {
    execFileSync('node', cmdArgs, {
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
    });
    ok++;
  } catch {
    fail++;
    console.error(`  ↑ failed, continuing...\n`);
  }
  console.log();
}

console.log(`Done: ${ok} succeeded, ${fail} failed out of ${lines.length}`);
