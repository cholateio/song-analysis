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
  const musicalCentroidHistory = new Float32Array(totalFrames);
  const musicalDenomHistory = new Float32Array(totalFrames);
  const zcrHistory = new Float32Array(totalFrames);
  const contrastHistory = new Float32Array(totalFrames);
  const musicalLoBin = Math.ceil(MUSICAL_CENTROID_LO_HZ / FFT_BIN_HZ);
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

    let mcNum = 0, mcDen = 0;
    for (let k = musicalLoBin; k < spectrum.length; k++) {
      const amp = spectrum[k];
      mcNum += k * amp;
      mcDen += amp;
    }
    musicalCentroidHistory[frameIdx] = mcDen > 0 ? (mcNum / mcDen) * FFT_BIN_HZ : 0;
    musicalDenomHistory[frameIdx] = mcDen;

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

  const vocalOnsetRate = computeVocalOnsetRate(frames, totalSamples / SAMPLE_RATE);
  const vocalModulationHz = computeVocalModulationHz(rawBinRows, totalFrames);
  const vocalCentroidHz = computeVocalCentroidHz(rawBinRows, totalFrames);

  const sortedCentroid = Float32Array.from(centroidHistory);
  sortedCentroid.sort();
  const medianCentroidHz = sortedCentroid[Math.floor(totalFrames / 2)];

  const musicalCentroidHz = (() => {
    let denomSum = 0;
    for (let i = 0; i < totalFrames; i++) denomSum += musicalDenomHistory[i];
    const denomMean = denomSum / totalFrames;
    if (!(denomMean > 0)) return null;
    const floor = denomMean * VOCAL_CENTROID_NOISE_RATIO;
    const valid = [];
    for (let i = 0; i < totalFrames; i++) {
      if (musicalDenomHistory[i] >= floor && musicalCentroidHistory[i] > 0) {
        valid.push(musicalCentroidHistory[i]);
      }
    }
    const minValid = Math.max(1, Math.floor(VOCAL_CENTROID_MIN_VALID_RATIO * totalFrames));
    if (valid.length < minValid) return null;
    valid.sort((a, b) => a - b);
    return +valid[valid.length >> 1].toFixed(2);
  })();

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
    musicalCentroidHz,
    zcrVariance: +zcrVariance.toFixed(3),
    meanSpectralContrastDb: +meanSpectralContrastDb.toFixed(2),
    vocalOnsetRate,
    vocalModulationHz,
    vocalCentroidHz,
    duration: totalSamples / SAMPLE_RATE,
    samples,
  };
}

const VOCAL_BAND_LO = 25;
const VOCAL_BAND_HI = 49;
const ONSET_WINDOW = 150;
const ONSET_MIN_IOI = 6;
const ONSET_K = 1.5;
const ONSET_ALPHA = 0.5;
const ONSET_T_MIN_FACTOR = 2.0;
const ONSET_MAX_RATE = 15;

const MOD_HPSS_KERNEL_HALF = 8;
const MOD_FREQ_LO_HZ = 2;
const MOD_FREQ_HI_HZ = 10;
const MOD_FULL_ENERGY_LO_HZ = 0.1;
const MOD_FULL_ENERGY_HI_HZ = 30;
const MOD_NULL_ENERGY_RATIO = 0.05;

const VOCAL_CENTROID_NOISE_RATIO = 0.1;
const VOCAL_CENTROID_MIN_VALID_RATIO = 0.1;

const MUSICAL_CENTROID_LO_HZ = 150;

function medianAndMad(values) {
  const sorted = Float32Array.from(values);
  sorted.sort();
  const median = sorted[sorted.length >> 1];
  const dev = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) dev[i] = Math.abs(values[i] - median);
  dev.sort();
  return { median, mad: dev[dev.length >> 1] };
}

