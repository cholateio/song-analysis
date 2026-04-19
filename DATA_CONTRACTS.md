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

Static constants (sample rate, band edges, blob header layout, clock render
parameters) that are identical for every song with a given `schemaVersion`
are **not** stored in the database. They're hardcoded in the frontend bundle,
keyed by `schemaVersion`. See §11.

---

## 3. `metadata` — JSONB object

All keys are always present on new rows. Ranges shown are post-rounding as
written by the analyzer. Per-song scalar features live here; shared constants
(sampleRate, bandEdges, blob header layout, etc.) are bundled with the
frontend — see §11.

```ts
type Metadata = {
  schemaVersion: 2;                  // bump on breaking shape changes; see §8
  duration: number;                  // song length in seconds, 3 decimal places
  frameCount: number;                // number of frames in BOTH blobs (they are row-aligned)

  // Rhythm
  bpm: number | null;                // estimated BPM (integer 60..200) or null if detection failed
  bpmConfidence: number | null;      // fraction of inter-beat intervals within ±10% of median; null if bpm is null

  // Timbre / loudness (per-song scalars, 2D-map friendly)
  medianCentroidHz: number;          // median spectral centroid across frames (Hz). Brightness/warmth axis.
  musicalCentroidHz: number | null;  // median spectral centroid with FFT bins < 150 Hz zeroed. "Perceived brightness" without sub-bass gravity.
  loudnessRangeLRA: number | null;   // EBU R128 Loudness Range (LU). null if ffmpeg ebur128 couldn't compute (very short audio)
  zcrVariance: number;               // sample variance of Meyda zcr (zero-crossings per 2048-sample frame) across all frames
  meanSpectralContrastDb: number;    // mean over frames of per-frame spectral contrast (dB) across 6 octave bands 100–12800 Hz
  vocalOnsetRate: number | null;     // onsets per second detected on vocal band (~272–3707 Hz). null only on computation error; missing (undefined) on pre-backfill rows.
  vocalModulationHz: number | null;  // dominant envelope modulation frequency (Hz) of the vocal-band harmonic stem, 1.5–10 Hz. Syllable-rate proxy. null on silent/instrumental sections.
  vocalCentroidHz: number | null;    // median per-frame spectral centroid restricted to vocal bands (~272–3707 Hz), in Hz. null if <10% of frames clear the noise floor.

  // Blob pointers
  analysisBlob: string;              // relative path inside song-blobs: "analysis/<video_id>.bin"
  clockBlob: string;                 // relative path inside song-blobs: "clock/<video_id>.bin"
};
```

**`duration`** is derived from PCM sample count / `sampleRate` (not from
YouTube metadata), so it reflects the actual decoded audio length.

**`frameCount`**: identical for both blobs. Formula (redundant with the value
already in metadata, but useful for sanity checks):

```
frameCount = floor((duration_sec * 48000 - 2048) / 800) + 1
```

### Per-song feature semantics

- **`medianCentroidHz`** — median of per-frame spectral centroid across the
  song, in Hz. Median (not mean or max) because transients like cymbals and
  sibilants spike the centroid; median describes the "dominant timbre" most
  of the time. Use for cross-song brightness/warmth comparisons and as a 2D
  map axis. Ranges observed: ~800 Hz (warm bass-heavy) to ~4000 Hz (bright
  distorted rock).

- **`musicalCentroidHz`** — same method as `medianCentroidHz` (per-frame
  spectral centroid on the full 1024-bin `amplitudeSpectrum`, song-median),
  except FFT bins below 150 Hz are zeroed before computing the per-frame
  centroid. Removes sub-bass and kick-drum fundamentals from the "brightness"
  reading so songs don't all pull toward the bass floor. Per frame the
  surviving-bin sum is also tracked as a denom; frames where denom is below
  10% of the song-wide mean denom are skipped (silent / sub-floor frames),
  and `musicalCentroidHz` is `null` if fewer than 10% of frames survive.
  Semantic pairing: `medianCentroidHz` (20 Hz–16 kHz, low-frequency gravity
  included) vs `vocalCentroidHz` (~272–3707 Hz, vocal timbre only) vs
  `musicalCentroidHz` (150 Hz–16 kHz, "perceived brightness" with bass
  weight removed but cymbals / synths / vocals retained). For a J-Pop /
  J-rock catalog expect most songs in ~1500–3500 Hz — higher than
  `medianCentroidHz` by a roughly song-dependent offset (~300–800 Hz).
  Additive field; rows ingested before it was added have
  `musicalCentroidHz === undefined` until reprocessed with `--force`.

