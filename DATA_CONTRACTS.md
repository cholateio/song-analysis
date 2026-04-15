# Data Contracts — `Songs` table + Storage blobs reference

Canonical reference for everything [analyzer.mjs](analyzer.mjs) writes when it
ingests a YouTube song. Frontend consumers should treat this file as the single
source of truth for row shape, binary blob layout, types, ranges, and time
alignment.

When the code and this doc disagree, the code wins and this doc is a bug —
please open a PR.

---

## Architecture at a glance

For each song, `analyzer.mjs` writes two things:

1. **A small row** in the Postgres `"Songs"` table holding metadata + lyrics.
2. **Two binary blobs** in the Supabase Storage bucket `song-blobs`, holding
   the per-frame spectrum and clock data that used to live in JSONB columns.

```
          ┌─────────────────────────────────┐
          │  Supabase Postgres "Songs" row  │
          │  ─────────────────────────────  │
          │  id, video_id, title, artist    │
          │  metadata (jsonb, ~5 KB)        │
          │   ├─ analysisBlob: "analysis/.."│──┐
          │   ├─ clockBlob:    "clock/.."   │──┤
          │   └─ ...                        │  │
          │  lyrics_jp, lyrics_tw (jsonb)   │  │
          └─────────────────────────────────┘  │
                                               │
          ┌────────────────────────────────────┴─┐
          │  Supabase Storage bucket `song-blobs`│
          │  ──────────────────────────────────  │
          │  analysis/<video_id>.bin             │
          │  clock/<video_id>.bin                │
          └──────────────────────────────────────┘
```

The row is always small (< ~100 KB) — it fits well below Supabase's row size
soft limit and `SELECT *` is cheap. Heavy per-frame data lives in the blobs,
which the frontend fetches separately.

---

## 1. Prerequisites (one-time setup)

Before running `analyzer.mjs`:

1. **Create the `"Songs"` table.** Apply [supabase-schema.sql](supabase-schema.sql)
   via the Supabase SQL editor or CLI.
2. **Create the `song-blobs` Storage bucket.** In the Supabase dashboard:
   - Storage → New bucket
   - Name: `song-blobs`
   - **Public bucket: ON** (so the frontend can fetch blobs without signed URLs)
   - File size limit: 10 MB (default 50 MB is also fine — our blobs are ≤ ~5 MB)
   - Allowed MIME types: leave empty
3. **Set env vars** in `.env` — see `.env.example`.

`analyzer.mjs` uploads with the service-role key, which bypasses RLS, so no
Storage policies need to be added beyond the "public read" that the dashboard
toggle grants automatically when you mark the bucket public.

---

## 2. Songs table DDL

See [supabase-schema.sql](supabase-schema.sql) for the exact `CREATE TABLE`.
Summary:

| Column         | Type        | Nullable | Notes |
|----------------|-------------|----------|-------|
| `id`           | uuid        | no       | PK, auto-generated |
| `video_id`     | text        | no       | unique; 11-char YouTube video ID |
| `title`        | text        | no       | YouTube title |
| `artist`       | text        | yes      | Uploader / channel name |
| `release_date` | date        | yes      | From `release_date` or fallback `upload_date` |
| `metadata`     | jsonb       | no       | See §3 |
| `lyrics_jp`    | jsonb       | yes      | See §6 |
| `lyrics_tw`    | jsonb       | yes      | See §6 |
| `created_at`   | timestamptz | no       | row insertion time |
| `updated_at`   | timestamptz | no       | last upsert time |

There are **no** `analysis` or `clock_analysis` columns — that data lives in
Storage blobs referenced from `metadata`.

Index: `songs_updated_at_idx on (updated_at desc)`.

---

## 3. `metadata` — JSONB object

All keys are always present on new rows. Ranges shown are post-rounding as
written by the analyzer.

