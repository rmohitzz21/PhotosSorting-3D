# Slice 1 — Reclaim Space and Best-of Culling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the metrics Slice 0 produced into a Reclaim screen that names a GB figure, proposes a keeper per duplicate group and per burst, and exports a worklist — then render it as the first WebGL surface.

**Architecture:** Analysis rows finally get written on both import paths; three pure modules (junk thresholds, burst grouping, cluster view model) turn them into proposals; one endpoint serves those proposals to two renderers — a DOM list that is the real implementation, and an instanced WebGL cluster scene layered on top behind a capability gatekeeper.

**Tech Stack:** Next.js 16, React 19.3.1, Postgres/PGlite, `sharp`, `exif-reader`, `three` 0.187, `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-25-3d-powers-design.md` (Slice 1 section).

**Prior plan:** `docs/superpowers/plans/2026-11-25-slice-0-foundation.md`.

---

## Prerequisites

Still not a git repository — confirm before starting and ask the owner before `git init`, since
`.env.local` holds live secrets. If it is still not a repo, skip every commit step and say so
when reporting.

Establish a green baseline:

```bash
npm test && npm run build
```

Expected: 20 tests pass across 8 files; build compiles with TypeScript clean.

---

## Two defects inherited from Slice 0

**D3 — nothing writes the `analysis` table.** `lib/derive.ts` returns `sharpness` and
`exposure`, but `lib/save-preview.ts:4` destructures only `{work, thumb, bits, pixels}` and
drops them, and no code path inserts an `analysis` row. Slice 0's file table listed
`save-preview.ts` as "pass the new metrics through" but no task step covered it. Every culling
and junk feature in this slice depends on it. Fixed in Task 1.

**D4 — no `camera` column.** `MASTER_PROMPT.md` §6 lists `camera` in the data model; the real
schema has no such column and no code reads EXIF. Burst grouping is defined as "same camera,
gaps under 2s" (§7, §8.4), so it cannot be built without it. Fixed in Task 2.

Both are closed before any feature work. Tasks 1 and 2 are not optional.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/analysis-store.ts` | **Create.** Upsert one `analysis` row. The only writer of that table. |
| `lib/save-preview.ts` | **Modify.** Return `sharpness`, `exposure`, `camera` to callers. |
| `lib/derive.ts` | **Modify.** Parse EXIF for camera make/model. |
| `schema.sql` | **Modify.** `media.camera`; index for burst scans. |
| `app/api/import/route.ts` | **Modify.** Write the analysis row and camera on the local path. |
| `lib/photo-picker.ts` | **Modify.** Same, on the Picker path. |
| `lib/junk.ts` | **Create.** Pure junk classification + the threshold table. |
| `lib/bursts.ts` | **Create.** Pure burst grouping and keeper ranking. |
| `lib/clusters.ts` | **Create.** Pure view model unifying dupe groups, bursts and junk. |
| `lib/reclaim.ts` | **Create.** Reads the DB, calls the pure modules, returns the view model. |
| `app/api/reclaim/route.ts` | **Create.** GET proposals, POST a keeper change. |
| `app/api/worklist/route.ts` | **Create.** CSV worklist + `audit_log` row. |
| `app/reclaim-panel.tsx` | **Create.** The DOM reclaim screen — the real implementation. |
| `app/browse-tabs.tsx` | **Modify.** Add the Reclaim tab. |
| `app/library.tsx` | **Modify.** Mount the panel on that tab. |
| `app/three/capability.ts` | **Create.** Pure `shouldRender3D`. No three imports. |
| `app/three/atlas.ts` | **Create.** Pure `LayerCache` LRU. No three imports. |
| `app/three/damp.ts` | **Create.** Pure damping math. |
| `app/three/scene.tsx` | **Create.** `<Scene3D fallback>` gatekeeper. |
| `app/three/camera-rig.ts` | **Create.** `useCameraRig`. |
| `app/three/clusters.tsx` | **Create.** The instanced cluster scene. |
| `tests/junk.test.mjs` | **Create.** Threshold and placeholder-safety assertions. |
| `tests/bursts.test.mjs` | **Create.** Grouping and ranking assertions. |
| `tests/clusters.test.mjs` | **Create.** View model assertions. |
| `tests/three.test.mjs` | **Create.** Gatekeeper, LRU and damping assertions. |
| `tests/reclaim.test.mjs` | **Create.** End-to-end over a seeded database. |

### Ordering

**Tasks 1–11 are the shippable product.** They deliver the Reclaim screen as DOM, which the
spec designates the real implementation — keyboard-navigable and screen-reader-correct. There
is a hard checkpoint at Task 11.

**Tasks 12–16 add the WebGL surface** on top. If they are abandoned, Slice 1 still ships.

---

## Task 1: Persist analysis rows (closes D3)

**Files:**
- Create: `lib/analysis-store.ts`
- Modify: `lib/save-preview.ts`
- Modify: `app/api/import/route.ts`
- Modify: `lib/photo-picker.ts`
- Test: `tests/reclaim.test.mjs` (asserted in Task 10; verified by Step 5 here)

- [ ] **Step 1: Create the store**

Create `lib/analysis-store.ts`:

```typescript
import { db } from "./db";
import type { Exposure } from "./quality.ts";

export type Metrics = { sharpness: number; exposure: Exposure };

/** The only writer of the analysis table. Safe to call twice for the same item. */
export async function writeAnalysis(mediaId: string, metrics: Metrics) {
  await db()`
    insert into analysis(media_id,sharpness,exposure)
    values(${mediaId},${metrics.sharpness},${JSON.stringify(metrics.exposure)}::jsonb)
    on conflict(media_id) do update
      set sharpness=excluded.sharpness, exposure=excluded.exposure`;
}
```

- [ ] **Step 2: Return the metrics from savePreview**

Replace the whole of `lib/save-preview.ts`:

```typescript
import { save } from "./preview-store";
import { derive } from "./derive";
export async function savePreview(user: string, id: string, input: Buffer) {
  const { work, thumb, bits, pixels, sharpness, exposure, camera } =
    await derive(input);
  const store = (label: string, data: Buffer) =>
    save(user + "/" + id + "/" + label + ".jpg", data);
  return {
    small: await store("thumb", thumb),
    large: await store("work", work),
    pixels: pixels.toString("base64"),
    phash: bits.toString(16),
    sharpness,
    exposure,
    camera,
  };
}
```

`camera` arrives in Task 2. Until then `derive()` does not return it and TypeScript will error
on that destructure — do Task 2 before building, or do Tasks 1 and 2 as one unit.

- [ ] **Step 3: Write the row on the local import path**

In `app/api/import/route.ts`, the success branch currently reads:

```typescript
    const input = Buffer.from(await file.arrayBuffer());
    const { small, large, pixels, phash } = await savePreview(user, id, input);
    await sql`update media set thumb=${small},work=${large},pixels=${pixels},phash=${phash},screenshot=${/\.png$|screen.?shot/i.test(name)},state='ready' where id=${id}`;
```

Replace those three lines with:

```typescript
    const input = Buffer.from(await file.arrayBuffer());
    const preview = await savePreview(user, id, input);
    await sql`update media set thumb=${preview.small},work=${preview.large},pixels=${preview.pixels},phash=${preview.phash},camera=${preview.camera},screenshot=${/\.png$|screen.?shot/i.test(name)},state='ready' where id=${id}`;
    await writeAnalysis(id, {
      sharpness: preview.sharpness,
      exposure: preview.exposure,
    });
```

Add the import at the top:

```typescript
import { writeAnalysis } from "../../../lib/analysis-store";
```

- [ ] **Step 4: Write the row on the Picker path**

In `lib/photo-picker.ts`, the insert added `sort_at` in Slice 0. Add `camera` to the column
list after `screenshot`'s neighbours — change the column list to end
`...,pixels,phash,screenshot,camera)` and append the value
`,${preview?.camera ?? null}` immediately after the `screenshot` expression.

That `insert into media` is the last statement inside the `.map(async (item) => { … })`
callback, immediately before its closing `}),`. Add the analysis write directly after it, still
inside the callback:

```typescript
          if (preview)
            await writeAnalysis(item.local, {
              sharpness: preview.sharpness,
              exposure: preview.exposure,
            });
```

Add the import at the top of the file:

```typescript
import { writeAnalysis } from "./analysis-store";
```

The `if (preview)` guard matters: a failed download leaves `preview` undefined and the media
row is inserted with `state='error'`. An error row gets no analysis row, and every consumer in
this slice filters on `state='ready'`.

- [ ] **Step 5: Verify both paths write rows**

Run: `npm test`
Expected: 20 tests still pass. `tests/import-integration.test.mjs` drives the Picker path and
asserts `analysis` is empty after `erase()`; it will now be non-empty *before* erase, and the
cascade must still clear it.

Add a positive assertion to `tests/import-integration.test.mjs`, immediately before the
`await erase();` line:

```javascript
  const analysed = (
    await pg.query("select count(*)::int n from analysis")
  ).rows[0].n;
  assert.ok(analysed > 0, "importing should write analysis rows, got " + analysed);
```

Run: `npm test`
Expected: PASS. If `analysed` is 0, the Picker path is not calling `writeAnalysis` — fix the
call site, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add lib/analysis-store.ts lib/save-preview.ts app/api/import/route.ts lib/photo-picker.ts tests/import-integration.test.mjs
git commit -m "fix: persist analysis rows on both import paths"
```

---

## Task 2: Camera from EXIF (closes D4)

`sharp` returns the EXIF block as a raw Buffer, not parsed fields. `exif-reader` (2.0.3, no
dependencies) is the reader `sharp`'s own documentation points to, and burst grouping needs
Make and Model — that is the one-line justification `MASTER_PROMPT.md` §5 asks for.

Camera is read from the **downloaded bytes**, not from Picker metadata, so both import routes
go through one code path. Per §1.4 the bytes carry EXIF minus location, which is exactly what
is needed here and nothing more.

