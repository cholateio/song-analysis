# Multi-language Lyrics — Design

## Goal

Let the frontend switch lyrics between Japanese (`ja`) and Traditional Chinese
(`zh-TW`) without re-querying the analyzer. The `ja` track remains the default
the frontend falls back to when the user's preferred language is absent.

## Non-goals

- Machine translation (YouTube auto-translate, AI models, etc.). Only
  human-uploaded official caption tracks are used.
- Backfilling historical rows. The existing `Songs` table will be wiped and
  re-ingested; there is no migration script.
- Deprecation shims for the old `--lang` flag. It is removed outright.

## Storage shape

`lyrics` stays in the existing `jsonb` column but changes from an array to an
object keyed by BCP-47 language tag:

```json
{
  "ja":    [{ "s": 12.45, "d": 2.1, "t": "..." }],
  "zh-TW": [{ "s": 12.50, "d": 2.0, "t": "..." }]
}
```

- Languages that were not found are **absent** keys (not `null` values).
- If *no* requested language produced cues, the whole `lyrics` column is
  `null` — same as today. Analysis still runs and is still upserted.
- Frontend reads `lyrics[userLang] ?? lyrics.ja` and treats `null` as "no
  lyrics available."

No SQL migration is needed: the column is already `jsonb`, and the table is
being wiped before the first run under the new schema.

## CLI

The `--lang` flag (single value, defaulted to `ja`) is replaced by `--langs`,
a comma-separated list with default `ja,zh-TW`.

```
node analyzer.mjs --url "..."                    # tries ja + zh-TW (default)
node analyzer.mjs --url "..." --langs ja         # ja only
node analyzer.mjs --url "..." --langs ja,zh-TW,en
```

- Unknown languages are not validated against a whitelist; whatever the caller
  passes is looked up in `info.subtitles[lang]`. If the track is absent, the
  language is simply skipped.
- Order in `--langs` does not matter for storage (the result is a keyed object)
  but it does determine the order of the `captions:` log line.
- `--list-captions` is unaffected. It still prints what YouTube exposes.

## Fetch logic (`src/youtube.mjs`)

`fetchCaptions(info, preferredLang)` becomes `fetchCaptions(info, langs)`:

- **Input:** `langs` is an array of BCP-47 strings (e.g. `["ja","zh-TW"]`).
- **Behavior:** for each lang, look up `info.subtitles[lang]`, pick the `vtt`
  variant, fetch it, and run it through the existing `parseVtt`. Fetches run
  in parallel via `Promise.all` since they are independent HTTP GETs. A
  fetch/parse failure for one language does **not** abort the others; the
  failed language is logged as a warning and omitted from the result.
- **Output:**
  ```js
  {
    cuesByLang: { ja: [...], "zh-TW": [...] }, // only langs that produced cues
    sources:    ["official:ja", "official:zh-TW"], // parallel to cuesByLang keys
  }
  ```
  If nothing was found, `cuesByLang` is an empty object and `sources` is `[]`.
- Automatic (machine-generated) captions are still ignored, matching today's
  behavior. Only `info.subtitles[lang]` is consulted.

`listCaptionSources` is unchanged.

## Analyzer integration (`analyzer.mjs`)

- Parse `--langs` with `minimist` (`string: ['langs']`, default
  `'ja,zh-TW'`), then split on commas and trim.
- Call `fetchCaptions(info, langs)`.
- Assign `row.lyrics = Object.keys(cuesByLang).length ? cuesByLang : null`.
- Replace the single `captions: …` log line with one of:
  - `captions: ja (42 cues), zh-TW (40 cues)` — when at least one language
    yielded cues,
  - `captions: no official tracks in ja,zh-TW; lyrics will be null` — when
    none did.
- Fetch errors are still caught around `fetchCaptions` the same way they are
  today; a total failure ends with `lyrics: null`.

## DB (`src/db.mjs`)

No changes. `upsertSong` passes `row.lyrics` straight through to the `jsonb`
column regardless of whether it is an object, `null`, or (temporarily) an
array.

## Verification

Before declaring the work done, run the analyzer against three real videos
and inspect the resulting rows:

1. A ja-only video (official `ja` track, no `zh-TW`). Expect
   `lyrics = { ja: [...] }`.
2. A video with both official `ja` and official `zh-TW` tracks. Expect
   `lyrics = { ja: [...], "zh-TW": [...] }`.
3. A video with no official tracks in either language. Expect
   `lyrics = null`, analysis still upserted, exit code `0`.

No new unit test files are added; the VTT parser and CLI arg parsing are
already exercised end-to-end by these runs, and the repo has no existing test
suite to extend.

## Out of scope / future work

- Adding more languages (`en`, `ko`, etc.) — already supported by the
  `--langs` list, no further work needed beyond passing them in.
- Frontend language-picker UI.
- Translating via an LLM when no official track exists.
