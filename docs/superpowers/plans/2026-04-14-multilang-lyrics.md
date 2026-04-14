# Multi-language Lyrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store YouTube lyrics keyed by language (`ja`, `zh-TW`, …) so the frontend can switch languages without re-ingesting, while keeping `ja` as the fallback default.

**Architecture:** `fetchCaptions` changes from single-lang to a parallel multi-lang fetch that returns `{cuesByLang, sources, errors}`. The analyzer's `--lang` flag is replaced by `--langs` (CSV, default `ja,zh-TW`). `row.lyrics` becomes an object keyed by BCP-47 language tag, or `null` when nothing was found. Only human-uploaded official captions are used — auto-captions are still ignored.

**Tech Stack:** Node 20, `minimist` CLI parsing, `@supabase/supabase-js`, existing `parseVtt` utility, Supabase `jsonb` column (no schema migration needed).

**Testing posture:** This repo has no unit test framework and the spec explicitly calls for manual verification instead. Every code task ends with a manual end-to-end run against real YouTube URLs; do not add Jest/Vitest/etc.

---

## File Structure

- **Modify** `src/youtube.mjs` — `fetchCaptions(info, langs)` new signature, parallel per-language fetch, per-language error isolation. `parseVtt`, `listCaptionSources`, and the audio pipeline are untouched.
- **Modify** `analyzer.mjs` — `--langs` flag wiring, log output, `row.lyrics` assignment. `preflight`, `makeProgressReporter`, and audio analysis are untouched.
- **No changes** to `src/db.mjs`, `src/audio.mjs`, `supabase-schema.sql`, or `package.json`.

Note the repo currently has uncommitted changes in `src/db.mjs` per `git status`. **Do not touch `src/db.mjs`** as part of this plan — those changes are unrelated.

---

## Task 1: Wipe the existing `Songs` table

**Why first:** The storage shape for `lyrics` is changing from an array to an object. Any pre-existing rows carry the old shape; the spec decided (option D during brainstorming) to wipe rather than migrate. Doing this before the code change keeps the database and code in sync at every step.

**Files:** none (operator action in Supabase SQL editor)

- [ ] **Step 1: Run the truncate in the Supabase SQL editor**

Open the Supabase project → SQL editor, paste and run:

```sql
truncate table "Songs";
```

Expected: "Success. No rows returned."

- [ ] **Step 2: Verify the table is empty**

In the same SQL editor:

```sql
select count(*) from "Songs";
```

Expected: `count = 0`.

No git commit — this task touches no files.

---

## Task 2: Update `fetchCaptions` to accept a list of languages

**Files:**
- Modify: `src/youtube.mjs` (current `fetchCaptions` at lines 85–95)

- [ ] **Step 1: Replace the body of `fetchCaptions` with a parallel multi-lang version**

Open `src/youtube.mjs` and replace the existing `fetchCaptions` function (currently starting with `export async function fetchCaptions(info, preferredLang)`) with this:

```js
export async function fetchCaptions(info, langs) {
  const results = await Promise.all(
    langs.map(async (lang) => {
      const tracks = info.subtitles?.[lang];
      if (!Array.isArray(tracks)) return { lang, cues: null };
      const track = tracks.find(t => t.ext === 'vtt');
      if (!track) return { lang, cues: null };
      try {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const vtt = await res.text();
        const cues = parseVtt(vtt);
        return { lang, cues };
      } catch (err) {
        return { lang, cues: null, error: err.message };
      }
    })
  );

  const cuesByLang = {};
  const sources = [];
  const errors = [];
  for (const r of results) {
    if (r.cues && r.cues.length > 0) {
      cuesByLang[r.lang] = r.cues;
      sources.push(`official:${r.lang}`);
    } else if (r.error) {
      errors.push(`${r.lang}: ${r.error}`);
    }
  }
  return { cuesByLang, sources, errors };
}
```

Key behaviors to double-check after editing:
- The function now takes an **array** `langs`, not a single string.
- Per-language fetch failures go into `errors`; they do **not** throw — the caller decides how loud to be.
- A language with zero parsed cues is treated as "not found" (same as the old code treating `parseVtt` returning `[]` as content-less).
- Automatic captions are still never consulted; only `info.subtitles[lang]` is read.

- [ ] **Step 2: Sanity-check imports and sibling exports**

