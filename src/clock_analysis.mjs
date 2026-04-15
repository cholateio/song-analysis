// Faithful port of virtual-music-clock's audio-engine FFT sampling.
//
// Source: virtual-music-clock/app/audio-engine/page.jsx uses the Web Audio API
// AnalyserNode with fftSize = 256, then calls getByteFrequencyData() every ~16ms
// and transmits a 128-element Uint8Array (Array.from(dataArray)).
//
// Offline we emit only { frequencies } per frame. The live engine also sends a
// `bass` scalar = mean(frequencies[0..4]), but consumers can derive it in one
// line so we do not store it; metadata.bassBinCount documents the 5-bin window.
//
// This file reproduces AnalyserNode's getByteFrequencyData() exactly, following
// the W3C Web Audio spec (§ "FFT windowing and smoothing-over-time"):
//   1. Apply Blackman window to the 256-sample input.
//   2. Take the FFT (normalized by 1/N).
//   3. Smooth the magnitude: Ŷ[k] = τ·Ŷ_prev[k] + (1-τ)·|X[k]|
//   4. Convert to dB: Y[k] = 20·log10(Ŷ[k])
//   5. Byte scale: b[k] = floor(255 / (maxDb - minDb) * (Y[k] - minDb)), clamp [0,255]
// AnalyserNode defaults: smoothingTimeConstant = 0.8, minDecibels = -100, maxDecibels = -30.
//
// Spec steps 1-5 and their AnalyserNode-default constants are fixed — do not
// tweak them. The one deliberate deviation is INPUT_GAIN applied at step 1:
// offline we read full-scale PCM straight from the file, whereas the live
// clock's mic picks up speaker output through the room, attenuated by roughly
// -6 to -10 dB of loopback plus the mic's own gain staging. Without that
// attenuation, loud bass transients saturate byte 255 on many adjacent bins
// and the render layer's linear (v/255)*60 radius mapping collapses them
// onto a single radius, producing a visible flat-top arc on the halo.
// INPUT_GAIN approximates the missing speaker→mic stage so the emitted bytes
// match what the live clock actually sees, not what a full-scale analytic
// source would produce.

import { SAMPLE_RATE, FPS, BUFFER_SIZE, HOP } from './audio.mjs';

const FFT_SIZE = 256;
const BIN_COUNT = FFT_SIZE / 2;            // 128 — matches analyser.frequencyBinCount
const SMOOTHING_TIME_CONSTANT = 0.8;       // AnalyserNode default
const MIN_DB = -100;                       // AnalyserNode default minDecibels
const MAX_DB = -30;                        // AnalyserNode default maxDecibels
const BASS_BIN_COUNT = 5;                  // matches `for (let i = 0; i < 5; i++)`

// Simulated speaker→mic loopback attenuation; see header comment for why.
// Tune in [0.1, 0.7] to visually match the live clock on a reference track.
const INPUT_GAIN = 0.3;

// Pre-computed Blackman window per Web Audio spec:
//   a0 = 0.42, a1 = 0.5, a2 = 0.08
//   w[n] = a0 - a1*cos(2πn/N) + a2*cos(4πn/N),  n = 0..N-1
const BLACKMAN = (() => {
  const w = new Float32Array(FFT_SIZE);
  const a0 = 0.42;
  const a1 = 0.5;
  const a2 = 0.08;
  for (let n = 0; n < FFT_SIZE; n++) {
    w[n] = a0
      - a1 * Math.cos((2 * Math.PI * n) / FFT_SIZE)
      + a2 * Math.cos((4 * Math.PI * n) / FFT_SIZE);
  }
  return w;
})();

// In-place radix-2 Cooley-Tukey FFT. Computes the un-normalized DFT; the
// caller multiplies by 1/N to match the spec's X[k] = (1/N) Σ x̂[n] e^(−2πikn/N).
function fftInPlace(re, im) {
  const N = re.length;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  // Butterflies
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = angleStep * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half];
        const bIm = im[i + k + half];
        const tRe = cos * bRe - sin * bIm;
        const tIm = cos * bIm + sin * bRe;
        re[i + k] = aRe + tRe;
        im[i + k] = aIm + tIm;
        re[i + k + half] = aRe - tRe;
        im[i + k + half] = aIm - tIm;
      }
    }
  }
}

// Run the clock's AnalyserNode pipeline over the decoded mono PCM samples and
// emit one { frequencies } record per frame. The live WebSocket payload also
// carries a `bass` scalar; see the header comment for why we omit it.
//
// Frame count and HOP are kept identical to audio.mjs so the output aligns
// row-for-row with the existing `analysis` column.
export function clockAnalyze(samples) {
  const totalSamples = samples.length;
  if (totalSamples < BUFFER_SIZE) {
    throw new Error(`audio too short for clock analysis: ${totalSamples} samples`);
  }

  const totalFrames = Math.floor((totalSamples - BUFFER_SIZE) / HOP) + 1;

  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const smoothed = new Float32Array(BIN_COUNT); // Ŷ_prev, starts at 0
  const frames = new Array(totalFrames);

  const invN = 1 / FFT_SIZE;
  const dbScale = 255 / (MAX_DB - MIN_DB);

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const start = frameIdx * HOP;

    // Step 1: Blackman-windowed time-domain input x̂[n] = x[n] * w[n] * INPUT_GAIN
    for (let n = 0; n < FFT_SIZE; n++) {
      re[n] = samples[start + n] * BLACKMAN[n] * INPUT_GAIN;
      im[n] = 0;
    }

    // Step 2: FFT (caller applies 1/N normalization below)
    fftInPlace(re, im);

    // Step 3-5: smoothing, dB, byte scaling
    const frequencies = new Array(BIN_COUNT);
    for (let k = 0; k < BIN_COUNT; k++) {
      const magnitude = Math.hypot(re[k], im[k]) * invN;       // |X[k]|
      const s = SMOOTHING_TIME_CONSTANT * smoothed[k]
        + (1 - SMOOTHING_TIME_CONSTANT) * magnitude;     // Ŷ[k]
      smoothed[k] = s;

      // Y[k] = 20 log10(Ŷ[k]); if Ŷ[k] is 0, Y[k] is -Infinity
      const db = s > 0 ? 20 * Math.log10(s) : -Infinity;

      // b[k] = floor(255 / (maxDb - minDb) * (Y[k] - minDb)), clamped [0, 255]
      let byteVal = Math.floor(dbScale * (db - MIN_DB));
      if (byteVal < 0) byteVal = 0;
      else if (byteVal > 255) byteVal = 255;

      frequencies[k] = byteVal;
    }

    frames[frameIdx] = { frequencies };
  }

  return {
    frames,
    fps: FPS,
    sampleRate: SAMPLE_RATE,
    fftSize: FFT_SIZE,
    binCount: BIN_COUNT,
    smoothingTimeConstant: SMOOTHING_TIME_CONSTANT,
    minDecibels: MIN_DB,
    maxDecibels: MAX_DB,
    bassBinCount: BASS_BIN_COUNT,
  };
}
