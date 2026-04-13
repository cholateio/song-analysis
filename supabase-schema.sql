-- Run once in the Supabase SQL editor (or via CLI) to create the Songs table.
-- Note: the table name is capitalized, so every query must quote it: FROM "Songs"
--
-- If you already created this table with the older schema (video_id as PK),
-- run supabase-migration-add-id.sql instead to add the id column in place.

create table if not exists "Songs" (
  id            uuid primary key default gen_random_uuid(),
  video_id      text        not null unique,
  title         text        not null,
  artist        text,
  release_date  date,
  metadata      jsonb       not null,
  lyrics        jsonb,
  analysis      jsonb       not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists songs_updated_at_idx on "Songs" (updated_at desc);