```ts
type Metadata = {
  schemaVersion: 1;             // bump on breaking shape changes; see §8
  duration: number;             // song length in seconds, 3 decimal places
  fps: 60;                      // analysis frame rate, fixed at 60
  bpm: number | null;           // estimated BPM (integer 60..200) or null if detection failed
  sampleRate: 48000;            // PCM sample rate used for analysis, fixed
  bandCount: 64;                // number of spectral bands per analysis frame, fixed
  bandEdges: number[];          // length 65; bandEdges[i] and [i+1] bracket band i in Hz
  vScale: 255;                  // divide a frame's v[j] byte by this to get [0,1]
  centroidMaxHz: number;        // peak spectral centroid across the song in Hz; see §4
  frameCount: number;           // number of frames in BOTH blobs (they are row-aligned)
  analysisBlob: string;         // relative path inside song-blobs: "analysis/<video_id>.bin"
  clockBlob: string;            // relative path inside song-blobs: "clock/<video_id>.bin"
  clock: {
    fftSize: 256;
    binCount: 128;              // bins per clock frame
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
to `v[]` indices — see §4.

**`duration`** is derived from PCM sample count / `sampleRate` (not from
YouTube metadata), so it reflects the actual decoded audio length.

**`frameCount`**: identical for both blobs. Formula (redundant with the value
already in metadata, but useful for sanity checks):

```
frameCount = floor((duration_sec * 48000 - 2048) / 800) + 1
```

---

## 4. Analysis binary blob — `song-blobs/analysis/<video_id>.bin`

One record per frame at 60 FPS. Frame `i` corresponds to audio time
`i / fps` seconds.

### Layout

```
Header (8 bytes, once at the start of the file):
  bytes 0-3 : ASCII "SABN"  (0x53 0x41 0x42 0x4E)  — magic
  byte  4   : 0x01                                 — version
  bytes 5-7 : 0x00 0x00 0x00                        — reserved

Frame (67 bytes, repeated frameCount times):
  bytes  0-63 : v[0..63]   — uint8 per-band spectrum
  byte   64   : r          — uint8 RMS loudness
  byte   65   : c          — uint8 spectral centroid
  byte   66   : k          — uint8: 0 = not a beat, 1 = beat
```

Total file size: `8 + frameCount * 67` bytes.

### Field semantics

- **`v[64]`** — per-band magnitude spectrum. Each byte is one of 64 log-spaced
  frequency bands (see `bandEdges` in metadata). Values are **peak-normalized
  per band across the full song**, then quantized to uint8 (0–255). Divide by
  `metadata.vScale` (= 255) to recover a float in [0, 1]. This normalization is
  per-band, so each band independently uses its full dynamic range — good for
  spectrograms, but means you cannot recover absolute loudness from `v[]`
  alone. Use `r` for that.

- **`r`** — RMS loudness of the frame, normalized to [0, 255] against the
  song's peak RMS. Divide by 255 to get [0, 1]. Use this for "overall how loud
  is this moment" — drives bloom, camera shake, mouth opening, etc.

- **`c`** — spectral centroid, normalized to [0, 255] against the song's peak
  centroid. Divide by 255 to get [0, 1], multiply by `metadata.centroidMaxHz`
  to recover absolute Hz. High values = bright timbres (cymbals, sibilance,
  front vowels); low values = dark timbres (bass, round vowels).

- **`k`** — beat flag. `1` on the first frame of each detected beat, else `0`.
  The detector is spectral-flux-based with a ~90-frame moving-window threshold
  (`mean + 1.5·stddev`) and a 6-frame minimum gap between beats. First 60
  frames of any song are never beats (warmup window).

### Parsing (frontend reference)

```js
async function loadAnalysis(song, supabase) {
  const { data } = supabase.storage
    .from('song-blobs')
    .getPublicUrl(song.metadata.analysisBlob);
  const buffer = await fetch(data.publicUrl).then(r => r.arrayBuffer());

  // Validate header
  const view = new Uint8Array(buffer);
  const magic = String.fromCharCode(view[0], view[1], view[2], view[3]);
  if (magic !== 'SABN') throw new Error('bad analysis magic: ' + magic);
  if (view[4] !== 1) throw new Error('unsupported analysis version: ' + view[4]);

  // Wrap the frame region for indexed access
  const FRAME_SIZE = 67;
  const HEADER = 8;
  const frameCount = song.metadata.frameCount;
  const framesBytes = new Uint8Array(buffer, HEADER, frameCount * FRAME_SIZE);

  return {
    frameCount,
    // Returns an object view of frame at index i; allocates one small object
    // per call, suitable for ~60 Hz playback. For tighter loops, read fields
    // directly from framesBytes with offset math (see tick() example below).
    getFrame(i) {
      const off = i * FRAME_SIZE;
      return {
        v: framesBytes.subarray(off, off + 64),   // zero-copy Uint8Array view
        r: framesBytes[off + 64] / 255,
        c: framesBytes[off + 65] / 255,
        k: framesBytes[off + 66] === 1,
      };
    },
    // Direct access — fastest for hot loops.
    bytes: framesBytes,
    frameSize: FRAME_SIZE,
  };
}
```

### Sampling by wall-clock time

```js
const idx = Math.min(
  frameCount - 1,
  Math.floor(currentTimeSec * song.metadata.fps),
);
const frame = analysis.getFrame(idx);
```

### Deriving legacy aggregates client-side

Earlier versions stored separate `b/m/h/vo` aggregate fields (bass / mid /
high / vocal band energy). These were removed; re-derive from `v[]` +
`bandEdges` when needed:

```js
// Run once at load time
function computeBandIndices(meta, loHz, hiHz) {
  const out = [];
  for (let i = 0; i < meta.bandCount; i++) {
    const bandLo = meta.bandEdges[i];
    const bandHi = meta.bandEdges[i + 1];
    if (bandHi >= loHz && bandLo <= hiHz) out.push(i);
  }
  return out;
}