Scan the rest of `src/youtube.mjs` and confirm:
- `parseVtt` is still exported (unchanged) and is what `fetchCaptions` calls.
- `listCaptionSources` is still exported and unchanged.
- No other file in the repo imports `fetchCaptions` except `analyzer.mjs` (Task 3 updates that caller).

Run:

```bash
grep -rn "fetchCaptions" src analyzer.mjs
```

Expected: two hits — the definition in `src/youtube.mjs` and the call site in `analyzer.mjs` that we'll fix in Task 3.

- [ ] **Step 3: Do not commit yet**

We will commit Tasks 2 and 3 together, because `analyzer.mjs` still calls the old single-lang signature. Committing now would leave `main` in a broken state.

---

## Task 3: Rewire `analyzer.mjs` for `--langs` and keyed lyrics

**Files:**
- Modify: `analyzer.mjs` (USAGE string around lines 12–23, `minimist` call around lines 77–82, captions block around lines 126–139, row construction around lines 150–169)

- [ ] **Step 1: Update the `USAGE` string**

Replace the existing `USAGE` constant (currently describing `--lang ja`) with:

```js
const USAGE = `Usage: node analyzer.mjs --url "<youtube-url-or-id>" [--langs ja,zh-TW] [--force] [--dry-run] [--list-captions]

Flags
  --url            YouTube URL in any form, or a raw 11-char video ID  (required)
  --langs          Comma-separated caption languages to try, default "ja,zh-TW".
                   Only official (human-uploaded) subtitle tracks matching these
                   BCP-47 tags exactly are accepted. Each language found is stored
                   under its tag in the lyrics JSON (e.g. {"ja": [...], "zh-TW": [...]}).
                   If none of the requested languages has an official track, lyrics
                   will be null (analysis is still saved).
  --force          Reprocess even if video_id already exists in "Songs"
  --dry-run        Run the full pipeline, skip the Supabase upsert
  --list-captions  Print available caption sources for this video and exit
  --help           Show this message
`;
```

- [ ] **Step 2: Update the `minimist` configuration**

Find the existing `minimist(process.argv.slice(2), { ... })` block and replace it with:

```js
  const argv = minimist(process.argv.slice(2), {
    string: ['url', 'langs'],
    boolean: ['force', 'dry-run', 'help', 'list-captions'],
    default: { langs: 'ja,zh-TW' },
    alias: { h: 'help' },
  });
```

The `string` array now contains `langs` instead of `lang`, and `default.langs` replaces `default.lang`.

- [ ] **Step 3: Parse `--langs` into an array**

Immediately after the existing `if (!argv.url) fail(...)` guard near the top of `main`, add:

```js
  const langs = String(argv.langs)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (langs.length === 0) fail(`--langs must contain at least one language\n\n${USAGE}`);
```

- [ ] **Step 4: Rewrite the captions-fetch block**

Replace the current block (the one containing `let cues = null; let captionSource = 'none'; try { const result = await fetchCaptions(info, argv.lang); …`) with:

```js
  let cuesByLang = {};
  try {
    const result = await fetchCaptions(info, langs);
    cuesByLang = result.cuesByLang;
    for (const errMsg of result.errors) {
      logWarn(`captions: ${errMsg}`);
    }
  } catch (err) {
    logWarn(`captions: fetch failed (${err.message}), continuing without lyrics`);
  }
  const foundLangs = Object.keys(cuesByLang);
  if (foundLangs.length > 0) {
    const parts = foundLangs.map(l => `${l} (${cuesByLang[l].length} cues)`);
    logOk(`captions: ${parts.join(', ')}`);
  } else {
    logWarn(`captions: no official tracks in ${langs.join(',')}; lyrics will be null`);
  }
```

- [ ] **Step 5: Update `row.lyrics`**

Find the `row = { …, lyrics: cues, analysis: analysis.frames, };` object literal and change the `lyrics:` line from `lyrics: cues,` to:

```js
    lyrics: foundLangs.length > 0 ? cuesByLang : null,
```

Leave every other property of `row` (videoId, title, metadata, analysis) exactly as it was.

- [ ] **Step 6: Smoke-check the file for stale references**

Run:

```bash
grep -nE "argv\.lang\b|preferredLang|captionSource|result\.cues\b" analyzer.mjs src/youtube.mjs
```

Expected: **no matches**. If any line still references `argv.lang` (singular), `captionSource`, `preferredLang`, or `result.cues` (the old single-array shape), fix it before moving on.

- [ ] **Step 7: Run `--help` as a syntax check**

```bash
node analyzer.mjs --help
```

