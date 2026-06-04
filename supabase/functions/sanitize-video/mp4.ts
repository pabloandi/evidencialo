/**
 * Portable ISO-BMFF (mp4) container metadata stripper — pure typed-array TS, NO
 * Deno/Node imports, so it runs in vitest AND the Deno Edge runtime.
 *
 * PRIVACY GOAL (SCEN-003): mp4 containers carry GPS PII as a `location` tag
 * (ISO-6709, e.g. `+40.0-074.0/`) inside `moov/udta` (the QuickTime `©xyz` atom)
 * and sometimes `moov/meta`. This module removes that metadata WITHOUT
 * transcoding (ffmpeg is unavailable in the Edge runtime).
 *
 * CRITICAL TECHNIQUE — size-PRESERVING retype, NOT removal:
 * `stco`/`co64` inside `moov` store ABSOLUTE file offsets to each media chunk in
 * `mdat`. Deleting or shrinking any `moov` child box would shift `mdat` and
 * invalidate every one of those offsets → unplayable video. Instead we locate
 * the metadata-bearing `udta` and `meta` boxes and OVERWRITE them in place:
 *   - retype the 4-byte box type to `free` (0x66 0x72 0x65 0x65), and
 *   - zero the box payload bytes.
 * `free`/`skip` boxes are defined by ISO-BMFF as free space players MUST skip.
 * Box sizes — and therefore every absolute offset in the file — are untouched,
 * so the result is byte-for-byte the same length and still plays, but the PII is
 * gone.
 *
 * We retype `udta`/`meta` wherever they appear under `moov` (and at the top
 * level), recursing into container boxes (`moov`, `trak`, `mdia`, `minf`,
 * `stbl`, `edts`) to reach nested occurrences. We deliberately do NOT recurse
 * INTO a box we have already retyped (its bytes are now free space).
 *
 * Robustness: a stream that is not parseable as a box tree (truncated header,
 * size shorter than the 8-byte header, size running past EOF, or a first box
 * that is not a plausible ISO-BMFF box) THROWS — the caller treats a parse
 * throw as a TERMINAL `'failed'` (SCEN-002), distinct from transient I/O.
 */

const HEADER_BYTES = 8; // u32 size + 4-char type
const FREE_TYPE = new Uint8Array([0x66, 0x72, 0x65, 0x65]); // 'free'

/** Box types that CONTAIN child boxes we may need to descend into. */
const CONTAINER_TYPES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "udta", // descended only when NOT being stripped (top-level safety; see below)
]);

/** Box types that carry the location/PII metadata — retype these to `free`. */
const STRIP_TYPES = new Set(["udta", "meta"]);

function readU32(buf: Uint8Array, off: number): number {
  return (
    (buf[off] * 0x1000000 +
      (buf[off + 1] << 16) +
      (buf[off + 2] << 8) +
      buf[off + 3]) >>>
    0
  );
}

function readU64(buf: Uint8Array, off: number): number {
  const hi = readU32(buf, off);
  const lo = readU32(buf, off + 4);
  // Safe for any real-world mp4 (well under 2^53 bytes).
  return hi * 0x100000000 + lo;
}

function typeString(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function isPrintableType(t: string): boolean {
  // ISO-BMFF box types are 4 chars; allow alnum, space and the QuickTime '©'
  // marker byte (0xA9). Used only for the top-level sanity check.
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 0x20 && c <= 0x7e) || c === 0xa9)) return false;
  }
  return true;
}

interface BoxHeader {
  type: string;
  /** Absolute offset of the box start (size field). */
  start: number;
  /** Absolute offset of the box payload (after size+type[+largesize]). */
  payloadStart: number;
  /** Absolute offset just past the box (start + total size). */
  end: number;
}

/**
 * Parse one box header at `off`. Returns null at clean EOF (off === limit).
 * Throws on any malformed/out-of-bounds header.
 */
function parseBoxHeader(buf: Uint8Array, off: number, limit: number): BoxHeader | null {
  if (off === limit) return null;
  if (off + HEADER_BYTES > limit) {
    throw new Error(`mp4: truncated box header at offset ${off}`);
  }
  let size = readU32(buf, off);
  const type = typeString(buf, off + 4);
  let payloadStart = off + HEADER_BYTES;

  if (size === 1) {
    // 64-bit largesize follows the type field.
    if (payloadStart + 8 > limit) {
      throw new Error(`mp4: truncated largesize at offset ${off}`);
    }
    size = readU64(buf, payloadStart);
    payloadStart += 8;
  } else if (size === 0) {
    // Box extends to EOF.
    size = limit - off;
  }

  if (size < payloadStart - off) {
    throw new Error(`mp4: box size ${size} smaller than header at offset ${off}`);
  }
  const end = off + size;
  if (end > limit) {
    throw new Error(`mp4: box at ${off} (size ${size}) runs past EOF ${limit}`);
  }
  return { type, start: off, payloadStart, end };
}

/** Retype a box to `free` and zero its payload bytes in place. */
function retypeToFree(buf: Uint8Array, box: BoxHeader): void {
  buf.set(FREE_TYPE, box.start + 4);
  buf.fill(0, box.payloadStart, box.end);
}

/**
 * Walk sibling boxes in [start, limit), stripping `udta`/`meta` (retype-to-free)
 * and recursing into known container boxes to reach nested occurrences.
 */
function walk(buf: Uint8Array, start: number, limit: number): void {
  let off = start;
  while (off < limit) {
    const box = parseBoxHeader(buf, off, limit);
    if (box === null) break;

    if (STRIP_TYPES.has(box.type)) {
      // Remove PII in place; do NOT recurse into now-free bytes.
      retypeToFree(buf, box);
    } else if (CONTAINER_TYPES.has(box.type)) {
      walk(buf, box.payloadStart, box.end);
    }
    // Leaf / unknown boxes (e.g. mdat, ftyp, stco) are left byte-for-byte intact.

    off = box.end;
  }
}

export function stripMp4Metadata(input: Uint8Array): Uint8Array {
  if (input.length < HEADER_BYTES) {
    throw new Error("mp4: input shorter than a single box header");
  }
  // Sanity gate: the first box must be a plausible ISO-BMFF box. A real mp4
  // starts with `ftyp` (or, rarely, `free`/`skip`/`moov`). Reject garbage so a
  // corrupt object becomes a TERMINAL parse failure rather than a silent no-op.
  const firstType = typeString(input, 4);
  if (!isPrintableType(firstType)) {
    throw new Error(`mp4: not an ISO-BMFF stream (first box type unprintable)`);
  }

  // Operate on a copy — pure function, never mutate the caller's buffer.
  const out = input.slice();
  walk(out, 0, out.length);
  return out;
}
