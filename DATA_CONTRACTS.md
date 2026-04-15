# Data Contracts — `Songs` table reference

Canonical reference for every field written by [analyzer.mjs](analyzer.mjs) into
the Supabase `"Songs"` table. Frontend consumers should treat this file as the
source of truth for shape, types, ranges, and time alignment.

When the code and this doc disagree, the code wins and this doc is a bug —
please open a PR.

---

## 1. Table DDL

See [supabase-schema.sql](supabase-schema.sql) for the exact `CREATE TABLE` DDL.
Summary:

| Column           | Type        | Nullable | Notes |
|------------------|-------------|----------|-------|
| `id`             | uuid        | no       | PK, auto-generated |
| `video_id`       | text        | no       | unique; 11-char YouTube video ID |
| `title`          | text        | no       | YouTube title |
| `artist`         | text        | yes      | Uploader / channel name |
| `release_date`   | date        | yes      | From `release_date` or fallback `upload_date` |
| `metadata`       | jsonb       | no       | See §2 |
| `lyrics_jp`      | jsonb       | yes      | See §5 |
| `lyrics_tw`      | jsonb       | yes      | See §5 |
| `analysis`       | jsonb       | no       | See §3 |
| `clock_analysis` | jsonb       | yes      | See §4 |
| `created_at`     | timestamptz | no       | row insertion time |
| `updated_at`     | timestamptz | no       | last upsert time (analyzer writes this) |

Index: `songs_updated_at_idx on (updated_at desc)`.

---

## 2. `metadata` — JSONB object

All keys are always present on new rows. Ranges shown are post-rounding as
written by the analyzer.

```ts
type Metadata = {
  schemaVersion: 1;             // bump on breaking shape changes; see §7
  duration: number;             // song length in seconds, 3 decimal places
  fps: 60;                      // analysis frame rate, fixed at 60
  bpm: number | null;           // estimated BPM (integer 60..200) or null if detection failed
  sampleRate: 48000;            // PCM sample rate used for analysis, fixed
  bandCount: 64;                // length of analysis[i].v, fixed
  bandEdges: number[];          // length 65; bandEdges[i] and [i+1] bracket band i in Hz
  vScale: 255;                  // divide analysis[i].v[j] by this to get [0,1]
  centroidMaxHz: number;        // peak spectral centroid across the song in Hz; see §3
  clock: {
    fftSize: 256;
    binCount: 128;              // == clock_analysis[i].frequencies.length
    smoothingTimeConstant: 0.8; // AnalyserNode default
    minDecibels: -100;          // AnalyserNode default
    maxDecibels: -30;           // AnalyserNode default
    bassBinCount: 5;            // use this many bins when deriving clock bass client-side
  };
};
```

**`bandEdges`**: 65 logarithmically-spaced Hz values from 20 Hz to 16000 Hz.
`bandEdges[i]` is the low edge of band `i`, `bandEdges[i+1]` is its high edge.
Use this when you need to map a physical frequency range (e.g. "bass = 20–250 Hz")
to `v[]` indices — see §3.

**`duration`** is derived from PCM sample count / `sampleRate` (not from
YouTube metadata), so it reflects the actual decoded audio length.

---

## 3. `analysis[i]` — JSONB array of per-frame records

One record per frame at 60 FPS. Frame `i` corresponds to audio time
`i / fps` seconds. Total frame count:

```
totalFrames = floor((duration_sec * sampleRate - 2048) / 800) + 1
            = floor((duration_sec * 48000 - 2048) / 800) + 1
```

The `2048` is the FFT buffer size (see [src/audio.mjs](src/audio.mjs)); `800`
is `sampleRate / fps`.

### Frame shape

```ts
type AnalysisFrame = {
  v: number[];   // length 64, each element is an integer 0..255 (uint8)
  r: number;     // float in [0, 1], 3 decimal places
  c: number;     // float in [0, 1], 3 decimal places
  k: boolean;
};
```

### Field semantics

- **`v[64]`** — per-band magnitude spectrum. Each element is one of 64 log-spaced
  frequency bands (see `bandEdges` in metadata). Values are **peak-normalized
  per band across the full song**, then quantized to uint8:
  ```
  v[i][j] = round( (bin_magnitude[i][j] / max_j_across_song) * 255 )
  ```
  Divide by `metadata.vScale` (= 255) to recover a float in [0, 1]. This
  normalization is per-band, so each band independently uses its full dynamic
  range — good for spectrograms, but means you cannot recover absolute loudness
  from `v[]` alone. Use `r` for that.