**Files:**
- Modify: `package.json` (add `exif-reader`)
- Modify: `lib/derive.ts`
- Modify: `schema.sql`
- Test: `tests/images.test.mjs`

- [ ] **Step 1: Install the reader**

```bash
npm install exif-reader@2.0.3
```

Expected: one package added, no peer warnings.

- [ ] **Step 2: Add the column**

Append to `schema.sql`:

```sql
-- Slice 1: camera make/model, needed to group bursts by device.
ALTER TABLE media ADD COLUMN IF NOT EXISTS camera text;
-- Slice 1: burst grouping scans an owner's ready photos in capture order.
CREATE INDEX IF NOT EXISTS media_owner_burst ON media(owner, camera, taken_at)
  WHERE state = 'ready' AND kind = 'photo';
```

- [ ] **Step 3: Write the failing test**

Append to `tests/images.test.mjs`:

```javascript
test("derive reads the camera make and model, and tolerates absent EXIF", async () => {
  const plain = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "grey" },
  })
    .jpeg()
    .toBuffer();
  assert.equal((await derive(plain)).camera, null, "no EXIF means no camera");

  const tagged = await sharp(plain)
    .withExif({ IFD0: { Make: "Canon", Model: "EOS R5" } })
    .jpeg()
    .toBuffer();
  assert.equal((await derive(tagged)).camera, "Canon EOS R5");

  const modelOnly = await sharp(plain)
    .withExif({ IFD0: { Model: "Pixel 9" } })
    .jpeg()
    .toBuffer();
  assert.equal((await derive(modelOnly)).camera, "Pixel 9");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/images.test.mjs`
Expected: FAIL — `camera` is `undefined`, not `null`.

- [ ] **Step 5: Implement**

In `lib/derive.ts`, add the imports:

```typescript
import exifReader from "exif-reader";
```

Add this helper above `derive`:

```typescript
/** "Make Model", or just whichever is present, or null. Never throws on bad EXIF. */
function cameraFrom(exif: Buffer | undefined) {
  if (!exif) return null;
  try {
    const tags = exifReader(exif)?.Image;
    const make = typeof tags?.Make === "string" ? tags.Make.trim() : "";
    const model = typeof tags?.Model === "string" ? tags.Model.trim() : "";
    // Many phones repeat the make inside the model ("Canon Canon EOS R5").
    const label = model.startsWith(make) ? model : [make, model].join(" ").trim();
    return label || null;
  } catch {
    return null;
  }
}
```

Inside `derive`, read the metadata from the original input before resizing, and include the
result in the returned object:

```typescript
export async function derive(input: Buffer) {
  const camera = cameraFrom((await sharp(input).metadata()).exif);
```

and add `camera,` to the returned object literal.

Read EXIF from `input`, not from `work`: the JPEG re-encode does not carry the original EXIF
block forward.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/images.test.mjs`
Expected: PASS, 4 tests.

If `exifReader(exif)?.Image` is undefined, log the parsed object — `exif-reader` 2.x nests
IFD0 tags under `Image`, but confirm against the installed version rather than assuming.

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS and a clean build. Task 1's `savePreview` destructure of `camera` now compiles.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/derive.ts schema.sql tests/images.test.mjs
git commit -m "feat: read camera make and model from EXIF"
```

---

## Task 3: Junk classification

Thresholds live in one exported table so Slice 1's screen, the tests, and any later
recalibration all read the same numbers.

Two of the three signals are scale-free and safe to pin now: clipping fractions and dynamic
range. The blur floor is not — absolute sharpness depends on subject and resolution, so it is
set conservatively and carries a `ponytail:` note.

**Files:**
- Create: `lib/junk.ts`
- Test: `tests/junk.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/junk.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { junkReasons, THRESHOLDS } from "../lib/junk.ts";

const item = (over) => ({
  kind: "photo",
  preview: true,
  screenshot: false,
  takenAt: new Date("2026-11-01T00:00:00Z"),
  sharpness: 500,
  exposure: { p1: 10, p50: 128, p99: 240, clippedLow: 0, clippedHigh: 0 },
  ...over,
});
const now = new Date("2026-11-26T00:00:00Z");

test("a well-exposed sharp photo is not junk", () => {
  assert.deepEqual(junkReasons(item(), now), []);
});

test("a photo below the sharpness floor reads as blurred", () => {
  assert.deepEqual(junkReasons(item({ sharpness: THRESHOLDS.blurBelow - 1 }), now), [
    "blurred",
  ]);
  assert.deepEqual(junkReasons(item({ sharpness: THRESHOLDS.blurBelow }), now), []);
});

test("heavy clipping reads as too dark or blown out", () => {
  assert.deepEqual(
    junkReasons(
      item({ exposure: { p1: 0, p50: 0, p99: 3, clippedLow: 0.8, clippedHigh: 0 } }),
      now,
    ).sort(),
    ["no-contrast", "too-dark"],
  );
  assert.ok(
    junkReasons(
      item({ exposure: { p1: 250, p50: 255, p99: 255, clippedLow: 0, clippedHigh: 0.7 } }),
      now,
    ).includes("blown-out"),
  );
});

test("a flat image has no contrast", () => {
  assert.deepEqual(
    junkReasons(
      item({ exposure: { p1: 120, p50: 128, p99: 134, clippedLow: 0, clippedHigh: 0 } }),
      now,
    ),
    ["no-contrast"],
  );
});

test("a screenshot older than a year is junk, a recent one is not", () => {
  assert.deepEqual(
    junkReasons(item({ screenshot: true, takenAt: new Date("2025-01-01Z") }), now),
    ["old-screenshot"],
  );
  assert.deepEqual(
    junkReasons(item({ screenshot: true, takenAt: new Date("2026-10-01Z") }), now),
    [],
  );
  // An undated screenshot cannot be aged, so it is left alone.
  assert.deepEqual(junkReasons(item({ screenshot: true, takenAt: null }), now), []);
});

test("videos and items without a preview are never flagged", () => {
  // A video placeholder has no real pixels: its metrics are meaningless.
  assert.deepEqual(junkReasons(item({ kind: "video", sharpness: 0 }), now), []);
  assert.deepEqual(junkReasons(item({ preview: false, sharpness: 0 }), now), []);
  // Missing metrics are not evidence of junk.
  assert.deepEqual(junkReasons(item({ sharpness: null, exposure: null }), now), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/junk.test.mjs`
Expected: FAIL — `Cannot find module '../lib/junk.ts'`.

- [ ] **Step 3: Implement**

Create `lib/junk.ts`:

```typescript
import type { Exposure } from "./quality.ts";

export type JunkReason =
  | "blurred"
  | "too-dark"
  | "blown-out"
  | "no-contrast"
  | "old-screenshot";

export type Judged = {
  kind: string;
  preview: boolean;
  screenshot: boolean;
  takenAt: Date | null;
  sharpness: number | null;
  exposure: Exposure | null;
};

export const THRESHOLDS = {
  /**
   * ponytail: an absolute sharpness floor, set low on purpose so it only catches
   * genuine smears. A synthetic hard checkerboard measures ~62,700 and a heavy
   * blur of it ~0.12 (see tests/quality.test.mjs), but real photographs land far
   * lower than the checkerboard, so this cannot be tuned aggressively without a
   * real library. Recalibrate from percentiles of a user's own analysis rows once
   * there is data; the number lives here and nowhere else.
   */
  blurBelow: 12,
  darkClippedAbove: 0.6,
  brightClippedAbove: 0.6,
  contrastRangeBelow: 24,
  screenshotAgeDays: 365,
} as const;

const DAY = 86_400_000;

/** Why this item is proposed as junk. Empty means keep it. Never throws. */
export function junkReasons(item: Judged, now: Date): JunkReason[] {
  // Video placeholders and failed previews have no meaningful pixels, and a
  // missing metric is not evidence of anything. See MASTER_PROMPT.md §7.2.
  if (item.kind !== "photo" || !item.preview) return [];

  const reasons: JunkReason[] = [];
  if (
    item.screenshot &&
    item.takenAt &&
    now.getTime() - item.takenAt.getTime() > THRESHOLDS.screenshotAgeDays * DAY
  )
    reasons.push("old-screenshot");

  if (item.sharpness !== null && item.sharpness < THRESHOLDS.blurBelow)
    reasons.push("blurred");

  const e = item.exposure;
  if (e) {
    if (e.clippedLow > THRESHOLDS.darkClippedAbove) reasons.push("too-dark");
    if (e.clippedHigh > THRESHOLDS.brightClippedAbove) reasons.push("blown-out");
    if (e.p99 - e.p1 < THRESHOLDS.contrastRangeBelow) reasons.push("no-contrast");
  }
  return reasons;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/junk.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/junk.ts tests/junk.test.mjs
git commit -m "feat: add junk classification thresholds"
```

---

## Task 4: Burst grouping and keeper ranking

