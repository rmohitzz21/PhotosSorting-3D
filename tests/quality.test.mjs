import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { sharpness, exposure } from "../lib/quality.ts";

const grey = async (buffer, size = 512) =>
  sharp(buffer).resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();

const checkerboard = async () => {
  const pixels = Buffer.alloc(512 * 512);
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++)
      pixels[y * 512 + x] = ((x >> 2) + (y >> 2)) % 2 ? 230 : 25;
  return sharp(pixels, { raw: { width: 512, height: 512, channels: 1 } })
    .png()
    .toBuffer();
};

test("a blurred image scores far lower sharpness than its sharp original", async () => {
  const crisp = await checkerboard();
  const blurred = await sharp(crisp).blur(8).png().toBuffer();
  const crispScore = sharpness(await grey(crisp), 512, 512);
  const blurredScore = sharpness(await grey(blurred), 512, 512);
  // Measured 2026-11-25 with sharp 0.35.5: crisp 62708.2, blurred 0.1177.
  assert.ok(crispScore > 50000, "a hard checkerboard should score high, got " + crispScore);
  assert.ok(blurredScore < 1, "a heavily blurred copy should collapse, got " + blurredScore);
});

test("a flat image has near-zero sharpness", () => {
  // Built as a raw buffer: sharp's `create` only supports 3 or 4 channels.
  assert.ok(sharpness(Buffer.alloc(512 * 512, 128), 512, 512) < 1);
});

test("exposure reports percentiles and clipping fractions", () => {
  const ramp = Buffer.alloc(256 * 100);
  for (let v = 0; v < 256; v++) ramp.fill(v, v * 100, v * 100 + 100);
  const e = exposure(ramp);
  // 100 pixels per value, 25600 total: the half mark falls inside value 127.
  assert.equal(e.p50, 127);
  assert.ok(e.p1 <= 3 && e.p99 >= 252);
  assert.ok(Math.abs(e.clippedLow - 1 / 256) < 1e-9);
  assert.ok(Math.abs(e.clippedHigh - 1 / 256) < 1e-9);
});

test("a fully black image reads as entirely clipped low", () => {
  const e = exposure(Buffer.alloc(1000));
  assert.equal(e.p50, 0);
  assert.equal(e.clippedLow, 1);
  assert.equal(e.clippedHigh, 0);
});