- **`r`** — RMS loudness of the frame, normalized to [0, 1] against the
  song's peak RMS. Use this for "overall how loud is this moment" — drives
  bloom, camera shake, mouth opening, etc.

- **`c`** — spectral centroid in [0, 1], normalized against the song's peak
  centroid (`metadata.centroidMaxHz` is the absolute peak in Hz). High values
  = bright timbres (cymbals, sibilance, front vowels); low values = dark
  timbres (bass, round vowels). Multiply by `centroidMaxHz` to recover Hz.

- **`k`** — beat flag. `true` on the first frame of each detected beat. The
  detector is spectral-flux-based with a ~90-frame moving window threshold
  (`mean + 1.5·stddev`) and a 6-frame minimum gap between beats. First 60
  frames of any song are never beats (warmup window).

### Sampling by wall-clock time

```js
const idx = Math.min(
  song.analysis.length - 1,
  Math.floor(currentTimeSec * song.metadata.fps),
);
const frame = song.analysis[idx];
```

### Deriving legacy aggregates client-side

Earlier versions stored separate `b/m/h/vo` aggregate fields. These were
removed; re-derive from `v[]` and `bandEdges` when needed:

```js
function aggregateEnergy(frame, meta, loHz, hiHz) {
  const indices = [];
  for (let i = 0; i < meta.bandCount; i++) {
    const bandLo = meta.bandEdges[i];
    const bandHi = meta.bandEdges[i + 1];
    if (bandHi >= loHz && bandLo <= hiHz) indices.push(i);
  }
  if (indices.length === 0) return 0;
  let sum = 0;
  for (const j of indices) sum += frame.v[j] / meta.vScale;
  return sum / indices.length;
}

// Example: the ranges the project historically used
const bass  = aggregateEnergy(frame, meta,   20,   250);
const mid   = aggregateEnergy(frame, meta,  250,  4000);
const high  = aggregateEnergy(frame, meta, 4000, 15000);
const vocal = aggregateEnergy(frame, meta,  300,  3400);
```

For performance, pre-compute the `indices` arrays once at song load, not per
frame.

---

## 4. `clock_analysis[i]` — JSONB array of per-frame records

Nullable. When present, one record per frame at 60 FPS, row-aligned with
`analysis[i]` — the two arrays describe the same instant at the same index.

See [CLOCK_ANALYSIS_HANDOVER.md](CLOCK_ANALYSIS_HANDOVER.md) for the full
rationale and W3C AnalyserNode spec implementation details.

### Frame shape

```ts
type ClockFrame = {
  frequencies: number[];  // length 128, each element is an integer 0..255 (uint8)
};
```

### Field semantics

- **`frequencies[128]`** — byte-scaled magnitude spectrum exactly as
  `getByteFrequencyData()` would return from a Web Audio `AnalyserNode` with
  `fftSize = 256`, `smoothingTimeConstant = 0.8`, `minDecibels = -100`,
  `maxDecibels = -30`. Pre-smoothed by the spec's τ=0.8 EMA; **do not apply
  additional smoothing** on the client — it will feel laggy.

- **No `bass` field.** The live virtual-music-clock WebSocket payload carries
  `bass = mean(dataArray[0..4])`; offline we omit it because it is trivially
  derivable. Use:
  ```js
  const N = song.metadata.clock.bassBinCount;  // 5
  function meanBass(freq) {
    let s = 0;
    for (let i = 0; i < N; i++) s += freq[i];
    return s / N;
  }
  ```

### Null case

`clock_analysis` can be `null` on rows ingested before the feature shipped.
Treat it as "no clock data — fall back to `analysis` or skip clock visuals".
Re-run `analyzer.mjs --url <url> --force` to populate it.

---

## 5. `lyrics_jp` / `lyrics_tw` — JSONB array of caption cues

Nullable. Written only if YouTube has a matching **official** (human-uploaded)
VTT track in that language. Auto-generated captions are never stored
regardless of quality.

### Cue shape

```ts
type LyricCue = {
  s: number;     // start time in seconds, 3 decimal places
  d: number;     // duration in seconds, 3 decimal places
  t: string;     // cue text, HTML-stripped, whitespace-collapsed
};

type LyricsTrack = LyricCue[] | null;
```

### Characteristics

- **Cues are line-level** — `s` marks the start of a phrase, not of a word.
  Expect phrase durations of ~2–5 seconds, not per-syllable timing.
- Inline word-level timing markers (`<HH:MM:SS.mmm>`) that some YouTube tracks
  include are stripped in [src/youtube.mjs `parseVtt`](src/youtube.mjs).
