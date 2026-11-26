import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { derive } from "../lib/derive.ts";
import { duplicateGroups } from "../lib/duplicates.ts";
test("ten encoded images produce only the exact and resized groups", async () => {
  const image = async (seed) => {
    const pixels = Buffer.alloc(256 * 256);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++)
        pixels[y * 256 + x] =
          (Math.sin((x + seed * y) * 0.03 * seed) +
            Math.cos((y + seed * x) * 0.015)) *
            62 +
          127;
    return sharp(pixels, { raw: { width: 256, height: 256, channels: 1 } })
      .png()
      .toBuffer();
  };
  const a = await image(2),
    b = await image(3),
    screen = await image(5);
  const changed = await sharp(screen)
    .composite([
      {
        input: {
          create: { width: 24, height: 36, channels: 3, background: "white" },
        },
        left: 40,
        top: 50,
      },
    ])
    .png()
    .toBuffer();
  const files = [
    a,
    a,
    b,
    await sharp(b).resize(192).jpeg().toBuffer(),
    screen,
    changed,
    ...(await Promise.all([7, 11, 13, 17].map(image))),
  ];
  const rows = await Promise.all(
    files.map(async (file, i) => {
      const d = await derive(file);
      return {
        id: String(i),
        kind: "photo",
        filename: i + ".jpg",
        bytes: file.length,
        hash: createHash("sha256").update(file).digest("hex"),
        phash: d.bits.toString(16),
        pixels: d.pixels.toString("base64"),
        screenshot: i === 4 || i === 5,
      };
    }),
  );
  const groups = duplicateGroups(rows)
    .map((g) =>
      g
        .map((r) => r.id)
        .sort()
        .join(","),
    )
    .sort();
  assert.deepEqual(groups, ["0,1", "2,3"]);
});
test("derive reports sharpness and exposure alongside the existing outputs", async () => {
  const pixels = Buffer.alloc(512 * 512);
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++)
      pixels[y * 512 + x] = ((x >> 2) + (y >> 2)) % 2 ? 230 : 25;
  const crisp = await sharp(pixels, {
    raw: { width: 512, height: 512, channels: 1 },
  })
    .png()
    .toBuffer();
  const blurred = await sharp(crisp).blur(8).png().toBuffer();
  const a = await derive(crisp);
  const b = await derive(blurred);
  assert.ok(a.sharpness > b.sharpness * 20);
  assert.equal(typeof a.exposure.p50, "number");
  assert.ok(a.exposure.clippedLow >= 0 && a.exposure.clippedLow <= 1);
  assert.ok(Buffer.isBuffer(a.work) && Buffer.isBuffer(a.thumb));
  assert.equal(typeof a.bits, "bigint");
});
