# generate-urls.mjs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `generate-urls.mjs` — a Node CLI that scrapes a YouTube channel via `yt-dlp`, filters/categorizes uploads, and writes a `<url> <genre>` text file consumable by `batch.mjs`.

**Architecture:** Single-file Node script at repo root. Pure helpers (`classify`, `shouldSkip`, `parseEntries`) are named exports so a sibling `generate-urls.test.mjs` can unit-test them via Node's built-in `node:test` runner. A `main()` at the bottom runs only when the file is invoked directly.

**Tech Stack:** Node 20+, Node built-ins (`node:child_process`, `node:fs`, `node:test`, `node:assert/strict`), `minimist` (already in `package.json`), external `yt-dlp` binary on PATH.

**Spec:** [../specs/2026-04-17-generate-urls-design.md](../specs/2026-04-17-generate-urls-design.md)

---

## File Structure

- **Create:** `generate-urls.mjs` — CLI entry + named exports for pure helpers.
- **Create:** `generate-urls.test.mjs` — `node:test` unit tests for the pure helpers.
- **Modify:** `package.json` — add a `"test"` script (`node --test`) so the test suite is runnable with `npm test`.
- **Not modified:** `batch.mjs`, `analyzer.mjs` — unchanged; output is consumed by `batch.mjs` as-is.

---

## Task 1: Pure helpers `classify()` and `shouldSkip()`

**Files:**
- Create: `generate-urls.test.mjs`
- Create: `generate-urls.mjs`
- Modify: `package.json` (add test script)

- [ ] **Step 1: Add `test` script to package.json**

Edit `package.json` `scripts` block to include a test runner. Replace the existing `scripts` object with:

```json
  "scripts": {
    "analyze": "node analyzer.mjs",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write failing tests for `classify()` and `shouldSkip()`**

Create `generate-urls.test.mjs` with the following content:

```js
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
```

- [ ] **Step 3: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — cannot import from `generate-urls.mjs` (file does not exist yet).

- [ ] **Step 4: Create `generate-urls.mjs` with minimal `classify` and `shouldSkip`**

Create `generate-urls.mjs` with:

```js
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
```

- [ ] **Step 5: Run tests — expect pass**

Run: `npm test`
Expected: PASS — all 14 tests green.

- [ ] **Step 6: Commit**

```bash
git add generate-urls.mjs generate-urls.test.mjs package.json
git commit -m "feat: add classify + shouldSkip helpers for url generator"
```

---

## Task 2: `parseEntries()` — NDJSON parse + normalize + sort

**Files:**
- Modify: `generate-urls.test.mjs` (append tests)
- Modify: `generate-urls.mjs` (add export)

- [ ] **Step 1: Append failing tests for `parseEntries()`**

Append to `generate-urls.test.mjs`:

```js
import { parseEntries } from './generate-urls.mjs';

test('parseEntries: parses NDJSON and sorts oldest-first by timestamp', () => {
  const ndjson = [
    JSON.stringify({ id: 'b', title: 'B', duration: 200, timestamp: 2000 }),
    JSON.stringify({ id: 'a', title: 'A', duration: 200, timestamp: 1000 }),
    JSON.stringify({ id: 'c', title: 'C', duration: 200, timestamp: 3000 }),
  ].join('\n');
  const entries = parseEntries(ndjson);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'c']);
});

test('parseEntries: falls back to upload_date when timestamp absent', () => {
  const ndjson = [
    JSON.stringify({ id: 'x', title: 'X', duration: 200, upload_date: '20240101' }),
    JSON.stringify({ id: 'y', title: 'Y', duration: 200, upload_date: '20230101' }),
  ].join('\n');
  const entries = parseEntries(ndjson);
  assert.deepEqual(entries.map(e => e.id), ['y', 'x']);
});

test('parseEntries: ignores blank lines', () => {
  const ndjson = '\n' + JSON.stringify({ id: 'a', title: 'A', duration: 10 }) + '\n\n';
  const entries = parseEntries(ndjson);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'a');
});

test('parseEntries: entries with no ordering key go to end, stable', () => {
  const ndjson = [
    JSON.stringify({ id: 'late1', title: 'L1', duration: 200 }),
    JSON.stringify({ id: 'mid', title: 'M', duration: 200, timestamp: 500 }),
    JSON.stringify({ id: 'late2', title: 'L2', duration: 200 }),
  ].join('\n');
  const entries = parseEntries(ndjson);
  assert.deepEqual(entries.map(e => e.id), ['mid', 'late1', 'late2']);
});

