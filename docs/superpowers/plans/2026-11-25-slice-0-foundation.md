# Slice 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shoebox's library scale to 50,000 items and persist the analysis, duplicate-group and category data that powers 2–6 need, without adding a user-facing feature.

**Architecture:** Server-side keyset pagination replaces the current load-everything-and-filter-in-the-browser approach; `app/library.tsx` splits into a slim client shell plus four focused islands; duplicate groups and per-item analysis move from recomputed-per-request into their own tables; `derive()` gains the sharpness and exposure metrics that culling and junk detection depend on.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Postgres (Neon in production, PGlite locally and in tests), `sharp`, `@tanstack/react-virtual`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-25-3d-powers-design.md` (Slice 0 section).

---

## Prerequisites

**This directory is not a git repository.** Verify before starting:

```bash
cd /d/Powerful-NotesSorting && git rev-parse --is-inside-work-tree
```

If that prints `fatal: not a git repository`, the commit steps in this plan cannot run. Ask the
project owner whether to `git init` before beginning. Do not initialise it unilaterally — the
directory contains `.env.local` with real secrets, and a first commit must come after
confirming `.gitignore` covers it. The existing `.gitignore` is 75 bytes; read it and confirm
it lists `.env.local`, `node_modules`, `.next` and `.shoebox` before any `git add`.

Run the test suite once to establish a green baseline:

```bash
npm test
```

Expected: all four test files pass (`core`, `images`, `picker`, `import-integration`).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/quality.ts` | **Create.** Pure `sharpness()` and `exposure()` over a greyscale buffer. No I/O, no `sharp`. |
| `lib/derive.ts` | **Modify.** Add one 512×512 greyscale pass, return `sharpness` + `exposure`. |
| `lib/cursor.ts` | **Create.** Pure encode/decode of the keyset cursor. |
| `lib/library.ts` | **Modify.** `library()` → `libraryPage()`, keyset-paginated, display columns only. |
| `lib/dupe-store.ts` | **Create.** Persist, read and re-key duplicate groups. |
| `lib/categories.ts` | **Modify.** Keep `safeCategory()`; add per-user seeding and reads. |
| `schema.sql` | **Modify.** `analysis`, `dupe_groups`, `categories` tables; `media.sort_at`; keyset index. |
| `app/api/library/route.ts` | **Modify.** Accept and validate query params; call `libraryPage()`. |
| `app/api/import/route.ts` | **Modify.** Set `sort_at` on insert; persist analysis metrics. |
| `lib/photo-picker.ts` | **Modify.** Set `sort_at` on insert. |
| `lib/save-preview.ts` | **Modify.** Pass the new metrics through. |
| `app/import-panel.tsx` | **Create.** The upload flow lifted out of `library.tsx`. |
| `app/search-bar.tsx` | **Create.** Query input + category select. |
| `app/browse-tabs.tsx` | **Create.** All photos / Duplicates tabs. |
| `app/media-grid.tsx` | **Create.** Virtualised grid + per-item category select. |
| `app/library.tsx` | **Modify.** Slimmed to composition, paging state and data fetching. |
| `tests/quality.test.mjs` | **Create.** Sharpness and exposure assertions. |
| `tests/cursor.test.mjs` | **Create.** Cursor round-trip and ordering assertions. |
| `tests/pagination.test.mjs` | **Create.** Keyset walk over a seeded DB: every row once, no gaps. |
| `tests/import-integration.test.mjs` | **Modify.** Follow the `library()` → `libraryPage()` rename; assert new tables erase. |

---

## Task 1: Pure quality metrics

`sharpness` is the variance of the Laplacian response — the standard blur measure. It is
computed in JS rather than via `sharp.convolve` because `convolve` clamps results to unsigned
8-bit and throws away the negative half of the kernel response, which is most of the signal.

**Files:**
- Create: `lib/quality.ts`
- Test: `tests/quality.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/quality.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/quality.test.mjs`
Expected: FAIL — `Cannot find module '../lib/quality.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/quality.ts`:

```typescript
export type Exposure = {
  p1: number;
  p50: number;
  p99: number;
  clippedLow: number;
  clippedHigh: number;
};

/** Variance of the Laplacian response. Higher is sharper. Border pixels are skipped. */
export function sharpness(gray: Uint8Array, width: number, height: number) {
  if (width < 3 || height < 3) return 0;
  let sum = 0,
    sumSquares = 0,
    count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const response =
        gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += response;
      sumSquares += response * response;
      count++;
    }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** Luma percentiles and the fraction of pixels pinned at pure black or pure white. */
export function exposure(gray: Uint8Array): Exposure {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  const total = gray.length || 1;
  const percentile = (fraction: number) => {
    let seen = 0;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value];
      if (seen >= total * fraction) return value;
    }
    return 255;
  };
  return {
    p1: percentile(0.01),
    p50: percentile(0.5),
    p99: percentile(0.99),
    clippedLow: histogram[0] / total,
    clippedHigh: histogram[255] / total,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/quality.test.mjs`
Expected: PASS, 4 tests.

These functions and every assertion above were run against `sharp` 0.35.5 on 2026-11-25 before
this plan was written, producing `crisp 62708.2`, `blurred 0.1177`, `flat 0`, and
`ramp {p1:2, p50:127, p99:253, clippedLow:0.00390625, clippedHigh:0.00390625}`. If your numbers
differ materially, something about the image pipeline changed — investigate rather than
loosening the assertions. Slice 1 reads its junk thresholds off this separation.

- [ ] **Step 5: Commit**

```bash
git add lib/quality.ts tests/quality.test.mjs
git commit -m "feat: add sharpness and exposure metrics"
```

---

## Task 2: Wire the metrics into derive()

**Files:**
- Modify: `lib/derive.ts:1-29`
- Test: `tests/images.test.mjs` (add one test)

- [ ] **Step 1: Write the failing test**

Append to `tests/images.test.mjs`:

```javascript
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
```

Note `derive` and `sharp` are already imported at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/images.test.mjs`
Expected: FAIL — comparing `undefined > NaN` is false, so the first `assert.ok` fails.

- [ ] **Step 3: Write the implementation**

Replace the whole of `lib/derive.ts` with:

```typescript
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
```

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS. `tests/images.test.mjs` now reports 2 tests; the other three files are
unchanged. `derive()` gained return fields and removed none, so existing callers still work.

- [ ] **Step 5: Commit**

```bash
git add lib/derive.ts tests/images.test.mjs
git commit -m "feat: return sharpness and exposure from derive"
```

---

## Task 3: Schema — analysis, dupe_groups, categories, sort_at

`schema.sql` is applied idempotently and is run twice in a row by
`tests/import-integration.test.mjs:18-19`, so every statement must tolerate re-application.
Follow the existing style in that file: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.

**Files:**
- Modify: `schema.sql` (append; do not reorder existing statements)
- Test: `tests/pagination.test.mjs` (created in Task 5 — this task is verified by Step 3 below)

- [ ] **Step 1: Append the new schema**

Add to the end of `schema.sql`:

```sql
-- Slice 0: per-item analysis, kept out of media so media stays lean.
CREATE TABLE IF NOT EXISTS analysis (
 media_id uuid PRIMARY KEY REFERENCES media ON DELETE CASCADE,
 sharpness real,
 exposure jsonb,
 ocr_text text,
 doc jsonb,
 embedding vector(1536),
 burst_key text,
 event_id uuid
);
CREATE INDEX IF NOT EXISTS analysis_burst ON analysis(burst_key) WHERE burst_key IS NOT NULL;

