// Binary packers for the Supabase Storage blobs.
// See docs/reference/data-contracts.md §3 and §4 for the authoritative layout spec.

const HEADER_SIZE = 8;
const BIN_VERSION = 1;

// "SABN" — Song Analysis Binary
const ANALYSIS_MAGIC = [0x53, 0x41, 0x42, 0x4E];
// "SCBN" — Song Clock Binary
const CLOCK_MAGIC    = [0x53, 0x43, 0x42, 0x4E];

const BAND_COUNT          = 64;
const ANALYSIS_FRAME_SIZE = BAND_COUNT + 3;   // v[64] + r + c + k = 67 bytes

const CLOCK_BIN_COUNT     = 128;
const CLOCK_FRAME_SIZE    = CLOCK_BIN_COUNT;  // 128 bytes

function writeHeader(buf, magic) {
  buf[0] = magic[0];
  buf[1] = magic[1];
  buf[2] = magic[2];
  buf[3] = magic[3];
  buf[4] = BIN_VERSION;
  // bytes 5..7 remain 0x00 from Buffer.alloc
}

function u8(x) {
  const r = Math.round(x);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

export function packAnalysis(frames) {
  const n = frames.length;
  const buf = Buffer.alloc(HEADER_SIZE + n * ANALYSIS_FRAME_SIZE);
  writeHeader(buf, ANALYSIS_MAGIC);

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const off = HEADER_SIZE + i * ANALYSIS_FRAME_SIZE;
    for (let j = 0; j < BAND_COUNT; j++) buf[off + j] = f.v[j];
    buf[off + BAND_COUNT    ] = u8(f.r * 255);
    buf[off + BAND_COUNT + 1] = u8(f.c * 255);
    buf[off + BAND_COUNT + 2] = f.k ? 1 : 0;
  }
  return buf;
}

export function packClock(frames) {
  const n = frames.length;
  const buf = Buffer.alloc(HEADER_SIZE + n * CLOCK_FRAME_SIZE);
  writeHeader(buf, CLOCK_MAGIC);

  for (let i = 0; i < n; i++) {
    const freq = frames[i].frequencies;
    const off = HEADER_SIZE + i * CLOCK_FRAME_SIZE;
    for (let j = 0; j < CLOCK_BIN_COUNT; j++) buf[off + j] = freq[j];
  }
  return buf;
}

export const BINARY_FORMAT = {
  headerSize: HEADER_SIZE,
  version: BIN_VERSION,
  analysis: {
    magic: 'SABN',
    frameSize: ANALYSIS_FRAME_SIZE,
    bandCount: BAND_COUNT,
  },
  clock: {
    magic: 'SCBN',
    frameSize: CLOCK_FRAME_SIZE,
    binCount: CLOCK_BIN_COUNT,
  },
};
