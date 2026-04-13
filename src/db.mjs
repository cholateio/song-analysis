import { createClient } from '@supabase/supabase-js';

const TABLE = 'KAF';

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
  if (error) throw new Error(`supabase select failed: ${error.message}`);
  return data !== null;
}

export async function upsertSong(row) {
  const db = getClient();
  const payload = {
    video_id: row.videoId,
    title: row.title,
    artist: row.artist,
    release_date: row.releaseDate,
    metadata: row.metadata,
    lyrics: row.lyrics,
    analysis: row.analysis,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from(TABLE).upsert(payload, { onConflict: 'video_id' });
  if (error) throw new Error(`supabase upsert failed: ${error.message}`);
}
