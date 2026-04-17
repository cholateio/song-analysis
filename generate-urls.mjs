#!/usr/bin/env node
// Generates a <url> <genre> text file for batch.mjs by scraping a YouTube
// channel with yt-dlp. See docs/superpowers/specs/2026-04-17-generate-urls-design.md

export function classify(title) {
  if (title.includes('歌ってみた') || title.includes('試著唱了')) return 'cover';
  if (title.includes('可不')) return 'kafu';
  if (title.includes('組曲')) return 'collab';
  return 'album';
}

export function shouldSkip({ duration, title }) {
  if (duration == null) return { skip: true, reason: 'no-duration' };
  if (duration < 120) return { skip: true, reason: 'short' };
  if (title.includes('Trailer')) return { skip: true, reason: 'trailer' };
  if (title.includes('Live Ver')) return { skip: true, reason: 'live' };
  return { skip: false };
}