- **`loudnessRangeLRA`** — EBU R128 Loudness Range in LU, produced by
  `ffmpeg -af ebur128`. Measures intra-song dynamic contrast (difference
  between quiet and loud passages, gated). Low LRA (< 4 LU) = compressed /
  wall-of-sound; high LRA (> 10 LU) = very dynamic (classical, unmastered).
  Null if audio was too short for ebur128 to gate.

- **`zcrVariance`** — sample variance of Meyda's `zcr` feature across all
  analysis frames. Each per-frame `zcr` is the count of zero-crossings in the
  2048-sample window (43 ms at 48 kHz). Variance captures temporal burstiness
  of high-frequency / percussive content — steady tonal material has low
  variance; songs with crashing drums, sibilant vocals, or breathy
  fricatives alongside smooth sections have high variance.

- **`meanSpectralContrastDb`** — mean across frames of per-frame spectral
  contrast, in dB. Per-frame contrast is computed on 6 octave subbands
  (cut-offs 100, 200, 400, 800, 1600, 3200, 6400, 12800 Hz); in each band
  the top 20% of magnitudes (peak) is compared to the bottom 20% (valley),
  and `20·log10(peak/valley)` is averaged over the 6 bands. High contrast
  (> 20 dB) = tonal / well-separated instruments (classical, vocals); low
  contrast (< 10 dB) = noisy / wall-of-sound (distorted rock, ambient).

- **`vocalOnsetRate`** — onsets per second detected on the vocal-range sub-bands
  `v[25..49]` of the analysis blob (log-spaced bins covering ~272–3707 Hz).
  Computed as spectral flux on the quantized, per-band peak-normalized `v[]`,
  smoothed with a 3-tap moving average, and thresholded per-frame as
  `max(T_min, α·thr_global + (1-α)·thr_local)` where `thr_local` uses a
  ±2.5 s median + 1.5·MAD window, `thr_global` is the same statistic over
  the whole song, `T_min = 2·median(smooth)` per song, and α = 0.5; peak-picked
  with a 100 ms minimum inter-onset interval (cap 10 onsets/s). Rank-comparable
  across songs: absolute rate reflects vocal articulation density above a
  per-song hybrid floor. A proxy for "how often the vocal line articulates";
  expected ranges (post hybrid-threshold, to be confirmed against catalog):
  pure instrumental < 1.5, slow ballad ~1.5–3, mid-tempo J-Pop ~2–5,
  fast rap / dense articulation ~5–10. **Caveat:** kick/snare energy
  bleeds into the vocal bands and inflates the rate; for a catalog with
  uniform band-instrumentation (e.g. a single artist's discography) the bias
  is systematic and relative ranking is still valid. Null only when the
  computed rate falls outside [0, 15] (sanity check); rows ingested before
  this field was added — or before the threshold was switched from pure
  adaptive to hybrid — have stale values until reprocessed with `--force`.

- **`vocalModulationHz`** — dominant modulation frequency (Hz) of the vocal-band
  harmonic envelope, in the 2–10 Hz syllable-rate range. Computed by applying
  horizontal-median HPSS (kernel ≈ 0.28 s) to the 64-band log-spaced spectrogram
  to suppress drum transients, then taking the RMS envelope of bands `[25..49]`
  (~272–3707 Hz), Hann-windowing, FFT-ing the full-song envelope at 60 fps, and
  reporting the energy-weighted centroid of magnitude over 2–10 Hz. Unlike
  `vocalOnsetRate` which counts acoustic attacks, this measures how fast the
  vocal energy itself oscillates — robust to legato vs staccato differences.
  Expected ranges are catalog-dependent: for a broad catalog
  (instrumental → pop → rap) expect ~1.5–8 Hz; for a narrow J-Pop / J-rock
  catalog (e.g. 花譜 + J-rock-band) expect most songs compressed into ~2–5 Hz
  with ballads ~1.5–2.5 and up-tempo tracks ~4–5. Null when bandpass energy
  is <5% of total envelope power (instrumental / silent sections), when the
  computed centroid falls outside [1.5, 10] Hz, or when the clip is shorter
  than 2 s. Rows ingested before this field was added have
  `vocalModulationHz === undefined` until reprocessed with `--force`.

- **`vocalCentroidHz`** — median per-frame spectral centroid over the
  vocal-band sub-bands covering ~272–3707 Hz, reported in Hz. Computed on
  the pre-quantization 64-band Float32 spectrogram (before the per-band
  peak-normalization that produces `v[]`), so the centroid weights bands
  by absolute energy — a conventional DSP spectral centroid restricted to
  the vocal band, with the coarseness of the 64-band log-spaced grid.
  Per frame: `numer = Σ bandCenter[b] · bins[i][b]`, `denom = Σ bins[i][b]`
  over `b ∈ [25..49]`, where `bandCenter[b] = sqrt(BAND_EDGES_HZ[b] ·
  BAND_EDGES_HZ[b+1])` is the geometric-mean centre of each log-spaced band.
  Frames with `denom` below 10% of the song-wide mean `denom` are skipped
  (silent / sub-floor frames). The metric is the median of the surviving
  frame centroids. Expected ranges are catalog-dependent; for a narrow
  J-Pop / J-rock catalog (e.g. 花譜 + J-rock-band) expect most songs in
  ~800–2500 Hz; a female-dominant catalog skews higher than a
  male-dominant one. Null when fewer than 10% of frames have valid denom
  (song is essentially silent in the vocal band) or when the song has no
  frames. Rows ingested before this field was added have
  `vocalCentroidHz === undefined` until reprocessed with `--force`.

- **`bpmConfidence`** — `count(|interval − median| / median < 0.1) /
  count(all intervals)`. `1.0` means every detected inter-beat interval is
  within 10% of the median; `0.5` means half. Distinguishes
  "no beat found" (`bpm: null`, `bpmConfidence: null`) from
  "beat found but unstable" (`bpm: 140`, `bpmConfidence: 0.4`).

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
  frequency bands (see `bandEdges` in the bundled schema constants — §11).
  Values are **peak-normalized per band across the full song**, then
  quantized to uint8 (0–255). Divide by `schema.vScale` (= 255) to recover a
  float in [0, 1]. This normalization is per-band, so each band independently
  uses its full dynamic range — good for spectrograms, but means you cannot
  recover absolute loudness from `v[]` alone. Use `r` for that.

- **`r`** — RMS loudness of the frame, normalized to [0, 255] against the
  song's peak RMS. Divide by 255 to get [0, 1]. Use this for "overall how loud
  is this moment" — drives bloom, camera shake, mouth opening, etc.

- **`c`** — spectral centroid, normalized to [0, 255] against the song's
  **own peak** centroid. Divide by 255 to get a [0, 1] **relative brightness**
  value within that song. Because the reference is per-song (not a shared
  scale), `c` is *not* cross-song comparable and cannot be mapped back to
  absolute Hz. For cross-song brightness comparisons, use
  `metadata.medianCentroidHz` instead. Within a single song, `c` is still
  useful as a 0–1 brightness index that tracks moment-to-moment timbre
  (high = cymbals/sibilance, low = bass/round vowels).

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
  Math.floor(currentTimeSec * schema.fps),
);
const frame = analysis.getFrame(idx);
```

### Deriving legacy aggregates client-side

Earlier versions stored separate `b/m/h/vo` aggregate fields (bass / mid /
high / vocal band energy). These were removed; re-derive from `v[]` +
the bundled `bandEdges` (see §11) when needed:

```js
import { ANALYSIS_SCHEMAS } from './analysisSchemas';
const schema = ANALYSIS_SCHEMAS[song.metadata.schemaVersion];
const { bandEdges, bandCount, vScale } = schema;