const bassIdx  = computeBandIndices(song.metadata,   20,   250);
const midIdx   = computeBandIndices(song.metadata,  250,  4000);
const highIdx  = computeBandIndices(song.metadata, 4000, 15000);
const vocalIdx = computeBandIndices(song.metadata,  300,  3400);

// Per frame
function avg(v, idx) {
  let s = 0;
  for (const i of idx) s += v[i];
  return s / (idx.length * 255);   // result in [0, 1]
}
const bassEnergy = avg(frame.v, bassIdx);
```

---

## 5. Clock-analysis binary blob — `song-blobs/clock/<video_id>.bin`

Row-aligned with the analysis blob: frame `i` in both blobs describes the same
instant. See [CLOCK_ANALYSIS_HANDOVER.md](CLOCK_ANALYSIS_HANDOVER.md) for the
rationale and the AnalyserNode spec details.

### Layout

```
Header (8 bytes):
  bytes 0-3 : ASCII "SCBN"  (0x53 0x43 0x42 0x4E)  — magic
  byte  4   : 0x01                                 — version
  bytes 5-7 : 0x00 0x00 0x00                        — reserved

Frame (128 bytes, repeated frameCount times):
  bytes 0-127 : frequencies[0..127]   — uint8 byte-scaled FFT bins
