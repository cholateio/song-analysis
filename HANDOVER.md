# song-analysis → frontend handover

This document is for the Three.js / visualizer project that will consume the data produced by `song-analysis`. It explains what this repo does, the shape of the data in Supabase, and how to read it back on the frontend.

---

## 1. What `song-analysis` is

A Node.js CLI that takes a YouTube URL, downloads the audio, runs FFT analysis on it, fetches the official caption track in a chosen language, and writes one row per song into a Supabase table called `"Songs"`.

Pipeline per invocation:

```
YouTube URL
  → yt-dlp: metadata (title, artist, release_date, duration)
  → yt-dlp: official captions in the requested language (or null)
  → yt-dlp → ffmpeg: raw 48 kHz mono f32 PCM stream
  → Meyda FFT (2048-point Hann, 60 fps hop) → 64 log-spaced bands
  → spectral-flux beat detection with adaptive threshold
  → per-band normalization (0–1, 3 decimals)
  → upsert into "Songs"
```

**Constraints the frontend can rely on:**
- Sampling is always **60 fps** (one frame every 16.67 ms).
- Spectrum always has **64 log-spaced bins** covering 20 Hz – 16 kHz.
- All per-frame values are normalized to `0.0–1.0` (per-band max) and rounded to 3 decimals.
- A song is never stored longer than **12 minutes** (hard cap in the ingester).
- Lyrics are only ever **creator-uploaded official captions** in the requested language. Auto-generated / machine-translated captions are **never** stored — if no official track exists, `lyrics` is `null`.

---

## 2. Supabase table `"Songs"`

⚠️ The table name is **capitalized**. In raw SQL you must quote it: `FROM "Songs"`. The Supabase JS client (`supabase.from('Songs')`) handles the quoting for you.

| column         | type           | nullable | notes |
|---             |---             |---       |---|
| `video_id`     | `text`         | PK       | YouTube 11-char ID |
| `title`        | `text`         | no       | from yt-dlp |
| `artist`       | `text`         | yes      | channel / uploader |
| `release_date` | `date`         | yes      | ISO `YYYY-MM-DD`, from yt-dlp's `release_date` falling back to `upload_date` |
| `metadata`     | `jsonb`        | no       | shape below |
| `lyrics`       | `jsonb`        | yes      | array of cues, or `null` if no official track |
| `analysis`     | `jsonb`        | no       | array of per-frame objects |
| `created_at`   | `timestamptz`  | no       | row created |
| `updated_at`   | `timestamptz`  | no       | bumped on every upsert |

The schema DDL lives in [supabase-schema.sql](supabase-schema.sql) in this repo.

### 2.1 `metadata` JSONB

```json
{
  "duration":   227.456,
  "fps":        60,
  "bpm":        170,
  "sampleRate": 48000,
  "bandCount":  64,
  "bandEdges":  [20.0, 22.4, 25.0, /* ... 63 more, total 65 values ... */, 16000.0],
  "bassRange":  [20,   250],
  "midRange":   [250,  4000],
  "highRange":  [4000, 15000],
  "vocalRange": [300,  3400]
}
```

- `duration` — seconds (float), what the visualizer should treat as the song length.
- `fps` — **always 60** for current data. Use this for the time → frame index math. Don't hardcode 60.
- `bpm` — integer BPM estimated from the median inter-beat interval. Can be `null` for clips too short or too beat-sparse.
- `bandCount` — **always 64** for current data.
- `bandEdges` — array of 65 frequency values in Hz. `v[i]` represents the energy in the range `[bandEdges[i], bandEdges[i+1])`. Useful if you want to label bands or map them to a log-frequency axis.
- `bassRange` / `midRange` / `highRange` / `vocalRange` — the `[loHz, hiHz]` windows used to compute the `b` / `m` / `h` / `vo` aggregate scalars.

### 2.2 `lyrics` JSONB (nullable)

Array of cue objects sorted by start time:

