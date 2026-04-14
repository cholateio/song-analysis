# Multi-language Lyrics Implementation Plan (v2: two columns)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single keyed `lyrics` JSONB column with two dedicated columns `lyrics_jp` and `lyrics_tw`. The analyzer always attempts both `ja` and `zh-TW` and writes whichever were found; each column is independently nullable. The `--langs` flag from the v1 design is removed.

**Architecture:** `fetchCaptions(info)` drops its `langs` parameter and always returns `{jp, tw, errors}`. `src/db.mjs` maps new row fields `lyricsJp` and `lyricsTw` to the new columns (and also absorbs a pre-existing uncommitted `TABLE` rename `'KAF'` → `'Songs'`). `analyzer.mjs` drops all `--langs` handling and populates the new row fields. `supabase-schema.sql` is updated to reflect the new DDL.

**Tech Stack:** Node 20, `minimist`, `@supabase/supabase-js`, Supabase `jsonb` columns (schema migration is operator-run, not scripted).

**Testing posture:** Repo has no test framework. Spec mandates manual end-to-end verification against real YouTube URLs. Do not add Jest/Vitest. Do not write unit test files.

**Prerequisite:** Operator must drop and recreate the `"Songs"` table with the new DDL before running verification. This is called out in Task 5.

---

## File Structure

- **Modify** `supabase-schema.sql` — replace `lyrics jsonb,` with `lyrics_jp jsonb,\n  lyrics_tw jsonb,`. Nothing else in the DDL changes.
- **Modify** `src/db.mjs` — includes the already-pending `TABLE` constant rename (`'KAF'` → `'Songs'`) plus new column mappings in `upsertSong`.
- **Modify** `src/youtube.mjs` — `fetchCaptions(info)` returns `{jp, tw, errors}`. Only this function changes.
- **Modify** `analyzer.mjs` — remove `--langs` everywhere; new captions block; new row field names.
- **No changes** to `src/audio.mjs`, `package.json`, `analyzer.mjs`'s audio pipeline, or anything in `virtual-clock-example/`.

Starting state of the branch (before this task):
- Branch: `feat/multilang-lyrics`
- HEAD: `7badb38 fix: update --list-captions text to --langs`
- Working tree: `src/db.mjs` has one unstaged change (`KAF` → `Songs`), which this plan intentionally absorbs into the new commit.

---

## Task 1: Update `supabase-schema.sql` for the two-column DDL

**Files:**
- Modify: `supabase-schema.sql`

- [ ] **Step 1: Replace the `lyrics` column with two columns**

Open `supabase-schema.sql` and change the column list inside `create table if not exists "Songs" (...)`. Replace:

```sql
  metadata      jsonb       not null,
  lyrics        jsonb,
  analysis      jsonb       not null,
```

with:

```sql
  metadata      jsonb       not null,
  lyrics_jp     jsonb,
  lyrics_tw     jsonb,
  analysis      jsonb       not null,
```

Do not touch any other line of the file. The header comment, the `id` column, the unique constraint on `video_id`, the index on `updated_at`, and every other column must stay exactly as they were.

- [ ] **Step 2: Sanity-check**

Run: `grep -n "lyrics" supabase-schema.sql`
Expected: two hits, one for `lyrics_jp` and one for `lyrics_tw`. No bare `lyrics jsonb` line should remain.

- [ ] **Step 3: Do not commit yet**

All four files in this plan ship in a single atomic commit at the end of Task 4.

---

## Task 2: Simplify `fetchCaptions` in `src/youtube.mjs`

**Files:**
- Modify: `src/youtube.mjs` (current `fetchCaptions` starts around line 85)

- [ ] **Step 1: Replace `fetchCaptions` with the two-language version**

In `src/youtube.mjs`, locate the current `export async function fetchCaptions(info, langs) { ... }` (the v1 multi-lang version) and replace the **entire function** with:

```js
export async function fetchCaptions(info) {
  const fetchOne = async (lang) => {
    const tracks = info.subtitles?.[lang];
    if (!Array.isArray(tracks)) return { cues: null };
    const track = tracks.find(t => t.ext === 'vtt');
    if (!track) return { cues: null };
    try {
      const res = await fetch(track.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vtt = await res.text();
      const cues = parseVtt(vtt);
      return { cues: cues.length > 0 ? cues : null };
    } catch (err) {
      return { cues: null, error: `${lang}: ${err.message}` };
    }
  };

  const [jaResult, twResult] = await Promise.all([
    fetchOne('ja'),
    fetchOne('zh-TW'),
  ]);

  const errors = [];
  if (jaResult.error) errors.push(jaResult.error);
  if (twResult.error) errors.push(twResult.error);

  return {
    jp: jaResult.cues,
    tw: twResult.cues,
    errors,
  };
}
```

Do **not** touch `parseVtt`, `listCaptionSources`, `parseVideoId`, `fetchMetadata`, `spawnAudioPipeline`, or any imports.

- [ ] **Step 2: Sanity-check for stale references**