```

Total file size: `8 + frameCount * 128` bytes.

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

### Parsing (frontend reference)

```js
async function loadClock(song, supabase) {
  const { data } = supabase.storage
    .from('song-blobs')
    .getPublicUrl(song.metadata.clockBlob);
  const buffer = await fetch(data.publicUrl).then(r => r.arrayBuffer());

  const view = new Uint8Array(buffer);
  const magic = String.fromCharCode(view[0], view[1], view[2], view[3]);
  if (magic !== 'SCBN') throw new Error('bad clock magic: ' + magic);
  if (view[4] !== 1) throw new Error('unsupported clock version: ' + view[4]);

  const FRAME_SIZE = 128;
  const HEADER = 8;
  const frameCount = song.metadata.frameCount;
  const framesBytes = new Uint8Array(buffer, HEADER, frameCount * FRAME_SIZE);

  return {
    frameCount,
    getFrequencies(i) {
      const off = i * FRAME_SIZE;
      return framesBytes.subarray(off, off + FRAME_SIZE);  // zero-copy view
    },
    bytes: framesBytes,
    frameSize: FRAME_SIZE,
  };
}
```

---

## 6. `lyrics_jp` / `lyrics_tw` — JSONB array of caption cues

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
- Cues are deduplicated when consecutive blocks repeat the same text.
- Cues arrive in chronological order.

### Fallback policy

- `lyrics_jp` present, `lyrics_tw` null → Japanese track found, no Traditional Chinese
- `lyrics_jp` null, `lyrics_tw` present → only Traditional Chinese available
- both null → no official track in either language; the row still has analysis blobs

---

## 7. Frame alignment guarantees

Both blobs use the same HOP = 800 samples and the same `frameCount` formula.
Consequences:

- `analysis[i]` and `clock_analysis[i]` describe the **same instant** at the
  same index `i`. You can read them in lockstep with a single `idx` value.
- `analysis.frameCount === clock.frameCount === metadata.frameCount`.
- Map wall-clock time to index with `Math.floor(t * metadata.fps)` for either
  blob.

Lyrics (`lyrics_jp`, `lyrics_tw`) are not frame-indexed; they carry their own
`s` / `d` in seconds and should be looked up by binary search or linear scan.

---

## 8. Schema versioning

`metadata.schemaVersion` is a single integer. Current value: **`1`**.

- **Bump on breaking changes:** removed field, changed semantics of an existing
  field, changed binary layout, or changed normalization/quantization.
- **Do NOT bump on additive changes:** adding a new optional field to
  `metadata`. Consumers should treat unknown metadata fields as non-breaking.
- **Binary blob versions** are tracked independently per the version byte at
  offset 4 of each blob's header. `schemaVersion` and the blob version byte
  should be bumped together when a blob layout changes.
- Consumers SHOULD check both `metadata.schemaVersion` and the blob version
  byte on load and fail loudly if they encounter an unexpected value.

Planned future versions (see [LIP_SYNC_PLAN.md](LIP_SYNC_PLAN.md)) will add
isolated-vocal-derived fields to the analysis frame — those will extend the
analysis frame size and bump both the binary version byte and
`schemaVersion`.

---

## 9. Size estimates

### Per frame (binary)

- analysis frame: **67 bytes** (v[64] + r + c + k)
- clock frame: **128 bytes** (frequencies[128])
- plus 8-byte header on each blob, once

### Per song (4 min ≈ 14,400 frames)

| Blob | Formula | Size |
|---|---|---|
| analysis | `8 + frames * 67` | ~965 KB |
| clock | `8 + frames * 128` | ~1.8 MB |
| row (metadata + lyrics) | — | ~50 KB |
| **Total** | | **~2.8 MB** |

### Per song (12 min ≈ 43,200 frames)

| Blob | Size |
|---|---|
| analysis | ~2.9 MB |
| clock | ~5.5 MB |
| row | ~100 KB |
| **Total** | **~8.5 MB** |

Row size is now a tiny constant regardless of song length; Postgres row limits
are never hit. The binary blobs use roughly 25% of the storage that the old
JSONB columns did and parse in constant-time from a single `ArrayBuffer`.

### 100 songs (average 4 min) estimate

- Storage: ~280 MB (well under Supabase Pro's 100 GB quota)
- One full-song fetch for the frontend: ~2.8 MB (raw) or ~1.5 MB gzipped by
  the CDN

### Measuring exactly

Run `node analyzer.mjs --url <url> --dry-run` to pack the blobs in memory and
print exact sizes without uploading.

---

## 10. Fetching workflow (frontend)

```js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);  // anon key is fine — bucket is public

async function loadSong(videoId) {
  // 1. Pull the small row
  const { data: song, error } = await supabase
    .from('Songs')
    .select('*')
    .eq('video_id', videoId)
    .single();
  if (error) throw error;

  // 2. Pull both blobs in parallel (each ~1-2 MB, gzipped by CDN)
  const [analysis, clock] = await Promise.all([
    loadAnalysis(song, supabase),   // see §4
    loadClock(song, supabase),      // see §5
  ]);

  return { song, analysis, clock };
}
```

### Tight 60 FPS render loop

The returned blob views hand out zero-copy `Uint8Array` subarrays, so per-frame
access is just integer math:

```js
function tick() {
  const t = audioElement.currentTime;
  const idx = Math.min(analysis.frameCount - 1, Math.floor(t * song.metadata.fps));

  // Direct byte access — no per-frame allocation
  const aOff = idx * 67;
  const vBytes = analysis.bytes.subarray(aOff, aOff + 64);
  const r = analysis.bytes[aOff + 64] / 255;
  const c = analysis.bytes[aOff + 65] / 255;
  const k = analysis.bytes[aOff + 66] === 1;

  const freq = clock.bytes.subarray(idx * 128, (idx + 1) * 128);

  render(vBytes, r, c, k, freq);
  requestAnimationFrame(tick);
}
```

### Caching and CDN

- Blobs are uploaded with `Cache-Control: max-age=31536000` (1 year).
- Content never mutates for a given `video_id` unless you `--force` re-run
  `analyzer.mjs`, in which case the uploader overwrites the existing object.
  If you need strict cache invalidation in that case, append a query string
  version or switch to hashed filenames.
- Don't re-fetch blobs on seek — cache the decoded `Uint8Array` in memory for
  the lifetime of the song selection.
- `metadata` is always fetched from the row (not the blob), so schema changes
  that only affect metadata keys don't require re-downloading blobs.

### Selective fetching

If a page only needs one blob (e.g. a lyric-display page that doesn't render
the clock halo), fetch only that blob. There's no penalty for skipping
`clock_analysis` — the row doesn't carry it.
