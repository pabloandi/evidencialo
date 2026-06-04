import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stripMp4Metadata } from "./mp4";

/**
 * SCEN-003 — container location metadata is stripped from the stored video.
 *
 * Uses REAL ffmpeg/ffprobe (available locally) to mint and inspect fixtures, so
 * the privacy claim is verified against an actual mp4 muxer/demuxer rather than a
 * synthetic byte pattern. The test is non-vacuous: it first asserts the INPUT
 * fixture genuinely carries the location tag.
 */

function ffprobeFormatLocation(file: string): string {
  // `location` may surface under a couple of tag keys depending on the muxer;
  // dump ALL format tags and grep for an ISO-6709-looking value.
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format_tags",
      "-of",
      "default=noprint_wrappers=1",
      file,
    ],
    { encoding: "utf8" },
  );
  return out;
}

function ffprobeHasVideoStream(file: string): boolean {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .includes("video");
}

describe("stripMp4Metadata (SCEN-003)", () => {
  let dir: string;
  let inputPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mp4-strip-"));
    inputPath = join(dir, "in.mp4");
    // Mint a tiny mp4 carrying a container-level GPS location tag.
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=160x120:rate=5",
        "-metadata",
        "location=+40.0-074.0/",
        inputPath,
      ],
      { stdio: "ignore" },
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ffmpeg normalizes `+40.0-074.0/` to the zero-padded ISO-6709 form below and
  // emits both `location` and `location-eng` tag keys. Match the real stored
  // value, not the pre-normalization literal.
  const GPS_VALUE = "40.0000-074.0000";

  it("INPUT fixture genuinely carries the location tag (non-vacuous)", () => {
    const tags = ffprobeFormatLocation(inputPath);
    expect(tags.toLowerCase()).toContain("location");
    expect(tags).toContain(GPS_VALUE);
  });

  it("OUTPUT exposes NO location metadata and stays a valid playable video", () => {
    const input = new Uint8Array(readFileSync(inputPath));
    const output = stripMp4Metadata(input);

    const outPath = join(dir, "out.mp4");
    writeFileSync(outPath, output);

    const tags = ffprobeFormatLocation(outPath);
    // Privacy: the GPS ISO-6709 value must be gone from the container tags.
    expect(tags).not.toContain(GPS_VALUE);
    expect(tags.toLowerCase()).not.toContain("location");

    // Not corrupted: ffprobe still demuxes a video stream.
    expect(ffprobeHasVideoStream(outPath)).toBe(true);
  });

  it("is a pure function (does not mutate the input buffer)", () => {
    const input = new Uint8Array(readFileSync(inputPath));
    const copy = input.slice();
    stripMp4Metadata(input);
    expect(input).toEqual(copy);
  });

  it("throws on a non-mp4 / corrupt byte stream (terminal-failure signal)", () => {
    const garbage = new Uint8Array(2048);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 31 + 7) & 0xff;
    expect(() => stripMp4Metadata(garbage)).toThrow();
  });
});

/**
 * SCEN-H02 — a pathologically deep-nested mp4 fails cleanly without exhausting
 * the runtime. A valid box tree that nests `moov` containers far deeper than any
 * real mp4 must throw a clean "nesting too deep" parse error (so the caller marks
 * the media terminal 'failed'), NOT a `RangeError: Maximum call stack size
 * exceeded` from unbounded recursion.
 */
describe("stripMp4Metadata depth bound (SCEN-H02)", () => {
  const HEADER = 8;

  function writeU32(buf: Uint8Array, off: number, v: number): void {
    buf[off] = (v >>> 24) & 0xff;
    buf[off + 1] = (v >>> 16) & 0xff;
    buf[off + 2] = (v >>> 8) & 0xff;
    buf[off + 3] = v & 0xff;
  }

  function setType(buf: Uint8Array, off: number, type: string): void {
    for (let i = 0; i < 4; i++) buf[off + 4 + i] = type.charCodeAt(i);
  }

  /**
   * Build `levels` nested `moov` boxes: each box is [size][moov][next-box].
   * The innermost box is an empty 8-byte `free`. Sizes are filled bottom-up so
   * the tree is a VALID ISO-BMFF parse (every box fits its parent exactly).
   */
  function buildDeepNest(levels: number): Uint8Array {
    const total = HEADER * (levels + 1); // `levels` moov headers + 1 leaf
    const buf = new Uint8Array(total);
    // Innermost leaf at the deepest offset.
    let off = HEADER * levels;
    writeU32(buf, off, HEADER);
    setType(buf, off, "free");
    // Wrap outward: each moov box spans from its offset to EOF (size = total-off).
    for (let level = levels - 1; level >= 0; level--) {
      off = HEADER * level;
      writeU32(buf, off, total - off);
      setType(buf, off, "moov");
    }
    return buf;
  }

  it("throws a clean 'nesting too deep' error (not a RangeError)", () => {
    const deep = buildDeepNest(1000);
    let thrown: unknown;
    try {
      stripMp4Metadata(deep);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toMatch(/nesting too deep/i);
  });

  it("still strips a normal shallow mp4 (depth bound does not break valid files)", () => {
    // A 3-level box from the same builder is well under the bound and parses.
    const shallow = buildDeepNest(3);
    expect(() => stripMp4Metadata(shallow)).not.toThrow();
  });
});
