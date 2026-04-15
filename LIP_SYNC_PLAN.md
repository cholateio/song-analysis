# Lip-Sync Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a virtual singer whose mouth shape automatically matches the singing voice — no manual animation, no per-song tuning.

**Architecture:** Three-tier progressive pipeline. Tier 0 ships immediately from the existing analysis binary blob (client-only MVP). Tier 1 adds a Python source-separation step (Demucs) to isolate the vocal track and drives the mouth off a clean vocal RMS. Tier 2 extracts MFCCs from the isolated vocal and runs a lightweight client-side classifier to map each frame to one of five Japanese vowel visemes (a/i/u/e/o). We deliberately skip ASR-based text alignment (Whisper/MFA) because it is unreliable on sung Japanese audio.

**Tech Stack:**
- Backend pipeline: existing Node.js analyzer (`analyzer.mjs` + `src/audio.mjs` + `src/binary_pack.mjs`), new Python subprocess step (Demucs v4 `htdemucs`), Meyda (MFCC extraction)
- Frontend: Three.js + VRM model with blendshapes `aa / ih / ou / ee / oh`
- Storage: existing Supabase `song-blobs` Storage bucket; new tiers extend the analysis binary frame layout and bump both the blob version byte and `metadata.schemaVersion`. See [DATA_CONTRACTS.md §8](DATA_CONTRACTS.md) for the versioning protocol.

> **Note on binary format evolution.** Each tier adds new bytes to the
> per-frame layout defined in [DATA_CONTRACTS.md §4](DATA_CONTRACTS.md). The
> detailed code samples in Tier 1 and Tier 2 below describe the feature
> extraction logic (Demucs + Meyda MFCC) but reference the pre-binary
> in-memory frame shape for readability. When a tier is actually implemented,
> update [src/binary_pack.mjs](src/binary_pack.mjs) to write the new fields
> and bump `BIN_VERSION`; [DATA_CONTRACTS.md](DATA_CONTRACTS.md) must be
> updated in the same commit.

---

## 0. Context & Current State

### What we already have

| Asset | Location | Relevant to |
|---|---|---|
| Per-frame 60 FPS spectrum `v[64]` (uint8) | `song-blobs/analysis/<video_id>.bin` (bytes 0–63 of each frame) | All tiers |
| Per-frame RMS `r`, spectral centroid `c`, beat `k` | Same blob, bytes 64–66 of each frame | Tier 0 fallback |
| Log band edges `bandEdges[65]` | `metadata.bandEdges` | Tier 0 vocal-band derivation |
| Binary packer | [src/binary_pack.mjs](src/binary_pack.mjs) | Tier 1 / Tier 2 frame extension |
| YouTube audio pipeline | [src/youtube.mjs](src/youtube.mjs) `spawnAudioPipeline()` | Tier 1 integration point |
| Analyzer entry point | [analyzer.mjs](analyzer.mjs) | Tier 1, Tier 2 |
| Meyda feature extraction | [src/audio.mjs](src/audio.mjs) `analyze()` | Tier 2 MFCC |

### What we don't have

- Isolated vocal audio (YouTube mixes are polluted with instruments in the 300–3400 Hz vocal band)
- Any formant / MFCC / phoneme features
- Per-frame viseme labels
- Any VRM / Three.js frontend code (lives in a separate project — this plan documents the data contract)

### Non-goals (explicit)