function computeBandIndices(loHz, hiHz) {
  const out = [];
  for (let i = 0; i < bandCount; i++) {
    if (bandEdges[i + 1] >= loHz && bandEdges[i] <= hiHz) out.push(i);
  }
  return out;
}

const bassIdx  = computeBandIndices(  20,   250);
const midIdx   = computeBandIndices( 250,  4000);
const highIdx  = computeBandIndices(4000, 15000);
const vocalIdx = computeBandIndices( 300,  3400);

// Per frame
function avg(v, idx) {
  let s = 0;
  for (const i of idx) s += v[i];
  return s / (idx.length * vScale);   // result in [0, 1]
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
  the parameters listed in `schema.clock` (§11). Pre-smoothed by the spec's
  τ=0.8 EMA; **do not apply additional smoothing** on the client — it will
  feel laggy.

- **No `bass` field.** The live virtual-music-clock WebSocket payload carries
  `bass = mean(dataArray[0..4])`; offline we omit it because it is trivially
  derivable. Use:
  ```js
  const N = schema.clock.bassBinCount;  // 5
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
- Map wall-clock time to index with `Math.floor(t * schema.fps)` for
  either blob.

Lyrics (`lyrics_jp`, `lyrics_tw`) are not frame-indexed; they carry their own
`s` / `d` in seconds and should be looked up by binary search or linear scan.

---

## 8. Schema versioning

`metadata.schemaVersion` is a single integer. Current value: **`2`**.

- **Bump on breaking changes:** removed field, changed semantics of an existing
  field, changed binary layout, or changed normalization/quantization.
- **Do NOT bump on additive changes:** adding a new optional field to
  `metadata`. Consumers should treat unknown metadata fields as non-breaking.
- **Binary blob versions** are tracked independently per the version byte at
  offset 4 of each blob's header. `schemaVersion` and the blob version byte
  should be bumped together when a blob layout changes.
- Consumers SHOULD check both `metadata.schemaVersion` and the blob version
  byte on load and fail loudly if they encounter an unexpected value.

### History

- **v2** (current): removed static constants (`fps`, `sampleRate`,
  `bandCount`, `bandEdges`, `vScale`, `clock.*`) from per-song `metadata` —
  they're now bundled with the frontend and keyed by `schemaVersion` (§11).
  Added per-song features `bpmConfidence`, `medianCentroidHz`,
  `loudnessRangeLRA`, `zcrVariance`, `meanSpectralContrastDb`. Removed
  `centroidMaxHz` (max is noise-dominated by transients and has no
  cross-song discriminative power — use `medianCentroidHz` instead). Blob
  magic/version bytes unchanged (per-frame layout identical to v1); the `c`
  byte's semantics are narrowed from "absolute-Hz-recoverable" to
  "relative brightness within this song" — use `medianCentroidHz` for
  cross-song comparison. Later additive amendment: `vocalOnsetRate` added as
  an optional metadata field without a schemaVersion bump (per §8 additive
  rule); old rows have the field missing until reprocessed.
- **v1**: original schema with all constants inlined per song.

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
  const idx = Math.min(analysis.frameCount - 1, Math.floor(t * schema.fps));

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

---

## 11. Schema constants — bundled with the frontend

Static parameters that are identical for every song analyzed with a given
`schemaVersion` are **not stored in the database**. They're hardcoded in the
frontend bundle, keyed by `schemaVersion`. Every song already carries
`metadata.schemaVersion`, so the frontend looks up the matching constants
at render time:

```js
// src/lib/analysisSchemas.js (frontend)
export const ANALYSIS_SCHEMAS = {
  2: {
    fps: 60,
    sampleRate: 48000,
    bandCount: 64,
    bandEdges: [
      20, 22.2, 24.65, 27.36, 30.37, 33.72, 37.43, 41.55, 46.12, 51.2,
      56.84, 63.1, 70.04, 77.75, 86.31, 95.82, 106.37, 118.08, 131.08, 145.51,
      161.53, 179.31, 199.05, 220.97, 245.3, 272.3, 302.28, 335.56, 372.5, 413.52,
      459.04, 509.58, 565.69, 627.97, 697.1, 773.85, 859.05, 953.63, 1058.62, 1175.17,
      1304.55, 1448.18, 1607.62, 1784.61, 1981.09, 2199.2, 2441.33, 2710.11, 3008.48, 3339.71,
      3707.4, 4115.57, 4568.68, 5071.67, 5630.05, 6249.9, 6937.99, 7701.84, 8549.79, 9491.09,
      10536.03, 11696.01, 12983.7, 14413.16, 16000,
    ],
    vScale: 255,
    analysisFrameBytes: 67,
    analysisBlobMagic: 'SABN',
    analysisBlobVersion: 1,
    clockFrameBytes: 128,
    clockBlobMagic: 'SCBN',
    clockBlobVersion: 1,
    clock: {
      fftSize: 256,
      binCount: 128,
      smoothingTimeConstant: 0.8,
      minDecibels: -100,
      maxDecibels: -30,
      bassBinCount: 5,
    },
  },
  // future: 3: { ... }
};

export function getSchema(song) {
  const s = ANALYSIS_SCHEMAS[song.metadata.schemaVersion];
  if (!s) throw new Error(`unknown schemaVersion: ${song.metadata.schemaVersion}`);
  return s;
}
```

### Why bundle and not a DB table?

The values never change within a schemaVersion and the analyzer already
hardcodes them in [src/audio.mjs](src/audio.mjs). Storing the same values in
a DB table would:
- Add a round-trip at app load for ~1 KB of data that can't change
- Introduce a new failure mode (no row for current schemaVersion)
- Require a deploy step (SQL migration) for constants the frontend must
  know about anyway

A frontend map keyed by `schemaVersion` handles multi-version song catalogs
(e.g., during a backfill) just as well, without any of the above.

### Keeping server and frontend in sync

When `analyzer.mjs`'s constants change, bump `schemaVersion` in
[src/audio.mjs](src/audio.mjs) (and in analyzer.mjs's metadata assembly) and
add a matching entry to `ANALYSIS_SCHEMAS` on the frontend in the same
release. The `getSchema()` helper throws loudly on unknown versions, so a
deploy skew is caught at the first song load rather than producing silently
wrong renders.
