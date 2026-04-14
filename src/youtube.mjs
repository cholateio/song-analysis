import { spawn } from 'node:child_process';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const YTDLP_BASE_ARGS = ['--js-runtimes', 'node', '--no-warnings'];

export function parseVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  let u;
  try { u = new URL(trimmed); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      return id && VIDEO_ID_RE.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|embed|v|live)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

function videoUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function runCommand(cmd, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let size = 0;
    child.stdout.on('data', d => {
      size += d.length;
      if (size > maxBuffer) {
        child.kill();
        reject(new Error(`${cmd} stdout exceeded ${maxBuffer} bytes`));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout: Buffer.concat(chunks).toString('utf8'), stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

function ymdToIso(ymd) {
  if (!ymd || !/^\d{8}$/.test(ymd)) return null;
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export async function fetchMetadata(videoId) {
  const { stdout } = await runCommand('yt-dlp', [
    ...YTDLP_BASE_ARGS,
    '--dump-json',
    '--skip-download',
    videoUrl(videoId),
  ]);
  const info = JSON.parse(stdout);
  if (info.is_live === true || info.live_status === 'is_live') {
    throw new Error('video is a live stream in progress; cannot analyze');
  }
  return {
    videoId: info.id,
    title: info.title,
    artist: info.uploader || info.channel || null,
    duration: Number(info.duration) || 0,
    releaseDate: ymdToIso(info.release_date) || ymdToIso(info.upload_date),
    subtitles: info.subtitles || {},
    automaticCaptions: info.automatic_captions || {},
  };
}

export async function fetchCaptions(info, langs) {
  const results = await Promise.all(
    langs.map(async (lang) => {
      const tracks = info.subtitles?.[lang];
      if (!Array.isArray(tracks)) return { lang, cues: null };
      const track = tracks.find(t => t.ext === 'vtt');
      if (!track) return { lang, cues: null };
      try {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const vtt = await res.text();
        const cues = parseVtt(vtt);
        return { lang, cues };
      } catch (err) {
        return { lang, cues: null, error: err.message };
      }
    })
  );

  const cuesByLang = {};
  const sources = [];
  const errors = [];
  for (const r of results) {
    if (r.cues && r.cues.length > 0) {
      cuesByLang[r.lang] = r.cues;
      sources.push(`official:${r.lang}`);
    } else if (r.error) {
      errors.push(`${r.lang}: ${r.error}`);
    }
  }
  return { cuesByLang, sources, errors };
}

export function listCaptionSources(info) {
  const official = Object.keys(info.subtitles || {}).filter(k => k !== 'live_chat');
  const autoKeys = Object.keys(info.automaticCaptions || {});
  const autoOrig = autoKeys.filter(k => k.endsWith('-orig')).map(k => k.slice(0, -'-orig'.length));
  return { official, autoOrig };
}

function vttTimeToSeconds(s) {
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

export function parseVtt(vtt) {
  const blocks = vtt.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map(l => l.replace(/\r$/, ''));
    const timingIdx = lines.findIndex(l => l.includes('-->'));
    if (timingIdx < 0) continue;
    const [startStr, endRest] = lines[timingIdx].split('-->').map(s => s.trim());
    if (!startStr || !endRest) continue;
    const endStr = endRest.split(/\s+/)[0];
    const start = vttTimeToSeconds(startStr);
    const end = vttTimeToSeconds(endStr);
    if (!(end > start)) continue;

    const textRaw = lines.slice(timingIdx + 1).join(' ');
    const text = textRaw
      .replace(/<\d{1,2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    const last = cues[cues.length - 1];
    if (last && last.t === text) {
      last.d = +((end - last.s).toFixed(3));
      continue;
    }
    if (last && text.startsWith(last.t) && text.length > last.t.length) {
      last.t = text;
      last.d = +((end - last.s).toFixed(3));
      continue;
    }

    let trimmed = text;
    if (last) {
      const prev = last.t;
      const maxOverlap = Math.min(prev.length, trimmed.length);
      for (let n = maxOverlap; n >= 3; n--) {
        if (trimmed.startsWith(prev.slice(-n))) {
          trimmed = trimmed.slice(n).replace(/^[\s\u3000]+/, '').replace(/[\s\u3000]+$/, '');
          break;
        }
      }
    }
    if (!trimmed) continue;

    cues.push({
      s: +start.toFixed(3),
      d: +((end - start).toFixed(3)),
      t: trimmed,
    });
  }
  return cues;
}

export function spawnAudioPipeline(videoId) {
  const ytdlp = spawn('yt-dlp', [
    ...YTDLP_BASE_ARGS,
    '-f', 'bestaudio',
    '-o', '-',
    '--quiet',
    videoUrl(videoId),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 'f32le',
    '-ac', '1',
    '-ar', '48000',
    'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ytdlpStderr = '';
  let ffmpegStderr = '';
  ytdlp.stderr.on('data', d => { ytdlpStderr += d.toString('utf8'); });
  ffmpeg.stderr.on('data', d => { ffmpegStderr += d.toString('utf8'); });

  ytdlp.stdout.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});
  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.on('error', err => {
    try { ffmpeg.kill('SIGKILL'); } catch {}
    ffmpeg.emit('error', new Error(`yt-dlp spawn failed: ${err.message}`));
  });

  const done = new Promise((resolve, reject) => {
    let ytdlpClosed = false;
    let ffmpegClosed = false;
    let ytdlpCode = null;
    let ffmpegCode = null;
    const check = () => {
      if (ytdlpClosed && ffmpegClosed) {
        if (ffmpegCode === 0) resolve();
        else if (ytdlpCode !== 0) reject(new Error(`yt-dlp exited ${ytdlpCode}: ${ytdlpStderr.trim() || '(no stderr)'}`));
        else reject(new Error(`ffmpeg exited ${ffmpegCode}: ${ffmpegStderr.trim() || '(no stderr)'}`));
      }
    };
    ytdlp.on('close', c => { ytdlpClosed = true; ytdlpCode = c; check(); });
    ffmpeg.on('close', c => { ffmpegClosed = true; ffmpegCode = c; check(); });
  });

  return { pcmStream: ffmpeg.stdout, done };
}