- **No Whisper / WhisperX transcription.** Word-level timestamps on sung Japanese audio are ±100–300 ms — too coarse for 60 FPS mouth animation. YouTube ja captions are also line-level only and parser deliberately strips inline timing (see [src/youtube.mjs:148](src/youtube.mjs#L148)).
- **No MFA (Montreal Forced Aligner).** Requires exact lyric text matching sung content; YouTube captions are often paraphrased.
- **No per-syllable Japanese kana alignment.** Replaced by spectral viseme classification in Tier 2, which does not depend on text.
- **No real-time source separation in the browser.** Demucs is backend-only, one-off per song.

---

## 1. File Structure

### Tier 0 (MVP) — front-end only

No backend or schema changes. Ships as a ~60-line JS helper that any consumer of the existing analysis binary blob can drop in.

- **Create:** `examples/lip-sync-mvp.js` (reference implementation; can be copied into downstream frontend project)

### Tier 1 — vocal isolation

- **Create:** `src/vocal_separation.mjs` — wraps Python subprocess, returns path to isolated vocal WAV
- **Create:** `scripts/run_demucs.py` — tiny Python entry script invoking Demucs programmatically
- **Modify:** [analyzer.mjs](analyzer.mjs) — call `separateVocals()` before `analyze()`, run analyzer twice (once on mix for existing fields, once on vocal for `rVoc`)
- **Modify:** [src/audio.mjs](src/audio.mjs) — add optional second-pass mode that extracts only vocal-RMS features (skips full spectrum re-computation)
- **Create:** `docs/demucs-setup.md` — one-page Python env setup (venv + `pip install demucs`)

### Tier 2 — spectral viseme features

- **Modify:** [src/audio.mjs](src/audio.mjs) — extend second-pass analyzer to extract `mfcc[13]` per frame from isolated vocal, uint8 quantized
- **Create:** `scripts/train-viseme-classifier.mjs` — one-off trainer: loads labeled reference vowel samples, fits 5-centroid k-means on MFCC space, exports `viseme-centroids.json`
- **Create:** `reference/vowels/` directory with 5 labeled reference clips (a/i/u/e/o sung at steady pitch, ~2 seconds each, public-domain or user-recorded)
- **Create:** `examples/lip-sync-viseme.js` — reference client-side classifier that loads centroids + per-frame MFCCs, outputs 5 blendshape weights

### Schema evolution (analysis binary frame layout)

Each tier extends the analysis frame with new trailing bytes and bumps the
blob version byte (offset 4 of the header) + `metadata.schemaVersion` in
lockstep.

```text
Tier 0 (current, version 1):  67 bytes/frame
  bytes  0-63 : v[64]
  byte   64   : r
  byte   65   : c
  byte   66   : k

Tier 1 (version 2):           68 bytes/frame
  bytes  0-66 : (unchanged)
  byte   67   : rVoc          (uint8, isolated vocal RMS)

Tier 2 (version 3):           81 bytes/frame
  bytes  0-67 : (unchanged)
  bytes 68-80 : voc[13]       (uint8 quantized MFCC)

metadata Tier 0 (current):    { schemaVersion: 1, duration, fps, bpm, sampleRate, bandCount,
                                bandEdges, vScale, centroidMaxHz, frameCount, analysisBlob,
                                clockBlob, clock }
metadata after T1:             + schemaVersion: 2, vocalIsolation: 'demucs-htdemucs-v4'
metadata after T2:             + schemaVersion: 3, mfccCount: 13, mfccMinDb, mfccMaxDb
```

Consumers MUST check the blob version byte on load and fail if it's higher
than they support. Because the layout is append-only, version-N consumers can
still read the first N-tier's worth of bytes from a version-M>N blob if they
choose to — but that's a conscious compatibility decision, not an automatic
guarantee.

---

## Tier 0 — MVP Ships Immediately

**Deliverable:** a JS helper that any consumer can drop into their Three.js / VRM frontend to drive `jawOpen` / `aa` blendshape from the existing analysis binary blob.

**Why it matters:** proves the data contract works end-to-end and gives visible feedback the same day. Has known flaws (instrumentals trigger the mouth) — these are the motivation for Tier 1.

**Acceptance criteria:**
- Given a Song row loaded from Supabase, the helper produces one `jawOpen` float in [0, 1] per frame at 60 FPS.
- Mouth visibly opens during vocal sections and closes during silence.
- Smoothing removes frame-to-frame jitter (no mouth chatter).
- Works with zero backend changes.

### Task T0.1: Create the reference MVP helper

**Files:**
- Create: `examples/lip-sync-mvp.js`

- [ ] **Step 1: Write the full helper**

```js
// examples/lip-sync-mvp.js
//
// Tier 0 lip-sync MVP — drives a single `jawOpen` / `aa` blendshape weight
// from the analysis binary blob. No backend changes required.
//
// The caller is responsible for fetching the blob (as an ArrayBuffer) from
// Storage first; see DATA_CONTRACTS.md §4 for the layout and a reference
// loadAnalysis() helper.
//
// Usage:
//   const analysisBuffer = await fetchAnalysisBlob(song);  // ArrayBuffer
//   const driver = createMvpLipSync(song, analysisBuffer);
//   function frame() {
//     const t = audioElement.currentTime;
//     const jawOpen = driver(t);
//     vrm.expressionManager.setValue('aa', jawOpen);
//     requestAnimationFrame(frame);
//   }

const HEADER = 8;
const FRAME_SIZE = 67;
const BAND_COUNT = 64;

export function createMvpLipSync(song, analysisBuffer, opts = {}) {
  const {
    smoothing = 0.7,   // EMA alpha for smoothed vocal RMS
    threshold = 0.25,  // values below this map to closed mouth
    gain      = 1.3,   // post-threshold amplification
  } = opts;

  // Validate header
  const bytes = new Uint8Array(analysisBuffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'SABN') throw new Error(`bad analysis magic: ${magic}`);
  if (bytes[4] !== 1)   throw new Error(`unsupported analysis version: ${bytes[4]}`);

  const meta = song.metadata;
  const fps = meta.fps;
  const vScale = meta.vScale ?? 255;
  const frameCount = meta.frameCount;
  const frames = new Uint8Array(analysisBuffer, HEADER, frameCount * FRAME_SIZE);

  // Indices of v[] bands whose frequency range overlaps the vocal band 300-3400 Hz.
  const edges = meta.bandEdges;
  const vocalBandIdx = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    if (hi >= 300 && lo <= 3400) vocalBandIdx.push(i);
  }
  if (vocalBandIdx.length === 0) throw new Error('no vocal bands found in bandEdges');

  let smoothed = 0;

  return function sampleJaw(currentTimeSec) {
    const idx = Math.min(frameCount - 1, Math.floor(currentTimeSec * fps));
    const off = idx * FRAME_SIZE;

    let sum = 0;
    for (const j of vocalBandIdx) sum += frames[off + j] / vScale;
    const voRms = sum / vocalBandIdx.length;

    smoothed = smoothing * smoothed + (1 - smoothing) * voRms;

    const gated = Math.max(0, (smoothed - threshold) * gain);
    return Math.min(1, gated);
  };
}
```

- [ ] **Step 2: Sanity-check data shape with inline node smoke test**

Run:

```bash
node -e "
import('./examples/lip-sync-mvp.js').then(({ createMvpLipSync }) => {
  // Build a fake 2-frame blob matching the SABN v1 layout.
  const HEADER = 8, FRAME_SIZE = 67;
  const buf = new ArrayBuffer(HEADER + 2 * FRAME_SIZE);
  const b = new Uint8Array(buf);
  b[0] = 0x53; b[1] = 0x41; b[2] = 0x42; b[3] = 0x4E; b[4] = 1;  // SABN v1
  // Frame 0: loud, mid-frequency energy
  for (let j = 20; j < 40; j++) b[HEADER + j] = 200;
  b[HEADER + 64] = 200;  // r
  // Frame 1: quiet
  for (let j = 20; j < 40; j++) b[HEADER + FRAME_SIZE + j] = 40;
  b[HEADER + FRAME_SIZE + 64] = 40;

  const fakeSong = {
    metadata: {
      fps: 60, vScale: 255, frameCount: 2,
      bandEdges: Array.from({ length: 65 }, (_, i) => 20 * Math.pow(800, i / 64)),
    },
  };
  const jaw = createMvpLipSync(fakeSong, buf);
  console.log('loud frame  jaw =', jaw(0 / 60));
  console.log('quiet frame jaw =', jaw(1 / 60));
});
"
```

Expected: loud frame produces jawOpen > 0.1, quiet frame produces jawOpen close to 0.

- [ ] **Step 3: Commit**

```bash
git add examples/lip-sync-mvp.js
git commit -m "feat: tier 0 lip-sync MVP (client-side helper)"
```

### Task T0.2: Document the MVP data contract

**Files:**
- Modify: [LIP_SYNC_PLAN.md](LIP_SYNC_PLAN.md) — add a "Using the MVP" block showing Three.js integration

- [ ] **Step 1: Append a Three.js integration example to this plan doc**

Append this section to the end of this file:

````markdown
## Appendix A: MVP frontend integration (Three.js + VRM)

```js
import { createClient } from '@supabase/supabase-js';
import { createMvpLipSync } from './examples/lip-sync-mvp.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 1. Pull the row (tiny)
const { data: song } = await supabase
  .from('Songs')
  .select('*')
  .eq('video_id', videoId)
  .single();

// 2. Pull the analysis blob (~1 MB for 4 min)
const { data: url } = supabase.storage
  .from('song-blobs')
  .getPublicUrl(song.metadata.analysisBlob);
const analysisBuffer = await fetch(url.publicUrl).then(r => r.arrayBuffer());

// 3. Wire up the MVP helper
const sampleJaw = createMvpLipSync(song, analysisBuffer);

function tick() {
  const t = audioElement.currentTime;
  const weight = sampleJaw(t);
  vrm.expressionManager.setValue('aa', weight);
  vrm.update(clock.getDelta());
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
```

**Known limitations:**
- Instrument energy in 300–3400 Hz will trigger the mouth during loud instrumental sections. Fixed in Tier 1.
- Only opens/closes the mouth. Does not distinguish a/i/u/e/o. Fixed in Tier 2.
````

- [ ] **Step 2: Commit**

```bash
git add LIP_SYNC_PLAN.md
git commit -m "docs: add MVP frontend integration example"
```

---

## Tier 1 — Vocal Isolation (Demucs)

**Deliverable:** the analysis binary blob gains a new `rVoc` byte per frame (isolated vocal RMS, uint8 quantized). Frame size grows from 67 → 68 bytes, blob version byte bumps to 2, and `metadata.schemaVersion` bumps to 2. The frontend uses `rVoc` instead of the vocal-band RMS from Tier 0.

**Why it matters:** removes instrument pollution. Mouth only opens when the singer is actually singing.

**Effort:** ~2–3 days. New Python dependency (Demucs + torch). CPU inference is ~2–5× realtime; a 4-minute song takes ~8–20 minutes on CPU, ~30 seconds on GPU.

**Acceptance criteria:**
- [src/binary_pack.mjs](src/binary_pack.mjs) `ANALYSIS_FRAME_SIZE` is 68 and `BIN_VERSION` is 2.
- `analyzer.mjs --url <url>` writes blobs whose per-frame byte 67 is `rVoc` in [0, 255].
- `metadata.schemaVersion === 2` and `metadata.vocalIsolation === 'demucs-htdemucs-v4'` on new rows.
- Frontend code validates the version byte and reads byte 67 as `rVoc / 255`.
- Demucs failures (missing Python, model download error) fall back to Tier 0 behavior with a warning, not a hard fail: the analyzer still produces a version-1 blob with frame size 67.
- Total added analysis size: ~14 KB/song (1 byte × 14400 frames).
- Frontend integration: one-line swap from vocal-band RMS to `frames[off + 67] / 255` in the MVP helper.

> **Binary-format note.** The code samples in the tasks below describe Demucs
> integration and the Meyda RMS extraction. When implementing, the final step
> of each pass is to write the `rVoc` byte at offset 67 inside
> [src/binary_pack.mjs](src/binary_pack.mjs) and bump both `BIN_VERSION` and
> `metadata.schemaVersion`. [DATA_CONTRACTS.md §4](DATA_CONTRACTS.md) must be
> updated in the same commit.

### Task T1.1: Python environment setup docs

**Files:**
- Create: `docs/demucs-setup.md`

- [ ] **Step 1: Write the setup doc**

```markdown
# Demucs Python Setup

Tier 1 of the lip-sync pipeline requires a Python environment with Demucs installed.
Demucs runs as a subprocess from the Node.js analyzer.

## Requirements

- Python 3.9 or newer
- ~3 GB disk (torch + demucs + model weights)
- Optional: CUDA-capable GPU for 10× speedup

## Install

```bash
# Create a dedicated venv alongside the project
python -m venv .venv-demucs
source .venv-demucs/bin/activate   # Windows: .venv-demucs\Scripts\activate
pip install --upgrade pip
pip install demucs==4.0.1
```

## Model weights (auto-downloaded on first run)

Demucs downloads the `htdemucs` model (~80 MB) on first invocation to
`~/.cache/torch/hub/checkpoints/`. No manual action needed.

## Verify

```bash
python -c "import demucs.separate; print('demucs ok')"
```

Should print `demucs ok` with no traceback.

## Point the analyzer at this environment

Add to `.env`:

```
DEMUCS_PYTHON=/absolute/path/to/.venv-demucs/bin/python
```

On Windows: `DEMUCS_PYTHON=C:\Users\...\song-analysis\.venv-demucs\Scripts\python.exe`
```

- [ ] **Step 2: Commit**

```bash
git add docs/demucs-setup.md
git commit -m "docs: demucs python setup"
```

### Task T1.2: Python Demucs wrapper script

**Files:**
- Create: `scripts/run_demucs.py`

- [ ] **Step 1: Write the Python wrapper**

```python
#!/usr/bin/env python
"""
Demucs wrapper for the song-analysis lip-sync pipeline.

Reads: path to mixed audio file (any format ffmpeg understands)
Writes: isolated vocal WAV at specified output path
Protocol: single line JSON result to stdout on success, non-zero exit + stderr on failure.
"""
import sys
import json
import pathlib
import tempfile
import shutil


def main():
    if len(sys.argv) != 3:
        print("usage: run_demucs.py <input_audio> <output_vocal_wav>", file=sys.stderr)
        sys.exit(2)

    in_path = pathlib.Path(sys.argv[1]).resolve()
    out_path = pathlib.Path(sys.argv[2]).resolve()
    if not in_path.exists():
        print(f"input not found: {in_path}", file=sys.stderr)
        sys.exit(2)

    # demucs.separate API writes into <outdir>/<model>/<stem>/<track>.wav
    # We use a temp dir then move the vocals stem to the requested path.
    import demucs.separate

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        args = [
            "--two-stems", "vocals",
            "-n", "htdemucs",
            "-o", str(tmp_path),
            str(in_path),
        ]
        demucs.separate.main(args)

        # Demucs writes to: tmp/<model>/<stem_basename>/vocals.wav
        stem_dir = tmp_path / "htdemucs" / in_path.stem
        vocal_src = stem_dir / "vocals.wav"
        if not vocal_src.exists():
            print(f"demucs produced no vocal stem at {vocal_src}", file=sys.stderr)
            sys.exit(3)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(vocal_src), str(out_path))

    result = {
        "ok": True,
        "vocal_path": str(out_path),
        "model": "htdemucs-v4",
    }
    print(json.dumps(result))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test manually with a short audio file**

Run:

```bash
# Prereq: venv activated, a short test.wav exists
python scripts/run_demucs.py test.wav /tmp/test_vocal.wav
```

Expected: `{"ok": true, "vocal_path": "/tmp/test_vocal.wav", "model": "htdemucs-v4"}` to stdout, file exists at `/tmp/test_vocal.wav`, and playing it sounds like isolated vocals.

- [ ] **Step 3: Commit**

```bash
git add scripts/run_demucs.py
git commit -m "feat: demucs python wrapper script"
```

### Task T1.3: Node wrapper for the Python subprocess

**Files:**
- Create: `src/vocal_separation.mjs`

- [ ] **Step 1: Write the Node wrapper**

```js
// src/vocal_separation.mjs
//
// Thin wrapper around scripts/run_demucs.py. Runs Demucs as a subprocess and
// returns the path to the isolated vocal WAV. Caller is responsible for
// feeding an input audio file and cleaning up the output afterwards.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';

export class VocalSeparationUnavailable extends Error {
  constructor(reason) {
    super(`vocal separation unavailable: ${reason}`);
    this.name = 'VocalSeparationUnavailable';
  }
}

export async function separateVocals(inputAudioPath) {
  const python = process.env.DEMUCS_PYTHON;
  if (!python) {
    throw new VocalSeparationUnavailable('DEMUCS_PYTHON env var not set');
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'song-vocal-'));
  const outPath = path.join(workDir, 'vocal.wav');
  const script = path.resolve('scripts/run_demucs.py');

  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, inputAudioPath, outPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });

    child.on('error', err => {
      reject(new VocalSeparationUnavailable(`spawn failed: ${err.message}`));
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new VocalSeparationUnavailable(`exit ${code}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim().split('\n').pop());
        if (!result.ok) {
          reject(new VocalSeparationUnavailable(`demucs reported failure: ${JSON.stringify(result)}`));
          return;
        }
        resolve({ vocalPath: result.vocal_path, workDir, model: result.model });
      } catch (err) {
        reject(new VocalSeparationUnavailable(`bad stdout: ${err.message}; raw: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/vocal_separation.mjs
git commit -m "feat: node wrapper for demucs subprocess"
```

### Task T1.4: Extend audio analyzer to compute vocal-only RMS per frame

**Files:**
- Modify: [src/audio.mjs](src/audio.mjs) — add `analyzeVocalRms(samples)` function that runs the same HOP/BUFFER loop but only extracts RMS, returning uint8 quantized array

- [ ] **Step 1: Add the second-pass function**

Add to the bottom of `src/audio.mjs`, before `estimateBpm`:

```js
// Second-pass analyzer for isolated vocal audio. Uses the same HOP and frame
// count as analyze() so rVoc[i] aligns row-for-row with analysis[i].
// Returns { rVoc: uint8[totalFrames] } with per-song peak normalization.
export function analyzeVocalRms(samples) {
  if (samples.length < BUFFER_SIZE) {
    throw new Error(`vocal audio too short: ${samples.length} samples`);
  }
  const totalFrames = Math.floor((samples.length - BUFFER_SIZE) / HOP) + 1;
  const raw = new Float32Array(totalFrames);
  let rMax = 0;

  for (let i = 0; i < totalFrames; i++) {
    const start = i * HOP;
    let sumSq = 0;
    for (let n = 0; n < BUFFER_SIZE; n++) {
      const s = samples[start + n];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / BUFFER_SIZE);
    raw[i] = rms;
    if (rms > rMax) rMax = rms;
  }

  const rVoc = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    rVoc[i] = rMax > 0 ? Math.min(V_SCALE, Math.round((raw[i] / rMax) * V_SCALE)) : 0;
  }
  return { rVoc };
}
```

- [ ] **Step 2: Verify with synthetic smoke test**

Run:

```bash
node -e "
import('./src/audio.mjs').then(m => {
  const SR = m.SAMPLE_RATE;
  const s = new Float32Array(SR * 2);
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (i / SR));
  const r = m.analyzeVocalRms(s);
  console.log('frames:', r.rVoc.length);
  console.log('rVoc[0..3]:', r.rVoc.slice(0, 4));
  console.log('max:', Math.max(...r.rVoc));
  if (!r.rVoc.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    console.error('FAIL: not uint8');
    process.exit(1);
  }
  console.log('OK');
});
"
```

Expected: frames > 100, rVoc is uint8, max ≈ 255.

- [ ] **Step 3: Commit**

```bash
git add src/audio.mjs
git commit -m "feat: analyzeVocalRms second-pass for isolated vocal"
```

### Task T1.5: Wire vocal separation into the main analyzer

**Files:**
- Modify: [analyzer.mjs](analyzer.mjs) — add vocal separation step, load vocal WAV via ffmpeg, feed to `analyzeVocalRms`, merge `rVoc` into analysis frames
- Modify: [src/youtube.mjs](src/youtube.mjs) — expose a helper that saves decoded PCM to a WAV file on disk (needed as Demucs input)

- [ ] **Step 1: Add a PCM-to-WAV helper in src/youtube.mjs**

Add to `src/youtube.mjs`:

```js
import { writeFile } from 'node:fs/promises';

// Write a 48 kHz 32-bit float mono PCM Float32Array to a minimal WAV file.
// Used to hand decoded audio off to Demucs, which needs a file on disk.
export async function writeFloat32Wav(samples, outPath, sampleRate = 48000) {
  const byteRate = sampleRate * 4;
  const dataSize = samples.byteLength;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);         // PCM fmt chunk size
  buf.writeUInt16LE(3, 20);          // IEEE float
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(4, 32);          // block align
  buf.writeUInt16LE(32, 34);         // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 44);
  await writeFile(outPath, buf);
}
```

- [ ] **Step 2: Add a WAV reader in src/audio.mjs**

Add to `src/audio.mjs`:

```js
import { readFile } from 'node:fs/promises';