function fftRealRadix2(x, size) {
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const xLen = Math.min(x.length, size);
  for (let i = 0; i < xLen; i++) re[i] = x[i];

  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const angle = -2 * Math.PI / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);
    for (let i = 0; i < size; i += len) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = wRe * re[i + k + half] - wIm * im[i + k + half];
        const vIm = wRe * im[i + k + half] + wIm * re[i + k + half];
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nwRe = wRe * wStepRe - wIm * wStepIm;
        const nwIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nwRe;
        wIm = nwIm;
      }
    }
  }

  return { re, im };
}

function horizontalMedianFilter(binRows, kernelHalfWidth) {
  const totalFrames = binRows.length;
  const bandCount = binRows[0].length;
  const out = new Array(totalFrames);
  for (let t = 0; t < totalFrames; t++) out[t] = new Float32Array(bandCount);
  const scratch = new Float32Array(kernelHalfWidth * 2 + 1);
  for (let b = 0; b < bandCount; b++) {
    for (let t = 0; t < totalFrames; t++) {
      const lo = Math.max(0, t - kernelHalfWidth);
      const hi = Math.min(totalFrames - 1, t + kernelHalfWidth);
      const w = hi - lo + 1;
      for (let k = 0; k < w; k++) scratch[k] = binRows[lo + k][b];
      const slice = scratch.subarray(0, w);
      slice.sort();
      out[t][b] = slice[w >> 1];
    }
  }
  return out;
}

function computeVocalModulationHz(rawBinRows, totalFrames) {
  if (totalFrames < 2 * FPS) return null;

  const harmonic = horizontalMedianFilter(rawBinRows, MOD_HPSS_KERNEL_HALF);

  const envelope = new Float32Array(totalFrames);
  for (let t = 0; t < totalFrames; t++) {
    let sumSq = 0;
    for (let b = VOCAL_BAND_LO; b <= VOCAL_BAND_HI; b++) {
      const v = harmonic[t][b];
      sumSq += v * v;
    }
    envelope[t] = Math.sqrt(sumSq);
  }

  let mean = 0;
  for (let t = 0; t < totalFrames; t++) mean += envelope[t];
  mean /= totalFrames;
  const denom = totalFrames > 1 ? totalFrames - 1 : 1;
  for (let t = 0; t < totalFrames; t++) {
    const hann = 0.5 * (1 - Math.cos(2 * Math.PI * t / denom));
    envelope[t] = (envelope[t] - mean) * hann;
  }

  let size = 1;
  while (size < totalFrames) size <<= 1;
  const { re, im } = fftRealRadix2(envelope, size);

  const freqPerBin = FPS / size;
  const nyquistBin = size >> 1;
  const kFullLo = Math.max(1, Math.ceil(MOD_FULL_ENERGY_LO_HZ / freqPerBin));
  const kFullHi = Math.min(nyquistBin, Math.floor(MOD_FULL_ENERGY_HI_HZ / freqPerBin));
  const kBandLo = Math.max(kFullLo, Math.ceil(MOD_FREQ_LO_HZ / freqPerBin));
  const kBandHi = Math.min(kFullHi, Math.floor(MOD_FREQ_HI_HZ / freqPerBin));
  if (kBandHi <= kBandLo || kFullHi <= kFullLo) return null;

  let fullEnergy = 0;
  for (let k = kFullLo; k <= kFullHi; k++) {
    fullEnergy += re[k] * re[k] + im[k] * im[k];
  }
  if (fullEnergy < 1e-8) return null;

  let bandEnergy = 0;
  let weightedFreq = 0;
  for (let k = kBandLo; k <= kBandHi; k++) {
    const mag2 = re[k] * re[k] + im[k] * im[k];
    bandEnergy += mag2;
    weightedFreq += (k * freqPerBin) * mag2;
  }

  if (bandEnergy / fullEnergy < MOD_NULL_ENERGY_RATIO) return null;
  if (bandEnergy < 1e-12) return null;

  const centroid = weightedFreq / bandEnergy;
  if (!(centroid >= 1.5) || centroid > MOD_FREQ_HI_HZ) return null;
  return +centroid.toFixed(2);
}