Run: `grep -nE "fetchCaptions\(info, |cuesByLang|foundLangs|\\blangs\\b" src/youtube.mjs`
Expected: no matches. If any show up inside `fetchCaptions`, fix before moving on.

- [ ] **Step 3: Do not commit yet**

---

## Task 3: Update `src/db.mjs` for the new columns (and absorb the `TABLE` rename)

**Files:**
- Modify: `src/db.mjs`

- [ ] **Step 1: Confirm the pre-existing `TABLE` rename is in place**

Run: `grep -n "^const TABLE" src/db.mjs`
Expected: exactly one line showing `const TABLE = 'Songs';`. If it still says `'KAF'`, change it to `'Songs'` now.

- [ ] **Step 2: Replace the `upsertSong` payload**

Locate the current `upsertSong` function and its `payload` object. Replace the `payload` construction so it reads:

```js
  const payload = {
    video_id:     row.videoId,
    title:        row.title,
    artist:       row.artist,
    release_date: row.releaseDate,
    metadata:     row.metadata,
    lyrics_jp:    row.lyricsJp,
    lyrics_tw:    row.lyricsTw,
    analysis:     row.analysis,
    updated_at:   new Date().toISOString(),
  };
```

The only difference vs. the current version is: the single `lyrics: row.lyrics,` line is removed and `lyrics_jp: row.lyricsJp,` + `lyrics_tw: row.lyricsTw,` are inserted in the same position. Everything else — `getClient`, `exists`, the `onConflict` upsert call — stays exactly as-is.

- [ ] **Step 3: Sanity-check**

Run: `grep -nE "\\blyrics\\b" src/db.mjs`
Expected: no matches. (Both occurrences should now be `lyrics_jp` or `lyrics_tw`; word-boundary `\b` excludes those.)

- [ ] **Step 4: Do not commit yet**

---

## Task 4: Rewire `analyzer.mjs` and commit everything

**Files:**
- Modify: `analyzer.mjs`

- [ ] **Step 1: Update the `USAGE` string**

Replace the existing `USAGE` constant with:

```js
const USAGE = `Usage: node analyzer.mjs --url "<youtube-url-or-id>" [--force] [--dry-run] [--list-captions]

Flags
  --url            YouTube URL in any form, or a raw 11-char video ID  (required)
  --force          Reprocess even if video_id already exists in "Songs"
  --dry-run        Run the full pipeline, skip the Supabase upsert
  --list-captions  Print available caption sources for this video and exit
  --help           Show this message

Captions
  The analyzer always tries YouTube's official "ja" and "zh-TW" tracks in
  parallel. Each track found is stored in its own column ("lyrics_jp" and
  "lyrics_tw"). Auto-transcribed captions are never used. If neither track
  exists, both columns are left null and audio analysis is still saved.
`;
```

- [ ] **Step 2: Update the `minimist` configuration**

Replace the existing `minimist(process.argv.slice(2), { ... })` call with:

```js
  const argv = minimist(process.argv.slice(2), {
    string: ['url'],
    boolean: ['force', 'dry-run', 'help', 'list-captions'],
    alias: { h: 'help' },
  });
```

The `string` array no longer contains `'langs'`, and the `default` object is removed entirely.

- [ ] **Step 3: Remove the v1 `langs` parsing block**

Delete the block immediately after `if (!argv.url) fail(...)` that currently reads:

```js
  const langs = String(argv.langs)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (langs.length === 0) fail(`--langs must contain at least one language\n\n${USAGE}`);
```

Remove all five lines. Nothing replaces them here; the new captions logic is in Step 5.

- [ ] **Step 4: Update the `--list-captions` explanatory text**

Find the two `log(...)` lines inside the `if (listOnly) { ... }` block that currently read:

```js
    log(`The analyzer only uses "Official" tracks matching --langs exactly. Auto-transcribed`);
    log(`tracks are shown for reference but are never used (quality is too poor for lyrics).`);
```

Replace them with:

```js
    log(`The analyzer only uses "Official" "ja" and "zh-TW" tracks. Auto-transcribed`);
    log(`tracks are shown for reference but are never used (quality is too poor for lyrics).`);
```

- [ ] **Step 5: Replace the captions-fetch block**

Find the v1 block (the one containing `let cuesByLang = {}; try { const result = await fetchCaptions(info, langs); …`) and replace it with:

```js
  let jp = null;
  let tw = null;
  try {
    const result = await fetchCaptions(info);
    jp = result.jp;
    tw = result.tw;
    for (const errMsg of result.errors) {
      logWarn(`captions: ${errMsg}`);
    }
  } catch (err) {
    logWarn(`captions: fetch failed (${err.message}), continuing without lyrics`);
  }
  const found = [];
  if (jp) found.push(`ja (${jp.length} cues)`);
  if (tw) found.push(`zh-TW (${tw.length} cues)`);
  if (found.length > 0) {
    logOk(`captions: ${found.join(', ')}`);
  } else {
    logWarn(`captions: no official ja or zh-TW tracks; lyrics will be null`);
  }
```

- [ ] **Step 6: Update the `row` construction**

Locate the `row = { ... }` object literal. Replace the current `lyrics: …` line with two sibling fields in the same position:

```js
    lyricsJp: jp,
    lyricsTw: tw,
```

Every other property of `row` (`videoId`, `title`, `artist`, `releaseDate`, `metadata`, `analysis`) must stay exactly as it was.

- [ ] **Step 7: Smoke-check for stale references**

Run:

```bash
grep -nE "argv\.langs|cuesByLang|foundLangs|\\blyrics\\b:" analyzer.mjs src/youtube.mjs src/db.mjs
```

Expected: **no matches**. Any hit on `argv.langs`, `cuesByLang`, `foundLangs`, or a bare `lyrics:` object property means a stale reference survived — fix before moving on.

Also run:

```bash
grep -n "\\-\\-langs" analyzer.mjs
```

Expected: **no matches**. The flag name must appear nowhere in the file.

- [ ] **Step 8: Run `--help` as a syntax check**

Run: `node analyzer.mjs --help`
Expected: prints the new USAGE, contains the word `--url` and `--force` but not `--langs`, exits 0.

- [ ] **Step 9: Commit all four files together**

```bash
git add supabase-schema.sql src/db.mjs src/youtube.mjs analyzer.mjs
git commit -m "refactor: split lyrics into lyrics_jp and lyrics_tw columns"
```

Do **not** stage any other file. Do **not** include `virtual-clock-example/`. Do **not** amend the previous commit.

- [ ] **Step 10: Verify commit contents**

Run: `git show --stat HEAD`
Expected: exactly four files changed — `analyzer.mjs`, `src/db.mjs`, `src/youtube.mjs`, `supabase-schema.sql`. No more, no fewer.

Run: `git status`
Expected: working tree clean except for the untracked `virtual-clock-example/` directory.

---

## Task 5: Operator manual verification (handed to the human)

**Files:** none (runtime verification)

Before this task can run, the operator must drop and recreate the `"Songs"` table in Supabase with the new DDL. The agent cannot do this — it requires DB credentials and destroys data.

- [ ] **Step 1: Operator drops and recreates the table**

In the Supabase SQL editor:

```sql
drop table if exists "Songs";
```

then open `supabase-schema.sql` and run the `create table` block it contains (which now has `lyrics_jp` and `lyrics_tw`). Confirm with:

```sql
select column_name, data_type
from information_schema.columns
where table_name = 'Songs'
order by ordinal_position;
```

Expected: rows include `lyrics_jp` and `lyrics_tw`, both `jsonb`. No `lyrics` column.

- [ ] **Step 2: Verify the ja-only case**

```bash
node analyzer.mjs --url "<ja-only video URL>" --force
```

Expected console line: `✓ captions: ja (N cues)`. SQL check:

```sql
select (lyrics_jp is not null) as has_jp,
       (lyrics_tw is not null) as has_tw
from "Songs"
where video_id = '<video_id>';
```

Expected: `has_jp = true`, `has_tw = false`.

- [ ] **Step 3: Verify the ja + zh-TW case**

```bash
node analyzer.mjs --url "<ja+zh-TW video URL>" --force
```

Expected console line: `✓ captions: ja (N cues), zh-TW (M cues)`.

```sql
select (lyrics_jp is not null) as has_jp,
       (lyrics_tw is not null) as has_tw,
       lyrics_jp -> 0 as first_jp_cue,
       lyrics_tw -> 0 as first_tw_cue
from "Songs"
where video_id = '<video_id>';
```

Expected: both booleans `true`; both first-cue objects shaped `{s,d,t}` with non-empty `t`.

- [ ] **Step 4: Verify the "neither" case**

```bash
node analyzer.mjs --url "<no-official-captions video URL>" --force
```

Expected console line: `! captions: no official ja or zh-TW tracks; lyrics will be null`, followed by `✓ upserted to "Songs"`, exit 0.

```sql
select (lyrics_jp is null) as jp_null,
       (lyrics_tw is null) as tw_null
from "Songs"
where video_id = '<video_id>';
```

Expected: both `true`.

- [ ] **Step 5: No commit**

Verification produces no file changes. If any step fails, return to Tasks 2–4, fix, re-run Task 5 from the top.

---

## Self-review notes

- **Spec coverage:** DDL change (Task 1), simplified `fetchCaptions` return shape (Task 2), db.mjs column mappings + `TABLE` rename absorption (Task 3), analyzer rewire with `--langs` removed (Task 4), three-scenario verification (Task 5).
- **Atomic commit:** Tasks 1–4 intentionally defer committing until every file is ready, because changing any one of them in isolation leaves the branch broken (e.g. Task 2's `fetchCaptions` shape is incompatible with v1's analyzer).
- **No orphan v1 artifacts:** the grep in Task 4 Step 7 catches `cuesByLang`, `foundLangs`, `argv.langs`, and bare `lyrics:` properties — the four signatures most likely to survive a sloppy refactor.
- **Unrelated `src/db.mjs` change absorbed:** The `TABLE = 'KAF'` → `'Songs'` edit was an unrelated in-flight change; the user explicitly authorized rolling it into this commit.
