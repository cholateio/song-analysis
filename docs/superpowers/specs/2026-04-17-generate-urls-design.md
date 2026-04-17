# generate-urls.mjs — Design Spec

**Date:** 2026-04-17
**Status:** Approved (pending user review of written spec)

## Purpose

Generate the input `.txt` file consumed by [batch.mjs](../../../batch.mjs) by scraping a YouTube channel's uploads. Each line of the output is `<video_url> <genre>`, ready for batch analyzer runs.

Primary target channel: `https://www.youtube.com/@virtual_kaf/videos`.

## Placement

- Script: `generate-urls.mjs` at repo root (sibling of `batch.mjs` / `analyzer.mjs`).
- Default output: `urls-virtual_kaf.txt` at repo root.
- No new npm dependencies. Uses Node built-ins (`node:child_process`, `node:fs`) + external `yt-dlp` binary on PATH.

## Inputs (CLI)

```
node generate-urls.mjs [--channel <url>] [--out <file>]
```

- `--channel <url>`: channel videos URL. Default: `https://www.youtube.com/@virtual_kaf/videos`.
- `--out <file>`: output txt path. Default: `urls-virtual_kaf.txt`.

## Data Flow

1. **Fetch metadata** — spawn:
   ```
   yt-dlp --flat-playlist --dump-json <channel_url>
   ```
   stdout is NDJSON (one JSON object per line).
2. **Parse** each line → extract `id`, `title`, `duration`, `timestamp` (fallback `upload_date`).
3. **Sort** ascending by `timestamp` (or parsed `upload_date`), so earliest videos emit first.
4. **Per-video rules** (in order):
   - **Skip** if `duration == null` OR `duration < 120` (seconds).
   - **Skip** if `title` contains substring `Trailer` or `Live Ver` (case-sensitive).
   - **Categorize** with first-match priority:
     1. title contains `歌ってみた` or `試著唱了` → `cover`
     2. title contains `可不` → `kafu`
     3. title contains `組曲` → `collab`
     4. otherwise → `album`
5. **Emit** one line per kept video: `https://www.youtube.com/watch?v=<id> <genre>\n`.
6. **Write** to the `--out` path, overwriting if it exists.

## Error Handling

- If `yt-dlp` is not on PATH or exits non-zero: print the stderr tail and exit with code 1.
- If a JSON line fails to parse: warn to stderr with the offending line, continue.
- If `duration` is missing/null on a kept-looking entry: treat as "skip" and log a warning to stderr (so the user knows coverage may be incomplete). Do NOT silently drop.
- If `timestamp` and `upload_date` are both missing: push that entry to the end of the sorted list (stable) and warn.

## Output Format

Plain UTF-8 text, LF line endings. Compatible with `batch.mjs`'s parser (whitespace-split, first token = URL, second = genre). Blank lines and `#` comments are allowed by `batch.mjs` but this script emits neither.

Example:
```
https://www.youtube.com/watch?v=aaaaaaaaaaa cover
https://www.youtube.com/watch?v=bbbbbbbbbbb kafu
https://www.youtube.com/watch?v=ccccccccccc album
https://www.youtube.com/watch?v=ddddddddddd collab
```

## Success Criteria

- Running `node generate-urls.mjs` with no args produces `urls-virtual_kaf.txt` where:
  - Every line is `<youtube url> <one of: cover|kafu|collab|album>`.
  - No line has `duration < 120` or title containing `Trailer` / `Live Ver`.
  - Lines are ordered oldest → newest.
- `node batch.mjs urls-virtual_kaf.txt --dry-run` accepts the file without parse errors.
- stderr summary at end: `Done: kept N, skipped M (short: X, no-duration: Y, trailer: Z, live: W), total fetched T. Wrote <out>.`.

## Non-Goals

- No resumption / incremental updates. Every run is a full refresh.
- No deduplication against an existing output file.
- No retrying failed yt-dlp calls — user re-runs on transient failure.
- No YouTube Data API path.
- No support for non-channel URLs (playlists, single videos).

## Open Risks

- **`--flat-playlist` field coverage.** Newer yt-dlp returns `duration` and `timestamp` for channel entries, but older versions may omit them. Mitigation: the "missing field → skip + warn" rule above makes silent data loss visible. If the user hits this in practice, we can fall back to a full (non-flat) fetch in a follow-up.
- **Substring matching is language-sensitive.** `可不` is the vocal synth's name; if a title mentions it incidentally (e.g., "可不可以") it would still match. Acceptable for this channel because `@virtual_kaf` is a Kafu-focused channel and false positives are unlikely.
