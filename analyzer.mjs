#!/usr/bin/env node
import 'dotenv/config';
import minimist from 'minimist';
import { spawn } from 'node:child_process';

import { parseVideoId, fetchMetadata, fetchCaptions, spawnAudioPipeline, listCaptionSources, parseLoudnessRangeLRA } from './src/youtube.mjs';
import { analyze } from './src/audio.mjs';
import { clockAnalyze } from './src/clock_analysis.mjs';
import { packAnalysis, packClock } from './src/binary_pack.mjs';
import { exists, upsertSong, uploadBlob } from './src/db.mjs';
import { parseTitle } from './src/title.mjs';

const MAX_DURATION_SEC = 12 * 60;

const USAGE = `Usage: node analyzer.mjs --url "<youtube-url-or-id>" [--genre <tag>] [--force] [--dry-run] [--list-captions] [--skip-lyrics]

Flags
  --url            YouTube URL in any form, or a raw 11-char video ID  (required)
  --genre          Free-form category tag (e.g. "cover", "album1", "live")
  --force          Reprocess even if video_id already exists in "Songs"
  --dry-run        Run the full pipeline, skip the Supabase upsert
  --list-captions  Print available caption sources for this video and exit
  --skip-lyrics    Skip caption download entirely (lyrics columns stay null).
                   Use when YouTube is rate-limiting caption requests.
  --help           Show this message

Captions
  The analyzer always tries YouTube's official "ja" and "zh-TW" tracks in
  parallel. Each track found is stored in its own column ("lyrics_jp" and
  "lyrics_tw"). Auto-transcribed captions are never used. If neither track
  exists, both columns are left null and audio analysis is still saved.
`;

function log(msg) { process.stdout.write(`${msg}\n`); }
function logOk(msg) { log(`\u2713 ${msg}`); }
function logWarn(msg) { log(`! ${msg}`); }
function logErr(msg) { process.stderr.write(`\u2717 ${msg}\n`); }

function fail(msg, code = 1) {
  logErr(msg);
  process.exit(code);
}

function checkBinary(cmd, args) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

