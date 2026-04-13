#!/usr/bin/env node
import 'dotenv/config';
import minimist from 'minimist';
import { spawn } from 'node:child_process';

import { parseVideoId, fetchMetadata, fetchCaptions, spawnAudioPipeline, listCaptionSources } from './src/youtube.mjs';
import { analyze, AGGREGATE_RANGES } from './src/audio.mjs';
import { exists, upsertSong } from './src/db.mjs';

const MAX_DURATION_SEC = 12 * 60;

const USAGE = `Usage: node analyzer.mjs --url "<youtube-url-or-id>" [--lang ja] [--force] [--dry-run] [--list-captions]

Flags
  --url            YouTube URL in any form, or a raw 11-char video ID  (required)
  --lang           Caption language, default "ja". Only official (human-uploaded) subtitles
                   in this exact language are accepted. If the video has no official track
                   in this language, lyrics will be null (analysis is still saved).
  --force          Reprocess even if video_id already exists in "Songs"
  --dry-run        Run the full pipeline, skip the Supabase upsert
  --list-captions  Print available caption sources for this video and exit
  --help           Show this message
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

function makeProgressReporter(duration) {
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
    string: ['url', 'lang'],
    boolean: ['force', 'dry-run', 'help', 'list-captions'],
    default: { lang: 'ja' },
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
    log(`The analyzer only uses "Official" tracks matching --lang exactly. Auto-transcribed`);
    log(`tracks are shown for reference but are never used (quality is too poor for lyrics).`);
    return;
  }

  if (!(info.duration > 0)) fail('yt-dlp returned no duration for this video');
  if (info.duration > MAX_DURATION_SEC) {
    fail(`duration ${info.duration}s exceeds hard cap of ${MAX_DURATION_SEC}s (12 min). Edit MAX_DURATION_SEC to override.`);
  }

  let cues = null;
  let captionSource = 'none';
  try {
    const result = await fetchCaptions(info, argv.lang);
    cues = result.cues;
    captionSource = result.source;
  } catch (err) {
    logWarn(`captions: fetch failed (${err.message}), continuing without lyrics`);
  }
  if (cues) {
    logOk(`captions: ${captionSource} (${cues.length} cues)`);
  } else {
    logWarn(`captions: no official '${argv.lang}' track; lyrics will be null`);
  }

  const { pcmStream, done } = spawnAudioPipeline(videoId);
  const onProgress = makeProgressReporter(info.duration);
  const analyzePromise = analyze(pcmStream, { durationHint: info.duration, onProgress });

  const analysis = await analyzePromise;
  await done;
  process.stdout.write('\n');
  logOk(`analysis: ${analysis.frames.length} frames, ${analysis.bandCount} bins, BPM ${analysis.bpm ?? 'unknown'}`);

  const row = {
    videoId,
    title: info.title,
    artist: info.artist,
    releaseDate: info.releaseDate,
    metadata: {
      duration: +analysis.duration.toFixed(3),
      fps: analysis.fps,
      bpm: analysis.bpm,
      sampleRate: analysis.sampleRate,
      bandCount: analysis.bandCount,
      bandEdges: analysis.bandEdges,
      bassRange:  [AGGREGATE_RANGES.bass.lo,  AGGREGATE_RANGES.bass.hi],
      midRange:   [AGGREGATE_RANGES.mid.lo,   AGGREGATE_RANGES.mid.hi],
      highRange:  [AGGREGATE_RANGES.high.lo,  AGGREGATE_RANGES.high.hi],
      vocalRange: [AGGREGATE_RANGES.vocal.lo, AGGREGATE_RANGES.vocal.hi],
    },
    lyrics: cues,
    analysis: analysis.frames,
  };

  if (argv['dry-run']) {
    const payloadSize = Buffer.byteLength(JSON.stringify(row));
    logOk(`dry-run: would upsert ${formatSize(payloadSize)} to "Songs" (skipped)`);
    return;
  }

  await upsertSong(row);
  logOk(`upserted to "Songs"`);
}

main().catch(err => {
  process.stdout.write('\n');
  fail(err.message || String(err));
});