// Read a 32-bit float mono WAV (the exact format writeFloat32Wav produces,
// or whatever Demucs outputs after we re-encode to 48k mono float32).
export async function readFloat32Wav(path) {
  const buf = await readFile(path);
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WAVE') {
    throw new Error(`not a WAV: ${path}`);
  }
  // Find data chunk
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const samples = new Float32Array(buf.buffer, buf.byteOffset + off + 8, size / 4);
      return new Float32Array(samples);  // copy
    }
    off += 8 + size;
  }
  throw new Error(`no data chunk in ${path}`);
}
```

- [ ] **Step 3: Orchestrate vocal separation in analyzer.mjs**

Modify `analyzer.mjs` around the existing `const analysis = await analyzePromise;` block. Replace:

```js
  const analysis = await analyzePromise;
  await done;
  process.stdout.write('\n');
  logOk(`analysis: ${analysis.frames.length} frames, ${analysis.bandCount} bins, BPM ${analysis.bpm ?? 'unknown'}`);

  const clock = clockAnalyze(analysis.samples);
  logOk(`clock_analysis: ${clock.frames.length} frames, ${clock.binCount} bins (fftSize ${clock.fftSize})`);
```

with:

```js
  const analysis = await analyzePromise;
  await done;
  process.stdout.write('\n');
  logOk(`analysis: ${analysis.frames.length} frames, ${analysis.bandCount} bins, BPM ${analysis.bpm ?? 'unknown'}`);

  const clock = clockAnalyze(analysis.samples);
  logOk(`clock_analysis: ${clock.frames.length} frames, ${clock.binCount} bins (fftSize ${clock.fftSize})`);

  // Tier 1: vocal isolation. Optional — fails soft to leave rVoc undefined.
  let vocalIsolationTag = null;
  try {
    const { separateVocals, VocalSeparationUnavailable } = await import('./src/vocal_separation.mjs');
    const { writeFloat32Wav } = await import('./src/youtube.mjs');
    const { analyzeVocalRms, readFloat32Wav } = await import('./src/audio.mjs');
    const { tmpdir } = await import('node:os');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const path = await import('node:path');

    const workDir = await mkdtemp(path.join(tmpdir(), 'song-mix-'));
    const mixPath = path.join(workDir, 'mix.wav');
    try {
      await writeFloat32Wav(analysis.samples, mixPath, analysis.sampleRate);
      const sep = await separateVocals(mixPath);
      vocalIsolationTag = sep.model;
      const vocalSamples = await readFloat32Wav(sep.vocalPath);
      const { rVoc } = analyzeVocalRms(vocalSamples);
      const n = Math.min(rVoc.length, analysis.frames.length);
      for (let i = 0; i < n; i++) analysis.frames[i].rVoc = rVoc[i];
      logOk(`vocal_rms: ${n} frames via ${sep.model}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    logWarn(`vocal isolation skipped: ${err.message}`);
  }
```

And update the metadata block to include the tag when present. Replace:

```js
      vScale: analysis.vScale,
      centroidMaxHz: analysis.centroidMaxHz,
      clock: {
```

with:

```js
      vScale: analysis.vScale,
      centroidMaxHz: analysis.centroidMaxHz,
      ...(vocalIsolationTag ? { vocalIsolation: vocalIsolationTag } : {}),
      clock: {
```

- [ ] **Step 4: End-to-end dry run on a short YouTube video**

Run (requires Demucs venv + short test video, e.g. a 30-second YouTube clip):

```bash
DEMUCS_PYTHON=/abs/path/to/.venv-demucs/bin/python node analyzer.mjs --url <short-test-url> --dry-run
```

Expected: output includes `✓ vocal_rms: N frames via htdemucs-v4` and the dry-run size report. The inserted `rVoc` values should be uint8 per frame.

- [ ] **Step 5: Verify backward compat**

Run without the env var:

```bash
node analyzer.mjs --url <short-test-url> --dry-run
```

Expected: output includes `! vocal isolation skipped: vocal separation unavailable: DEMUCS_PYTHON env var not set` and completes successfully with Tier 0 data only.

- [ ] **Step 6: Commit**

```bash
git add src/youtube.mjs src/audio.mjs analyzer.mjs
git commit -m "feat: tier 1 vocal isolation via demucs"
```

### Task T1.6: Update MVP helper to prefer rVoc when present

**Files:**
- Modify: `examples/lip-sync-mvp.js`

- [ ] **Step 1: Add rVoc detection**

Replace the `sampleJaw` return function with:

```js
  const hasVoc = frames[0] && 'rVoc' in frames[0];

  return function sampleJaw(currentTimeSec) {
    const idx = Math.min(frames.length - 1, Math.floor(currentTimeSec * fps));
    const f = frames[idx];

    let voRms;
    if (hasVoc) {
      voRms = f.rVoc / vScale;
    } else {
      let sum = 0;
      for (const j of vocalBandIdx) sum += f.v[j] / vScale;
      voRms = sum / vocalBandIdx.length;
    }

    smoothed = smoothing * smoothed + (1 - smoothing) * voRms;
    const gated = Math.max(0, (smoothed - threshold) * gain);
    return Math.min(1, gated);
  };
```

- [ ] **Step 2: Commit**

```bash
git add examples/lip-sync-mvp.js
git commit -m "feat: MVP helper prefers rVoc when present"
```

---

## Tier 2 — Spectral Viseme Classification

**Deliverable:** every frame of every song has a `voc[13]` MFCC vector (uint8 quantized) computed from the isolated vocal. A one-off trainer script produces 5 vowel centroids. A client-side classifier maps each frame to 5 blendshape weights (a/i/u/e/o), smoothed temporally, weighted by `rVoc`.

**Why it matters:** distinguishes vowel shapes (open `a` vs rounded `u` vs flat `i`), not just open/closed. This is the actual "virtual singer" deliverable.

**Why spectral-not-text:** ASR/MFA alignment on sung Japanese is unreliable (±100–300 ms word timing, lyric mismatch). Spectral classification works directly on vocal timbre — no text needed, works on any song, degrades gracefully.

**Known risk:** the 5-vowel k-means classifier is the research-y part. We budget time for tuning and may need to iterate the reference samples. Mitigation: ship T2 behind a feature flag and A/B against the T1 open/closed mouth until the classifier is visually acceptable.

**Acceptance criteria:**
- [src/binary_pack.mjs](src/binary_pack.mjs) `ANALYSIS_FRAME_SIZE` is 81 and `BIN_VERSION` is 3.
- Bytes 68..80 of each frame are the uint8 quantized 13-element MFCC vector.
- `metadata.schemaVersion === 3`, `metadata.mfccCount === 13`, `metadata.mfccMinDb`, `metadata.mfccMaxDb` present.
- `viseme-centroids.json` ships in the repo (computed once, committed).
- `examples/lip-sync-viseme.js` outputs 5 blendshape weights per frame, reading the MFCC slice directly from the blob bytes.
- When a human listener hears a sung `a`, the `aa` blendshape dominates; same for `i/u/e/o`. Measured on a held-out test clip.
- Size impact: +13 bytes/frame × 14400 ≈ +190 KB/song, ≈ +19 MB for 100 songs.

> **Binary-format note.** Same as Tier 1: the task code samples below describe
> the Meyda MFCC extraction and the k-means classifier logic. When
> implementing, append the 13 MFCC bytes at offset 68 in
> [src/binary_pack.mjs](src/binary_pack.mjs), bump `BIN_VERSION` to 3 and
> `metadata.schemaVersion` to 3, and update [DATA_CONTRACTS.md §4](DATA_CONTRACTS.md).

### Task T2.1: Extend the second-pass analyzer with MFCC extraction

**Files:**
- Modify: [src/audio.mjs](src/audio.mjs) — replace `analyzeVocalRms` with `analyzeVocal` that returns both `rVoc` and `voc[13]` per frame

- [ ] **Step 1: Replace analyzeVocalRms**

Replace the `analyzeVocalRms` function added in T1.4 with:

```js
const MFCC_COUNT = 13;

export function analyzeVocal(samples) {
  if (samples.length < BUFFER_SIZE) {
    throw new Error(`vocal audio too short: ${samples.length} samples`);
  }
  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = SAMPLE_RATE;
  Meyda.numberOfMFCCCoefficients = MFCC_COUNT;

  const totalFrames = Math.floor((samples.length - BUFFER_SIZE) / HOP) + 1;
  const rawRms = new Float32Array(totalFrames);
  const rawMfcc = new Array(totalFrames);
  let rMax = 0;
  const mfccMin = new Array(MFCC_COUNT).fill(Infinity);
  const mfccMax = new Array(MFCC_COUNT).fill(-Infinity);

  const window = new Float32Array(BUFFER_SIZE);

  for (let i = 0; i < totalFrames; i++) {
    const start = i * HOP;
    for (let n = 0; n < BUFFER_SIZE; n++) window[n] = samples[start + n];

    const features = Meyda.extract(['rms', 'mfcc'], window);
    const rms = features.rms || 0;
    const mfcc = features.mfcc || new Array(MFCC_COUNT).fill(0);

    rawRms[i] = rms;
    rawMfcc[i] = mfcc;
    if (rms > rMax) rMax = rms;
    for (let k = 0; k < MFCC_COUNT; k++) {
      if (mfcc[k] < mfccMin[k]) mfccMin[k] = mfcc[k];
      if (mfcc[k] > mfccMax[k]) mfccMax[k] = mfcc[k];
    }
  }

  const rVoc = new Array(totalFrames);
  const voc = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    rVoc[i] = rMax > 0 ? Math.min(V_SCALE, Math.round((rawRms[i] / rMax) * V_SCALE)) : 0;
    const q = new Array(MFCC_COUNT);
    for (let k = 0; k < MFCC_COUNT; k++) {
      const span = mfccMax[k] - mfccMin[k];
      q[k] = span > 0
        ? Math.min(V_SCALE, Math.max(0, Math.round(((rawMfcc[i][k] - mfccMin[k]) / span) * V_SCALE)))
        : 0;
    }
    voc[i] = q;
  }

  return {
    rVoc,
    voc,
    mfccCount: MFCC_COUNT,
    mfccMin: mfccMin.map(x => +x.toFixed(4)),
    mfccMax: mfccMax.map(x => +x.toFixed(4)),
  };
}
```

Leave `analyzeVocalRms` in place for one release cycle for backward compat, or remove immediately — your call. If removing, update T1.5 references to `analyzeVocalRms` → `analyzeVocal`.

- [ ] **Step 2: Verify with synthetic vowel-like signal**

Run:

```bash
node -e "
import('./src/audio.mjs').then(m => {
  const SR = m.SAMPLE_RATE;
  const s = new Float32Array(SR * 2);
  // Synthesize a rough /a/-like vowel: F1=750, F2=1200
  for (let i = 0; i < s.length; i++) {
    const t = i / SR;
    s[i] = 0.3 * Math.sin(2 * Math.PI * 750 * t)
         + 0.25 * Math.sin(2 * Math.PI * 1200 * t)
         + 0.1 * Math.sin(2 * Math.PI * 220 * t);  // pitched at 220 Hz
  }
  const r = m.analyzeVocal(s);
  console.log('frames:', r.rVoc.length, 'mfcc shape:', r.voc[0].length);
  console.log('rVoc[100]:', r.rVoc[100]);
  console.log('voc[100]:', r.voc[100]);
  if (r.voc[0].length !== 13) { console.error('FAIL'); process.exit(1); }
  console.log('OK');
});
"
```

Expected: 13-element uint8 MFCC vector per frame, plausible values.

- [ ] **Step 3: Commit**

```bash
git add src/audio.mjs
git commit -m "feat: analyzeVocal extracts mfcc + rVoc"
```

### Task T2.2: Wire MFCC into analyzer.mjs

**Files:**
- Modify: [analyzer.mjs](analyzer.mjs) — update the Tier 1 block from T1.5 to call `analyzeVocal` and merge both `rVoc` and `voc`; write MFCC metadata

- [ ] **Step 1: Replace the vocal isolation block**

In the block added in T1.5, replace:

```js
      const { analyzeVocalRms, readFloat32Wav } = await import('./src/audio.mjs');
```

with:

```js
      const { analyzeVocal, readFloat32Wav } = await import('./src/audio.mjs');
```

And replace:

```js
      const { rVoc } = analyzeVocalRms(vocalSamples);
      const n = Math.min(rVoc.length, analysis.frames.length);
      for (let i = 0; i < n; i++) analysis.frames[i].rVoc = rVoc[i];
      logOk(`vocal_rms: ${n} frames via ${sep.model}`);
```

with:

```js
      const vocResult = analyzeVocal(vocalSamples);
      const n = Math.min(vocResult.rVoc.length, analysis.frames.length);
      for (let i = 0; i < n; i++) {
        analysis.frames[i].rVoc = vocResult.rVoc[i];
        analysis.frames[i].voc = vocResult.voc[i];
      }
      vocalMeta = {
        mfccCount: vocResult.mfccCount,
        mfccMin: vocResult.mfccMin,
        mfccMax: vocResult.mfccMax,
      };
      logOk(`vocal features: ${n} frames, ${vocResult.mfccCount} MFCCs via ${sep.model}`);
```

Declare `let vocalMeta = null;` at the top of the try block.

Update the metadata spread in analyzer.mjs to include vocalMeta:

```js
      ...(vocalIsolationTag ? { vocalIsolation: vocalIsolationTag } : {}),
      ...(vocalMeta ? { vocal: vocalMeta } : {}),
      clock: {
```

- [ ] **Step 2: End-to-end dry run**

Run:

```bash
DEMUCS_PYTHON=/abs/path/.venv-demucs/bin/python node analyzer.mjs --url <short-test-url> --dry-run
```

Expected: output includes `✓ vocal features: N frames, 13 MFCCs via htdemucs-v4`. Dry-run payload size report is ~190 KB larger than T1.

- [ ] **Step 3: Commit**

```bash
git add analyzer.mjs
git commit -m "feat: wire MFCC extraction into analyzer pipeline"
```

### Task T2.3: Collect reference vowel samples

**Files:**
- Create: `reference/vowels/README.md`
- Create: `reference/vowels/{a,i,u,e,o}.wav` (5 files, 2-3 sec each)

- [ ] **Step 1: Write the README describing what each file must contain**

```markdown
# Reference Vowel Samples

Used by `scripts/train-viseme-classifier.mjs` to learn the 5 vowel centroids
in MFCC space. Replace these files with your own recordings to tune the
classifier to a specific singer's vocal timbre.

## Requirements per file

- 48 kHz mono 32-bit float WAV (matches pipeline sample rate)
- 2–3 seconds of sustained vowel at a mid-range pitch (e.g. A3 for female, A2 for male)
- Natural singing voice, not spoken
- Clean, no background music

## Files

- `a.wav` — sustained /a/ (あ)
- `i.wav` — sustained /i/ (い)
- `u.wav` — sustained /u/ (う)
- `e.wav` — sustained /e/ (え)
- `o.wav` — sustained /o/ (お)

## Recording tips

Record yourself or ask a singer to hold each vowel at a comfortable pitch,
trying to keep the vowel shape stable (no drift to adjacent vowels).
Any DAW can export 48 kHz float WAV; Audacity: File → Export → WAV (32-bit float).

## Replacing samples

After replacing any file, re-run:

```bash
node scripts/train-viseme-classifier.mjs
```

to regenerate `viseme-centroids.json`.
```

- [ ] **Step 2: Record or acquire the 5 WAV files**

This is a manual step. Record yourself, ask a collaborator, or use public-domain vowel samples from a linguistics dataset (e.g. Hillenbrand et al. vowel corpus — check license).

Sanity check each file:

```bash
ffprobe reference/vowels/a.wav
```

Expected: sample rate 48000, 1 channel, f32 format, duration ≥ 2 seconds.

- [ ] **Step 3: Commit**

```bash
git add reference/vowels/
git commit -m "chore: reference vowel samples for viseme training"
```

### Task T2.4: Write the one-off viseme trainer

**Files:**
- Create: `scripts/train-viseme-classifier.mjs`
- Create: `viseme-centroids.json` (output artifact, committed)

- [ ] **Step 1: Write the trainer**

```js
#!/usr/bin/env node
// Train a 5-vowel viseme classifier from reference samples.
//
// Inputs:  reference/vowels/{a,i,u,e,o}.wav
// Output:  viseme-centroids.json — { a: [13 floats], i: [...], ... }
//
// Algorithm: for each reference file, run analyzeVocal, average the
// middle 50% of frames (trimmed to skip attack/release), and save as centroid.
// Classifier at runtime is nearest-centroid in MFCC space.

import { analyzeVocal, readFloat32Wav } from '../src/audio.mjs';
import { writeFile } from 'node:fs/promises';

const VOWELS = ['a', 'i', 'u', 'e', 'o'];

async function centroidFor(vowel) {
  const path = `reference/vowels/${vowel}.wav`;
  const samples = await readFloat32Wav(path);
  const { voc, mfccMin, mfccMax } = analyzeVocal(samples);

  // Use middle 50% of frames to skip attack/release noise.
  const n = voc.length;
  const lo = Math.floor(n * 0.25);
  const hi = Math.floor(n * 0.75);

  const centroid = new Array(13).fill(0);
  let count = 0;
  for (let i = lo; i < hi; i++) {
    for (let k = 0; k < 13; k++) centroid[k] += voc[i][k];
    count++;
  }
  for (let k = 0; k < 13; k++) centroid[k] /= count;

  return { vowel, centroid: centroid.map(x => +x.toFixed(2)), mfccMin, mfccMax };
}

const results = await Promise.all(VOWELS.map(centroidFor));

// Warning: each reference file has its own per-file normalization (mfccMin/Max).
// Centroids are only comparable if we renormalize using a shared global range,
// OR if the runtime classifier uses per-frame normalization. For simplicity we
// store centroids in the per-file uint8 space and require runtime to
// cosine-distance in uint8 space (scale-invariant-ish).
const out = {};
for (const r of results) out[r.vowel] = r.centroid;

await writeFile('viseme-centroids.json', JSON.stringify(out, null, 2));
console.log('wrote viseme-centroids.json');
console.log(out);
```

- [ ] **Step 2: Run the trainer**

```bash
node scripts/train-viseme-classifier.mjs
```

Expected: prints the 5 centroids and writes `viseme-centroids.json`. Each centroid should be distinct (eyeball check: the 5 arrays should not all look identical).

- [ ] **Step 3: Commit**

```bash
git add scripts/train-viseme-classifier.mjs viseme-centroids.json
git commit -m "feat: viseme classifier trainer + initial centroids"
```

### Task T2.5: Client-side viseme classifier reference implementation

**Files:**
- Create: `examples/lip-sync-viseme.js`

- [ ] **Step 1: Write the reference client**

```js
// examples/lip-sync-viseme.js
//
// Tier 2 lip-sync: 5-way viseme classifier.
// Consumes analysis frames with { voc[13], rVoc } and viseme-centroids.json,
// outputs 5 blendshape weights { aa, ih, ou, ee, oh } per frame.

export function createVisemeLipSync(song, centroids, opts = {}) {
  const {
    smoothing   = 0.6,  // EMA on blendshape weights
    silenceGate = 20,   // rVoc below this → all weights → 0
    gain        = 1.0,
  } = opts;

  const frames = song.analysis;
  const fps = song.metadata.fps;
  const vScale = song.metadata.vScale ?? 255;

  if (!frames[0] || !('voc' in frames[0])) {
    throw new Error('song has no Tier 2 MFCC data (voc field missing)');
  }

  // Ordered list of 5 vowels → blendshape names.
  const vowelToBlend = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh' };
  const vowels = Object.keys(vowelToBlend);
  const centroidArr = vowels.map(v => centroids[v]);

  const smoothed = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

  function cosineDistance(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? 1 - (dot / denom) : 1;
  }

  return function sampleVisemes(currentTimeSec) {
    const idx = Math.min(frames.length - 1, Math.floor(currentTimeSec * fps));
    const f = frames[idx];

    const amplitude = (f.rVoc ?? 0) / vScale;
    const alive = (f.rVoc ?? 0) > silenceGate ? 1 : 0;

    // Nearest-centroid in uint8 MFCC space (cosine distance).
    const dists = centroidArr.map(c => cosineDistance(f.voc, c));
    const minDist = Math.min(...dists);
    // Softmax-ish: closer centroid gets more weight.
    const weights = dists.map(d => Math.exp(-(d - minDist) * 8));
    const sum = weights.reduce((s, w) => s + w, 0);

    // Target weights: softmax × amplitude × alive × gain.
    const target = {};
    for (let i = 0; i < vowels.length; i++) {
      const blend = vowelToBlend[vowels[i]];
      target[blend] = (weights[i] / sum) * amplitude * alive * gain;
    }

    // EMA smoothing.
    for (const blend of Object.values(vowelToBlend)) {
      smoothed[blend] = smoothing * smoothed[blend] + (1 - smoothing) * target[blend];
    }
    return { ...smoothed };
  };
}
```

- [ ] **Step 2: Document usage**

Append to this plan's Appendix A:

````markdown
## Appendix B: Tier 2 viseme integration

```js
import { createVisemeLipSync } from './examples/lip-sync-viseme.js';
import centroids from './viseme-centroids.json';

const song = await fetch(`/api/songs/${videoId}`).then(r => r.json());
const sampleVisemes = createVisemeLipSync(song, centroids);

function tick() {
  const t = audioElement.currentTime;
  const w = sampleVisemes(t);
  vrm.expressionManager.setValue('aa', w.aa);
  vrm.expressionManager.setValue('ih', w.ih);
  vrm.expressionManager.setValue('ou', w.ou);
  vrm.expressionManager.setValue('ee', w.ee);
  vrm.expressionManager.setValue('oh', w.oh);
  vrm.update(clock.getDelta());
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
```
````

- [ ] **Step 3: Commit**

```bash
git add examples/lip-sync-viseme.js LIP_SYNC_PLAN.md
git commit -m "feat: tier 2 viseme classifier client reference"
```

### Task T2.6: Validation on a real song

This is an acceptance test, not a TDD step — it validates the whole Tier 2 pipeline works end-to-end.

- [ ] **Step 1: Pick a song with clear Japanese vocals**

Choose a song where you can clearly hear the singer articulating different vowels (ideally a ballad or j-pop with clean vocal mix). Run:

```bash
DEMUCS_PYTHON=/abs/path/.venv-demucs/bin/python node analyzer.mjs --url <url> --force
```

Expected: row in `Songs` table includes `voc[13]` on every analysis frame and `metadata.vocal.mfccCount === 13`.

- [ ] **Step 2: Manually verify visemes match audio**

Load the row in a Node REPL:

```bash
node -e "
import('@supabase/supabase-js').then(async ({ createClient }) => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data } = await db.from('Songs').select('*').eq('video_id', '<videoId>').single();
  const centroids = await import('./viseme-centroids.json', { assert: { type: 'json' } });
  const { createVisemeLipSync } = await import('./examples/lip-sync-viseme.js');
  const sample = createVisemeLipSync(data, centroids.default);
  // Print visemes at 5 chosen timestamps where you know what vowel is being sung
  for (const t of [15.0, 23.5, 41.2, 68.0, 92.5]) {
    console.log(t.toFixed(1) + 's:', sample(t));
  }
});
"
```

Expected: at each timestamp, the dominant blendshape roughly matches the vowel you hear at that moment in the audio. Accuracy of ~60-70% is the starting bar; tuning the reference samples and smoothing params can push this higher.

- [ ] **Step 3: Record findings**

If the classifier performs poorly:
- Re-record `reference/vowels/*.wav` with a voice closer to the song's singer (gender, pitch range, timbre)
- Adjust `silenceGate` (raise if mouth flutters during rests, lower if mouth skips short syllables)
- Adjust `smoothing` (raise for steadier mouth, lower for snappier reaction)
- Re-run `train-viseme-classifier.mjs` and test again

Document what worked in a new `docs/viseme-tuning-notes.md`.

---

## Success Metrics

| Tier | Ships when | Visible signal |
|---|---|---|
| T0 | T0.1 green + manual browser check | Mouth opens on loud vocal sections |
| T1 | T1.5 green + end-to-end dry run | Mouth stops flapping during instrumental breaks |
| T2 | T2.6 validation ≥ 60% vowel match | Mouth shape changes between open/flat/round depending on vowel |

## Out of Scope (Explicit)

- Whisper / WhisperX / MFA text-based alignment (see non-goals in section 0)
- Consonants (plosives, fricatives) — we only model vowels; consonants are too fast and spectrally noisy for the 16.67 ms / 60 FPS grid to express meaningfully on a VRM mouth
- Expression beyond vowels (smile, frown, eyebrow) — handled separately, driven by beat/RMS/centroid, not by this pipeline
- Real-time browser Demucs
- Multi-singer separation (duets, chorus)

## Rollback Plan

Each tier is additive in the sense that newer versions append bytes to the
analysis frame. Consumers gate behavior on `metadata.schemaVersion` and the
blob version byte.

- **Roll back T2:** revert the T2 commits to [src/binary_pack.mjs](src/binary_pack.mjs)
  (`ANALYSIS_FRAME_SIZE` 81 → 68) and [src/audio.mjs](src/audio.mjs) (drop
  MFCC extraction), then re-run `analyzer.mjs --force` on affected rows. The
  analyzer will write version-2 blobs. Old version-3 blobs in Storage will
  still parse via their own header byte; T2 consumers will simply never see
  new version-3 data.
- **Roll back T1:** unset `DEMUCS_PYTHON` and revert the T1 commits (frame
  size 68 → 67, `BIN_VERSION` 2 → 1). Re-run `analyzer.mjs --force` on
  affected rows to regenerate version-1 blobs.
- **No database migration is ever needed** — the rows just carry blob paths,
  and the blobs carry their own versioning. The only schema change across
  tiers is the integer value of `metadata.schemaVersion` inside the JSONB.
