import sharp from "sharp";
import { sharpness, exposure } from "./quality.ts";

const METRIC_SIZE = 512;

export async function derive(input: Buffer) {
  const work = await sharp(input)
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 83 })
    .toBuffer();
  const thumb = await sharp(work).resize(256, 256).jpeg().toBuffer();
  const raw = await sharp(work)
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bits = (bits << 1n) | BigInt(raw[y * 9 + x] > raw[y * 9 + x + 1]);
  const pixels = await sharp(work)
    .resize(128, 128, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  // One extra greyscale pass: 128px is too soft to separate blur reliably.
  const metrics = await sharp(work)
    .resize(METRIC_SIZE, METRIC_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  return {
    work,
    thumb,
    bits,
    pixels,
    sharpness: sharpness(metrics, METRIC_SIZE, METRIC_SIZE),
    exposure: exposure(metrics),
  };
}
