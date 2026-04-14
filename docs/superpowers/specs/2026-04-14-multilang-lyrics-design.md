# Multi-language Lyrics — Design (v2: two columns)

> **Revision history:**
> - **v1 (superseded):** single `lyrics` JSONB column keyed by BCP-47 tag, `--langs` CSV flag.
> - **v2 (current):** two dedicated columns `lyrics_jp` and `lyrics_tw`, fixed two-language scope, `--langs` flag removed.

## Goal

Store Japanese and Traditional Chinese lyrics for each song in two separate,
dedicated JSONB columns so the frontend can pick a language with a single
column read. Japanese remains the implicit default: the frontend falls back
to `lyrics_jp` when the user's preferred language is not populated.

## Non-goals

- Machine translation (YouTube auto-translate, AI models). Only
  human-uploaded official caption tracks are used.
- Any language other than Japanese (`ja`) and Traditional Chinese (`zh-TW`).
  Adding another language in the future would require a new column and is
  out of scope for this spec.
- Data migration. The user is responsible for dropping/recreating the
  `"Songs"` table with the new DDL before running the new analyzer.

## Storage shape

The `Songs` table gains two new columns and loses the old `lyrics` column:

```sql
-- old
lyrics        jsonb,

-- new
lyrics_jp     jsonb,   -- official "ja" cues, [{s,d,t},...] or null
lyrics_tw     jsonb,   -- official "zh-TW" cues, [{s,d,t},...] or null
```

- Each column is independently `null` when the video has no official track
  for that language.
- When a column is populated, it holds the same `[{s,d,t},...]` array shape
  the analyzer has always produced — no wrapper object, no language tag.
- Naming note: the column uses `jp` (country-style), not the BCP-47 tag `ja`.
  The CLI and fetch code still speak BCP-47 (`ja`, `zh-TW`) because those
  are the exact keys YouTube uses; only the storage columns differ.

`supabase-schema.sql` is updated to reflect the new DDL.

## CLI

The `--langs` flag from v1 is **removed**. The analyzer always attempts both
`ja` and `zh-TW` and never accepts a language override. The USAGE string and
`--list-captions` explanatory text are updated to describe the fixed
ja + zh-TW behavior.

```
node analyzer.mjs --url "..."           # always tries ja + zh-TW
node analyzer.mjs --url "..." --force
node analyzer.mjs --url "..." --dry-run
```

## Fetch logic (`src/youtube.mjs`)

`fetchCaptions(info)` — signature simplifies back to a single argument.
Behavior:

1. In parallel (`Promise.all`), look up `info.subtitles.ja` and
   `info.subtitles["zh-TW"]`. Only official tracks are consulted; automatic
   captions are still ignored.
2. For each, pick the `vtt` variant, fetch it, and run it through `parseVtt`.
3. A per-language fetch/parse failure is captured (not thrown); sibling
   languages are unaffected.
4. Return `{ jp, tw, errors }` where:
   - `jp`: the parsed cue array if the `ja` track was present and yielded
     at least one cue, otherwise `null`.
   - `tw`: the parsed cue array if the `zh-TW` track was present and yielded
     at least one cue, otherwise `null`.
   - `errors`: array of human-readable strings (e.g. `"ja: HTTP 503"`) for
     any per-language failures. Empty when everything succeeded or when a
     language simply had no track.
5. If both `jp` and `tw` are `null` and there are no errors, it means the
   video simply has no official ja/zh-TW tracks — caller logs it and
   continues with both columns null.

## Analyzer integration (`analyzer.mjs`)

- All `--langs` parsing, the `langs` variable, and the generic
  `cuesByLang`/`foundLangs` code from v1 are removed.
- The captions block becomes:
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
- The row passed to `upsertSong` replaces `lyrics:` with two sibling fields:
  ```js
  lyricsJp: jp,
  lyricsTw: tw,
  ```
- The `--list-captions` explanatory text is updated to reference
  "ja or zh-TW" instead of `--langs`.

## DB layer (`src/db.mjs`)

- The `TABLE` constant already needs to change from `'KAF'` to `'Songs'`
  (this was a pre-existing uncommitted change in the working tree and is
  absorbed into the same commit as the multi-lang work).
- `upsertSong` maps the new row fields to the new columns:
  ```js
  const payload = {
    video_id:    row.videoId,
    title:       row.title,
    artist:      row.artist,
    release_date: row.releaseDate,
    metadata:    row.metadata,
    lyrics_jp:   row.lyricsJp,
    lyrics_tw:   row.lyricsTw,
    analysis:    row.analysis,
    updated_at:  new Date().toISOString(),
  };
  ```
  The old `lyrics: row.lyrics` line is removed.

## Schema file (`supabase-schema.sql`)

The DDL is updated to replace `lyrics jsonb` with the two new columns.
Ordering in the file is kept for readability (new columns sit where `lyrics`
was).

## Verification

Before declaring the feature done, the operator runs three real videos and
spot-checks the rows via SQL:

1. **ja-only video** — expect `lyrics_jp` populated, `lyrics_tw` null.
2. **ja + zh-TW video** — expect both columns populated, each with a
   `[{s,d,t},...]` array.
3. **neither** — expect both columns null, analysis still upserted, exit 0.

No `--langs ja` override test is needed because the flag is removed.

## Out of scope / future work

- Frontend language-picker UI.
- Additional languages beyond ja + zh-TW.
- Translating via an LLM when no official track exists.
