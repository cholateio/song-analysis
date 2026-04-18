import Meyda from 'meyda';

export const SAMPLE_RATE = 48000;
export const FPS = 60;
export const BUFFER_SIZE = 2048;
export const HOP = SAMPLE_RATE / FPS;

const BAND_COUNT = 64;
const FREQ_MIN = 20;
const FREQ_MAX = 16000;
const V_SCALE = 255;

const FFT_BIN_HZ = SAMPLE_RATE / BUFFER_SIZE;
const FFT_BIN_COUNT = BUFFER_SIZE / 2;

const BAND_EDGES_HZ = (() => {
  const edges = new Float32Array(BAND_COUNT + 1);
  const logLo = Math.log(FREQ_MIN);
  const logHi = Math.log(FREQ_MAX);
  for (let i = 0; i <= BAND_COUNT; i++) {
    edges[i] = Math.exp(logLo + (logHi - logLo) * (i / BAND_COUNT));
  }
  return edges;
})();

const BAND_FFT_RANGES = (() => {
  const ranges = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    const lo = Math.max(0, Math.floor(BAND_EDGES_HZ[i] / FFT_BIN_HZ));
    const hi = Math.min(FFT_BIN_COUNT - 1, Math.max(lo, Math.ceil(BAND_EDGES_HZ[i + 1] / FFT_BIN_HZ) - 1));
    ranges.push([lo, hi]);
  }
  return ranges;
})();

// Octave bands for spectral-contrast: 100 Hz – 12.8 kHz (7 cut-offs → 6 bands).
const CONTRAST_EDGES_HZ = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
const CONTRAST_BAND_BINS = (() => {
  const ranges = [];
  for (let i = 0; i < CONTRAST_EDGES_HZ.length - 1; i++) {
    const lo = Math.max(0, Math.floor(CONTRAST_EDGES_HZ[i] / FFT_BIN_HZ));
    const hi = Math.min(FFT_BIN_COUNT - 1, Math.max(lo, Math.ceil(CONTRAST_EDGES_HZ[i + 1] / FFT_BIN_HZ) - 1));
    ranges.push([lo, hi]);
  }
  return ranges;
})();
const CONTRAST_WORK = new Float32Array(FFT_BIN_COUNT);

function frameSpectralContrastDb(spectrum) {
  const eps = 1e-8;
  let sumDb = 0;
  let bandsCounted = 0;
  for (const [lo, hi] of CONTRAST_BAND_BINS) {
    const n = hi - lo + 1;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) CONTRAST_WORK[i] = spectrum[lo + i];
    const slice = CONTRAST_WORK.subarray(0, n);
    slice.sort();
    const k = Math.max(1, Math.floor(n * 0.2));
    let valleySum = 0;
    for (let i = 0; i < k; i++) valleySum += slice[i];
    let peakSum = 0;
    for (let i = n - k; i < n; i++) peakSum += slice[i];
    const peak = peakSum / k;
    const valley = valleySum / k;
    sumDb += 20 * Math.log10((peak + eps) / (valley + eps));
    bandsCounted++;
  }
  return bandsCounted > 0 ? sumDb / bandsCounted : 0;
}

async function collectPcm(pcmStream, totalExpectedBytes, onProgress) {
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for await (const chunk of pcmStream) {
    chunks.push(chunk);
    received += chunk.length;
    if (onProgress && received - lastReport > 1_000_000) {
      onProgress(received, totalExpectedBytes);
      lastReport = received;
    }
  }
  if (onProgress) onProgress(received, totalExpectedBytes);

  const totalSamples = received / 4;
  const samples = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    const sampleCount = chunk.length / 4;
    const view = new Float32Array(chunk.buffer, chunk.byteOffset, sampleCount);
    samples.set(view, offset);
    offset += sampleCount;
  }
  return samples;
}