test('parseEntries: malformed JSON line is skipped (not thrown)', () => {
  const ndjson = [
    JSON.stringify({ id: 'a', title: 'A', duration: 200, timestamp: 1 }),
    'NOT JSON',
    JSON.stringify({ id: 'b', title: 'B', duration: 200, timestamp: 2 }),
  ].join('\n');
  const entries = parseEntries(ndjson);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b']);
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test`
Expected: FAIL — `parseEntries` is not exported.

- [ ] **Step 3: Implement `parseEntries()`**

Add to `generate-urls.mjs` (after `shouldSkip`):

```js
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
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npm test`
Expected: PASS — all 19 tests green.

- [ ] **Step 5: Commit**

```bash
git add generate-urls.mjs generate-urls.test.mjs
git commit -m "feat: parse and sort yt-dlp NDJSON entries"
```

---

## Task 3: yt-dlp integration + CLI + output writing

**Files:**
- Modify: `generate-urls.mjs` (add `main()`, `runYtDlp()`, auto-invoke at bottom)

- [ ] **Step 1: Add `runYtDlp()` and `main()` to `generate-urls.mjs`**

Append to `generate-urls.mjs`:

```js
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
```

- [ ] **Step 2: Re-run the existing test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all 19 tests still green (the new code paths aren't exercised by unit tests, but the import graph must still load).

- [ ] **Step 3: Dry-run sanity check (help-ish)**

Run: `node generate-urls.mjs --channel https://www.youtube.com/@virtual_kaf/videos --out /tmp/test-out.txt`
Expected: script executes, writes a non-empty `/tmp/test-out.txt`, stderr shows the `Done: kept N, skipped M ...` summary.

If yt-dlp is slow/rate-limited, abort with Ctrl+C — this step's purpose is only to confirm the CLI wiring works end-to-end (no crash, summary printed, file written). Save the full output verification for Task 4.

- [ ] **Step 4: Commit**

```bash
git add generate-urls.mjs
git commit -m "feat: yt-dlp integration, CLI, and output writing for generate-urls"
```

---

## Task 4: End-to-end smoke test against `@virtual_kaf`

**Files:**
- No code changes expected. This task verifies behavior against the real target channel and amends earlier tasks only if bugs are found.

- [ ] **Step 1: Run against the real channel**

Run: `node generate-urls.mjs`
Expected:
- Exits 0.
- Writes `urls-virtual_kaf.txt` at repo root.
- Stderr shows a `Done: kept N, skipped M (short: X, no-duration: Y, trailer: Z, live: W), total fetched T` line.

- [ ] **Step 2: Spot-check the output**

Read the first 5 and last 5 lines of `urls-virtual_kaf.txt`. Verify:
- Each line matches `https://www.youtube.com/watch?v=<11 chars> (cover|kafu|collab|album)`.
- Upload order: the first entries are older than the last entries (check by eyeballing 2–3 video IDs on YouTube if uncertain).
- No line contains `Trailer` or `Live Ver` in the ID itself (sanity: shouldn't be possible, but easy to confirm).

- [ ] **Step 3: Confirm `batch.mjs` accepts the file**

Run: `node batch.mjs urls-virtual_kaf.txt --dry-run`
Expected: `batch.mjs` prints `Found N entries in urls-virtual_kaf.txt` and invokes the analyzer with `--dry-run` for each line without parse errors. (It is acceptable if individual analyzer dry-runs report their own failures — we only need `batch.mjs` itself to parse the file cleanly.)

- [ ] **Step 4: Decide on committing the generated file**

`urls-virtual_kaf.txt` is a generated artifact. Do NOT commit it by default — it will change every time the channel publishes a new video. If the user explicitly wants it committed, add it separately; otherwise add it to `.gitignore`:

```bash
echo "urls-virtual_kaf.txt" >> .gitignore
git add .gitignore
git commit -m "chore: ignore generated urls-virtual_kaf.txt"
```

- [ ] **Step 5: If any bugs were found in Steps 1–3**

Fix them by amending whichever earlier task's code owns the bug, extend the unit tests in `generate-urls.test.mjs` to cover the regression, re-run `npm test`, and commit each fix as its own `fix: ...` commit. Do not squash fixes into prior `feat:` commits.

---

## Self-Review

- **Spec coverage:**
  - CLI `--channel` / `--out` with defaults → Task 3.
  - `yt-dlp --flat-playlist --dump-json` spawn → Task 3 (`runYtDlp`).
  - NDJSON parse → Task 2 (`parseEntries`).
  - Sort oldest→newest via `timestamp` w/ `upload_date` fallback → Task 2.
  - Skip `duration < 120`, missing duration, `Trailer`, `Live Ver` → Task 1 (`shouldSkip`).
  - Categorize cover > kafu > collab > album → Task 1 (`classify`).
  - Emit `https://www.youtube.com/watch?v=<id> <genre>` → Task 3 (`main`).
  - Overwrite output file → Task 3 (`writeFileSync`).
  - yt-dlp ENOENT / non-zero exit handling → Task 3 (`runYtDlp`).
  - Malformed JSON → warn + continue → Task 2.
  - Missing duration → skip + warn → Task 1 (`shouldSkip` returns `no-duration`), counted in Task 3 summary.
  - Missing timestamp → stable-append + warn → Task 2.
  - Summary stderr line → Task 3.
  - `batch.mjs` compatibility verified → Task 4 Step 3.

- **Placeholder scan:** No `TBD` / `TODO` / "fill in details". Every code step has complete runnable code. Every verification step has an exact command and expected output.

- **Type consistency:**
  - `shouldSkip` returns `{ skip: true, reason }` or `{ skip: false }` — consistent across Task 1 tests, Task 1 implementation, and Task 3 consumer (which reads `s.skip` / `s.reason`).
  - `reason` values are `'short' | 'no-duration' | 'trailer' | 'live'` — matches the `reasons` keys in `main()`.
  - `parseEntries` returns an array of raw yt-dlp entry objects with `id`, `title`, `duration`, `timestamp`, `upload_date` — `main()` consumes only those fields.
  - `classify(title)` takes a string — `main()` passes `e.title ?? ''` to guard against undefined titles.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-generate-urls.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
