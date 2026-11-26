import test from "node:test";
import assert from "node:assert/strict";
import { duplicateGroups } from "../lib/duplicates.ts";
import { safeCategory, seedRows, categories } from "../lib/categories.ts";
test("exact and resized pairs group, distinct screens and video previews stay separate", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: String(i),
    filename: i + ".jpg",
    bytes: 100 - i,
    kind: i > 7 ? "video" : "photo",
    hash: String(i),
    phash: null,
    pixels: null,
    screenshot: false,
  }));
  rows[1].hash = rows[0].hash;
  rows[2].phash = "ffff";
  rows[3].phash = "fffe";
  for (const i of [4, 5])
    Object.assign(rows[i], {
      phash: "0000",
      screenshot: true,
      pixels: Buffer.alloc(256, i * 40).toString("base64"),
    });
  rows[8].phash = rows[9].phash = "0000";
  assert.deepEqual(
    duplicateGroups(rows).map((g) => g.map((r) => r.id)),
    [
      ["0", "1"],
      ["2", "3"],
    ],
  );
});
test("video gets a review flag for a photo label", () =>
  assert.deepEqual(safeCategory("video", "Receipts"), {
    category: "Videos",
    review: true,
  }));
test("seed rows cover every default category, kind-tagged, with stable order", () => {
  const rows = seedRows("tester");
  assert.equal(rows.length, categories.length);
  assert.deepEqual(
    rows.map((r) => r.label),
    [...categories],
  );
  assert.deepEqual(
    rows.filter((r) => r.kind === "video").map((r) => r.label),
    ["Videos"],
  );
  assert.ok(rows.every((r) => r.owner === "tester"));
  assert.deepEqual(
    rows.map((r) => r.sort_order),
    rows.map((_, i) => i),
  );
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});