```json
[
  { "s": 12.45, "d": 2.10, "t": "Ah, 素晴らしき世界に今日も乾杯" },
  { "s": 14.80, "d": 1.50, "t": "街に溢れるノイズが心地いい" }
]
```

- `s` — start time in seconds (float, 3 decimals)
- `d` — duration in seconds (float, 3 decimals)
- `t` — cleaned text (HTML entities decoded, `<tag>` and inline `<HH:MM:SS.mmm>` markers stripped)

`lyrics === null` means the video had no official caption track in the requested language. The row still has a full `analysis`, so the visualizer can run fine without lyrics — just hide or skip the lyric layer.

### 2.3 `analysis` JSONB

The critical payload. An array of per-frame objects, one every `1/fps` seconds, starting at `t = 0`. **Time is implicit via the array index** — there is no `t` field inside each frame, that would just waste space.

Each element:

```json
{
  "v":  [0.12, 0.08, 0.14, /* ... 64 floats in 0–1 ... */],
  "b":  0.92,
  "m":  0.54,
  "h":  0.21,
  "vo": 0.47,
  "r":  0.63,
  "k":  false
}
```

| field | type          | what it is | intended use |
|---    |---            |---         |---|
| `v`   | `number[64]`  | 64 log-spaced FFT band magnitudes, normalized 0–1 | the **radial spectrum ring** — one sample per point around the circle |
| `b`   | `number`      | bass band aggregate (20–250 Hz), 0–1 | drives **HSL hue / lightness** (Miku-green → cyan → deep blue as `b` rises) |
| `m`   | `number`      | mid band aggregate (250–4 000 Hz), 0–1 | general intensity signal |
| `h`   | `number`      | high band aggregate (4 000–15 000 Hz), 0–1 | sparkle / highlight effects |
| `vo`  | `number`      | vocal band aggregate (300–3 400 Hz), 0–1 | **"human voice reacts to higher voice"** — drive the vocal layer animation |
| `r`   | `number`      | overall RMS loudness, 0–1 | clock-face glow / brightness |
| `k`   | `boolean`     | beat/kick flag, `true` on detected onsets | one-shot pulse animations (shake, scale bump, flash) |

**Normalization note.** Each value is divided by the song's own maximum for that channel. That means `v[0] === 1.0` on the loudest bass-heavy frame of *this particular song*, not 1.0 relative to some universal scale. So intensity is consistent within a song but not directly comparable across songs. This is deliberate: it makes every song look alive on the visualizer without per-song hand-tuning.

---

## 3. How the frontend reads it

### 3.1 Connection

The frontend should use the Supabase **anon key** (not the service key used by this ingester). Enable RLS on `"Songs"` and add a read-only policy for the anon role.

```js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);
```

### 3.2 Fetching one song

```js
async function loadSong(videoId) {
  const { data, error } = await supabase
    .from('Songs')
    .select('video_id, title, artist, release_date, metadata, lyrics, analysis')
    .eq('video_id', videoId)
    .single();
  if (error) throw error;
  return data;
}
```

**Fetch once per song.** The `analysis` payload is ~1–6 MB of JSON for a normal-length song, so cache it in memory (or IndexedDB for offline) rather than re-fetching on every navigation.

### 3.3 Indexing into `analysis` at the current playback time

Because frames are evenly spaced at `fps` per second, the current frame is just:

```js
function frameAt(song, currentTime) {
  const { metadata, analysis } = song;
  const raw = Math.floor(currentTime * metadata.fps);
  const i = Math.max(0, Math.min(analysis.length - 1, raw));
  return analysis[i];
}
```

Call this inside your `requestAnimationFrame` loop every frame:

```js
function tick(now) {
  const currentTime = audioElement.currentTime;    // seconds
  const frame = frameAt(song, currentTime);

  ring.updateBars(frame.v);                        // radial spectrum
  clock.setGlow(frame.r);                          // overall loudness
  vocalLayer.setIntensity(frame.vo);               // voice reactivity
  background.setHsl(bassToHsl(frame.b));           // HSL color from bass
  if (frame.k) beatPulse.trigger();                // kick flash

  requestAnimationFrame(tick);
}
```

### 3.4 Looking up the current lyric line

Lyrics are sorted by `s`, so you can keep a running pointer and advance it instead of searching every frame:

```js
let lyricCursor = 0;

function currentLyric(song, currentTime) {
  const { lyrics } = song;
  if (!lyrics) return null;
  while (lyricCursor < lyrics.length - 1 && currentTime >= lyrics[lyricCursor + 1].s) {
    lyricCursor++;
  }
  const cue = lyrics[lyricCursor];
  if (!cue || currentTime < cue.s || currentTime >= cue.s + cue.d) return null;
  return cue.t;
}
```

If you seek backward (scrubbing), reset `lyricCursor = 0` before the next lookup. For a full-song lyric list (to render all lines stacked), just iterate `lyrics` directly.

### 3.5 Example: bass → HSL mapping

The ingester doesn't prescribe the color function — that's the visualizer's job. Something like this matches the "Miku green → cyan → deep blue" design:

```js
function bassToHsl(b) {
  // b is 0..1, normalized per-song
  const hue = 174 + b * 36;        // 174° ≈ Miku green, 210° ≈ blue
  const sat = 65 + b * 15;         // 65%..80%
  const lig = 40 + b * 20;         // 40%..60%
  return `hsl(${hue}, ${sat}%, ${lig}%)`;
}
```

---

## 4. Gotchas

- **Capitalized table name.** Every raw SQL query must quote `"Songs"`. The JS client hides this, but the Supabase SQL editor will fail with an unhelpful error if you forget.
- **Lyrics may be null.** Don't assume `song.lyrics.length`. Null means "no official captions in the requested language." Auto-generated captions are deliberately excluded because they are unreliable for singing.
- **Time axis is zero-indexed from the start of the audio file**, not from any intro offset. If YouTube's audio has silence at the start, so will `analysis[0..n]`.
- **Frame count is `analysis.length`, not `duration * fps`**, due to the FFT window needing `bufferSize` samples (2048) at the start. Expect `analysis.length ≈ floor((duration * sampleRate - 2048) / 800) + 1`. Clamp the index to `[0, analysis.length - 1]` when mapping from `currentTime`.
- **Normalization is per-song.** A quiet song's `r = 1.0` is not the same absolute loudness as a loud song's `r = 1.0`. This is intentional and keeps visual intensity consistent across different masters / genres.
- **`k` is boolean, not a velocity.** If you want variable-strength beat pulses, use `r` or `b` on the same frame as a modulator (e.g. `if (k) pulse(r)`).
- **Beat detection has a 1-second warmup.** The first 60 frames will never have `k === true`. Don't rely on beats in the first second of the song.
- **Row size is bounded but not tiny.** Expect 1–6 MB of JSON for the `analysis` column depending on song length. Don't do `SELECT *` across many rows on the listing view — fetch just `video_id, title, artist, release_date` for listings and only load `metadata, lyrics, analysis` for the now-playing song.

---

## 5. Querying examples

```sql
-- Listing view: lightweight columns only
SELECT video_id, title, artist, release_date
FROM "Songs"
ORDER BY updated_at DESC;

-- Full payload for the player
SELECT video_id, title, artist, release_date, metadata, lyrics, analysis
FROM "Songs"
WHERE video_id = '3Dr91z1-Iug';

-- Quick sanity check: how many frames vs expected
SELECT video_id,
       jsonb_array_length(analysis)   AS frames,
       metadata->>'fps'               AS fps,
       (metadata->>'duration')::float AS duration,
       metadata->>'bpm'               AS bpm
FROM "Songs"
ORDER BY updated_at DESC
LIMIT 10;
```