export async function analyze(pcmStream, { durationHint = 0, onProgress = null } = {}) {
  Meyda.bufferSize = BUFFER_SIZE;
  Meyda.sampleRate = SAMPLE_RATE;

  const expectedBytes = durationHint > 0 ? Math.floor(durationHint * SAMPLE_RATE * 4) : 0;
  const samples = await collectPcm(pcmStream, expectedBytes, onProgress);
  const totalSamples = samples.length;
  if (totalSamples < BUFFER_SIZE) {
    throw new Error(`audio too short: ${totalSamples} samples (need ≥ ${BUFFER_SIZE})`);
  }

  const totalFrames = Math.floor((totalSamples - BUFFER_SIZE) / HOP) + 1;
  const rawFrames = new Array(totalFrames);
  const rawBinRows = new Array(totalFrames);
  const perBandMax = new Float32Array(BAND_COUNT);
  const centroidHistory = new Float32Array(totalFrames);
  const zcrHistory = new Float32Array(totalFrames);
  const contrastHistory = new Float32Array(totalFrames);
  let rMax = 0;
  let cMaxHz = 0;

  const window = new Float32Array(BUFFER_SIZE);
  const prevSpectrum = new Float32Array(FFT_BIN_COUNT);
  let hasPrevSpectrum = false;
  const fluxHistory = [];
  const FLUX_HISTORY_LEN = 90;
  const MIN_BEAT_GAP = 6;
  const WARMUP_FRAMES = 60;
  let lastBeatFrameIdx = -Infinity;

  for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
    const start = frameIdx * HOP;
    for (let i = 0; i < BUFFER_SIZE; i++) window[i] = samples[start + i];

    const features = Meyda.extract(['amplitudeSpectrum', 'rms', 'spectralCentroid', 'zcr'], window);
    const spectrum = features.amplitudeSpectrum;
    const rms = features.rms || 0;
    const centroidBin = features.spectralCentroid || 0;
    const centroidHz = Number.isFinite(centroidBin) ? centroidBin * FFT_BIN_HZ : 0;
    const zcr = Number.isFinite(features.zcr) ? features.zcr : 0;
    centroidHistory[frameIdx] = centroidHz;
    zcrHistory[frameIdx] = zcr;
    contrastHistory[frameIdx] = frameSpectralContrastDb(spectrum);

    const bins = new Float32Array(BAND_COUNT);
    for (let i = 0; i < BAND_COUNT; i++) {
      const [lo, hi] = BAND_FFT_RANGES[i];
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += spectrum[j];
      const avg = sum / (hi - lo + 1);
      bins[i] = avg;
      if (avg > perBandMax[i]) perBandMax[i] = avg;
    }
    rawBinRows[frameIdx] = bins;

    if (rms > rMax) rMax = rms;
    if (centroidHz > cMaxHz) cMaxHz = centroidHz;

    let flux = 0;
    if (hasPrevSpectrum) {
      for (let i = 0; i < spectrum.length; i++) {
        const diff = spectrum[i] - prevSpectrum[i];
        if (diff > 0) flux += diff;
      }
    }
    prevSpectrum.set(spectrum);
    hasPrevSpectrum = true;

    fluxHistory.push(flux);
    if (fluxHistory.length > FLUX_HISTORY_LEN) fluxHistory.shift();

    let isBeat = false;
    if (frameIdx >= WARMUP_FRAMES && fluxHistory.length >= FLUX_HISTORY_LEN) {
      let mean = 0;
      for (const f of fluxHistory) mean += f;
      mean /= fluxHistory.length;
      let variance = 0;
      for (const f of fluxHistory) variance += (f - mean) * (f - mean);
      variance /= fluxHistory.length;
      const stddev = Math.sqrt(variance);
      const thresh = mean + 1.5 * stddev;
      if (flux > thresh && (frameIdx - lastBeatFrameIdx) >= MIN_BEAT_GAP) {
        isBeat = true;
        lastBeatFrameIdx = frameIdx;
      }
    }

    rawFrames[frameIdx] = { r: rms, k: isBeat, cHz: centroidHz };
  }

  const n3 = (v, max) => max > 0 ? Math.round((v / max) * 1000) / 1000 : 0;
  const q8 = (v, max) => max > 0 ? Math.min(V_SCALE, Math.round((v / max) * V_SCALE)) : 0;

  const frames = new Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const f = rawFrames[i];
    const binRow = rawBinRows[i];
    const v = new Array(BAND_COUNT);
    for (let j = 0; j < BAND_COUNT; j++) {
      v[j] = q8(binRow[j], perBandMax[j]);
    }
    frames[i] = {
      v,
      r: n3(f.r, rMax),
      c: n3(f.cHz, cMaxHz),
      k: f.k,
    };
  }

  const beatTimes = [];
  for (let i = 0; i < totalFrames; i++) {
    if (rawFrames[i].k) beatTimes.push(i / FPS);
  }
  const { bpm, confidence: bpmConfidence } = estimateBpm(beatTimes);

  const sortedCentroid = Float32Array.from(centroidHistory);
  sortedCentroid.sort();
  const medianCentroidHz = sortedCentroid[Math.floor(totalFrames / 2)];

  let zcrSum = 0;
  for (let i = 0; i < totalFrames; i++) zcrSum += zcrHistory[i];
  const zcrMean = zcrSum / totalFrames;
  let zcrSq = 0;
  for (let i = 0; i < totalFrames; i++) {
    const d = zcrHistory[i] - zcrMean;
    zcrSq += d * d;
  }
  const zcrVariance = totalFrames > 1 ? zcrSq / (totalFrames - 1) : 0;

  let contrastSum = 0;
  for (let i = 0; i < totalFrames; i++) contrastSum += contrastHistory[i];
  const meanSpectralContrastDb = contrastSum / totalFrames;

  return {
    frames,
    bpm,
    bpmConfidence,
    medianCentroidHz: Math.round(medianCentroidHz * 10) / 10,
    zcrVariance: +zcrVariance.toFixed(3),
    meanSpectralContrastDb: +meanSpectralContrastDb.toFixed(2),
    duration: totalSamples / SAMPLE_RATE,
    samples,
  };
}

function estimateBpm(beatTimes) {
  if (beatTimes.length < 4) return { bpm: null, confidence: null };
  const intervals = [];
  for (let i = 1; i < beatTimes.length; i++) {
    intervals.push(beatTimes[i] - beatTimes[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  if (!(median > 0)) return { bpm: null, confidence: null };

  let within = 0;
  for (const iv of intervals) {
    if (Math.abs(iv - median) / median < 0.1) within++;
  }
  const confidence = +(within / intervals.length).toFixed(3);

  let bpm = 60 / median;
  while (bpm < 60)  bpm *= 2;
  while (bpm > 200) bpm /= 2;
  return { bpm: Math.round(bpm), confidence };
}
