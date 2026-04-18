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

-- Static, per-schemaVersion analysis constants. Moved here from per-song
-- metadata to avoid duplicating identical values on every row (bandEdges
-- alone is a 65-float list). Clients look up their schemaVersion once and
-- cache the result.
create table if not exists "AnalysisSchema" (
  version    int primary key,
  config     jsonb not null,
  created_at timestamptz not null default now()
);

insert into "AnalysisSchema" (version, config) values (2, '{
  "fps": 60,
  "sampleRate": 48000,
  "bandCount": 64,
  "bandEdges": [20,22.2,24.65,27.36,30.37,33.72,37.43,41.55,46.12,51.2,56.84,63.1,70.04,77.75,86.31,95.82,106.37,118.08,131.08,145.51,161.53,179.31,199.05,220.97,245.3,272.3,302.28,335.56,372.5,413.52,459.04,509.58,565.69,627.97,697.1,773.85,859.05,953.63,1058.62,1175.17,1304.55,1448.18,1607.62,1784.61,1981.09,2199.2,2441.33,2710.11,3008.48,3339.71,3707.4,4115.57,4568.68,5071.67,5630.05,6249.9,6937.99,7701.84,8549.79,9491.09,10536.03,11696.01,12983.7,14413.16,16000],
  "vScale": 255,
  "analysisFrameBytes": 67,
  "analysisBlobMagic": "SABN",
  "analysisBlobVersion": 1,
  "clockFrameBytes": 128,
  "clockBlobMagic": "SCBN",
  "clockBlobVersion": 1,
  "clock": {
    "fftSize": 256,
    "binCount": 128,
    "smoothingTimeConstant": 0.8,
    "minDecibels": -100,
    "maxDecibels": -30,
    "bassBinCount": 5
  }
}'::jsonb)
on conflict (version) do nothing;