**Files:**
- Create: `lib/bursts.ts`
- Test: `tests/bursts.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/bursts.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { burstsOf, rankBurst } from "../lib/bursts.ts";

const frame = (n, seconds, over = {}) => ({
  id: "f" + n,
  camera: "Canon EOS R5",
  takenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
  sharpness: 100,
  exposure: { p1: 10, p50: 128, p99: 240, clippedLow: 0, clippedHigh: 0 },
  bytes: 1000,
  ...over,
});

test("five frames a second apart form one burst", () => {
  const bursts = burstsOf([0, 1, 2, 3, 4].map((n) => frame(n, n)));
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].memberIds.length, 5);
});

test("the same scene ten minutes later is a separate burst", () => {
  const rows = [
    ...[0, 1, 2].map((n) => frame(n, n)),
    ...[3, 4, 5].map((n) => frame(n, 600 + n)),
  ];
  const bursts = burstsOf(rows);
  assert.equal(bursts.length, 2);
  assert.deepEqual(
    bursts.map((b) => b.memberIds.length),
    [3, 3],
  );
});

test("two frames are not a burst", () => {
  assert.deepEqual(burstsOf([frame(0, 0), frame(1, 1)]), []);
});

test("frames from different cameras never share a burst", () => {
  const rows = [
    frame(0, 0),
    frame(1, 1),
    frame(2, 2, { camera: "Pixel 9" }),
    frame(3, 3, { camera: "Pixel 9" }),
    frame(4, 4, { camera: "Pixel 9" }),
  ];
  const bursts = burstsOf(rows);
  assert.equal(bursts.length, 1);
  assert.deepEqual(bursts[0].memberIds, ["f2", "f3", "f4"]);
});

test("undated frames and frames with no camera are never grouped", () => {
  assert.deepEqual(
    burstsOf([0, 1, 2].map((n) => frame(n, n, { takenAt: null }))),
    [],
  );
  assert.deepEqual(burstsOf([0, 1, 2].map((n) => frame(n, n, { camera: null }))), []);
});

test("a burst key is stable and unique per burst", () => {
  const rows = [0, 1, 2].map((n) => frame(n, n));
  assert.equal(burstsOf(rows)[0].key, burstsOf(rows)[0].key);
  assert.notEqual(
    burstsOf(rows)[0].key,
    burstsOf([3, 4, 5].map((n) => frame(n, 600 + n)))[0].key,
  );
});

test("the sharpest well-exposed frame is ranked keeper", () => {
  const members = [
    frame(0, 0, { sharpness: 50 }),
    frame(1, 1, { sharpness: 900 }),
    frame(2, 2, { sharpness: 400 }),
  ];
  assert.equal(rankBurst(members)[0].id, "f1");
  // Clipping demotes an otherwise sharp frame below a clean one.
  const clipped = [
    frame(0, 0, {
      sharpness: 900,
      exposure: { p1: 0, p50: 2, p99: 8, clippedLow: 0.9, clippedHigh: 0 },
    }),
    frame(1, 1, { sharpness: 400 }),
  ];
  assert.equal(rankBurst(clipped)[0].id, "f1");
});

test("ranking is total and stable, never dropping a frame", () => {
  const members = [frame(0, 0), frame(1, 1), frame(2, 2)];
  const ranked = rankBurst(members);
  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.map((m) => m.id).sort(),
    ["f0", "f1", "f2"],
  );
  // Equal metrics fall back to id so the keeper never flickers between runs.
  assert.deepEqual(rankBurst(members), rankBurst([...members].reverse()));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/bursts.test.mjs`
Expected: FAIL — `Cannot find module '../lib/bursts.ts'`.

- [ ] **Step 3: Implement**

Create `lib/bursts.ts`:

```typescript
import type { Exposure } from "./quality.ts";

export type Frame = {
  id: string;
  camera: string | null;
  takenAt: Date | null;
  sharpness: number | null;
  exposure: Exposure | null;
  bytes: number | null;
};

export type Burst = { key: string; memberIds: string[] };

export const BURST_GAP_MS = 2000;
export const BURST_MIN_FRAMES = 3;

/**
 * Frames from one camera, each within BURST_GAP_MS of the previous, at least
 * BURST_MIN_FRAMES long. Frames without a camera or a capture time are skipped:
 * a null is not evidence that two photos belong together.
 */
export function burstsOf(frames: Frame[]): Burst[] {
  const usable = frames.filter((f) => f.camera && f.takenAt);
  usable.sort(
    (a, b) =>
      a.camera!.localeCompare(b.camera!) ||
      a.takenAt!.getTime() - b.takenAt!.getTime() ||
      a.id.localeCompare(b.id),
  );
  const bursts: Burst[] = [];
  let run: Frame[] = [];
  const flush = () => {
    if (run.length >= BURST_MIN_FRAMES)
      bursts.push({
        key: `${run[0].camera}|${run[0].takenAt!.toISOString()}`,
        memberIds: run.map((f) => f.id),
      });
    run = [];
  };
  for (const frame of usable) {
    const previous = run[run.length - 1];
    if (
      previous &&
      previous.camera === frame.camera &&
      frame.takenAt!.getTime() - previous.takenAt!.getTime() <= BURST_GAP_MS
    )
      run.push(frame);
    else {
      flush();
      run = [frame];
    }
  }
  flush();
  return bursts;
}

/** A clean frame beats a clipped one; otherwise sharper wins. Index 0 is the keeper. */
export function rankBurst<T extends Frame>(members: T[]): T[] {
  const penalty = (f: Frame) => {
    const e = f.exposure;
    if (!e) return 0;
    return (e.clippedLow > 0.25 ? 1 : 0) + (e.clippedHigh > 0.25 ? 1 : 0);
  };
  return [...members].sort(
    (a, b) =>
      penalty(a) - penalty(b) ||
      (b.sharpness ?? -1) - (a.sharpness ?? -1) ||
      Number(b.bytes ?? 0) - Number(a.bytes ?? 0) ||
      a.id.localeCompare(b.id),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/bursts.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/bursts.ts tests/bursts.test.mjs
git commit -m "feat: add burst grouping and keeper ranking"
```

---

## Task 5: Cluster view model

One shape serves the DOM list, the WebGL scene and the CSV. Keeping it a pure function means
both renderers cannot disagree about what a cluster is.

**Files:**
- Create: `lib/clusters.ts`
- Test: `tests/clusters.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/clusters.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { buildProposals } from "../lib/clusters.ts";

const clean = { p1: 10, p50: 128, p99: 240, clippedLow: 0, clippedHigh: 0 };
// camera defaults to null so no test forms a burst by accident. Burst tests opt in.
const row = (id, over = {}) => ({
  id,
  filename: id + ".jpg",
  kind: "photo",
  preview: true,
  screenshot: false,
  bytes: 1000,
  takenAt: new Date("2026-01-01T00:00:00Z"),
  camera: null,
  sharpness: 500,
  exposure: clean,
  ...over,
});
const now = new Date("2026-11-26T00:00:00Z");

test("duplicate groups become clusters that reclaim the non-keeper bytes", () => {
  const p = buildProposals({
    rows: [row("a"), row("b"), row("c")],
    groups: [
      {
        id: "g1",
        kind: "exact",
        keeperId: "a",
        memberIds: ["a", "b"],
        bytesReclaimable: 1000,
        unknownSizes: 0,
      },
    ],
    now,
  });
  assert.equal(p.clusters.length, 1);
  assert.equal(p.clusters[0].keeperId, "a");
  assert.equal(p.clusters[0].kind, "exact");
  assert.deepEqual(
    p.clusters[0].members.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(p.clusters[0].bytesReclaimable, 1000);
  // Totals count every item proposed for deletion exactly once.
  assert.equal(p.totals.items, 1);
  assert.equal(p.totals.bytes, 1000);
});

test("a burst becomes a cluster with the sharpest frame as keeper", () => {
  const cam = "Canon EOS R5";
  const rows = [
    row("a", { camera: cam, sharpness: 100, takenAt: new Date("2026-01-01T00:00:00Z") }),
    row("b", { camera: cam, sharpness: 900, takenAt: new Date("2026-01-01T00:00:01Z") }),
    row("c", { camera: cam, sharpness: 300, takenAt: new Date("2026-01-01T00:00:02Z") }),
  ];
  const p = buildProposals({ rows, groups: [], now });
  assert.equal(p.clusters.length, 1);
  assert.equal(p.clusters[0].kind, "burst");
  assert.equal(p.clusters[0].keeperId, "b");
  assert.equal(p.clusters[0].bytesReclaimable, 2000);
});

test("an item already in a duplicate group is not also offered as a burst", () => {
  // Five frames one second apart would all burst together; the duplicate group
  // claims two of them, so only the other three may form a burst.
  const cam = "Canon EOS R5";
  const rows = ["a", "b", "c", "d", "e"].map((id, n) =>
    row(id, {
      camera: cam,
      takenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
    }),
  );
  const p = buildProposals({
    rows,
    groups: [
      {
        id: "g1",
        kind: "exact",
        keeperId: "a",
        memberIds: ["a", "b"],
        bytesReclaimable: 1000,
        unknownSizes: 0,
      },
    ],
    now,
  });
  const burst = p.clusters.find((c) => c.kind === "burst");
  assert.ok(burst, "the unclaimed frames should still burst");
  assert.deepEqual(
    burst.members.map((m) => m.id).sort(),
    ["c", "d", "e"],
    "a burst must never include an item claimed by a duplicate group",
  );
  assert.equal(p.clusters.length, 2);
  // One duplicate copy plus two burst rejects, each counted once.
  assert.equal(p.totals.items, 3);
});

test("junk is listed separately and never double-counted with a cluster", () => {
  const p = buildProposals({
    rows: [
      row("a"),
      row("blurry", { sharpness: 1 }),
      row("dark", {
        exposure: { p1: 0, p50: 1, p99: 4, clippedLow: 0.9, clippedHigh: 0 },
      }),
    ],
    groups: [],
    now,
  });
  assert.deepEqual(
    p.junk.map((j) => j.id).sort(),
    ["blurry", "dark"],
  );
  assert.ok(p.junk.every((j) => j.reasons.length > 0));
  assert.equal(p.totals.items, 2);
  assert.equal(p.totals.bytes, 2000);
});

test("a keeper is never proposed for deletion, even if it looks like junk", () => {
  const p = buildProposals({
    rows: [row("a", { sharpness: 1 }), row("b")],
    groups: [
      {
        id: "g1",
        kind: "exact",
        keeperId: "a",
        memberIds: ["a", "b"],
        bytesReclaimable: 1000,
        unknownSizes: 0,
      },
    ],
    now,
  });
  assert.ok(!p.junk.some((j) => j.id === "a"), "the keeper must not be junk");
  assert.equal(p.totals.items, 1);
});

test("unknown sizes are reported rather than counted as zero", () => {
  const p = buildProposals({
    rows: [row("a"), row("b", { bytes: null })],
    groups: [
      {
        id: "g1",
        kind: "exact",
        keeperId: "a",
        memberIds: ["a", "b"],
        bytesReclaimable: 0,
        unknownSizes: 1,
      },
    ],
    now,
  });
  assert.equal(p.totals.unknownSizes, 1);
  assert.equal(p.totals.bytes, 0);
});

test("videos are never proposed as junk or bursts", () => {
  const p = buildProposals({
    rows: [0, 1, 2].map((n) =>
      row("v" + n, {
        kind: "video",
        preview: false,
        sharpness: null,
        exposure: null,
        takenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
      }),
    ),
    groups: [],
    now,
  });
  assert.deepEqual(p.clusters, []);
  assert.deepEqual(p.junk, []);
  assert.equal(p.totals.items, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/clusters.test.mjs`