Expected: the new `USAGE` text prints, the word `--langs` appears, the word `--lang ` (singular, with trailing space) does **not** appear, exit code 0.

- [ ] **Step 8: Commit Tasks 2 and 3 together**

```bash
git add src/youtube.mjs analyzer.mjs
git commit -m "feat: multi-language lyrics via --langs (ja,zh-TW default)"
```

Do **not** stage `src/db.mjs` — it has unrelated uncommitted work per the repo's `git status`.

---

## Task 4: Manual end-to-end verification

**Files:** none (runtime verification against real YouTube videos and Supabase)

The spec calls out three scenarios that must be verified before declaring the feature done. Pick one URL for each scenario. Good starter candidates:

- **ja-only:** most original Japanese music videos on large label channels (e.g. YOASOBI, Ado) ship a human-uploaded `ja` track but no `zh-TW`.
- **ja + zh-TW:** some cover/translation channels or lyric-video reuploads add an official `zh-TW` track alongside `ja`.
- **neither:** any short clip with only auto-captions.

Use `--list-captions` on a candidate to confirm which official tracks it actually has before running the full pipeline:

```bash
node analyzer.mjs --url "<candidate-url>" --list-captions
```

- [ ] **Step 1: Verify the ja-only case**

```bash
node analyzer.mjs --url "<ja-only video URL>" --force
```

Expected console output includes a line like:

```
✓ captions: ja (NN cues)
```

Then in the Supabase SQL editor:

```sql
select video_id, jsonb_typeof(lyrics) as lyrics_type,
       jsonb_object_keys(lyrics) as langs
from "Songs"
where video_id = '<video_id>';
```

Expected: `lyrics_type = 'object'`, one row with `langs = 'ja'`.

- [ ] **Step 2: Verify the ja + zh-TW case**

```bash
node analyzer.mjs --url "<ja+zh-TW video URL>" --force
```

Expected console output:

```
✓ captions: ja (NN cues), zh-TW (MM cues)
```

(Order reflects the default `--langs ja,zh-TW`; both entries must be present.)

SQL check:

```sql
select video_id, jsonb_object_keys(lyrics) as lang
from "Songs"
where video_id = '<video_id>'
order by lang;
```

Expected: exactly two rows, `lang = 'ja'` and `lang = 'zh-TW'`. Spot-check one cue of each:

```sql
select lyrics->'ja'->0  as first_ja_cue,
       lyrics->'zh-TW'->0 as first_zhtw_cue
from "Songs"
where video_id = '<video_id>';
```

Expected: both values are objects shaped `{"s": …, "d": …, "t": "…"}` with non-empty `t`.

- [ ] **Step 3: Verify the "neither" case**

```bash
node analyzer.mjs --url "<no-official-captions video URL>" --force
```

Expected console output includes:

```
! captions: no official tracks in ja,zh-TW; lyrics will be null
```

followed later by `✓ upserted to "Songs"` and exit code 0.

SQL check:

```sql
select lyrics is null as lyrics_null
from "Songs"
where video_id = '<video_id>';
```

Expected: `lyrics_null = true`.

- [ ] **Step 4: Verify `--langs` override still works**

```bash
node analyzer.mjs --url "<ja+zh-TW video URL>" --force --langs ja
```

Expected: console shows `captions: ja (NN cues)` only; SQL confirms only the `ja` key is present in `lyrics` for that row.

- [ ] **Step 5: No extra commit**

Verification produces no file changes. If any step failed, return to Task 2 or 3, fix the bug, and re-run **all** of Task 4 from the top before calling the feature done.

---

## Self-review notes

- **Spec coverage:** schema shape (Task 3 step 5), CLI flag replacement (Task 3 steps 1–3), parallel multi-lang fetch with per-language error isolation (Task 2 step 1), log-line format both found/not-found (Task 3 step 4), wipe rather than migrate (Task 1), manual verification of all three required scenarios (Task 4 steps 1–3). The `--langs ja` override in Task 4 step 4 additionally exercises the flag's non-default path.
- **No unused helpers left behind:** `fetchCaptions` returns `sources`/`errors` alongside `cuesByLang`; the analyzer consumes `cuesByLang` and `errors`, and `sources` is left as a forward-compatible extra (handy if a future `--verbose` log wants it). This is intentional, not a dead field.
- **Order safety:** Task 2 leaves `main` in a broken state on purpose; Task 3 step 8 is the first commit, which fixes both files in a single atomic change.