-- Slice 0: duplicate groups become durable rows instead of a per-request recomputation.
CREATE TABLE IF NOT EXISTS dupe_groups (
 id uuid PRIMARY KEY,
 owner text NOT NULL REFERENCES users ON DELETE CASCADE,
 kind text NOT NULL,
 keeper_id uuid NOT NULL REFERENCES media ON DELETE CASCADE,
 member_ids uuid[] NOT NULL,
 bytes_reclaimable bigint NOT NULL DEFAULT 0,
 unknown_sizes integer NOT NULL DEFAULT 0,
 built_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dupe_groups_owner ON dupe_groups(owner);

-- Slice 0: categories become per-user data, seeded from the previous hardcoded list.
CREATE TABLE IF NOT EXISTS categories (
 owner text NOT NULL REFERENCES users ON DELETE CASCADE,
 key text NOT NULL,
 kind text NOT NULL,
 label text NOT NULL,
 emoji text NOT NULL DEFAULT '',
 rule text NOT NULL DEFAULT '',
 sort_order integer NOT NULL DEFAULT 0,
 PRIMARY KEY (owner, key)
);

-- Slice 0: a non-null sort key so keyset pagination can use a plain b-tree index.
-- A literal cast is not immutable, so this cannot be an expression index or a generated column.
ALTER TABLE media ADD COLUMN IF NOT EXISTS sort_at timestamptz NOT NULL DEFAULT '-infinity';
UPDATE media SET sort_at = coalesce(taken_at, '-infinity') WHERE sort_at = '-infinity' AND taken_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_owner_keyset ON media(owner, sort_at DESC, id DESC);
```

- [ ] **Step 2: Verify the schema applies twice over a clean PGlite database**

Run:

```bash
node --input-type=module -e "
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import fs from 'node:fs/promises';
const pg = new PGlite({ extensions: { vector } });
const schema = await fs.readFile('schema.sql', 'utf8');
await pg.exec(schema);
await pg.exec(schema);
const r = await pg.query(\"select table_name from information_schema.tables where table_name in ('analysis','dupe_groups','categories') order by 1\");
console.log(r.rows);
const c = await pg.query(\"select column_name from information_schema.columns where table_name='media' and column_name='sort_at'\");
console.log(c.rows);
await pg.close();
"
```

Expected output:

```
[ { table_name: 'analysis' }, { table_name: 'categories' }, { table_name: 'dupe_groups' } ]
[ { column_name: 'sort_at' } ]
```

If `vector(1536)` is rejected by the PGlite pgvector build, drop the `embedding` column from
this task and add it in Slice 2 where it is first used, noting the reason in the spec's
"Open decisions" section. Do not change the dimension to make it pass.

- [ ] **Step 3: Set `sort_at` at both insert sites**

In `app/api/import/route.ts:34`, add `sort_at` to the column list and
`coalesce(${time}, '-infinity')` to the select list. Extract the time value first so it is
used twice. Replace lines 25-34 with:

```typescript
  const form = await req.formData(),
    id = String(form.get("id")),
    batch = String(form.get("import")),
    name = String(form.get("name")).slice(0, 500),
    kind = form.get("kind") === "video" ? "video" : "photo";
  const file = form.get("preview"),
    hash = String(form.get("hash") || ""),
    index = Number(form.get("index")),
    time = (form.get("time") as string) || null;
  const reserved =
    await sql`insert into media(id,owner,import_id,filename,kind,bytes,hash,category,state,position,taken_at,sort_at,geo) select ${id},i.owner,i.id,${name},${kind},${Number(form.get("bytes"))},${hash || null},${kind === "video" ? "Videos" : "Other photos"},'uploading',${index},${time},coalesce(${time}::timestamptz,'-infinity'),${(form.get("geo") as string) || null}::jsonb from imports i join users u on u.id=i.owner where i.id=${batch} and i.source is distinct from 'picker' and i.owner=${user} and not u.deleting and ${index} between 0 and i.expected-1 on conflict do nothing returning id`;
```

In `lib/photo-picker.ts:190-192`, add `sort_at` to the column list and the matching value.
Change the column list to end `...,position,taken_at,sort_at,thumb,work,pixels,phash,screenshot)`
and insert `coalesce(${item.createTime ?? null}::timestamptz,'-infinity'),` immediately after
the existing `${item.createTime ?? null},` value.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, unchanged counts. `tests/import-integration.test.mjs` exercises the
`photo-picker.ts` insert, so a column/value mismatch fails loudly here.

- [ ] **Step 5: Commit**

```bash
git add schema.sql app/api/import/route.ts lib/photo-picker.ts
git commit -m "feat: add analysis, dupe_groups, categories tables and media.sort_at"
```

---

## Task 4: Cursor encoding

**Files:**
- Create: `lib/cursor.ts`
- Test: `tests/cursor.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/cursor.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor } from "../lib/cursor.ts";

test("a cursor round-trips through encode and decode", () => {
  const row = { sort_at: new Date("2026-03-04T05:06:07.000Z"), id: "a3f1" };
  const decoded = decodeCursor(encodeCursor(row));
  assert.equal(decoded.sortAt, "2026-03-04T05:06:07.000Z");
  assert.equal(decoded.id, "a3f1");
});

test("a string sort_at is accepted unchanged", () => {
  const encoded = encodeCursor({ sort_at: "-infinity", id: "b2" });
  assert.deepEqual(decodeCursor(encoded), { sortAt: "-infinity", id: "b2" });
});

test("absent, empty and malformed cursors decode to null", () => {
  for (const bad of [null, undefined, "", "not-base64!!", "eyJub3BlIjoxfQ=="])
    assert.equal(decodeCursor(bad), null, "should reject " + JSON.stringify(bad));
});

test("a cursor containing a quote or separator survives encoding", () => {
  const encoded = encodeCursor({ sort_at: "-infinity", id: 'x"|y' });
  assert.equal(decodeCursor(encoded).id, 'x"|y');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/cursor.test.mjs`
Expected: FAIL — `Cannot find module '../lib/cursor.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/cursor.ts`:

```typescript
export type Cursor = { sortAt: string; id: string };

/** Opaque, URL-safe cursor. base64url of JSON so ids containing separators are safe. */
export function encodeCursor(row: { sort_at: Date | string; id: string }) {
  const sortAt =
    row.sort_at instanceof Date ? row.sort_at.toISOString() : String(row.sort_at);
  return Buffer.from(JSON.stringify([sortAt, row.id])).toString("base64url");
}

export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortAt, id] = parsed;
    if (typeof sortAt !== "string" || typeof id !== "string" || !id) return null;
    return { sortAt, id };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/cursor.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/cursor.ts tests/cursor.test.mjs
git commit -m "feat: add opaque keyset cursor encoding"
```

---

## Task 5: Keyset-paginated library query

This replaces `library()`, which currently selects every row for the owner including `pixels`
(~16KB of base64 per row) and `phash`, strips them in JS, and returns the whole library.

`q` stays a server-side `ILIKE` for now, which preserves today's substring behaviour. Slice 2
replaces it with hybrid vector + full-text search.

**Files:**
- Modify: `lib/library.ts` (replace the file)
- Test: `tests/pagination.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/pagination.test.mjs`:

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

test("keyset paging walks every row exactly once, newest first", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-page-"));
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
      contents: 'export {libraryPage} from "./lib/library";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "page.cjs"),
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
  const { libraryPage } = req(path.join(output, "page.cjs"));

  await pg.exec("insert into users(id) values('tester')");
  await pg.query("insert into imports(id,owner,expected) values($1,'tester',250)", [
    "11111111-1111-1111-1111-111111111111",
  ]);
  // 250 rows: 200 dated an hour apart, 50 with no date at all.
  for (let i = 0; i < 250; i++) {
    const dated = i < 200;
    const taken = dated ? new Date(Date.UTC(2026, 0, 1, i)).toISOString() : null;
    await pg.query(
      `insert into media(id,owner,import_id,filename,kind,bytes,category,state,position,taken_at,sort_at,thumb)
       values($1,'tester','11111111-1111-1111-1111-111111111111',$2,'photo',1000,'Other photos','ready',$3,$4,coalesce($4::timestamptz,'-infinity'),'t')`,
      [
        "22222222-0000-4000-8000-" + String(i).padStart(12, "0"),
        "photo" + i + ".jpg",
        i,
        taken,
      ],
    );
  }

  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = await libraryPage({ user: "tester", cursor, limit: 40 });
    seen.push(...page.items.map((i) => i.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 250, "expected every row once, got " + seen.length);
  assert.equal(new Set(seen).size, 250, "pages overlapped");

  // Dated rows come first, newest first; undated rows land last.
  const first = await libraryPage({ user: "tester", limit: 3 });
  assert.deepEqual(
    first.items.map((i) => i.filename),
    ["photo199.jpg", "photo198.jpg", "photo197.jpg"],
  );

  // Filters narrow the page without breaking the walk.
  await pg.query("update media set category='Receipts' where position < 5");
  const receipts = await libraryPage({ user: "tester", category: "Receipts", limit: 100 });
  assert.equal(receipts.items.length, 5);
  assert.equal(receipts.nextCursor, null);

  const matched = await libraryPage({ user: "tester", q: "photo17.jpg", limit: 100 });
  assert.deepEqual(
    matched.items.map((i) => i.filename),
    ["photo17.jpg"],
  );

  // Display queries must not ship fingerprint columns to the client.
  for (const key of ["pixels", "phash", "hash"])
    assert.ok(!(key in first.items[0]), key + " must not be returned");

  assert.equal(first.total, 250);
  await pg.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/pagination.test.mjs`
Expected: FAIL — esbuild cannot resolve the export `libraryPage` from `./lib/library`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `lib/library.ts` with:

```typescript
import { db } from "./db";
import { encodeCursor, decodeCursor } from "./cursor.ts";

export type LibraryQuery = {
  user: string;
  cursor?: string | null;
  limit?: number;
  category?: string | null;
  q?: string | null;
  tab?: string | null;
};

/** The highest possible keyset position, so the first page's predicate matches every row. */
const TOP_SORT_AT = "infinity";
const TOP_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export async function libraryPage({
  user,
  cursor,
  limit,
  category,
  q,
  tab,
}: LibraryQuery) {
  const size = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const after = decodeCursor(cursor);
  // ponytail: substring match preserves today's behaviour. Slice 2 replaces this
  // with pgvector + full-text fusion; the shape of the return value does not change.
  const term = q?.trim() ? "%" + q.trim() + "%" : null;
  const wanted = category && category !== "All categories" ? category : null;
  const duplicatesOnly = tab === "duplicates";
  const sql = db();
  const rows = await sql`
    select id,filename,kind,category,caption,tags,state,sort_at,
           thumb is not null as preview
    from media
    where owner=${user}
      and (sort_at,id) < (${after?.sortAt ?? TOP_SORT_AT}::timestamptz,${after?.id ?? TOP_ID}::uuid)
      and (${wanted}::text is null or category=${wanted})
      and (${term}::text is null or filename ilike ${term} or category ilike ${term}
           or caption ilike ${term} or tags ilike ${term})
      and (${!duplicatesOnly} or id in (select unnest(member_ids) from dupe_groups where owner=${user}))
    order by sort_at desc, id desc
    limit ${size + 1}`;
  const page = rows.slice(0, size) as {
    id: string;
    sort_at: Date | string;
    [key: string]: unknown;
  }[];
  const [counted] = await sql`select count(*)::int as n from media where owner=${user}`;
  const last = page[page.length - 1];
  return {
    items: page.map(({ sort_at, ...visible }) => visible),
    nextCursor: rows.length > size && last ? encodeCursor(last) : null,
    total: counted.n as number,
  };
}
```

The keyset predicate uses sentinels rather than a `${after === null} or …` guard because
Postgres does not short-circuit `OR` and a row comparison against `NULL` yields `NULL`, not
`true`. `(sort_at,id) < ('infinity', 'ffffffff-…')` matches every row, so the first page needs
no special case. `sort_at` is `NOT NULL DEFAULT '-infinity'` from Task 3, so no row can sort
above the sentinel.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/pagination.test.mjs`
Expected: PASS, 1 test.

If the walk returns fewer than 250 ids, print each page's length and its `nextCursor`. The
usual cause is a cursor built from the wrong row — it must come from the last row of the
**trimmed** page (`page[page.length - 1]`), never from the extra `size + 1` row used only to
detect that another page exists.

If `(sort_at,id) < (…)` raises a type error, the driver is sending the sentinel as an untyped
parameter; the `::timestamptz` and `::uuid` casts in the query are what resolve it, so confirm
they were not dropped when the query was copied.

- [ ] **Step 5: Commit**

```bash
git add lib/library.ts tests/pagination.test.mjs
git commit -m "feat: keyset-paginate the library query"
```

---

## Task 6: Persist duplicate groups

`lib/duplicates.ts` keeps its signature and its two existing tests untouched. Only the call
site and persistence change.

**Files:**
- Create: `lib/dupe-store.ts`
- Test: `tests/dupes.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/dupes.test.mjs`. It reuses the harness shape from Task 5; the differences are the
bundled exports and the assertions.

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

test("groups persist, total bytes, and survive a keeper change", async (t) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-dupes-"));
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
        'export {rebuildGroups,readGroups,setKeeper} from "./lib/dupe-store";',
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(output, "dupes.cjs"),
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
  const { rebuildGroups, readGroups, setKeeper } = req(path.join(output, "dupes.cjs"));

  await pg.exec("insert into users(id) values('tester')");
  await pg.query("insert into imports(id,owner,expected) values($1,'tester',4)", [
    "11111111-1111-1111-1111-111111111111",
  ]);
  const id = (n) => "33333333-0000-4000-8000-" + String(n).padStart(12, "0");
  const add = (n, bytes, hash, kind = "photo", thumb = "t") =>
    pg.query(
      `insert into media(id,owner,import_id,filename,kind,bytes,hash,category,state,position,sort_at,thumb)
       values($1,'tester','11111111-1111-1111-1111-111111111111',$2,$3,$4,$5,'Other photos','ready',$6,'-infinity',$7)`,
      [id(n), "p" + n + ".jpg", kind, bytes, hash, n, thumb],
    );
  await add(0, 900, "same");
  await add(1, 500, "same");
  await add(2, 100, "unique");
  // A video placeholder pair must never become a group.
  await add(3, 400, null, "video", null);

  assert.equal(await rebuildGroups("tester"), 1);
  let groups = await readGroups("tester");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keeperId, id(0), "largest bytes should be keeper");
  assert.deepEqual(groups[0].memberIds.slice().sort(), [id(0), id(1)].sort());
  assert.equal(Number(groups[0].bytesReclaimable), 500);
  assert.equal(groups[0].kind, "exact");

  // Rebuilding is idempotent: no duplicate group rows.
  assert.equal(await rebuildGroups("tester"), 1);
  assert.equal((await readGroups("tester")).length, 1);

  // Promoting the other member recomputes the reclaimable figure.
  await setKeeper("tester", groups[0].id, id(1));
  groups = await readGroups("tester");
  assert.equal(groups[0].keeperId, id(1));
  assert.equal(Number(groups[0].bytesReclaimable), 900);

  // A keeper that is not a member of the group is refused.
  await assert.rejects(() => setKeeper("tester", groups[0].id, id(2)), /member/);
  // Another user cannot touch this group.
  await assert.rejects(() => setKeeper("other", groups[0].id, id(0)), /not found/);

  await pg.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/dupes.test.mjs`
Expected: FAIL — esbuild cannot resolve `./lib/dupe-store`.

- [ ] **Step 3: Write the implementation**

Create `lib/dupe-store.ts`:

```typescript
import { db } from "./db";
import { duplicateGroups, type Fingerprint } from "./duplicates.ts";

export type StoredGroup = {
  id: string;
  kind: string;
  keeperId: string;
  memberIds: string[];
  bytesReclaimable: number;
  unknownSizes: number;
};

/** Recompute groups for one owner and replace that owner's stored rows. Returns the count. */
export async function rebuildGroups(user: string) {
  const sql = db();
  const rows = await sql`
    select id,filename,kind,bytes,hash,phash,pixels,screenshot from media
    where owner=${user} and state='ready' and thumb is not null`;
  const groups = duplicateGroups(rows as Fingerprint[]);
  await sql`delete from dupe_groups where owner=${user}`;
  for (const group of groups) {
    const [keeper, ...copies] = group;
    await sql`
      insert into dupe_groups(id,owner,kind,keeper_id,member_ids,bytes_reclaimable,unknown_sizes)
      values(${crypto.randomUUID()},${user},
             ${group.every((r) => r.hash && r.hash === keeper.hash) ? "exact" : "near"},
             ${keeper.id},${group.map((r) => r.id)},
             ${copies.reduce((sum, r) => sum + Number(r.bytes ?? 0), 0)},
             ${copies.filter((r) => r.bytes === null).length})`;
  }
  return groups.length;
}

export async function readGroups(user: string): Promise<StoredGroup[]> {
  const rows = await db()`
    select id,kind,keeper_id,member_ids,bytes_reclaimable,unknown_sizes
    from dupe_groups where owner=${user} order by bytes_reclaimable desc, id`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    keeperId: r.keeper_id,
    memberIds: r.member_ids,
    bytesReclaimable: Number(r.bytes_reclaimable),
    unknownSizes: Number(r.unknown_sizes),
  }));
}

/** Promote a member to keeper and recompute what the group reclaims. */
export async function setKeeper(user: string, groupId: string, keeperId: string) {
  const sql = db();
  const [group] =
    await sql`select member_ids from dupe_groups where id=${groupId} and owner=${user}`;
  if (!group) throw Error("That duplicate group was not found.");
  if (!group.member_ids.includes(keeperId))
    throw Error("That photo is not a member of this group.");
  const sizes = await sql`
    select coalesce(sum(bytes),0)::bigint as total,
           count(*) filter (where bytes is null)::int as unknown
    from media where owner=${user} and id = any(${group.member_ids}) and id<>${keeperId}`;
  await sql`
    update dupe_groups set keeper_id=${keeperId},
      bytes_reclaimable=${String(sizes[0].total)}::bigint,
      unknown_sizes=${sizes[0].unknown}
    where id=${groupId} and owner=${user}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/dupes.test.mjs`
Expected: PASS, 1 test.

The video placeholder assertion is the one most likely to surface a real bug: `add(3, …)`
inserts a video with `thumb` null, so `rebuildGroups` must exclude it via the
`thumb is not null` predicate. If the test reports 2 groups instead of 1, that predicate is
missing — fix the query, not the test.

- [ ] **Step 5: Call it after labelling, and expose it through the library endpoint**

In `lib/jobs.ts`, find where a batch finishes and no work remains, and call
`await rebuildGroups(user)` there, importing it at the top:

```typescript
import { rebuildGroups } from "./dupe-store.ts";
```

Read `lib/jobs.ts` in full first — it is 119 lines — and place the call on the path that
returns "no more work", so a resumed import rebuilds once at the end rather than per batch.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/import-integration.test.mjs` drives `runBatch` to completion, so a
`rebuildGroups` that throws will fail there.

- [ ] **Step 7: Commit**

```bash
git add lib/dupe-store.ts tests/dupes.test.mjs lib/jobs.ts
git commit -m "feat: persist duplicate groups"
```

---

## Task 7: Per-user categories

`safeCategory()` keeps its exact current contract so `tests/core.test.mjs:34-38` stays green.
The hardcoded array becomes the seed list.

**Files:**
- Modify: `lib/categories.ts`
- Test: `tests/core.test.mjs` (add one test)

- [ ] **Step 1: Write the failing test**

First widen the existing import at `tests/core.test.mjs:4`, replacing that single line:

```javascript
import { safeCategory, seedRows, categories } from "../lib/categories.ts";
```

Then append the new test to the end of the file:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/core.test.mjs`
Expected: FAIL — `seedRows is not a function`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `lib/categories.ts` with:

```typescript
export const categories = [
  "Other photos",
  "Receipts",
  "Documents",
  "Screenshots",
  "People",
  "Places",
  "Videos",
] as const;

export type CategoryRow = {
  owner: string;
  key: string;
  kind: string;
  label: string;
  emoji: string;
  rule: string;
  sort_order: number;
};

const EMOJI: Record<string, string> = {
  "Other photos": "🖼️",
  Receipts: "🧾",
  Documents: "📄",
  Screenshots: "📱",
  People: "🧑",
  Places: "🗺️",
  Videos: "🎬",
};

const RULES: Record<string, string> = {
  "Other photos": "Any photo that does not clearly belong in another category.",
  Receipts: "Receipts, invoices, bills and proofs of purchase.",
  Documents: "Letters, forms, contracts, tickets, IDs and whiteboards.",
  Screenshots: "Screenshots and screen recordings of apps or websites.",
  People: "Photos where a person is the subject.",
  Places: "Landscapes, buildings, streets and travel scenery.",
  Videos: "Any video, whatever its subject.",
};

const key = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The rows a new user's `categories` table starts with. */
export function seedRows(owner: string): CategoryRow[] {
  return categories.map((label, i) => ({
    owner,
    key: key(label),
    kind: label === "Videos" ? "video" : "photo",
    label,
    emoji: EMOJI[label] ?? "",
    rule: RULES[label] ?? "",
    sort_order: i,
  }));
}

export function safeCategory(kind: string, category: string) {
  const valid =
    categories.some((c) => c === category) &&
    (kind === "video") === (category === "Videos");
  return {
    category: valid ? category : kind === "video" ? "Videos" : "Other photos",
    review: !valid,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --test tests/core.test.mjs`
Expected: PASS, 3 tests — the two existing ones plus the new seed test.

- [ ] **Step 5: Seed on first import**

In `app/api/import/route.ts`, the user row is created at line 14 with
`insert into users(id) values(${user}) on conflict do nothing`. Immediately after it, seed the
categories idempotently:

```typescript
    await sql`insert into users(id) values(${user}) on conflict do nothing`;
    for (const row of seedRows(user))
      await sql`insert into categories(owner,key,kind,label,emoji,rule,sort_order)
        values(${row.owner},${row.key},${row.kind},${row.label},${row.emoji},${row.rule},${row.sort_order})
        on conflict(owner,key) do nothing`;
```

Add the import at the top of the file:

```typescript
import { seedRows } from "../../../lib/categories";
```

Nothing reads the `categories` table yet — the UI still imports the `categories` array. Wiring
the UI to per-user rows is deliberately out of Slice 0; this task only establishes the data so
Slice 1 and later can edit categories without a migration.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/import-integration.test.mjs` goes through the Picker path rather than
`app/api/import/route.ts`, so confirm the seed by hand:

```bash
SHOEBOX_LOCAL_STORAGE=1 npm run dev
```

Import one folder, then check the rows:

```bash
node --input-type=module -e "
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
const pg = new PGlite('.shoebox/postgres', { extensions: { vector } });
console.log((await pg.query('select label,kind,sort_order from categories order by sort_order')).rows);
await pg.close();
"
```

Expected: seven rows, `Videos` tagged `video`, `sort_order` 0 through 6.

- [ ] **Step 7: Commit**

```bash
git add lib/categories.ts tests/core.test.mjs app/api/import/route.ts
git commit -m "feat: seed per-user categories"
```

---

## Task 8: Library endpoint takes query parameters

**Files:**
- Modify: `app/api/library/route.ts:1-6` (GET only; leave DELETE untouched)
- Modify: `tests/import-integration.test.mjs:44` and `:127`

- [ ] **Step 1: Update the integration test to the new name**

`tests/import-integration.test.mjs` bundles and calls `library()`, which no longer exists.

At line 44, change the bundled export from `export {library} from "./lib/library";` to:

```javascript
export {libraryPage} from "./lib/library";
```

At line 67, change the destructure to `libraryPage`:

```javascript
  const { stepPhotos, runBatch, libraryPage, csv, erase } = req(
    path.join(output, "app.cjs"),
  );
```

At lines 126-130, change the assertion to:

```javascript
  assert.ok(
    (await libraryPage({ user: "tester", limit: 500 })).items.some((i) =>
      i.caption.includes("Hotel Iris"),
    ),
  );
```

In the erase assertion at lines 134-141, add the new tables to the list so a missing cascade
is caught:

```javascript
  for (const t of [
    "imports",
    "jobs",
    "photo_sessions",
    "budgets",
    "media",
    "audit_log",
    "analysis",
    "dupe_groups",
    "categories",
  ])
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --test tests/import-integration.test.mjs`
Expected: PASS if Tasks 5 and 6 are complete. If it fails on `analysis`, `dupe_groups` or
`categories` being non-zero after `erase()`, the `REFERENCES users ON DELETE CASCADE` or
`REFERENCES media ON DELETE CASCADE` clauses from Task 3 are wrong — fix the schema.

- [ ] **Step 3: Update the route handler**

Replace lines 1-6 of `app/api/library/route.ts` with:

```typescript
import { db, owner } from "../../../lib/db";
import { libraryPage } from "../../../lib/library";
import { readGroups } from "../../../lib/dupe-store";
import { erasePreviews } from "../../../lib/preview-store";
export async function GET(req: Request) {
  const user = await owner(),
    params = new URL(req.url).searchParams;
  const page = await libraryPage({
    user,
    cursor: params.get("cursor"),
    limit: Number(params.get("limit")) || 200,
    category: params.get("category"),
    q: params.get("q"),
    tab: params.get("tab"),
  });
  return Response.json({ ...page, groups: await readGroups(user) });
}
```

Leave the `DELETE` handler at lines 7-21 exactly as it is.

- [ ] **Step 4: Verify the endpoint by hand**

```bash
SHOEBOX_LOCAL_STORAGE=1 npm run dev
```

With a signed-in session and some imported photos, in the browser console:

```javascript
const a = await (await fetch("/api/library?limit=2")).json();
const b = await (await fetch("/api/library?limit=2&cursor=" + a.nextCursor)).json();
console.log(a.items.length, b.items.length, a.items[0].id !== b.items[0].id);
```

Expected: `2 2 true`.

- [ ] **Step 5: Commit**

```bash
git add app/api/library/route.ts tests/import-integration.test.mjs
git commit -m "feat: accept paging and filter params on the library endpoint"
```

---

## Task 9: Extract the import panel

`app/library.tsx` is 346 lines carrying the import flow, search, filtering, the grid,
duplicate review, CSV export and account deletion. Tasks 9 through 12 split it. Behaviour is
preserved throughout — this is decomposition, not redesign.

The import flow is lines 34-42 (`json`), 51-52 (the two refs), 61-135 (`upload`) and the two
hidden `<input>` elements plus the two buttons at lines 164-199.

**Files:**
- Create: `app/import-panel.tsx`
- Create: `app/fetch-json.ts`
- Modify: `app/library.tsx`

- [ ] **Step 1: Extract the shared fetch helper**

Create `app/fetch-json.ts`:

```typescript
export const json = async (response: Response) => {
  if (!response.ok)
    throw Error(
      response.status === 409
        ? await response.text()
        : "Shoebox couldn’t finish that request. Please try again.",
    );
  return response.json();
};
```

- [ ] **Step 2: Create the import panel**

Create `app/import-panel.tsx`. This is the `upload` function and its UI, moved verbatim except
that `setStatus`/`setBusy` become props and `refresh` becomes `onImported`:

```tsx
"use client";
import { useRef } from "react";
import { Archive, FolderPlus } from "lucide-react";
import { entries, prepare } from "../lib/files";
import { json } from "./fetch-json";

export default function ImportPanel({
  busy,
  setBusy,
  setStatus,
  onImported,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setStatus: (status: string) => void;
  onImported: () => Promise<void>;
}) {
  const files = useRef<HTMLInputElement>(null),
    folder = useRef<HTMLInputElement>(null);
  async function upload(selection: File[]) {
    if (busy || !selection.length) return;
    setBusy(true);
    let progress: EventSource | undefined;
    try {
      setStatus("Reading your files…");
      const batch = await entries(selection);
      const request = (confirm: boolean) =>
        fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count: batch.length, confirm }),
        }).then(json);
      const quote = await request(false);
      if (
        !window.confirm(
          "Import " +
            batch.length +
            " items? " +
            (quote.enabled
              ? "Maximum estimated labeling cost, including retries: $" +
                quote.estimate.toFixed(3)
              : "AI labeling is off. Estimated cost: $0."),
        )
      ) {
        setStatus("");
        return;
      }
      const { id } = await request(true);
      progress = new EventSource("/api/progress/" + id);
      progress.onmessage = (e) => {
        const p = JSON.parse(e.data);
        setStatus("Received " + p.received + " of " + p.total + " items.");
        if (p.received >= p.total) progress?.close();
      };
      for (let i = 0; i < batch.length; i += 3) {
        setStatus("Importing " + (i + 1) + " of " + batch.length + "…");
        await Promise.all(
          batch.slice(i, i + 3).map(async (entry, k) =>
            json(
              await fetch("/api/import", {
                method: "POST",
                body: await prepare(entry, id, i + k),
              }),
            ),
          ),
        );
      }
      progress.close();
      await onImported();
      if (quote.enabled) {
        setStatus("Reading contact sheets…");
        while (
          (
            await json(
              await fetch("/api/jobs", {
                method: "POST",
                body: JSON.stringify({ id }),
              }),
            )
          ).worked
        )
          await onImported();
      }
      setStatus("Imported " + batch.length + " items.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Import interrupted.");
      await onImported().catch(() => {});
    } finally {
      progress?.close();
      setBusy(false);
      if (files.current) files.current.value = "";
      if (folder.current) folder.current.value = "";
    }
  }
  return (
    <>
      <div className="actions">
        <button disabled={busy} onClick={() => folder.current?.click()}>
          <FolderPlus />
          Choose folder
        </button>
        <button
          disabled={busy}
          className="primary"
          onClick={() => files.current?.click()}
        >
          <Archive />
          Import files
        </button>
      </div>
      <input
        hidden
        ref={files}
        type="file"
        multiple
        accept="image/*,video/*,.zip,.heic,.heif"
        onChange={(e) => upload(Array.from(e.target.files ?? []))}
      />
      <input
        hidden
        ref={folder}
        type="file"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => upload(Array.from(e.target.files ?? []))}
      />
    </>
  );
}
```

- [ ] **Step 3: Expose `upload` for the drag-and-drop handler**

`app/library.tsx:158-162` drops files onto the whole `<main>`. Keep that behaviour by having
the panel accept a ref-like callback. Add to `ImportPanel`'s props:

```tsx
  onReady?: (upload: (selection: File[]) => Promise<void>) => void;