Expected: FAIL — `Cannot find module '../lib/clusters.ts'`.

- [ ] **Step 3: Implement**

Create `lib/clusters.ts`:

```typescript
import type { Exposure } from "./quality.ts";
import { junkReasons, type JunkReason } from "./junk.ts";
import { burstsOf, rankBurst, type Frame } from "./bursts.ts";
import type { StoredGroup } from "./dupe-store.ts";

export type Row = {
  id: string;
  filename: string;
  kind: string;
  preview: boolean;
  screenshot: boolean;
  bytes: number | null;
  takenAt: Date | null;
  camera: string | null;
  sharpness: number | null;
  exposure: Exposure | null;
};

export type Member = {
  id: string;
  filename: string;
  preview: boolean;
  bytes: number | null;
  sharpness: number | null;
  keeper: boolean;
  reasons: JunkReason[];
};

export type Cluster = {
  id: string;
  kind: "exact" | "near" | "burst";
  keeperId: string;
  members: Member[];
  bytesReclaimable: number;
  unknownSizes: number;
};

export type JunkItem = {
  id: string;
  filename: string;
  preview: boolean;
  bytes: number | null;
  reasons: JunkReason[];
};

export type Proposals = {
  clusters: Cluster[];
  junk: JunkItem[];
  totals: { items: number; bytes: number; unknownSizes: number };
};

/**
 * Everything Shoebox proposes removing, as one structure. Nothing here deletes
 * anything: these are proposals the user executes (MASTER_PROMPT.md §9.1).
 * An item appears in at most one place — a duplicate group, a burst, or junk.
 */
export function buildProposals({
  rows,
  groups,
  now,
}: {
  rows: Row[];
  groups: StoredGroup[];
  now: Date;
}): Proposals {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const spoken = new Set<string>();
  const clusters: Cluster[] = [];

  const toMember = (row: Row, keeper: boolean): Member => ({
    id: row.id,
    filename: row.filename,
    preview: row.preview,
    bytes: row.bytes,
    sharpness: row.sharpness,
    keeper,
    reasons: keeper ? [] : junkReasons(row, now),
  });

  for (const group of groups) {
    const members = group.memberIds
      .map((id) => byId.get(id))
      .filter((r): r is Row => Boolean(r));
    if (members.length < 2) continue;
    const keeperId = members.some((m) => m.id === group.keeperId)
      ? group.keeperId
      : members[0].id;
    for (const m of members) spoken.add(m.id);
    clusters.push({
      id: group.id,
      kind: group.kind === "near" ? "near" : "exact",
      keeperId,
      members: members.map((m) => toMember(m, m.id === keeperId)),
      bytesReclaimable: group.bytesReclaimable,
      unknownSizes: group.unknownSizes,
    });
  }

  // Bursts only from photos not already claimed by a duplicate group.
  const frames: Frame[] = rows
    .filter((r) => r.kind === "photo" && r.preview && !spoken.has(r.id))
    .map((r) => ({
      id: r.id,
      camera: r.camera,
      takenAt: r.takenAt,
      sharpness: r.sharpness,
      exposure: r.exposure,
      bytes: r.bytes,
    }));
  for (const burst of burstsOf(frames)) {
    const members = burst.memberIds
      .map((id) => byId.get(id))
      .filter((r): r is Row => Boolean(r));
    const ranked = rankBurst(
      members.map((m) => ({
        id: m.id,
        camera: m.camera,
        takenAt: m.takenAt,
        sharpness: m.sharpness,
        exposure: m.exposure,
        bytes: m.bytes,
      })),
    );
    const keeperId = ranked[0].id;
    for (const m of members) spoken.add(m.id);
    const copies = members.filter((m) => m.id !== keeperId);
    clusters.push({
      id: burst.key,
      kind: "burst",
      keeperId,
      members: members.map((m) => toMember(m, m.id === keeperId)),
      bytesReclaimable: copies.reduce((sum, m) => sum + Number(m.bytes ?? 0), 0),
      unknownSizes: copies.filter((m) => m.bytes === null).length,
    });
  }

  const junk: JunkItem[] = [];
  for (const row of rows) {
    if (spoken.has(row.id)) continue;
    const reasons = junkReasons(row, now);
    if (!reasons.length) continue;
    junk.push({
      id: row.id,
      filename: row.filename,
      preview: row.preview,
      bytes: row.bytes,
      reasons,
    });
  }

  const doomed = [
    ...clusters.flatMap((c) => c.members.filter((m) => !m.keeper)),
    ...junk,
  ];
  return {
    clusters,
    junk,
    totals: {
      items: doomed.length,
      bytes: doomed.reduce((sum, m) => sum + Number(m.bytes ?? 0), 0),
      unknownSizes: doomed.filter((m) => m.bytes === null).length,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/clusters.test.mjs`
Expected: PASS, 7 tests.

The "never double-counted" and "keeper is never junk" tests are the important ones: a GB figure
that counts an item twice destroys trust in the whole screen.

- [ ] **Step 5: Commit**

```bash
git add lib/clusters.ts tests/clusters.test.mjs
git commit -m "feat: add the reclaim proposal view model"
```

---

## Task 6: Reclaim reader

**Files:**
- Create: `lib/reclaim.ts`

- [ ] **Step 1: Implement**

Create `lib/reclaim.ts`:

```typescript
import { db } from "./db";
import { readGroups } from "./dupe-store.ts";
import { buildProposals, type Row, type Proposals } from "./clusters.ts";

/** Reads one owner's library and returns everything Shoebox proposes removing. */
export async function reclaim(user: string, now = new Date()): Promise<Proposals> {
  const rows = await db()`
    select m.id,m.filename,m.kind,m.bytes,m.screenshot,m.taken_at,m.camera,
           m.thumb is not null as preview,
           a.sharpness, a.exposure
    from media m left join analysis a on a.media_id=m.id
    where m.owner=${user} and m.state='ready'
    order by m.sort_at desc, m.id desc`;
  const shaped: Row[] = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    kind: r.kind,
    preview: r.preview,
    screenshot: Boolean(r.screenshot),
    bytes: r.bytes === null ? null : Number(r.bytes),
    takenAt: r.taken_at ? new Date(r.taken_at) : null,
    camera: r.camera ?? null,
    sharpness: r.sharpness === null ? null : Number(r.sharpness),
    exposure: r.exposure ?? null,
  }));
  return buildProposals({
    rows: shaped,
    groups: await readGroups(user),
    now,
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: clean. Nothing imports `reclaim` yet; this catches type errors early.

- [ ] **Step 3: Commit**

```bash
git add lib/reclaim.ts
git commit -m "feat: add the reclaim reader"
```

---

## Task 7: Reclaim endpoint

**Files:**
- Create: `app/api/reclaim/route.ts`

- [ ] **Step 1: Implement**

Create `app/api/reclaim/route.ts`:

```typescript
import { owner } from "../../../lib/db";
import { reclaim } from "../../../lib/reclaim";
import { setKeeper } from "../../../lib/dupe-store";

export async function GET() {
  return Response.json(await reclaim(await owner()));
}

export async function POST(req: Request) {
  const user = await owner();
  const { group, keeper } = await req.json();
  if (typeof group !== "string" || typeof keeper !== "string")
    return new Response("Choose a photo to keep.", { status: 400 });
  try {
    await setKeeper(user, group, keeper);
  } catch (e) {
    // setKeeper refuses unknown groups and non-members; both are the caller's fault.
    return new Response(
      e instanceof Error ? e.message : "That change could not be applied.",
      { status: 409 },
    );
  }
  return Response.json(await reclaim(user));
}
```

Burst keepers are **not** settable through this route. `setKeeper` writes `dupe_groups`, and a
burst has no row there — its keeper is computed by `rankBurst`. Making burst keepers editable
means persisting them, which is Slice 1's one deliberate omission; see "Not in this slice".

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: clean, with `/api/reclaim` listed in the route table.

- [ ] **Step 3: Commit**

```bash
git add app/api/reclaim/route.ts
git commit -m "feat: add the reclaim endpoint"
```

---

## Task 8: Worklist CSV

The product never deletes anything in Google Photos. This file is the handover
(`MASTER_PROMPT.md` §8.3, §9.1).

**Files:**
- Create: `app/api/worklist/route.ts`

- [ ] **Step 1: Implement**

Create `app/api/worklist/route.ts`:

```typescript
import { owner, db } from "../../../lib/db";
import { reclaim } from "../../../lib/reclaim";

export async function GET() {
  const user = await owner();
  const { clusters, junk } = await reclaim(user);
  const escape = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[\s]*[=+@-]|^[\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const records: unknown[][] = [
    ["id", "filename", "bytes", "proposal", "group_id", "group_kind", "keeper_id", "reasons"],
  ];
  for (const cluster of clusters)
    for (const member of cluster.members)
      if (!member.keeper)
        records.push([
          member.id,
          member.filename,
          member.bytes,
          "extra copy",
          cluster.id,
          cluster.kind,
          cluster.keeperId,
          member.reasons.join(" "),
        ]);
  for (const item of junk)
    records.push([
      item.id,
      item.filename,
      item.bytes,
      "junk",
      "",
      "",
      "",
      item.reasons.join(" "),
    ]);
  await db()`insert into audit_log(owner,action) select id,'worklist_export' from users where id=${user}`;
  return new Response(records.map((r) => r.map(escape).join(",")).join("\r\n"), {
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": 'attachment; filename="shoebox-worklist.csv"',
    },
  });
}
```

The `escape` function is copied from `app/api/export/route.ts:9-13` deliberately rather than
shared: it guards against spreadsheet formula injection, and a second caller is not yet reason
enough to invent a module. If a third appears, extract it then.

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: clean, with `/api/worklist` in the route table.

- [ ] **Step 3: Commit**

```bash
git add app/api/worklist/route.ts
git commit -m "feat: add the worklist CSV export"
```

---

## Task 9: End-to-end reclaim test

**Files:**
- Create: `tests/reclaim.test.mjs`

- [ ] **Step 1: Write the test**

Create `tests/reclaim.test.mjs`:

```javascript
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

