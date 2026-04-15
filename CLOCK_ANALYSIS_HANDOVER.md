# Clock Analysis — Frontend Handover

A new `clock_analysis` column on `"Songs"` replays a YouTube song as if it were
being fed through `virtual-music-clock`'s `audio-engine` AnalyserNode in real
time. Use it to drive clock-style visualizers without running Web Audio on the
client.

---

## 1. How the original clock samples audio

See [virtual-music-clock/app/audio-engine/page.jsx](virtual-music-clock/app/audio-engine/page.jsx).
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
steps by hand. That's [src/clock_analysis.mjs](src/clock_analysis.mjs).

| Spec step                                | Implementation |
|------------------------------------------|----------------|
| Blackman coefficients `0.42 / 0.5 / 0.08`, precomputed | [clock_analysis.mjs:48-59](src/clock_analysis.mjs#L48-L59) |
| Radix-2 Cooley–Tukey FFT (256-point)     | [clock_analysis.mjs:63-99](src/clock_analysis.mjs#L63-L99) |
| `1/N` normalize, τ=0.8 smoothing, `20·log10`, byte clamp | [clock_analysis.mjs:135-152](src/clock_analysis.mjs#L135-L152) |
| Emits `{ frequencies }` — `bass` is omitted offline (client derives it; see §5) | [clock_analysis.mjs:154](src/clock_analysis.mjs#L154) |

Constants (`smoothingTimeConstant`, `minDecibels`, `maxDecibels`, fftSize, bass
bin count) are pinned to AnalyserNode defaults. Nothing is tunable.

### What had to change to run offline (framing, not formula)

Most of these are scaffolding because we're not inside a live audio graph —
they don't touch the math. The `INPUT_GAIN` item is the one deliberate
departure from the AnalyserNode defaults, explained below.

- **Input source.** Instead of a microphone stream, we read mono 48 kHz float32
  PCM from `yt-dlp | ffmpeg -f f32le -ac 1 -ar 48000` ([src/youtube.mjs](src/youtube.mjs)).
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
  as [src/audio.mjs](src/audio.mjs), so `analysis[i]` and `clock_analysis[i]`
  describe the same instant and can be read in lockstep.
- **Smoothing state.** `Ŷ_prev` starts at 0 and carries across frames — matches
  the spec's "first call smooths against 0" behaviour, so the first few frames
  ease in from silence exactly like the live clock on startup.
- **PCM reuse.** `analyze()` in [src/audio.mjs](src/audio.mjs) now returns the
  decoded `samples` so both the Meyda-based `analysis` and the clock analysis
  share one decode pass.

### What was deliberately NOT done

- No rescaling of bytes to 0..1 — they stay as the `Uint8Array` values the
  clock expects.
- No second-layer EMA / smoothing on top of the 0.8 τ from the spec.
- No alternative window function — it's Blackman, not Hann/Hamming.
- No changes to `minDecibels / maxDecibels / smoothingTimeConstant`.
- No 64-band downsampling. That happens in
  [virtual-music-clock/app/page.js](virtual-music-clock/app/page.js) on the
  render side with a 0.15 lerp — copy that verbatim on the frontend if you
  want the identical look; don't bake it into the stored data.
- No touching of the 5-bin bass average.

Net effect: the stored frame is byte-for-byte what the live clock's WebSocket
would emit if you played the same audio through a microphone loopback.

---

## 3. Row shape (clock_analysis column only)

```ts
type Song = {
  // ...see DATA_CONTRACTS.md for full row shape...
  metadata: {
    clock: {
      fftSize: 256;
      binCount: 128;               // == frequencies.length
      smoothingTimeConstant: 0.8;
      minDecibels: -100;
      maxDecibels: -30;
      bassBinCount: 5;             // use this many bins when deriving bass client-side
    };
    // ...other metadata fields documented in DATA_CONTRACTS.md...
  };
  clock_analysis: Array<{
    frequencies: number[];         // length 128, each 0..255
    // bass is NOT stored — derive client-side as mean(frequencies[0..bassBinCount-1])
  }> | null;
};
```

- **Frame rate:** `metadata.fps` (always 60).
- **Frame count:** identical to `analysis` — the two arrays are row-aligned.
- **Null case:** `clock_analysis` can be null for any row ingested before this
  feature shipped. Re-run `analyzer.mjs --force` to populate it, or guard the
  render path with a null check.

---

## 4. Fetching

```js
const { data } = await supabase
  .from('Songs')
  .select('video_id, metadata, clock_analysis')
  .eq('video_id', videoId)
  .single();
```

Payload is large (see size table below) — only select `clock_analysis` on the
page that actually renders it, and cache the decoded array in memory per song.

---

## 5. Playback sync

Drive frame selection off the YouTube player's `getCurrentTime()`, not a local
clock, so it stays in sync across seeks and buffering.

```js
const FPS = song.metadata.fps;                       // 60
const frames = song.clock_analysis;                  // may be null

function sampleClock(currentTimeSec) {
  if (!frames) return null;
  const idx = Math.min(frames.length - 1, Math.floor(currentTimeSec * FPS));
  return frames[idx];                                // { frequencies }
}

// Derive bass the same way the live engine does: mean of first N bins.
// N comes from metadata.clock.bassBinCount (5 by default).
const N = song.metadata.clock.bassBinCount;
function meanBass(freq) {
  let s = 0;
  for (let i = 0; i < N; i++) s += freq[i];
  return s / N;
}

function tick() {
  const t = ytPlayer.getCurrentTime();               // YT IFrame API
  const frame = sampleClock(t);
  if (frame) render(meanBass(frame.frequencies), frame.frequencies);
  requestAnimationFrame(tick);
}
```

Every element of `frequencies` is already a 0..255 value matching
`getByteFrequencyData()` output — pass it straight into whatever rendering
code used that before. The live engine's `bass` scalar is `mean(frequencies[0..N])`
where `N = metadata.clock.bassBinCount`; derive it client-side as shown.

---

## 6. Size budget

Each frame serializes to roughly **465 bytes** of JSON:
`{"frequencies":[v0,v1,...,v127]}` where each byte value is 1–3 digits plus a
comma. Total per song:

```
frames   = floor((duration_sec * 48000 - 2048) / 800) + 1
bytes    ≈ frames * 465
```

So a 4 min song ≈ 14,400 frames ≈ 6.7 MB raw JSON; a 12 min song ≈ 20 MB raw.
Gzip over the wire cuts this roughly in half. Don't re-fetch on seek.

This is the exact row size as written by `analyzer.mjs`; run with `--dry-run`
to measure a specific song if you need a real number.

---

## 7. Gotchas

- **Do not re-smooth.** τ=0.8 is already baked in per spec. A second EMA on top
  will feel laggy.
- **Do not rescale bytes.** They're already clamped to 0..255 against the
  spec's −100/−30 dB window.
- **Frame 0 is quiet.** `Ŷ_prev` starts at 0, so the first few frames ramp up
  from silence — exactly like the live clock on startup. Not a bug.
- **Old rows have `clock_analysis = null`.** Re-run `analyzer.mjs --force` on
  any song you need clock data on, or guard the render path.