```

and inside the component, after `upload` is defined:

```tsx
  useEffect(() => {
    onReady?.(upload);
  }, [busy]);
```

Import `useEffect` alongside `useRef`. The `busy` dependency re-publishes the closure when
`busy` flips, so the drop handler never calls a stale `upload`.

- [ ] **Step 4: Verify the app still imports**

Run: `SHOEBOX_LOCAL_STORAGE=1 npm run dev`, then import a folder of five photos and drop two
more onto the page. Both paths must work and the status line must update.

Run: `npm run build`
Expected: compiles with no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/import-panel.tsx app/fetch-json.ts app/library.tsx
git commit -m "refactor: extract the import panel from library.tsx"
```

---

## Task 10: Extract the search bar and browse tabs

**Files:**
- Create: `app/search-bar.tsx`
- Create: `app/browse-tabs.tsx`
- Modify: `app/library.tsx`

- [ ] **Step 1: Create the search bar**

Create `app/search-bar.tsx` from lines 227-246 of `app/library.tsx`:

```tsx
"use client";
import { Search } from "lucide-react";
import { categories } from "../lib/categories";

export default function SearchBar({
  query,
  setQuery,
  category,
  setCategory,
}: {
  query: string;
  setQuery: (query: string) => void;
  category: string;
  setCategory: (category: string) => void;
}) {
  return (
    <div className="filters">
      <label>
        <Search />
        <input
          aria-label="Search library"
          placeholder="Search photos, receipts, places…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <select
        aria-label="Filter by category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        {["All categories", ...categories].map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Create the browse tabs**

Create `app/browse-tabs.tsx` from lines 201-226:

```tsx
"use client";
import { Copy, Image as Photo } from "lucide-react";