test("reclaim proposes duplicates, bursts and junk over a real database", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-reclaim-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url)),
    req = createRequire(root + "/package.json"),
    pg = new PGlite({ extensions: { vector } });
  await pg.exec(await fs.readFile(root + "/schema.sql", "utf8"));
  globalThis.sql = (parts, ...args) => {
    const query = parts.reduce((s, p, i) => s + (i ? "$" + i : "") + p, "");
    const run = async (c) => (await c.query(query, args)).rows;
    return { run, then: (ok, fail) => run(pg).then(ok, fail) };
  };
  const db = 'export const db=()=>globalThis.sql;export const owner=async()=>"tester";';
  const mocks = {
    "./database": "export const localData=false;export const dataDirectory=String();",
    "./db": db,
  };
  await build({
    stdin: {
      contents:
        'export {reclaim} from "./lib/reclaim";export {rebuildGroups,setKeeper} from "./lib/dupe-store";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "r.cjs"),
    plugins: [
      {
        name: "mock",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (a) => {
            if (mocks[a.path]) return { namespace: "mock", path: a.path };
          });
          b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
            contents: mocks[a.path],
          }));
        },
      },
    ],
  });
  const { reclaim, rebuildGroups, setKeeper } = req(path.join(output, "r.cjs"));

  await pg.exec("insert into users(id) values('tester')");
  await pg.query("insert into imports(id,owner,expected) values($1,'tester',20)", [
    "11111111-1111-1111-1111-111111111111",
  ]);
  const id = (n) => "44444444-0000-4000-8000-" + String(n).padStart(12, "0");
  const clean = { p1: 10, p50: 128, p99: 240, clippedLow: 0, clippedHigh: 0 };
  const add = async (n, over = {}) => {
    const o = {
      kind: "photo",
      bytes: 1000,
      hash: "h" + n,
      camera: "Canon EOS R5",
      takenAt: null,
      thumb: "t",
      screenshot: false,
      sharpness: 500,
      exposure: clean,
      ...over,
    };
    await pg.query(
      `insert into media(id,owner,import_id,filename,kind,bytes,hash,camera,category,state,position,taken_at,sort_at,thumb,screenshot)
       values($1,'tester','11111111-1111-1111-1111-111111111111',$2,$3,$4,$5,$6,'Other photos','ready',$7,$8,coalesce($8::timestamptz,'-infinity'),$9,$10)`,
      [id(n), "p" + n + ".jpg", o.kind, o.bytes, o.hash, o.camera, n, o.takenAt, o.thumb, o.screenshot],
    );
    if (o.sharpness !== null)
      await pg.query(
        "insert into analysis(media_id,sharpness,exposure) values($1,$2,$3::jsonb)",
        [id(n), o.sharpness, JSON.stringify(o.exposure)],
      );
  };

  // 0,1: byte-identical duplicates.
  await add(0, { hash: "same", bytes: 900 });
  await add(1, { hash: "same", bytes: 500 });
  // 2,3,4: a burst one second apart, 3 is sharpest.
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  await add(2, { takenAt: new Date(t0).toISOString(), sharpness: 100 });
  await add(3, { takenAt: new Date(t0 + 1000).toISOString(), sharpness: 900 });
  await add(4, { takenAt: new Date(t0 + 2000).toISOString(), sharpness: 300 });
  // 5: blurred junk. 6: an old screenshot. 7: clean, keep it.
  await add(5, { sharpness: 1 });
  await add(6, {
    screenshot: true,
    takenAt: new Date(Date.UTC(2024, 0, 1)).toISOString(),
  });
  await add(7);
  // 8: a video placeholder with no thumb and no metrics — must never be touched.
  await add(8, { kind: "video", thumb: null, sharpness: null, hash: null });

  await rebuildGroups("tester");
  let p = await reclaim("tester", new Date("2026-11-26T00:00:00Z"));

  const dupe = p.clusters.find((c) => c.kind === "exact");
  assert.ok(dupe, "expected an exact duplicate cluster");
  assert.equal(dupe.keeperId, id(0), "the larger file should be keeper");

  const burst = p.clusters.find((c) => c.kind === "burst");
  assert.ok(burst, "expected a burst cluster");
  assert.equal(burst.keeperId, id(3), "the sharpest frame should be keeper");
  assert.equal(burst.members.length, 3);
  assert.equal(burst.bytesReclaimable, 2000);

  const junkIds = p.junk.map((j) => j.id).sort();
  assert.deepEqual(junkIds, [id(5), id(6)].sort());
  assert.ok(!p.junk.some((j) => j.id === id(8)), "a video must never be junk");
  assert.ok(!p.junk.some((j) => j.id === id(7)), "a clean photo must not be junk");

  // One duplicate copy + two burst rejects + two junk items.
  assert.equal(p.totals.items, 5);
  assert.equal(p.totals.bytes, 500 + 2000 + 1000 + 1000);

  // Promoting the other copy moves the reclaimable bytes and keeps the count right.
  await setKeeper("tester", dupe.id, id(1));
  p = await reclaim("tester", new Date("2026-11-26T00:00:00Z"));
  const after = p.clusters.find((c) => c.id === dupe.id);
  assert.equal(after.keeperId, id(1));
  assert.equal(after.bytesReclaimable, 900);
  assert.equal(p.totals.items, 5, "changing a keeper must not change how many items go");

  await pg.close();
});
```

- [ ] **Step 2: Run it**

Run: `node --experimental-strip-types --test tests/reclaim.test.mjs`
Expected: PASS, 1 test.

The most likely real failure is the burst not forming, because `rebuildGroups` claimed items
2–4 as a near-duplicate group first. If that happens, check `duplicateGroups` — frames of the
same scene one second apart legitimately have close perceptual hashes. Either give the burst
fixtures distinct `phash` values, or accept that duplicates win over bursts and assert that
instead. Do not weaken `buildProposals`' no-overlap rule to make the test pass.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. Test files: core, images, picker, import-integration, quality, cursor,
pagination, dupes, junk, bursts, clusters, reclaim.

- [ ] **Step 4: Commit**

```bash
git add tests/reclaim.test.mjs
git commit -m "test: cover reclaim proposals end to end"
```

---

## Task 10: The DOM reclaim screen

This is the real implementation. It must work with a keyboard and a screen reader, and the
WebGL surface in Tasks 12–16 is layered on top of it without replacing it.

**Files:**
- Create: `app/reclaim-panel.tsx`
- Modify: `app/style.css`

- [ ] **Step 1: Create the panel**

Create `app/reclaim-panel.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, HardDrive } from "lucide-react";
import { json } from "./fetch-json";

type Member = {
  id: string;
  filename: string;
  preview: boolean;
  bytes: number | null;
  sharpness: number | null;
  keeper: boolean;
  reasons: string[];
};
type Cluster = {
  id: string;
  kind: "exact" | "near" | "burst";
  keeperId: string;
  members: Member[];
  bytesReclaimable: number;
  unknownSizes: number;
};
type JunkItem = {
  id: string;
  filename: string;
  preview: boolean;
  bytes: number | null;
  reasons: string[];
};
export type Proposals = {
  clusters: Cluster[];
  junk: JunkItem[];
  totals: { items: number; bytes: number; unknownSizes: number };
};

const LABEL: Record<string, string> = {
  exact: "Identical copies",
  near: "Near-identical copies",
  burst: "Burst — one moment, several frames",
};
const REASON: Record<string, string> = {
  blurred: "blurred",
  "too-dark": "too dark",
  "blown-out": "overexposed",
  "no-contrast": "blank or flat",
  "old-screenshot": "screenshot over a year old",
};

