// 花譜-specific YouTube title → display title normalizer.
//
// Strips noisy prefixes (【歌ってみた】etc.) and attribution tails so the
// frontend A–Z index sorts on the actual song name, then composes a display
// title that preserves useful context (collab, 組曲, feat., MV type) after
// the song name.
//
// Output shape: `<songName>[ /<collab>][<tag1><tag2>...]`
// Examples:
//   "花譜 #77「ソレカラ」【オリジナルMV】"
//     → "ソレカラ【オリジナルMV】"
//   "【組曲2】花譜×崎山蒼志 # 139「抱きしめて」【オリジナルMV】"
//     → "抱きしめて /花譜×崎山蒼志【組曲】"
//
// parseTitle never throws. If no rule matches, the raw title is returned
// verbatim with matched:false so the caller can log a warning.

const TRAILING_BY_KAF = /\s*(?:covered\s+by\s+花譜|by\s+花譜)\s*$/i;
const BRACKET = /【([^】]+)】/;
const LEADING_BRACKET = /^【[^】]+】/;
const TRAILING_BRACKET = /【[^】]+】\s*$/;
const QUOTED = /「([^」]+)」/;
const FEAT = /feat\.\s+([^\s(【]+)(?:\s*\([^)]*\))?/i;
const COLLAB = /花譜\s*[×xX✕]\s*([^\s#「【/]+)/;

export function parseTitle(raw) {
  if (typeof raw !== 'string') return { title: String(raw ?? ''), matched: false };
  const original = raw;

  let s = raw.replace(TRAILING_BY_KAF, '').trim();

  // 1. Peel leading 【...】 tags off into prefixTags.
  const prefixTags = [];
  while (LEADING_BRACKET.test(s)) {
    const m = s.match(LEADING_BRACKET);
    prefixTags.push(m[0]);
    s = s.slice(m[0].length).trim();
  }

  // 2. Peel trailing 【...】 tags off into suffixTags (preserve original order).
  const suffixTags = [];
  while (TRAILING_BRACKET.test(s)) {
    const m = s.match(TRAILING_BRACKET);
    suffixTags.unshift(m[0].trim());
    s = s.slice(0, s.length - m[0].length).trim();
  }

  // 3. Extract 「song」 if present — that's the authoritative song name.
  let songName = null;
  let quotedLead = s;
  const quoted = s.match(QUOTED);
  if (quoted) {
    songName = quoted[1].trim();
    quotedLead = s.slice(0, s.indexOf(quoted[0])).trim();
  }

  // 4. Look for feat. X in the un-quoted remainder.
  const featMatch = s.match(FEAT);
  const featName = featMatch ? featMatch[1].trim() : null;

  // 5. Look for collab (花譜×X) in the part that comes before the song.
  //    When 「」 quoted the song, search the head; otherwise search the whole tail.
  const collabSearchScope = quoted ? quotedLead : s;
  const collabMatch = collabSearchScope.match(COLLAB);
  const collab = collabMatch ? `花譜×${collabMatch[1].trim()}` : null;

  // 6. Fallback song extraction when there was no 「...」.
  if (!songName) {
    songName = fallbackSongName(s);
  }

  // 7. Normalize tags.
  const normalizedPrefix = [];
  let hasSuite = false;
  for (const tag of prefixTags) {
    const inner = tag.slice(1, -1).trim();
    const suiteMatch = inner.match(/^組曲\s*\d*$/);
    if (suiteMatch) {
      normalizedPrefix.push('【組曲】');
      hasSuite = true;
      continue;
    }
    if (inner.startsWith('音楽的同位体')) {
      // Subsumed by feat. X in tail when both are present.
      if (featName) continue;
      normalizedPrefix.push(tag);
      continue;
    }
    normalizedPrefix.push(tag);
  }

  const normalizedSuffix = [];
  for (const tag of suffixTags) {
    if (tag === '【オリジナルMV】' && hasSuite) continue; // 組曲 implies MV
    normalizedSuffix.push(tag);
  }

  const tags = [...normalizedPrefix, ...normalizedSuffix];
  if (featName && !tags.some(t => t.startsWith('【feat.'))) {
    tags.push(`【feat. ${featName}】`);
  }

  // 8. Did any rule fire?
  const matched =
    prefixTags.length > 0 ||
    suffixTags.length > 0 ||
    quoted !== null ||
    featMatch !== null ||
    collabMatch !== null;

  if (!matched) {
    return { title: original, matched: false };
  }

  if (!songName) {
    return { title: original, matched: false };
  }

  let out = songName;
  if (collab) out += ` /${collab}`;
  out += tags.join('');

  return { title: out, matched: true };
}

function fallbackSongName(s) {
  // Drop leading "花譜" + optional "#NN" / "# NN".
  let t = s.replace(/^花譜\s*(?:#\s*\d+)?\s*/, '').trim();
  // Drop "/ 花譜 feat. X(Y)" attribution tail.
  t = t.replace(/\s*\/\s*花譜[^]*$/, '').trim();
  // Drop "feat. X(Y)" if nothing else stripped it.
  t = t.replace(/\s*feat\.[^]*$/i, '').trim();
  return t || s.trim();
}