export default function BrowseTabs({
  tab,
  setTab,
  groupCount,
  reclaimBytes,
  unknownSizes,
}: {
  tab: "all" | "duplicates";
  setTab: (tab: "all" | "duplicates") => void;
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
            {unknownSizes &&
              "Google Photos does not report original sizes. "}
            Review the extra copies and export your list. You decide which
            originals to delete.
          </p>
        </section>
      )}
    </>
  );
}
```

Note the `dupes` boolean becomes a `tab` string, because `/api/library?tab=` already takes
`"duplicates"` from Task 5 and a third tab arrives in Slice 1.

- [ ] **Step 2b: Verify the build**

Run: `npm run build`
Expected: compiles. Neither component is referenced yet; this step catches type errors early.

- [ ] **Step 3: Commit**

```bash
git add app/search-bar.tsx app/browse-tabs.tsx
git commit -m "refactor: extract the search bar and browse tabs"
```

---

## Task 11: Virtualised media grid

This is where the 50,000-item target is actually met. `@tanstack/react-virtual` is already in
`package.json:21` and has never been imported.

The grid is a CSS grid of variable column count, so virtualise by **row**: compute columns from
the container width, chunk items into rows, and virtualise the rows.

**Files:**
- Create: `app/media-grid.tsx`
- Modify: `app/style.css`

- [ ] **Step 1: Create the grid**

Create `app/media-grid.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Film, Image as Photo } from "lucide-react";
import { categories } from "../lib/categories";