export default function ReclaimPanel() {
  const [data, setData] = useState<Proposals | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await json(await fetch("/api/reclaim", { cache: "no-store" })));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function keep(group: string, keeper: string) {
    if (busy) return;
    setBusy(true);
    try {
      setData(
        await json(
          await fetch("/api/reclaim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ group, keeper }),
          }),
        ),
      );
      setStatus("Updated which copy you keep.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p role="status">{status || "Looking for copies and junk…"}</p>;

  const gb = (bytes: number) =>
    (bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 });

  // Named rather than inlined into .map() so Task 16 can hand the same markup to
  // Scene3D as its fallback without duplicating it.
  const renderCluster = (cluster: Cluster) => (
    <article key={cluster.id} className="cluster">
      <h3>
        {LABEL[cluster.kind]} · {gb(cluster.bytesReclaimable)} GB
      </h3>
      <ul>
        {cluster.members.map((member) => (
          <li key={member.id} className={member.keeper ? "keeper" : undefined}>
            {member.preview ? (
              <img src={"/api/thumb/" + member.id} alt={member.filename} />
            ) : (
              <span className="placeholder" aria-hidden="true" />
            )}
            <strong>{member.filename}</strong>
            {member.keeper ? (
              <em>Keeping this one</em>
            ) : cluster.kind === "burst" ? (
              <em>Extra frame</em>
            ) : (
              <button disabled={busy} onClick={() => void keep(cluster.id, member.id)}>
                Keep this one instead
              </button>
            )}
            {member.reasons.length > 0 && (
              <small>{member.reasons.map((r) => REASON[r] ?? r).join(", ")}</small>
            )}
          </li>
        ))}
      </ul>
    </article>
  );

  return (
    <section className="reclaim" aria-label="Reclaim space">
      <div className="reclaim-headline">
        <HardDrive />
        <div>
          <h2>
            Delete {data.totals.items.toLocaleString()} items →{" "}
            {gb(data.totals.bytes)} GB back
          </h2>
          <p>
            Shoebox never deletes anything in Google Photos or on your disk. This is
            a list you review and act on yourself.
            {data.totals.unknownSizes > 0 &&
              ` ${data.totals.unknownSizes} of these have an unknown original size, so the total is a floor, not an estimate.`}
          </p>
        </div>
        <a className="primary" href="/api/worklist">
          <Download />
          Export worklist
        </a>
      </div>
      <p role="status">{status}</p>

      {data.clusters.map(renderCluster)}

      {data.junk.length > 0 && (
        <article className="cluster">
          <h3>Junk · {data.junk.length.toLocaleString()} items</h3>
          <ul>
            {data.junk.map((item) => (
              <li key={item.id}>
                {item.preview ? (
                  <img src={"/api/thumb/" + item.id} alt={item.filename} />
                ) : (
                  <span className="placeholder" aria-hidden="true" />
                )}
                <strong>{item.filename}</strong>
                <small>{item.reasons.map((r) => REASON[r] ?? r).join(", ")}</small>
              </li>
            ))}
          </ul>
        </article>
      )}

      {!data.clusters.length && !data.junk.length && (
        <p>Nothing to reclaim. No duplicate copies, bursts or junk were found.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `app/style.css`:

```css
.reclaim-headline{display:flex;gap:14px;align-items:flex-start;padding:16px 0}
.reclaim-headline h2{margin:0 0 4px}
.reclaim-headline p{margin:0;max-width:62ch}
.reclaim-headline a{margin-left:auto;flex-shrink:0}
.cluster{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 14px}
.cluster h3{margin:0 0 10px;font-size:1rem}
.cluster ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:12px}
.cluster li{width:170px;display:flex;flex-direction:column;gap:6px}
.cluster li img,.cluster li .placeholder{width:100%;height:120px;object-fit:cover;border-radius:6px;background:var(--card);display:block}
.cluster li strong{font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cluster li small{font-size:.72rem;opacity:.75}
.cluster li.keeper img{outline:3px solid #6cc24a;outline-offset:2px}
.cluster li em{font-size:.75rem;color:#6cc24a;font-style:normal}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/reclaim-panel.tsx app/style.css
git commit -m "feat: add the DOM reclaim screen"
```

---

## Task 11: Mount the Reclaim tab — CHECKPOINT

**Files:**
- Modify: `app/browse-tabs.tsx`
- Modify: `app/library.tsx`

- [ ] **Step 1: Add the third tab**

Replace the whole of `app/browse-tabs.tsx`. The exported `Tab` type replaces the inline unions
so `library.tsx` cannot drift from it:

```tsx
"use client";
import { Copy, HardDrive, Image as Photo } from "lucide-react";

export type Tab = "all" | "duplicates" | "reclaim";

export default function BrowseTabs({
  tab,
  setTab,
  groupCount,
  reclaimBytes,
  unknownSizes,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  groupCount: number;
  reclaimBytes: number;
  unknownSizes: boolean;
}) {
  return (
    <>
      <nav>
        <button aria-pressed={tab === "all"} onClick={() => setTab("all")}>
          <Photo />
          All photos
        </button>
        <button
          aria-pressed={tab === "duplicates"}
          onClick={() => setTab("duplicates")}
        >
          <Copy />
          Duplicates · {groupCount}
        </button>
        <button aria-pressed={tab === "reclaim"} onClick={() => setTab("reclaim")}>
          <HardDrive />
          Reclaim
        </button>
      </nav>
      {tab === "duplicates" && (
        <section>
          <h2>
            {(reclaimBytes / 1e9).toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}{" "}
            GB reclaimable from copies with known sizes
          </h2>
          <p>
            {unknownSizes && "Google Photos does not report original sizes. "}
            Review the extra copies and export your list. You decide which
            originals to delete.
          </p>
        </section>
      )}
    </>
  );
}
```

The duplicates banner is unchanged and still renders only on its own tab.

- [ ] **Step 2: Mount the panel**

In `app/library.tsx`:

- Change the tab state to use the shared type:
  `const [tab, setTab] = useState<Tab>("all")`, importing `type Tab` from `./browse-tabs`.
- Add the import: `import ReclaimPanel from "./reclaim-panel";`
- Render the panel instead of the search bar and grid when the tab is `reclaim`. Replace the
  block from `<SearchBar` through the closing of the grid/empty ternary with:

```tsx
      {tab === "reclaim" ? (
        <ReclaimPanel />
      ) : (
        <>
          <SearchBar
            query={query}
            setQuery={setQuery}
            category={category}
            setCategory={setCategory}
          />
          <p role="status">{status}</p>
          {tab === "all" && (
            <>
              <CategoryStacks
                items={items}
                selected={category}
                select={setCategory}
              />
              <PhotoOrbit key={category} photos={items.slice(0, 24)} />
            </>
          )}
          {items.length ? (
            <MediaGrid
              items={items}
              note={tab === "duplicates" ? (id) => members.get(id) : undefined}
              onCategory={async (id, next) => {
                try {
                  await json(
                    await fetch("/api/category", {
                      method: "POST",
                      body: JSON.stringify({ id, category: next }),
                    }),
                  );
                  setItems((previous) =>
                    previous.map((i) =>
                      i.id === id ? { ...i, category: next } : i,
                    ),
                  );
                } catch (e) {
                  setStatus(String(e));
                }
              }}
              onReachEnd={() => {
                if (cursor) void load(cursor);
              }}
            />
          ) : (
            <section className="empty">
              <Files />
              <h2>{total ? "No matching photos" : "Add your first photos"}</h2>
              <p>
                {total
                  ? "Try another search or category."
                  : "Drop photos or a Takeout ZIP here, or choose a folder above."}
              </p>
            </section>
          )}
        </>
      )}
```

The `tab` value is also sent to `/api/library`, which only recognises `"duplicates"`; `reclaim`
falls through to the unfiltered branch and costs one harmless request. Leave it — the panel
does not read that response.

- [ ] **Step 3: Run the full suite and build**

Run: `npm test && npm run build`
Expected: PASS and clean.

- [ ] **Step 4: Verify by hand**

Run: `SHOEBOX_LOCAL_STORAGE=1 npm run dev`

1. Sign in and import a folder containing at least one obvious duplicate pair, one deliberately
   blurred photo and a burst of three or more frames from a phone.
2. Open the Reclaim tab. A headline reads "Delete N items → X GB back".
3. The sentence stating Shoebox deletes nothing is visible without scrolling past it.
4. The keeper in each duplicate cluster has a visible outline; press Tab to reach
   "Keep this one instead" and activate it with Enter. The headline figure changes.
5. Burst clusters show "Extra frame" and no keeper button.
6. Junk items list a plain-language reason.
7. "Export worklist" downloads a CSV whose rows match what is on screen.
8. Navigate the whole screen with the keyboard only. Every control must be reachable and have a
   visible focus state.

- [ ] **Step 5: Commit**

```bash
git add app/browse-tabs.tsx app/library.tsx
git commit -m "feat: mount the Reclaim tab"
```

> ### CHECKPOINT
>
> **Slice 1's product is now complete and shippable.** Powers 3 and 4 work, accessibly, on
> every device. Deploy here if you want the feature in users' hands before adding WebGL.
>
> Tasks 12–16 add the 3D surface. They change no data and no behaviour — only presentation. If
> they are abandoned, nothing above is affected.

---

## Task 12: Pure 3D decision logic

Written before any three.js code so the gatekeeper and the texture cache are testable in Node
with no GPU. Both are pure functions over plain data.

**Files:**
- Create: `app/three/capability.ts`
- Create: `app/three/atlas.ts`
- Create: `app/three/damp.ts`
- Test: `tests/three.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/three.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRender3D } from "../app/three/capability.ts";
import { LayerCache } from "../app/three/atlas.ts";
import { damp } from "../app/three/damp.ts";

const capable = {
  reducedMotion: false,
  flat: false,
  webgl2: true,
  cores: 8,
  width: 1440,
};

test("a capable desktop gets the 3D surface", () => {
  assert.equal(shouldRender3D(capable), true);
});

test("reduced motion always wins, even on capable hardware", () => {
  assert.equal(shouldRender3D({ ...capable, reducedMotion: true }), false);
});

test("the flat escape hatch, no WebGL2, few cores and narrow viewports fall back", () => {
  assert.equal(shouldRender3D({ ...capable, flat: true }), false);
  assert.equal(shouldRender3D({ ...capable, webgl2: false }), false);
  assert.equal(shouldRender3D({ ...capable, cores: 4 }), false);
  assert.equal(shouldRender3D({ ...capable, cores: 5 }), true);
  assert.equal(shouldRender3D({ ...capable, width: 899 }), false);
  assert.equal(shouldRender3D({ ...capable, width: 900 }), true);
});

test("layers are handed out, reused, and evicted least-recently-used first", () => {
  const cache = new LayerCache(3);
  const a = cache.acquire("a").layer;
  const b = cache.acquire("b").layer;
  const c = cache.acquire("c").layer;
  assert.equal(new Set([a, b, c]).size, 3, "distinct layers");
  assert.equal(cache.acquire("a").layer, a, "an existing id keeps its layer");

  // b is now least recently used.
  const fourth = cache.acquire("d");
  assert.equal(fourth.evicted, "b");
  assert.equal(fourth.layer, b, "the evicted layer is reused");
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("a"), true);
});

test("a pinned id is never evicted, whatever its recency", () => {
  const cache = new LayerCache(2);
  cache.acquire("focus");
  cache.pin("focus");
  cache.acquire("x");
  // "focus" is the oldest, but pinned, so "x" must go instead.
  assert.equal(cache.acquire("y").evicted, "x");
  assert.equal(cache.has("focus"), true);
});

test("a cache with every slot pinned refuses rather than corrupting itself", () => {
  const cache = new LayerCache(1);
  cache.acquire("only");
  cache.pin("only");
  assert.throws(() => cache.acquire("other"), /no free layer/);
});

test("damping converges and is frame-rate independent", () => {
  let one = 0;
  for (let i = 0; i < 60; i++) one = damp(one, 10, 4, 1 / 60);
  let two = 0;
  for (let i = 0; i < 120; i++) two = damp(two, 10, 4, 1 / 120);
  assert.ok(Math.abs(one - two) < 0.01, one + " vs " + two);
  assert.ok(one > 9.8 && one < 10, "should approach the target in one second");
  assert.equal(damp(5, 5, 4, 0.016), 5, "already there means no movement");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/three.test.mjs`
Expected: FAIL — `Cannot find module '../app/three/capability.ts'`.

- [ ] **Step 3: Implement all three**

Create `app/three/capability.ts`:

```typescript
export type Capability = {
  reducedMotion: boolean;
  flat: boolean;
  webgl2: boolean;
  cores: number;
  width: number;
};

export const MIN_CORES = 5;
export const MIN_WIDTH = 900;

/**
 * The single 3D/no-3D decision. Desktop-first: a phone keeps the DOM view, which
 * is the real implementation. Reduced motion is honoured unconditionally
 * (MASTER_PROMPT.md §9.8).
 */
export function shouldRender3D(c: Capability) {
  if (c.reducedMotion) return false;
  if (c.flat) return false;
  if (!c.webgl2) return false;
  if (c.cores < MIN_CORES) return false;
  if (c.width < MIN_WIDTH) return false;
  return true;
}

/** Reads the real environment. Browser only. */
export function detectCapability(search = ""): Capability {
  let webgl2 = false;
  try {
    webgl2 = Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    webgl2 = false;
  }
  return {
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    flat: new URLSearchParams(search).get("flat") === "1",
    webgl2,
    cores: navigator.hardwareConcurrency || 1,
    width: window.innerWidth,
  };
}
```

Create `app/three/atlas.ts`:

```typescript
export type Acquired = { layer: number; evicted: string | null };

/**
 * Maps item ids onto a fixed number of texture-array layers, evicting the
 * least recently used. One id may be pinned — the focused item — and is never
 * evicted. Pure data: no three.js, so it is testable in Node.
 */
export class LayerCache {
  private layers = new Map<string, number>();
  private order: string[] = [];
  private free: number[];
  private pinned: string | null = null;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw Error("LayerCache needs at least one layer");
    this.free = Array.from({ length: capacity }, (_, i) => i);
  }

  has(id: string) {
    return this.layers.has(id);
  }

  layerOf(id: string) {
    return this.layers.get(id) ?? null;
  }

  pin(id: string | null) {
    this.pinned = id;
  }

  private touch(id: string) {
    const at = this.order.indexOf(id);
    if (at !== -1) this.order.splice(at, 1);
    this.order.push(id);
  }

  acquire(id: string): Acquired {
    const existing = this.layers.get(id);
    if (existing !== undefined) {
      this.touch(id);
      return { layer: existing, evicted: null };
    }
    if (this.free.length) {
      const layer = this.free.shift()!;
      this.layers.set(id, layer);
      this.touch(id);
      return { layer, evicted: null };
    }
    const victim = this.order.find((candidate) => candidate !== this.pinned);
    if (victim === undefined) throw Error("LayerCache has no free layer to give");
    const layer = this.layers.get(victim)!;
    this.layers.delete(victim);
    this.order.splice(this.order.indexOf(victim), 1);
    this.layers.set(id, layer);
    this.touch(id);
    return { layer, evicted: victim };
  }
}
```

Create `app/three/damp.ts`:

```typescript
/**
 * Exponential approach to a target, independent of frame rate: the same elapsed
 * time produces the same result whatever the step size. `lambda` is stiffness.
 */
export function damp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/three.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/three/capability.ts app/three/atlas.ts app/three/damp.ts tests/three.test.mjs
git commit -m "feat: add pure 3D capability, texture-cache and damping logic"
```

---

## Task 13: Install the 3D dependencies

Justification for `MASTER_PROMPT.md` §5: instanced rendering of thousands of textured planes
with a damped camera is not reachable with CSS transforms, and the cluster scene is the
product's signature surface.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm install three@0.187.0 @react-three/fiber@9.8.2 @react-three/drei@10.7.9
npm install --save-dev @types/three@0.187.0
```

`@react-three/fiber` 9.8.2 peers `react: >=19 <19.4`; the project is on 19.3.1, and `three`
0.187 satisfies its `>=0.156`. Expect no peer warnings — if npm reports any, stop and report
them rather than forcing the install.

- [ ] **Step 2: Confirm the grid route did not grow**

Run: `npm run build`

Record the First Load JS for `/` from the route table. Nothing imports three yet, so this is
the baseline the budget in Task 16 is measured against. Write the number down.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add three, react-three-fiber and drei"
```

---

## Task 14: The gatekeeper component

**Files:**
- Create: `app/three/scene.tsx`

- [ ] **Step 1: Implement**

Create `app/three/scene.tsx`:

```tsx
"use client";
import { useEffect, useState, type ReactNode } from "react";
import { detectCapability, shouldRender3D } from "./capability";

/**
 * Decides once, on the client, whether to mount a 3D surface. The fallback is the
 * real implementation and stays in the DOM for assistive technology either way;
 * the canvas is decorative and aria-hidden.
 */
export default function Scene3D({
  fallback,
  children,
}: {
  fallback: ReactNode;
  children: ReactNode;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    setEnabled(shouldRender3D(detectCapability(window.location.search)));
  }, []);

  // Server render and first paint show the fallback: no layout shift, and a
  // visitor who never reaches the check still gets a working screen.
  if (enabled !== true) return <>{fallback}</>;

  return (
    <>
      <div className="scene" aria-hidden="true">
        {children}
      </div>
      <details className="scene-escape">
        <summary>Switch to list view</summary>
        {fallback}
      </details>
    </>
  );
}
```

- [ ] **Step 2: Add the styles**

Append to `app/style.css`:

```css
.scene{position:relative;height:min(68vh,720px);border:1px solid var(--line);border-radius:12px;overflow:hidden;background:radial-gradient(ellipse at center,#2b312d,#151816)}
.scene canvas{display:block;width:100%;height:100%}
.scene-escape{margin:12px 0}
.scene-escape summary{cursor:pointer;padding:6px 0}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: clean. `Scene3D` is not yet used.

- [ ] **Step 4: Commit**

```bash
git add app/three/scene.tsx app/style.css
git commit -m "feat: add the Scene3D capability gatekeeper"
```

---

## Task 15: The instanced cluster scene

Each cluster is a ring of planes in depth: the keeper forward and bright, rejects receding and
dimmed. One `InstancedMesh` draws every tile, with thumbnails packed into a
`DataArrayTexture` so a scene of thousands of planes costs one draw call.

**Files:**
- Create: `app/three/cluster-layout.ts`
- Create: `app/three/clusters.tsx`
- Test: `tests/three.test.mjs` (extend)

- [ ] **Step 1: Write the failing layout test**

Append to `tests/three.test.mjs`:

```javascript
import { layoutClusters } from "../app/three/cluster-layout.ts";

const cluster = (id, members) => ({
  id,
  kind: "exact",
  keeperId: members[0],
  members: members.map((m) => ({
    id: m,
    filename: m + ".jpg",
    preview: true,
    bytes: 1000,
    sharpness: 100,
    keeper: m === members[0],
    reasons: [],
  })),
  bytesReclaimable: 1000,
  unknownSizes: 0,
});

test("layout places one tile per member and keeps keepers nearest the camera", () => {
  const tiles = layoutClusters([
    cluster("g1", ["a", "b", "c"]),
    cluster("g2", ["d", "e"]),
  ]);
  assert.equal(tiles.length, 5);
  assert.deepEqual(
    tiles.map((t) => t.id).sort(),
    ["a", "b", "c", "d", "e"],
  );
  const keeper = tiles.find((t) => t.id === "a");
  const reject = tiles.find((t) => t.id === "b");
  assert.ok(keeper.keeper);
  assert.ok(keeper.position[2] > reject.position[2], "keeper sits nearer");
  assert.ok(keeper.dim < reject.dim, "rejects are dimmed more");
});

test("clusters are spaced apart and layout is deterministic", () => {
  const input = [cluster("g1", ["a", "b"]), cluster("g2", ["c", "d"])];
  const first = layoutClusters(input);
  assert.deepEqual(first, layoutClusters(input));
  const xs = first.map((t) => t.position[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0, "clusters occupy different x");
});

test("an empty proposal set lays out nothing", () => {
  assert.deepEqual(layoutClusters([]), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/three.test.mjs`
Expected: FAIL — `Cannot find module '../app/three/cluster-layout.ts'`.

- [ ] **Step 3: Implement the layout**

Create `app/three/cluster-layout.ts`:

```typescript
export type LayoutTile = {
  id: string;
  clusterId: string;
  keeper: boolean;
  position: [number, number, number];
  dim: number;
};

type LaidOut = {
  id: string;
  keeperId: string;
  members: { id: string; keeper: boolean }[];
};

export const CLUSTER_SPACING = 6;
const RING_RADIUS = 1.15;
const DEPTH_STEP = 0.9;

/**
 * Clusters march along x; within one cluster the keeper sits forward and centred
 * and the rejects fan out behind it on a ring. Pure maths so it can be tested
 * without a GPU, and deterministic so the scene does not reshuffle on refetch.
 */
export function layoutClusters(clusters: LaidOut[]): LayoutTile[] {
  const tiles: LayoutTile[] = [];
  clusters.forEach((cluster, index) => {
    const originX = index * CLUSTER_SPACING;
    const rejects = cluster.members.filter((m) => !m.keeper);
    cluster.members
      .filter((m) => m.keeper)
      .forEach((member) => {
        tiles.push({
          id: member.id,
          clusterId: cluster.id,
          keeper: true,
          position: [originX, 0, 0],
          dim: 0,
        });
      });
    rejects.forEach((member, n) => {
      const angle = (n / Math.max(rejects.length, 1)) * Math.PI * 2;
      tiles.push({
        id: member.id,
        clusterId: cluster.id,
        keeper: false,
        position: [
          originX + Math.cos(angle) * RING_RADIUS,
          Math.sin(angle) * RING_RADIUS * 0.6,
          -DEPTH_STEP * (1 + n * 0.25),
        ],
        dim: 0.45,
      });
    });
  });
  return tiles;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/three.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Implement the scene**

Create `app/three/clusters.tsx`:

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { layoutClusters, CLUSTER_SPACING, type LayoutTile } from "./cluster-layout";
import { LayerCache } from "./atlas";
import { damp } from "./damp";

const THUMB = 256;
const CAPACITY = 2048;

type SceneCluster = {
  id: string;
  keeperId: string;
  members: { id: string; keeper: boolean }[];
};

/** Packs 256px thumbs into one texture array so every tile is a single draw call. */
function useAtlas(tiles: LayoutTile[]) {
  const cache = useMemo(() => new LayerCache(CAPACITY), []);
  const texture = useMemo(() => {
    const t = new THREE.DataArrayTexture(
      new Uint8Array(THUMB * THUMB * 4 * CAPACITY),
      THUMB,
      THUMB,
      CAPACITY,
    );
    t.format = THREE.RGBAFormat;
    t.needsUpdate = true;
    return t;
  }, []);
  const [layers, setLayers] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const context = document.createElement("canvas");
    context.width = THUMB;
    context.height = THUMB;
    const ctx = context.getContext("2d");
    (async () => {
      for (const tile of tiles) {
        if (cancelled) return;
        if (cache.has(tile.id)) continue;
        try {
          const response = await fetch("/api/thumb/" + tile.id);
          if (!response.ok) continue;
          const bitmap = await createImageBitmap(await response.blob());
          if (cancelled || !ctx) return;
          ctx.clearRect(0, 0, THUMB, THUMB);
          ctx.drawImage(bitmap, 0, 0, THUMB, THUMB);
          bitmap.close();
          const { layer } = cache.acquire(tile.id);
          const pixels = ctx.getImageData(0, 0, THUMB, THUMB).data;
          (texture.image.data as Uint8Array).set(
            pixels,
            layer * THUMB * THUMB * 4,
          );
          texture.needsUpdate = true;
          setLayers((previous) => ({ ...previous, [tile.id]: layer }));
        } catch {
          // A thumb that will not load leaves its tile a flat tint. The scene continues.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tiles, cache, texture]);

  return { texture, layers };
}

function Rig({ targetX }: { targetX: number }) {
  const { camera } = useThree();
  useFrame((_, dt) => {
    camera.position.x = damp(camera.position.x, targetX, 3.5, dt);
    camera.lookAt(targetX, 0, 0);
  });
  return null;
}

function Tiles({
  tiles,
  onPick,
}: {
  tiles: LayoutTile[];
  onPick: (tile: LayoutTile) => void;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const { texture, layers } = useAtlas(tiles);

  useEffect(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    tiles.forEach((tile, i) => {
      const scale = tile.keeper ? 1.25 : 1;
      matrix.makeScale(scale, scale, 1);
      matrix.setPosition(...tile.position);
      instanced.setMatrixAt(i, matrix);
      const shade = 1 - tile.dim;
      instanced.setColorAt(i, colour.setScalar(shade));
    });
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  }, [tiles, layers]);

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, Math.max(tiles.length, 1)]}
      onClick={(event) => {
        const index = event.instanceId;
        if (index !== undefined && tiles[index]) onPick(tiles[index]);
      }}
    >
      <planeGeometry args={[1.6, 1.6]} />
      <meshBasicMaterial map={texture as unknown as THREE.Texture} toneMapped={false} />
    </instancedMesh>
  );
}

export default function ClusterScene({
  clusters,
  onPromote,
}: {
  clusters: SceneCluster[];
  onPromote: (clusterId: string, memberId: string) => void;
}) {
  const tiles = useMemo(() => layoutClusters(clusters), [clusters]);
  const [focus, setFocus] = useState(0);
  return (
    <Canvas camera={{ position: [0, 0, 6], fov: 50 }} dpr={[1, 2]}>
      <ambientLight intensity={1} />
      <Rig targetX={focus * CLUSTER_SPACING} />
      <Tiles
        tiles={tiles}
        onPick={(tile) => {
          const index = clusters.findIndex((c) => c.id === tile.clusterId);
          if (index !== -1) setFocus(index);
          if (!tile.keeper) onPromote(tile.clusterId, tile.id);
        }}
      />
    </Canvas>
  );
}
```

`meshBasicMaterial` with a `DataArrayTexture` samples only layer 0 without a custom shader, so
every tile shows the same image until a per-instance layer attribute and a small
`onBeforeCompile` patch are added. That patch is deliberately **not** in this task — Task 16
verifies the scene renders, moves and responds to clicks first. Record the limitation in the
spec's "Open decisions" when you reach it, and treat per-instance texturing as the first
follow-up.

- [ ] **Step 6: Commit**

```bash
git add app/three/cluster-layout.ts app/three/clusters.tsx tests/three.test.mjs
git commit -m "feat: add the instanced cluster scene"
```

---

## Task 16: Wire the scene behind the gatekeeper

**Files:**
- Modify: `app/reclaim-panel.tsx`

- [ ] **Step 1: Mount it**

In `app/reclaim-panel.tsx`, add the dynamic import at the top of the module, below the existing
imports:

```tsx
import dynamic from "next/dynamic";
import Scene3D from "./three/scene";

// Never statically imported: the three.js chunk loads only on this tab, on a
// device that passed the capability check.
const ClusterScene = dynamic(() => import("./three/clusters"), { ssr: false });
```

Then wrap the cluster list. Task 10 already defined `renderCluster`, so this is a single
substitution — replace the line

```tsx
      {data.clusters.map(renderCluster)}
```

with:

```tsx
      {data.clusters.length > 0 && (
        <Scene3D fallback={<>{data.clusters.map(renderCluster)}</>}>
          <ClusterScene
            clusters={data.clusters.map((c) => ({
              id: c.id,
              keeperId: c.keeperId,
              members: c.members.map((m) => ({ id: m.id, keeper: m.keeper })),
            }))}
            onPromote={(group, keeper) => void keep(group, keeper)}
          />
        </Scene3D>
      )}
```

The same `renderCluster` now serves both the DOM path and the gatekeeper's fallback, so the two
renderers cannot drift. The headline and the junk list stay outside `Scene3D` — they are DOM in
both modes.

- [ ] **Step 2: Verify the bundle budget**

Run: `npm run build`

Compare the First Load JS for `/` against the baseline recorded in Task 13 Step 2. It must be
unchanged — the three.js chunk is behind `next/dynamic` and must not enter the route's initial
payload. If it grew, something imports `./three/clusters` statically; find it and make it
dynamic.

The spec's budget is 180KB gzipped for the R3F chunk. Read the chunk size from the build output
and record it. If it exceeds the budget, drop `@react-three/drei` — nothing in Task 15 uses it,
and it was installed speculatively.

- [ ] **Step 3: Verify by hand, both modes**

Run: `SHOEBOX_LOCAL_STORAGE=1 npm run dev`

On a desktop browser with the Reclaim tab open and at least two clusters:

1. The scene renders, with keepers larger and brighter than rejects.
2. Clicking a cluster glides the camera to it rather than cutting.
3. Clicking a reject promotes it to keeper; the headline GB figure updates.
4. "Switch to list view" expands the full DOM list, and it works.
5. Append `?flat=1` to the URL. The DOM list renders and no canvas appears.
6. Enable "reduce motion" in the OS and reload. The DOM list renders.
7. Narrow the window below 900px and reload. The DOM list renders.
8. In the console, confirm the canvas element has `aria-hidden="true"` on its wrapper and that
   tabbing never lands inside it.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run build`
Expected: PASS and clean. Test files: core, images, picker, import-integration, quality,
cursor, pagination, dupes, junk, bursts, clusters, reclaim, three.

- [ ] **Step 5: Commit**

```bash
git add app/reclaim-panel.tsx
git commit -m "feat: render the cluster scene behind the capability gatekeeper"
```

---

## Done means

- Importing a photo writes an `analysis` row with sharpness and exposure, and a `camera` value
  when the file carries EXIF. Asserted in `tests/import-integration.test.mjs`.
- The Reclaim tab shows "Delete N items → X GB back" where N counts every proposed item exactly
  once, and no keeper is ever among them. Asserted in `tests/clusters.test.mjs`.
- Duplicate keepers are changeable and the figure follows. Bursts propose the sharpest frame.
  Junk carries a plain-language reason. Video placeholders appear nowhere.
- The worklist CSV matches the screen and writes an `audit_log` row.
- The whole screen is keyboard-navigable, and the sentence saying Shoebox deletes nothing is
  visible.
- `shouldRender3D` returns false for reduced motion, `?flat=1`, no WebGL2, fewer than 5 cores,
  and viewports under 900px — each asserted.
- The route's First Load JS is unchanged by the three.js dependency.
- `npm test` passes 13 files; `npm run build` is clean.

## Not in this slice

**Editable burst keepers.** `setKeeper` writes `dupe_groups`, and bursts have no row there, so
a burst keeper is recomputed from `rankBurst` on every read. Persisting a user's burst choice
means either giving bursts rows in `dupe_groups` with `kind='burst'` or adding a keeper column
to `analysis`. Decide that when the feature is asked for, not before.

**Per-instance atlas layers.** See the note in Task 15 Step 5. The scene is structurally
correct and interactive; distinct textures per tile need a small shader patch, which is the
first follow-up.

**Threshold calibration.** `THRESHOLDS.blurBelow` is set conservatively because it cannot be
tuned without a real library. Once there is real analysis data, recalibrate from percentiles of
the user's own rows.

Also still deferred: hybrid search (Slice 2), documents (Slice 3), trips (Slice 4), and face
recognition (indefinitely, per `MASTER_PROMPT.md` §8).
