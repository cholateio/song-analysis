-- Canonical fresh-install DDL for the song-analysis project.
-- The table name is capitalized, so every query must quote it: FROM "Songs".
-- For a description of the metadata JSONB shape and the binary blob format
-- used for analysis + clock_analysis, see DATA_CONTRACTS.md.
--
-- Prerequisite: in the Supabase dashboard, create a public Storage bucket
-- named 'song-blobs' before running analyzer.mjs. The analyzer uploads
-- per-song binary blobs to:
--   song-blobs/analysis/<video_id>.bin
--   song-blobs/clock/<video_id>.bin

create table if not exists "Songs" (
  id             uuid primary key default gen_random_uuid(),
  video_id       text        not null unique,
  title          text        not null,
  artist         text,
  genre          text,
  release_date   date,
  metadata       jsonb       not null,
  lyrics_jp      jsonb,
  lyrics_tw      jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists songs_updated_at_idx on "Songs" (updated_at desc);