export type Item = {
  id: string;
  filename: string;
  kind: string;
  category: string;
  caption: string;
  tags: string;
  state: string;
  preview: boolean;
};

const TILE = 210;
const ROW_HEIGHT = 268;

export default function MediaGrid({
  items,
  note,
  onCategory,
  onReachEnd,
}: {
  items: Item[];
  note?: (id: string) => string | undefined;
  onCategory: (id: string, category: string) => Promise<void>;
  onReachEnd: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setColumns(Math.max(1, Math.floor(element.clientWidth / TILE)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rows = Math.ceil(items.length / columns);
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const last = virtualRows[virtualRows.length - 1];
  useEffect(() => {
    if (last && last.index >= rows - 2) onReachEnd();
  }, [last?.index, rows]);
  return (
    <div className="grid-scroller" ref={scroller}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((row) => (
          <div
            key={row.key}
            className="grid"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
            }}
          >
            {items
              .slice(row.index * columns, row.index * columns + columns)
              .map((i) => (
                <article key={i.id} tabIndex={0}>
                  {i.preview ? (
                    <img
                      loading="lazy"
                      src={"/api/thumb/" + i.id}
                      alt={i.caption || i.filename}
                    />
                  ) : (
                    <div className="placeholder">
                      {i.kind === "video" ? <Film /> : <Photo />}
                    </div>
                  )}
                  <div>
                    <strong>{i.filename}</strong>
                    {note?.(i.id) && <small>{note(i.id)}</small>}
                    {i.state === "error" && <small>Preview unavailable</small>}
                    {i.state === "needs_review" && <small>Needs review</small>}
                    <select
                      aria-label={"Category for " + i.filename}
                      value={i.category}
                      onChange={(e) => void onCategory(i.id, e.target.value)}
                    >
                      {categories
                        .filter((c) => (c === "Videos") === (i.kind === "video"))
                        .map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                    </select>
                  </div>
                </article>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the scroller style**

Append to `app/style.css`:

```css
.grid-scroller{height:min(70vh,780px);overflow-y:auto;overflow-x:hidden;contain:strict}
```

`contain:strict` keeps the absolutely positioned rows from affecting layout outside the
scroller. The existing `.grid` rule is unchanged and still lays out each row.

- [ ] **Step 3: Verify with a large library**

Run: `SHOEBOX_LOCAL_STORAGE=1 npm run dev`

Seed 5,000 rows against the local database:

```bash
node --input-type=module -e "
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
const pg = new PGlite('.shoebox/postgres', { extensions: { vector } });
const [u] = (await pg.query('select id from users limit 1')).rows;
const [i] = (await pg.query('select id from imports where owner=\$1 limit 1', [u.id])).rows;
for (let n = 0; n < 5000; n++)
  await pg.query(
    \"insert into media(id,owner,import_id,filename,kind,bytes,category,state,position,sort_at,thumb) values(gen_random_uuid(),\$1,\$2,\$3,'photo',1000,'Other photos','ready',\$4,now() - (\$4 * interval '1 minute'),null)\",
    [u.id, i.id, 'seed' + n + '.jpg', 10000 + n],
  );
console.log('seeded');
await pg.close();
"
```

Then open the library. Expected: the page renders immediately, scrolling stays smooth, and the
DOM holds on the order of tens of `<article>` elements at any moment — check with
`document.querySelectorAll("article").length` in the console, which must stay well under 200
rather than reaching 5,000.

- [ ] **Step 4: Commit**

```bash
git add app/media-grid.tsx app/style.css
git commit -m "feat: virtualise the media grid"
```

---

## Task 12: Recompose library.tsx

The shell keeps only composition, paging state and data fetching. The title, the orbit, the
stacks, the export link and the delete button stay here.

**Files:**
- Modify: `app/library.tsx` (replace the file)

- [ ] **Step 1: Write the new shell**

Replace the whole of `app/library.tsx` with:

```tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Files } from "lucide-react";
import CategoryStacks from "./category-stacks";
import PhotoOrbit from "./photo-orbit";
import Photos from "./photos";
import ImportPanel from "./import-panel";
import SearchBar from "./search-bar";
import BrowseTabs from "./browse-tabs";
import MediaGrid, { type Item } from "./media-grid";
import { json } from "./fetch-json";

type Group = {
  id: string;
  keeperId: string;
  memberIds: string[];
  bytesReclaimable: number;
  unknownSizes: number;
};

export default function Library() {
  const [items, setItems] = useState<Item[]>([]),
    [groups, setGroups] = useState<Group[]>([]),
    [total, setTotal] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("All categories"),
    [tab, setTab] = useState<"all" | "duplicates">("all"),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  // React 19 requires an explicit initial value for useRef.
  const upload = useRef<((selection: File[]) => Promise<void>) | undefined>(
    undefined,
  );
  const loading = useRef(false);

  const load = useCallback(
    async (next: string | null) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const params = new URLSearchParams({ limit: "200", tab });
        if (next) params.set("cursor", next);
        if (query.trim()) params.set("q", query.trim());
        if (category !== "All categories") params.set("category", category);
        const data = await json(
          await fetch("/api/library?" + params, { cache: "no-store" }),
        );
        setItems((previous) => (next ? [...previous, ...data.items] : data.items));
        setGroups(data.groups);
        setTotal(data.total);
        setCursor(data.nextCursor);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        loading.current = false;
      }
    },
    [tab, query, category],
  );

  // Refetch from the first page whenever a filter changes. A 250ms debounce keeps
  // typing in the search box from firing a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(null), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const refresh = useCallback(async () => {
    await load(null);
  }, [load]);

  const members = new Map<string, string>();
  for (const group of groups) {
    members.set(group.keeperId, "Keeper");
    for (const id of group.memberIds)
      if (id !== group.keeperId) members.set(id, "Extra copy");
  }
  const reclaim = groups.reduce((sum, g) => sum + Number(g.bytesReclaimable), 0);

  return (
    <main
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload.current?.(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="title">
        <div>
          <h1>Photo library</h1>
          <p>{total.toLocaleString()} items</p>
        </div>
        <ImportPanel
          busy={busy}
          setBusy={setBusy}
          setStatus={setStatus}
          onImported={refresh}
          onReady={(fn) => {
            upload.current = fn;
          }}
        />
      </div>
      <Photos onImported={refresh} />
      <BrowseTabs
        tab={tab}
        setTab={setTab}
        groupCount={groups.length}
        reclaimBytes={reclaim}
        unknownSizes={groups.some((g) => g.unknownSizes > 0)}
      />
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
                previous.map((i) => (i.id === id ? { ...i, category: next } : i)),
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
      <footer>
        <a href="/api/export">
          <Download />
          Export CSV
        </a>
        <button
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm(
                "Delete all Shoebox copies, labels and account data? This cannot be undone.",
              )
            )
              return;
            try {
              const r = await json(
                await fetch("/api/library", { method: "DELETE" }),
              );
              await refresh();
              setStatus(
                "Removed " + r.removed + " items and their stored copies.",
              );
            } catch (e) {
              setStatus(String(e));
            }
          }}
        >
          Delete my data
        </button>
      </footer>
    </main>
  );
}
```

Three behaviour changes, all intended:

- Search and category filtering now happen on the server, so they apply to the whole library
  rather than the loaded page. This is the fix for **D1**.
- `PhotoOrbit` takes the first 24 loaded items rather than every match, because the full set no
  longer lives in the browser.
- `CategoryStacks` counts the loaded page, not the library. It is a browse affordance, not a
  statistic; Slice 1 replaces its counts with a server-side aggregate.

- [ ] **Step 2: Check the file sizes came down**

Run:

```bash
wc -l app/library.tsx app/import-panel.tsx app/search-bar.tsx app/browse-tabs.tsx app/media-grid.tsx app/fetch-json.ts
```

Expected: `library.tsx` well under 200 lines, every other file under 150, and no file doing
more than one job.

- [ ] **Step 3: Verify the whole app by hand**

Run: `SHOEBOX_LOCAL_STORAGE=1 npm run dev` and walk the full path:

1. Sign in.
2. Import a folder of ten photos; the status line counts up and the grid fills.
3. Type a filename fragment in the search box; the grid narrows and the request fires once,
   not once per keystroke — confirm in the Network tab.
4. Pick a category in the select; the grid narrows.
5. Open the Duplicates tab; the GB figure and the group count appear.
6. Change one item's category; the tile updates without a full reload.
7. Scroll a seeded 5,000-row library to the bottom; further pages load.
8. Export CSV; the file downloads.
9. Delete my data; the library empties and the count returns to zero.

- [ ] **Step 4: Run the full suite and a production build**

Run: `npm test`
Expected: PASS — `core` (3), `images` (2), `picker`, `import-integration`, `quality` (4),
`cursor` (4), `pagination` (1), `dupes` (1).

Run: `npm run build`
Expected: compiles with no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/library.tsx
git commit -m "refactor: recompose library.tsx around server-side paging"
```

---

## Done means

- The grid renders a seeded 50,000-row library without the browser holding 50,000 items or the
  database reading `pixels` for every row.
- `/api/library` returns in under 200ms at that size — measure it, do not assume it.
- `analysis`, `dupe_groups` and `categories` exist, cascade on user deletion, and are asserted
  empty by `tests/import-integration.test.mjs` after `erase()`.
- `derive()` returns `sharpness` and `exposure`, with the sharp-versus-blurred separation
  pinned by a test.
- `npm test` passes with 8 test files, and `npm run build` is clean.
- No user-facing feature was added. If one was, it belongs to a later slice.

## Execution record — 2026-11-25

All 12 tasks implemented. `npm test` passes 20/20 across 8 files; `npm run build` compiles with
TypeScript clean. Commits were **not** made: the directory is still not a git repository.

### Measured, not assumed

50,000 seeded rows in PGlite, after `ANALYZE media`:

| Query | Time |
|---|---|
| first page, limit 200 (includes `count(*)`) | 18.9 ms |
| pages 2–5 via cursor | 7.8–9.8 ms |
| page at row ~25,000 | 7.4 ms |
| filtered by category | 7.3 ms |
| substring search (`ILIKE`) | 80.3 ms |
| `readGroups` | 0.7 ms |
| core display query, `EXPLAIN ANALYZE` | 0.891 ms, Index Scan, no sort |

Against the 200 ms budget in "Done means", with constant-time deep paging confirmed — row
25,000 costs the same as row 200. The `pixels` column totals 5,225 kB at 50,000 rows and the
display query no longer reads it. The `ILIKE` search is the slowest path by an order of
magnitude, which is the thing Slice 2 replaces.

**Statistics matter more than the query shape.** Before `ANALYZE`, the planner estimated 42
rows against 50,000 actual, chose a Bitmap Index Scan, lost the index ordering and added a
top-N sort — 45 ms instead of 0.9 ms. With statistics present the sentinel predicate and a
branched "no predicate on the first page" variant are indistinguishable (0.96 ms vs 0.90 ms),
so the single query shape stands. Autovacuum covers this in production; a bulk restore should
`ANALYZE media` rather than add a second query path.

### Deviations from the plan

1. **`app/api/export/route.ts` was an unlisted caller of `library()`.** The plan's file table
   missed it, so Task 8 broke the build. It needed more than a rename: the CSV wants `bytes`,
   which is not a display column, and must cover the whole library rather than one page. It now
   owns a small query of its own (`id, filename, category, caption, bytes`) and maps duplicates
   through `readGroups`. Separate needs, separate query — better than widening `libraryPage`.
2. **`rebuildGroups` used `crypto.randomUUID()` per group**, so group ids changed on every
   rebuild and the second rebuild orphaned any keeper the user had chosen. Ids are now derived
   from sorted membership via SHA-1 formatted as a v5-shaped UUID, and a rebuild preserves a
   stored keeper that is still a member. This is what `MASTER_PROMPT.md` §8.1 requires of a user
   correction; the test now pins both id stability and keeper survival.
3. **`allowImportingTsExtensions` added to `tsconfig.json`.** `lib/` files import each other
   with explicit `.ts` extensions because the `node:test` suite loads them directly under
   `--experimental-strip-types`, where ESM will not resolve `./quality`. `noEmit: true` was
   already set, which is the precondition for the flag.
4. **`count(*)` moved off the scroll path.** It cost more than the page query itself and ran on
   every page; the total cannot change mid-scroll. `libraryPage` now returns `total: null` when
   a cursor is present and the client keeps the first page's figure.

### Verified by hand

`next dev` boots in 930 ms; `/` and `/privacy` both return 200. `/api/library` returns 500 when
unauthenticated because `owner()` throws — pre-existing behaviour, unchanged by this slice, and
worth a cleaner 401 in a later one.

Running `next dev` caused Next.js 16 to generate `AGENTS.md` in the project root. It is the
framework's own agent guidance, not part of this work; delete it or keep it as you prefer.

### Not verified

The browser-level checks in Task 11 Step 3 and Task 12 Step 3 — virtualised scrolling holding
the DOM node count down, the 250 ms search debounce firing one request, drag-and-drop import,
and the Duplicates tab rendering — need a signed-in Google session, which this environment does
not have. The server paths behind all of them are covered by the test suite; the React
rendering is not.

## Not in this slice

Three-dimensional surfaces, junk detection, burst grouping, keeper promotion in the UI,
embeddings, OCR, documents, events, and wiring the UI to per-user category rows. Each belongs
to Slices 1 through 4 in
`docs/superpowers/specs/2026-11-25-3d-powers-design.md`.