- Cues are deduplicated when consecutive blocks repeat the same text (common
  in YouTube's rolling-caption style).
- Cues arrive in chronological order.

### Fallback policy

- `lyrics_jp` present, `lyrics_tw` null → Japanese track found, no Traditional Chinese
- `lyrics_jp` null, `lyrics_tw` present → only Traditional Chinese available
- both null → no official track in either language; song row still has audio analysis

---

## 6. Frame alignment guarantees

All three time-series columns use the same `HOP = 800` samples and the same
`totalFrames` formula. Consequences:

- `analysis[i]` and `clock_analysis[i]` describe the **same instant** at the
  same index `i`. You can read them in lockstep with a single `idx` value.
- `analysis.length === clock_analysis.length` when both are present.
- Map wall-clock time to index with `Math.floor(t * metadata.fps)` for either
  column.

Lyrics (`lyrics_jp`, `lyrics_tw`) are not frame-indexed; they carry their own
`s` / `d` in seconds and should be looked up by binary search or linear scan.

---

## 7. Schema versioning

`metadata.schemaVersion` is a single integer. Current value: **`1`**.

- **Bump on breaking changes:** removed field, changed semantics of an existing
  field, or changed normalization/quantization.
- **Do NOT bump on additive changes:** adding a new optional field to `metadata`
  or to a frame. Consumers should treat unknown fields as non-breaking and
  missing optional fields as "feature absent".
- Consumers SHOULD check `metadata.schemaVersion` on load and warn or fail if
  they encounter an unexpected major version.
- Old rows ingested before `schemaVersion` existed will have this field
  missing — treat missing as `schemaVersion: 1` for rows that already have
  `vScale`, `centroidMaxHz`, and the uint8 `v[]` shape; earlier rows are
  considered unsupported and should be re-ingested.

Planned future versions (see [LIP_SYNC_PLAN.md](LIP_SYNC_PLAN.md)) will add
fields like `rVoc` and `voc` to analysis frames — those are additive and do
NOT bump the version.

---

## 8. Size estimates

### `analysis` column — per frame

Each frame serializes to approximately **~290 bytes** of JSON:
`{"v":[v0,v1,...,v63],"r":0.xxx,"c":0.xxx,"k":false}` where each `v[j]` is 1–3
digits plus a comma.

Total per song:

```
frames ≈ floor((duration_sec * 48000 - 2048) / 800) + 1
bytes  ≈ frames * 290
```

- 3 min ≈ 10,800 frames ≈ 3.1 MB raw JSON
- 4 min ≈ 14,400 frames ≈ 4.2 MB raw JSON
- 8 min ≈ 28,800 frames ≈ 8.3 MB raw JSON
- 12 min ≈ 43,200 frames ≈ 12.5 MB raw JSON

### `clock_analysis` column — per frame

Each frame serializes to approximately **~465 bytes** of JSON:
`{"frequencies":[v0,...,v127]}`.

- 3 min ≈ 5.0 MB raw JSON
- 4 min ≈ 6.7 MB raw JSON
- 8 min ≈ 13.4 MB raw JSON
- 12 min ≈ 20.1 MB raw JSON

### Combined row size

A 4 minute song writes a row of roughly `4.2 + 6.7 = 10.9 MB` raw JSON
(plus `metadata` + lyrics, typically < 100 KB combined). This is **above the
Supabase 10 MB row soft limit**; 5 minute+ songs may fail to upsert. If this
becomes a problem, the recommended fix is to move `clock_analysis` (and
later `analysis`) to Supabase Storage as binary blobs and keep only metadata
in the row.

Gzip over the wire roughly halves these numbers. Don't re-fetch on seek —
cache the decoded arrays in memory per song.

### Measuring exactly

Run `node analyzer.mjs --url <url> --dry-run` to get the exact row size for
a specific song without writing to the database.

---

## 9. Fetching tips

- Only `select` the columns you need. `clock_analysis` is the largest — skip
  it on pages that don't render the clock visualizer.
- `metadata` is tiny; always fetch it since it carries `vScale`, `bandEdges`,
  `fps`, and `clock.bassBinCount` which every other interpretation needs.
- Drive frame selection off your audio source's `currentTime` (YouTube iframe
  API, `<audio>` element, etc.), never a local clock — this stays in sync
  across seeks and buffering.
- Pre-compute any per-song derived lookup tables (e.g. the vocal-band indices
  from §3) once when the song loads, not every frame.
