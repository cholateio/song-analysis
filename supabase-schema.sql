-- Canonical fresh-install DDL for the song-analysis project.
-- The table name is capitalized, so every query must quote it: FROM "Songs".
-- For a description of the metadata / analysis / clock_analysis JSONB shapes
-- see DATA_CONTRACTS.md.

create table if not exists "Songs" (
  id             uuid primary key default gen_random_uuid(),
  video_id       text        not null unique,
  title          text        not null,
  artist         text,
  release_date   date,
  metadata       jsonb       not null,
  lyrics_jp      jsonb,
  lyrics_tw      jsonb,
  analysis       jsonb       not null,
  clock_analysis jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists songs_updated_at_idx on "Songs" (updated_at desc);
