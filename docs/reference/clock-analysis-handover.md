# Clock Analysis — Frontend Handover

A new `clock_analysis` column on `"Songs"` replays a YouTube song as if it were
being fed through `virtual-music-clock`'s `audio-engine` AnalyserNode in real
time. Use it to drive clock-style visualizers without running Web Audio on the
client.

---

## 1. How the original clock samples audio

See `virtual-music-clock/app/audio-engine/page.jsx`.
It does **not** implement FFT itself — it just calls one Web Audio API method
on a loop:

```js
analyser.fftSize = 256;
const dataArray = new Uint8Array(analyser.frequencyBinCount); // 128

const processAudio = () => {
  analyser.getByteFrequencyData(dataArray);
  let bassSum = 0;
  for (let i = 0; i < 5; i++) bassSum += dataArray[i];
  const bass = bassSum / 5;
  const frequencies = Array.from(dataArray);
  wsRef.current.send(JSON.stringify({ bass, frequencies }));
  setTimeout(processAudio, 16); // ~60 FPS
};
```

Signal graph: `getUserMedia → MediaStreamSource → AnalyserNode → GainNode(0) → destination`.
The zero-gain node is a defensive trick — AnalyserNode only updates if it has a
downstream path to `destination`.

So the clock's entire "sampling formula" is whatever the browser does inside
`getByteFrequencyData()`. Per the W3C Web Audio spec, that's exactly:

1. Take the latest 256 time-domain samples.
2. Multiply by a Blackman window: `w[n] = 0.42 − 0.5·cos(2πn/N) + 0.08·cos(4πn/N)`.
3. FFT, normalized by `1/N`: `X[k] = (1/N) Σ x̂[n] · e^(−2πikn/N)`.
4. EMA smoothing with `smoothingTimeConstant = 0.8`:
   `Ŷ[k] = 0.8 · Ŷ_prev[k] + 0.2 · |X[k]|`.
5. Convert to dB: `Y[k] = 20 · log10(Ŷ[k])`.
6. Map to byte with `minDecibels = −100`, `maxDecibels = −30`:
   `b[k] = floor(255 / (maxDb − minDb) · (Y[k] − minDb))`, clamped to `[0, 255]`.

Then `bass` is just the mean of `frequencies[0..4]`. That's the whole pipeline.

---

## 2. What the offline analyzer does

Node.js has no Web Audio API, so "copy verbatim" means reimplementing those six
steps by hand. That's [src/clock_analysis.mjs](../../src/clock_analysis.mjs).

