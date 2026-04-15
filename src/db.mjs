import { createClient } from '@supabase/supabase-js';

const TABLE = 'Songs';
const BUCKET = 'song-blobs';

let client = null;

export function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.example)');
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export async function exists(videoId) {
  const db = getClient();
  const { data, error } = await db
    .from(TABLE)
    .select('video_id')
    .eq('video_id', videoId)
    .maybeSingle();
  if (error) throw new Error(`supabase select failed: ${cleanError(error)}`);
  return data !== null;
}

export async function uploadBlob(path, buffer) {
  const db = getClient();
  const { error } = await db.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: 'application/octet-stream',
      cacheControl: '31536000',
      upsert: true,
    });
  if (error) throw new Error(`supabase storage upload "${path}" failed: ${cleanError(error)}`);
}

export async function upsertSong(row) {
  const db = getClient();
  const payload = {
    video_id:     row.videoId,
    title:        row.title,
    artist:       row.artist,
    release_date: row.releaseDate,
    metadata:     row.metadata,
    lyrics_jp:    row.lyricsJp,
    lyrics_tw:    row.lyricsTw,
    updated_at:   new Date().toISOString(),
  };
  const { error } = await db.from(TABLE).upsert(payload, { onConflict: 'video_id' });
  if (error) throw new Error(`supabase upsert failed: ${cleanError(error)}`);
}

// Supabase's edge (Cloudflare) sometimes returns an HTML error page instead of
// a JSON error. supabase-js surfaces the raw body in error.message, which
// produces walls of HTML in the terminal. Collapse it to a short summary.
function cleanError(error) {
  const msg = error?.message || String(error) || '(no message)';
  if (msg.startsWith('<') || msg.includes('<!DOCTYPE') || msg.includes('<html')) {
    const status = error?.status ? ` HTTP ${error.status}` : '';
    return `edge returned HTML error page${status} (likely Cloudflare 5xx — timeout, rate limit, or upstream failure)`;
  }
  return msg;
}