async function preflight({ needsDb }) {
  if (needsDb && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
    fail('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env (see .env.example)');
  }
  const [ytOk, ffOk] = await Promise.all([
    checkBinary('yt-dlp', ['--version']),
    checkBinary('ffmpeg', ['-version']),
  ]);
  if (!ytOk) fail('yt-dlp not found on PATH. Install: scoop install yt-dlp');
  if (!ffOk) fail('ffmpeg not found on PATH. Install: scoop install ffmpeg');
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function makeProgressReporter() {
  let lastPct = -1;
  return (received, expected) => {
    if (!expected) return;
    const pct = Math.min(100, Math.floor((received / expected) * 100));
    if (pct > lastPct) {
      lastPct = pct;
      process.stdout.write(`\r  decoding audio... ${pct.toString().padStart(3)}% (${formatSize(received)})`);
    }
  };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['url', 'genre'],
    boolean: ['force', 'dry-run', 'help', 'list-captions', 'skip-lyrics'],
    alias: { h: 'help' },
  });

  if (argv.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (!argv.url) fail(`missing --url\n\n${USAGE}`);

  const videoId = parseVideoId(argv.url);
  if (!videoId) fail(`could not extract a YouTube video ID from: ${argv.url}`);
  logOk(`video_id: ${videoId}`);

  const listOnly = argv['list-captions'];
  await preflight({ needsDb: !argv['dry-run'] && !listOnly });

  if (!argv.force && !argv['dry-run'] && !listOnly) {
    const already = await exists(videoId);
    if (already) {
      log(`  already processed. Use --force to reprocess.`);
      return;
    }
  }

  const info = await fetchMetadata(videoId);
  logOk(`metadata: ${info.title}${info.artist ? ` — ${info.artist}` : ''} (${info.duration}s${info.releaseDate ? `, released ${info.releaseDate}` : ''})`);

  if (listOnly) {
    const sources = listCaptionSources(info);
    log('');
    log('Available captions:');
    log(`  Official (human-uploaded): ${sources.official.length ? sources.official.join(', ') : '(none)'}`);
    log(`  Auto-transcribed in original language: ${sources.autoOrig.length ? sources.autoOrig.map(l => `${l}-orig`).join(', ') : '(none)'}`);
    log('');
    log(`The analyzer only uses "Official" "ja" and "zh-TW" tracks. Auto-transcribed`);
    log(`tracks are shown for reference but are never used (quality is too poor for lyrics).`);
    return;
  }

  if (!(info.duration > 0)) fail('yt-dlp returned no duration for this video');
  if (info.duration > MAX_DURATION_SEC) {
    fail(`duration ${info.duration}s exceeds hard cap of ${MAX_DURATION_SEC}s (12 min). Edit MAX_DURATION_SEC to override.`);
  }

  let jp = null;
  let tw = null;
  if (argv['skip-lyrics']) {
    logWarn(`captions: skipped via --skip-lyrics; lyrics will be null`);
  } else {
    try {
      const result = await fetchCaptions(info);
      jp = result.jp;
      tw = result.tw;
      for (const errMsg of result.errors) {
        logWarn(`captions: ${errMsg}`);
      }
    } catch (err) {
      logWarn(`captions: fetch failed (${err.message}), continuing without lyrics`);
    }
    const found = [];
    if (jp) found.push(`ja (${jp.length} cues)`);
    if (tw) found.push(`zh-TW (${tw.length} cues)`);
    if (found.length > 0) {
      logOk(`captions: ${found.join(', ')}`);
    } else {
      logWarn(`captions: no official ja or zh-TW tracks; lyrics will be null`);
    }
  }

  const { pcmStream, done, getFfmpegStderr } = spawnAudioPipeline(videoId);
  const onProgress = makeProgressReporter();
  const analyzePromise = analyze(pcmStream, { durationHint: info.duration, onProgress });

  const analysis = await analyzePromise;
  await done;
  process.stdout.write('\n');
  logOk(`analysis: ${analysis.frames.length} frames, BPM ${analysis.bpm ?? 'unknown'}${analysis.bpmConfidence !== null ? ` (conf ${analysis.bpmConfidence})` : ''}`);

  const loudnessRangeLRA = parseLoudnessRangeLRA(getFfmpegStderr());
  if (loudnessRangeLRA !== null) {
    logOk(`loudness range: LRA ${loudnessRangeLRA} LU`);
  } else {
    logWarn(`loudness range: ebur128 summary not found in ffmpeg stderr; loudnessRangeLRA will be null`);
  }

  const clock = clockAnalyze(analysis.samples);
  logOk(`clock_analysis: ${clock.frames.length} frames, ${clock.binCount} bins (fftSize ${clock.fftSize})`);

  const analysisBlob = packAnalysis(analysis.frames);
  const clockBlob = packClock(clock.frames);
  const analysisPath = `analysis/${videoId}.bin`;
  const clockPath = `clock/${videoId}.bin`;
  logOk(`packed: analysis ${formatSize(analysisBlob.length)}, clock ${formatSize(clockBlob.length)}`);

  const parsedTitle = parseTitle(info.title);
  if (!parsedTitle.matched) {
    logWarn(`title: no rule matched "${info.title}", keeping as-is`);
  } else if (parsedTitle.title !== info.title) {
    logOk(`title: "${info.title}" → "${parsedTitle.title}"`);
  }

  const row = {
    videoId,
    title: parsedTitle.title,
    artist: info.artist,
    genre: argv.genre || null,
    releaseDate: info.releaseDate,
    metadata: {
      schemaVersion: 2,
      duration: +analysis.duration.toFixed(3),
      frameCount: analysis.frames.length,
      bpm: analysis.bpm,
      bpmConfidence: analysis.bpmConfidence,
      medianCentroidHz: analysis.medianCentroidHz,
      loudnessRangeLRA,
      zcrVariance: analysis.zcrVariance,
      meanSpectralContrastDb: analysis.meanSpectralContrastDb,
      vocalOnsetRate: analysis.vocalOnsetRate,
      vocalModulationHz: analysis.vocalModulationHz,
      vocalCentroidHz: analysis.vocalCentroidHz,
      analysisBlob: analysisPath,
      clockBlob: clockPath,
    },
    lyricsJp: jp,
    lyricsTw: tw,
  };

  if (argv['dry-run']) {
    const rowSize = Buffer.byteLength(JSON.stringify(row));
    const total = rowSize + analysisBlob.length + clockBlob.length;
    logOk(`dry-run: row ${formatSize(rowSize)} + blobs ${formatSize(analysisBlob.length + clockBlob.length)} = ${formatSize(total)} (upload skipped)`);
    return;
  }

  await uploadBlob(analysisPath, analysisBlob);
  logOk(`uploaded: ${analysisPath}`);
  await uploadBlob(clockPath, clockBlob);
  logOk(`uploaded: ${clockPath}`);
  await upsertSong(row);
  logOk(`upserted to "Songs"`);
}

main().catch(err => {
  process.stdout.write('\n');
  fail(err.message || String(err));
});