| Spec step                                | Implementation |
|------------------------------------------|----------------|
| Blackman coefficients `0.42 / 0.5 / 0.08`, precomputed | [clock_analysis.mjs:48-59](../../src/clock_analysis.mjs#L48-L59) |
| Radix-2 Cooley–Tukey FFT (256-point)     | [clock_analysis.mjs:63-99](../../src/clock_analysis.mjs#L63-L99) |
| `1/N` normalize, τ=0.8 smoothing, `20·log10`, byte clamp | [clock_analysis.mjs:135-152](../../src/clock_analysis.mjs#L135-L152) |
| Emits `{ frequencies }` — `bass` is omitted offline (client derives it; see §5) | [clock_analysis.mjs:154](../../src/clock_analysis.mjs#L154) |

Constants (`smoothingTimeConstant`, `minDecibels`, `maxDecibels`, fftSize, bass
bin count) are pinned to AnalyserNode defaults. Nothing is tunable.

### What had to change to run offline (framing, not formula)

Most of these are scaffolding because we're not inside a live audio graph —
they don't touch the math. The `INPUT_GAIN` item is the one deliberate
departure from the AnalyserNode defaults, explained below.

- **Input source.** Instead of a microphone stream, we read mono 48 kHz float32
  PCM from `yt-dlp | ffmpeg -f f32le -ac 1 -ar 48000` ([src/youtube.mjs](../../src/youtube.mjs)).
- **Pre-FFT input gain (`INPUT_GAIN = 0.3`).** The live clock's mic picks up
  speaker output through the room, which attenuates the signal by roughly
  −6 to −10 dB of loopback plus the mic's own gain staging. Reading full-scale
  PCM straight from the file skips that stage, so loud bass transients
  saturate byte 255 on many adjacent bins and the render layer's linear
  `(value/255)*60` radius mapping collapses them onto a single radius — the
  visible flat-top arc on the halo. Multiplying the windowed input by
  `INPUT_GAIN` approximates the missing speaker→mic attenuation so the
  emitted bytes match what the live clock actually sees on the same track.
  The constant is the only tunable in this file; adjust in `[0.1, 0.7]` if a
  reference track visually diverges from the live clock.
- **Manual clock.** The live engine relies on `setTimeout(..., 16)` to advance
  time. Offline we step through samples with `HOP = 48000 / 60 = 800`; frame
  `i` takes `samples[i*HOP .. i*HOP + 256)` as its 256-sample window.
- **Frame count aligned with `analysis`.** `totalFrames` uses the same formula
  as [src/audio.mjs](../../src/audio.mjs), so `analysis[i]` and `clock_analysis[i]`
  describe the same instant and can be read in lockstep.
- **Smoothing state.** `Ŷ_prev` starts at 0 and carries across frames — matches
  the spec's "first call smooths against 0" behaviour, so the first few frames
  ease in from silence exactly like the live clock on startup.
- **PCM reuse.** `analyze()` in [src/audio.mjs](../../src/audio.mjs) now returns the
  decoded `samples` so both the Meyda-based `analysis` and the clock analysis
  share one decode pass.

### What was deliberately NOT done

- No rescaling of bytes to 0..1 — they stay as the `Uint8Array` values the
  clock expects.
- No second-layer EMA / smoothing on top of the 0.8 τ from the spec.
- No alternative window function — it's Blackman, not Hann/Hamming.
- No changes to `minDecibels / maxDecibels / smoothingTimeConstant`.
- No 64-band downsampling. That happens in
  `virtual-music-clock/app/page.js` on the
  render side with a 0.15 lerp — copy that verbatim on the frontend if you
  want the identical look; don't bake it into the stored data.
- No touching of the 5-bin bass average.

Net effect: the stored frame is byte-for-byte what the live clock's WebSocket
would emit if you played the same audio through a microphone loopback.

---

## 3. Storage layout

Clock data is **not** in the `Songs` row. Every song has its byte-scaled FFT
frames written as a small binary blob inside the `song-blobs` public Storage
bucket:

```
song-blobs/clock/<video_id>.bin
```

The row's `metadata.clockBlob` field carries the relative path (e.g.
`"clock/dQw4w9WgXcQ.bin"`). See [data-contracts.md §5](data-contracts.md) for
the authoritative binary layout spec; in short:

```
Header (8 bytes):
  bytes 0-3 : ASCII "SCBN"  — magic
  byte  4   : 0x01          — version
  bytes 5-7 : 0x00          — reserved

Frame (128 bytes, repeated metadata.frameCount times):
  bytes 0-127 : frequencies[0..127]   — uint8 byte-scaled FFT bins
```

Frame `i` of the clock blob corresponds to audio time `i / metadata.fps`
seconds, and is **row-aligned** with frame `i` of the analysis blob
(`metadata.analysisBlob`) — you can drive both visualizers off a single
`idx` value.

Relevant keys still live in `metadata.clock` for any consumer that wants them
at hand (they also match the constants burned into every blob):

```ts
metadata.clock = {
  fftSize: 256,
  binCount: 128,               // == frequencies.length in each frame
  smoothingTimeConstant: 0.8,  // AnalyserNode default
  minDecibels: -100,           // AnalyserNode default
  maxDecibels: -30,            // AnalyserNode default
  bassBinCount: 5,             // use this many bins when deriving bass
};
```

---

## 4. Fetching from Storage

The bucket is public, so the anon Supabase key is enough on the client — you
don't need a signed URL. Pattern:

```js
// 1. Pull the row (tiny, ~50 KB)
const { data: song } = await supabase
  .from('Songs')
  .select('video_id, metadata')
  .eq('video_id', videoId)
  .single();

// 2. Resolve the public URL and download the blob as an ArrayBuffer
const { data: url } = supabase.storage
  .from('song-blobs')
  .getPublicUrl(song.metadata.clockBlob);
const buffer = await fetch(url.publicUrl).then(r => r.arrayBuffer());

// 3. Validate + wrap the frame region
const bytes = new Uint8Array(buffer);
const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
if (magic !== 'SCBN') throw new Error('bad clock magic');
if (bytes[4] !== 1)   throw new Error('unsupported clock version');

const HEADER = 8;
const FRAME_SIZE = 128;
const frameCount = song.metadata.frameCount;
const frames = new Uint8Array(buffer, HEADER, frameCount * FRAME_SIZE);
```

Blobs are served with `Cache-Control: max-age=31536000`, so a repeat visit
hits the browser / CDN cache with no download. Cache the decoded `Uint8Array`
in memory for the lifetime of the current song selection — don't re-fetch on
seek.

Only fetch this blob on pages that actually render the clock halo. Pages that
only need `analysis` (spectrum, lyrics, beat) can skip it entirely.

---

## 5. Playback sync

Drive frame selection off your audio source's `currentTime` (YouTube iframe
API, `<audio>` element, whatever) — never a local clock — so the visuals stay
in sync across seeks, buffering, and pauses.

```js
const FPS = song.metadata.fps;   // 60
const N   = song.metadata.clock.bassBinCount;   // 5

function sampleClockBytes(currentTimeSec) {
  const idx = Math.min(song.metadata.frameCount - 1, Math.floor(currentTimeSec * FPS));
  return frames.subarray(idx * 128, (idx + 1) * 128);  // zero-copy view into the blob
}

function meanBass(freq) {
  let s = 0;
  for (let i = 0; i < N; i++) s += freq[i];
  return s / N;
}

function tick() {
  const t = ytPlayer.getCurrentTime();
  const freq = sampleClockBytes(t);
  render(meanBass(freq), freq);
  requestAnimationFrame(tick);
}
```

`freq` is a zero-copy `Uint8Array` subarray — already 0..255 byte values, the
same shape the original `getByteFrequencyData()` consumer used. Pass it
straight into whatever rendering code expects that input.

The live engine's `bass` scalar is `mean(frequencies[0..N])`; derive it
client-side as shown above. `N` comes from `metadata.clock.bassBinCount`
(currently 5, matches the live engine).

---

## 6. Size budget

Per-frame size is now a hard constant:

```
file_size = 8 + frameCount * 128
frameCount = floor((duration_sec * 48000 - 2048) / 800) + 1
```

| Duration | Frames | Blob size |
|---------:|-------:|----------:|
| 3 min    | ~10,800 | ~1.35 MB |
| 4 min    | ~14,400 | ~1.80 MB |
| 8 min    | ~28,800 | ~3.60 MB |
| 12 min   | ~43,200 | ~5.50 MB |

These are exact (the packer emits a fixed-size record); the CDN further
gzip-compresses binary content when the client requests it, though gzip's
win on byte-dense uint8 data is modest (~10–20%).

For a combined row + both blobs size estimate (analysis + clock), see
[data-contracts.md §9](data-contracts.md).

---

## 7. Gotchas

- **Do not re-smooth.** τ=0.8 is already baked in per spec. A second EMA on top
  will feel laggy.
- **Do not rescale bytes.** They're already clamped to 0..255 against the
  spec's −100/−30 dB window.
- **Frame 0 is quiet.** `Ŷ_prev` starts at 0, so the first few frames ramp up
  from silence — exactly like the live clock on startup. Not a bug.
- **Check the magic bytes and version byte when parsing.** The header exists
  precisely so consumers can fail loudly if the blob format evolves. Never
  assume offset 0 is the first frame.
- **Don't cache across `--force` re-runs of `analyzer.mjs`.** A forced re-run
  overwrites the blob at the same URL; the `Cache-Control: max-age=31536000`
  header means browsers may keep the old bytes. If you ever need a hard
  invalidation, append a version query string or switch to hashed filenames.