function computeVocalCentroidHz(rawBinRows, totalFrames) {
  if (totalFrames === 0) return null;

  const bandCount = VOCAL_BAND_HI - VOCAL_BAND_LO + 1;
  const bandCenters = new Float32Array(bandCount);
  for (let b = VOCAL_BAND_LO; b <= VOCAL_BAND_HI; b++) {
    bandCenters[b - VOCAL_BAND_LO] = Math.sqrt(BAND_EDGES_HZ[b] * BAND_EDGES_HZ[b + 1]);
  }

  const denoms = new Float32Array(totalFrames);
  let denomSum = 0;
  for (let i = 0; i < totalFrames; i++) {
    const row = rawBinRows[i];
    let d = 0;
    for (let b = VOCAL_BAND_LO; b <= VOCAL_BAND_HI; b++) d += row[b];
    denoms[i] = d;
    denomSum += d;
  }
  const denomMean = denomSum / totalFrames;
  if (!(denomMean > 0)) return null;
  const floor = denomMean * VOCAL_CENTROID_NOISE_RATIO;

  const centroids = [];
  for (let i = 0; i < totalFrames; i++) {
    const d = denoms[i];
    if (!(d > 0) || d < floor) continue;
    const row = rawBinRows[i];
    let numer = 0;
    for (let b = VOCAL_BAND_LO; b <= VOCAL_BAND_HI; b++) {
      numer += bandCenters[b - VOCAL_BAND_LO] * row[b];
    }
    centroids.push(numer / d);
  }

  const minValid = Math.max(1, Math.floor(VOCAL_CENTROID_MIN_VALID_RATIO * totalFrames));
  if (centroids.length < minValid) return null;

  centroids.sort((a, b) => a - b);
  const median = centroids[centroids.length >> 1];
  if (!(median > 0)) return null;
  return +median.toFixed(2);
}

function computeVocalOnsetRate(frames, durationSec) {
  const n = frames.length;
  if (n < 2 || !(durationSec > 0)) return null;

  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const v = frames[i].v;
    const vp = frames[i - 1].v;
    let s = 0;
    for (let b = VOCAL_BAND_LO; b <= VOCAL_BAND_HI; b++) {
      const d = v[b] - vp[b];
      if (d > 0) s += d;
    }
    flux[i] = s / 255;
  }

  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += flux[j];
    smooth[i] = s / (hi - lo + 1);
  }

  const { median: gMed, mad: gMad } = medianAndMad(smooth);
  const thrGlobal = gMed + ONSET_K * gMad;
  const tMin = ONSET_T_MIN_FACTOR * gMed;

  const scratch = new Float32Array(ONSET_WINDOW * 2 + 1);
  let onsets = 0;
  let lastIdx = -Infinity;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - ONSET_WINDOW);
    const hi = Math.min(n - 1, i + ONSET_WINDOW);
    const w = hi - lo + 1;
    for (let j = 0; j < w; j++) scratch[j] = smooth[lo + j];
    let win = scratch.subarray(0, w);
    win.sort();
    const lMed = win[w >> 1];
    for (let j = 0; j < w; j++) scratch[j] = Math.abs(smooth[lo + j] - lMed);
    win = scratch.subarray(0, w);
    win.sort();
    const lMad = win[w >> 1];
    const thrLocal = lMed + ONSET_K * lMad;
    const thr = Math.max(tMin, ONSET_ALPHA * thrGlobal + (1 - ONSET_ALPHA) * thrLocal);

    const isLocalMax =
      (i === 0 || smooth[i] >= smooth[i - 1]) &&
      (i === n - 1 || smooth[i] >= smooth[i + 1]);

    if (smooth[i] > thr && isLocalMax && (i - lastIdx) >= ONSET_MIN_IOI) {
      onsets++;
      lastIdx = i;
    }
  }

  const rate = onsets / durationSec;
  if (!(rate >= 0) || rate > ONSET_MAX_RATE) {
    console.warn(`vocalOnsetRate out of range: ${rate} (onsets=${onsets}, dur=${durationSec}) — returning null`);
    return null;
  }
  return +rate.toFixed(2);
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
