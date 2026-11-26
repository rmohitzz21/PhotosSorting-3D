# Shoebox — 3D library surfaces and powers 2–6

Date: 2026-11-25
Status: approved for planning

## Goal

Shoebox today is the Phase 1 vertical slice from `MASTER_PROMPT.md` §10: Google sign-in,
local/Takeout/Picker import, derive, dedupe, contact-sheet labelling, a flat grid, a
substring search box, CSV export, delete-my-data. That is already past the reference tool in
the video (`How to Organise Photos with Claude AI!`, the local Python `claude-photo-sorter`
pattern), which only sorts a folder into folders.

This spec covers two things the product does not yet have:

1. **Powers 2, 3, 4, 5 and 6** from `MASTER_PROMPT.md` §8 — search, reclaim, culling,
   documents, trips.
2. **A real 3D presentation layer** for the three of those where depth carries meaning,
   replacing the current CSS-transform flourishes on the surfaces where they are not enough.

Non-goal: face recognition (§8, deferred on legal grounds). Non-goal: anything that writes to
Google Photos (§1.5, §9.2).

## What exists, verified against the code

| Area | State | Evidence |
|---|---|---|
| Import (local, Takeout, Picker) | working | `lib/files.ts`, `lib/photo-picker.ts`, `app/api/import/route.ts` |
| Derive (work copy, thumb, dHash, pixel signature) | working | `lib/derive.ts` |
| Duplicate detection incl. screenshot pixel guard | working, not persisted | `lib/duplicates.ts` |
| Contact-sheet labelling, resumable, budget-capped | working | `lib/jobs.ts`, `lib/import-cost.ts` |
| Grid UI, duplicate filter, CSV export, delete-my-data | working | `app/library.tsx`, `app/api/export/route.ts` |
| CSS-3D orbit carousel and category stacks | working | `app/photo-orbit.tsx`, `app/category-stacks.tsx`, `app/style.css:242-253` |
| Hybrid search | **absent** — client-side `.includes()` | `app/library.tsx:145-153` |
| Quality metrics (sharpness, exposure) | **absent** | `lib/derive.ts` returns only `work, thumb, bits, pixels` |
| OCR / document fields | **absent** | no column, no deep-pass tier |
| Events / trips | **absent** | no table |
| Per-user editable categories | **absent** — hardcoded array | `lib/categories.ts:1-9` |
| Virtualised grid | **absent** — `@tanstack/react-virtual` installed, never imported | `package.json:21` |

### Two defects that set the build order

**D1 — the library query does not scale.** `lib/library.ts:5` selects every row for the owner
including `pixels` (a base64 128×128 greyscale buffer, ~16KB per row) and `phash`, strips them
in JS, and returns every item to the browser. `app/library.tsx:145` then filters that array
with `String.includes`. At the 50,000-item target named in `MASTER_PROMPT.md` §5 and §10 that
is roughly 800MB of database reads per refresh and a 50,000-element client array.

**D2 — duplicate groups are recomputed on every request.** `lib/library.ts:6` calls
`duplicateGroups()` over all rows per load. The grouping logic is correct and tested; it is the
lack of persistence that blocks powers 3 and 4, which need stable group ids, a keeper the user
can change, and a `bytes_reclaimable` figure that does not drift between requests.

Both are fixed in Slice 0. No later slice is attempted before they are.

## Architecture

### Rendering: hybrid, with the DOM as the source of truth

Two renderers, with a hard boundary and a clear rule for which is which.

Components stay flat in `app/`, which is the existing convention (`library.tsx`, `photos.tsx`,
`category-stacks.tsx`, `photo-orbit.tsx`). `app/page.tsx` is already the server shell — it does
the auth check and renders `<Library/>` — so it stays as-is rather than being replaced by a
route group, which would collide with it at `/`.

```
app/
  page.tsx              server shell, unchanged: auth + sign-in screen
  library.tsx           client shell, slimmed to composition + shared state
  import-panel.tsx      client island, the upload flow lifted out of library.tsx
  browse-tabs.tsx       client island, browse axes
  search-bar.tsx        client island, query + category filter
  media-grid.tsx        client island, virtualised DOM grid
  three/
    scene.tsx           <Scene3D fallback> gatekeeper — the only 3D/no-3D decision
    atlas.ts            thumb -> DataArrayTexture packing, LRU
    camera-rig.ts       useCameraRig: damped focus(target)
    clusters.tsx        Slice 1 surface
    flythrough.tsx      Slice 2 surface
    ribbon.tsx          Slice 4 surface
```

`app/three/` contains no `page.tsx`, so it creates no route.

Nothing under `app/three/` is ever statically imported. Each surface is reached through
`next/dynamic(() => import("../three/clusters"), { ssr: false })`, so the grid route's bundle
is unchanged and a phone that never opens a 3D surface never downloads one.

**The DOM view is the real implementation.** For every 3D surface there is a DOM/CSS twin that
is keyboard-navigable, screen-reader-correct, and feature-complete. The canvas is
`aria-hidden="true"` and accompanied by a visible "Switch to list view" control. This is how
`MASTER_PROMPT.md` §9.8 (accessibility is not phase 5) is satisfied without arguing about it,
and it means a WebGL bug degrades the product instead of breaking it.

### The gatekeeper

`<Scene3D fallback={...}>` is the single place that decides. In order:

1. `prefers-reduced-motion: reduce` → fallback, always, no override.
2. `?flat=1` in the URL → fallback. (Also the escape hatch for support.)
3. No WebGL2 context, or `navigator.hardwareConcurrency <= 4`, or viewport width < 900px →
   fallback.
4. Otherwise → canvas, with the fallback still in the DOM for assistive technology.

Decision 3 implements the chosen posture: desktop-first, mobile degrades. `MASTER_PROMPT.md`
§2 says users are on a phone half the time, so the phone path must stay fully functional —
it simply stays DOM.

### Textures

This is the detail that decides whether the 3D surfaces work at realistic sizes. Thumbs
already exist at 256×256 JPEG behind `/api/thumb/:id` (authenticated, per §9.4). For a surface:

- Fetch thumbs for visible ids, decode via `createImageBitmap`, pack into a
  `THREE.DataArrayTexture` of 256×256 layers.
- Draw one `InstancedMesh` per surface; per-instance attributes carry atlas layer index,
  position, and a dim/highlight factor. 10,000 tiles is one draw call.
- Keep at most 2,048 layers resident, LRU-evicting the rest. Evicted instances render a flat
  tint until their layer is re-uploaded. The currently focused item is pinned and is never
  evicted, whatever its recency.
- Upload in `requestIdleCallback` batches so a large scene fades in rather than janking.

`ponytail: one shared atlas format for all three surfaces, sized for 256px thumbs. If a
surface later needs the 1600px working copy (full-screen inspect in the flythrough), add a
second single-layer texture for the focused item only — do not widen the atlas.`

### Camera

Each surface exposes `focus(target)`. A single `useCameraRig` hook does critically-damped
interpolation toward the target position and look-at. No per-surface tween code, and one place
to change feel. Reduced-motion never reaches the rig, since the gatekeeper already excluded it.

## Slices

Each slice ends deployed and usable, per `MASTER_PROMPT.md` §10. Import must never be broken
on main.

These five slices are five independent subsystems and do not belong in one implementation
plan. This spec is the architecture they share; **Slice 0 is planned and built first, on its
own**, because D1 and D2 block every other slice. Slices 1–4 each get their own plan, written
against this spec once the slice before it is deployed.

### Slice 0 — Foundation

No new user-facing feature. Everything later depends on it.

- Split `app/library.tsx` (346 lines, currently import flow + search + filtering + grid +
  duplicate review + export + account deletion) into the server shell and client islands shown
  above. Behaviour is preserved; this is decomposition, not redesign.
- `/api/library` becomes keyset-paginated: `?cursor=&limit=200&tab=&category=&q=`, ordered by
  `(taken_at desc nulls last, id)`. Display queries select only display columns — never
  `pixels` or `phash`. Fixes **D1**.
- `media-grid.tsx` uses `@tanstack/react-virtual`, already a dependency.
- New `analysis` table, one row per media item, keeping `media` lean:
  `media_id pk, sharpness real, exposure jsonb, ocr_text text, doc jsonb, embedding vector(1536),
  burst_key text, event_id uuid`.
- New `dupe_groups` table: `id, owner, kind('exact'|'near'), keeper_id, member_ids uuid[],
  bytes_reclaimable bigint, unknown_sizes int`. Written once after dedupe, updated when the
  user changes a keeper. Fixes **D2**. `lib/duplicates.ts` keeps its current signature and
  tests; only its call site and persistence change.
- New `categories` table: `owner, key, kind, label, emoji, rule, sort_order`, seeded per user
  from the current `lib/categories.ts` array. `safeCategory()` keeps its kind-safety contract
  (§3, §11.2) but reads the user's rows.
- `derive()` additionally returns `sharpness` (variance of the Laplacian response) and
  `exposure` (256-bucket luma histogram, stored as percentiles plus clipping fractions). Both
  are computed in JS from one new 512×512 greyscale raw pass over the working copy — the
  existing 128×128 `pixels` buffer is too soft to separate blur reliably, and `sharp.convolve`
  clamps the negative half of the Laplacian to zero. That is one additional `sharp()` call
  alongside the four `derive()` already makes.

Done means: the grid renders 50,000 fixture rows at 60fps, the library endpoint returns in
under 200ms at that size, and `npm test` passes unchanged.

### Slice 1 — Reclaim space and best-of culling (powers 3, 4)

- **Junk detection** from the new metrics: below a sharpness floor, exposure clipped past a
  threshold, and screenshots older than a year. Thresholds live in one module with the fixture
  numbers that justify them.
  - Hard constraint: video placeholder thumbs must never be grouped or flagged
    (`MASTER_PROMPT.md` §7.2). Placeholders are excluded by `kind` before any grouping.
- **Burst grouping**: same camera, gaps under 2s, at least 3 frames → one burst. Rank members
  by sharpness then exposure, propose the top as keeper. Rejects stay visible, never hidden
  (§8.4).
- **3D surface: cluster scene.** Each duplicate group and burst is a cluster of instanced
  planes arranged in depth. The keeper sits forward and lit; rejects recede and dim. The camera
  dollies between clusters; clicking a reject promotes it to keeper, which writes
  `dupe_groups.keeper_id` and recomputes `bytes_reclaimable`.
- The reclaimed total, the counts, and all controls are DOM overlay, not in the canvas.
- **Worklist export**: CSV of items proposed for deletion, with group id and keeper marked.
  Writes an `audit_log` row (§8.8). The screen states plainly that Shoebox deletes nothing in
  Google Photos and the user executes the list (§9.1).

Done means: a stranger opens Reclaim, sees a GB figure, changes one keeper, sees the figure
change, and exports the list.

### Slice 2 — Ask your library (power 2)

- Embed `caption + tags + ocr_text` into `analysis.embedding` through the AI Gateway, counted
  against the existing budget guard in `lib/import-cost.ts`.
- Indexes: HNSW on `analysis.embedding`, GIN on
  `to_tsvector(coalesce(caption,'') || tags || coalesce(ocr_text,''))`.
- **Query parser**, a pure function: extract date ranges ("2026", "last summer", "March"),
  category names, and kind words from the query string; the remainder is the semantic text.
  Parsed filters become SQL predicates, not prompt text.
- **Hybrid ranking**: pgvector cosine and Postgres full-text run as two ranked lists, fused by
  reciprocal rank. Budget: under 400ms at 50,000 items, asserted in a test with a timer, not
  assumed.
- **3D surface: search flythrough.** Matches fly in from depth ordered by fused rank, highest
  nearest. Non-matches dim and drift back rather than disappearing, so the user sees the
  library respond rather than reload. Clicking an item focuses the camera and loads the 1600px
  working copy for the focused item only.
- DOM twin: the existing grid, re-ordered by rank, with the same filters as chips.

`ponytail: text embeddings over captions, not multimodal — purely visual queries ("blurry
orange sunsets") will degrade. The schema already holds the vector; swap in an image embedding
model when search quality is the complaint.` (Carried from `MASTER_PROMPT.md` §7.6.)

Done means: the known receipt fixture is findable by its vendor name (§11.6), and
"hotel receipts from 2026" parses to text `hotel`, category `Receipts`, year `2026`.

### Slice 3 — Receipt and document intelligence (power 5)

**No 3D on this slice, deliberately.** The output is a table of vendors and amounts; depth adds
nothing and costs legibility.

- Deep-pass tier (§7.5): only items whose sheet-label `flags` contain
  `document|receipt|ticket|id|whiteboard` get a single-image OCR plus field-extraction call.
  Everything else stops at tier 1. This two-tier split is the cost design and is not optional.
- Strict Zod schema on the response → `analysis.doc` (`vendor, doc_date, total, currency,
  doc_type`) and `analysis.ocr_text`. Malformed output degrades the item to `needs_review`;
  it never crashes the job (§9.7, §11.5).
- Deep-pass spend is estimated and capped by the same monthly ceiling as labelling. A deep pass
  that would exceed the ceiling does not start, and says so (§11.8).
- Documents tab: sortable, filterable table with a CSV export. Sums shown per filter, e.g.
  "Every hotel receipt in 2026: ₹184,300 across 11 stays."

### Slice 4 — Trips and stories (power 6)

- Event clustering: a new event after a gap over 6 hours with at least 8 items, merging events
  within 36 hours (§7.7). Stored in an `events` table; members carry `analysis.event_id`.
- Title and a one-paragraph recap generated from member captions, Zod-validated.
- **3D surface: timeline ribbon.** Events sit as covers along a curved ribbon receding into
  depth; scrolling drives camera travel along it. Date ranges and counts are DOM overlay.
- Geo appears only where `geo_source='sidecar'` (§1.4). An inferred place is never drawn as a
  pin and is labelled a guess wherever it appears.
- Share pages: read-only, expiring, revocable, off by default (§8.6, §9.4). Each share writes
  an `audit_log` row.

## Error handling and degradation

Carried from `MASTER_PROMPT.md` §9.7, extended to the new surfaces:

- No WebGL2, lost context, or a shader compile failure → the gatekeeper's fallback renders and
  a one-line plain-language notice appears. No stack traces (§3, plain-language status).
- Thumb fetch failure inside a scene → that instance renders a flat tint; the scene continues.
- No embedding model → search falls back to full-text alone, and says it is doing so.
- No OCR model → documents keep their tier-1 category and caption; the Documents tab shows what
  it has.
- A single unreadable item is one error row, never a dead job.

## Testing

Following the existing style: `node --test` over fixtures in `tests/`, asserting logic rather
than pixels.

| Test | Asserts |
|---|---|
| quality metrics | a known-blurry fixture scores below a known-sharp one, with the recorded numbers |
| junk detection | video placeholder thumbs are never flagged or grouped (§7.2 trap) |
| burst grouping | 5 frames 1s apart form one burst; the same scene 10 min apart forms two |
| keeper change | promoting a reject updates `keeper_id` and recomputes `bytes_reclaimable` |
| keyset pagination | walking all pages yields every row exactly once, no gaps, no repeats |
| query parser | "hotel receipts from 2026" → text `hotel`, category `Receipts`, year 2026 |
| search recall | the known receipt fixture is found by vendor name (§11.6) |
| search latency | fused query over a 50k-row fixture returns under 400ms |
| doc extraction | truncated JSON, extra prose, unknown and missing ids all degrade to `needs_review` (§11.5) |
| cost guard | a deep pass over the monthly ceiling does not start and reports why (§11.8) |
| event clustering | a >6h gap splits; events within 36h merge |
| gatekeeper | reduced-motion, no-WebGL2, low-core and narrow-viewport inputs each return the fallback |
| atlas LRU | exceeding the resident cap evicts least-recently-used layers and never evicts a focused item |

The gatekeeper and the atlas are written as pure functions precisely so they can be tested in
Node with no GPU. The existing eight checks in `MASTER_PROMPT.md` §11 continue to pass
unchanged; Slice 0 must not alter their results.

## Dependencies

Added: `three`, `@react-three/fiber`, `@react-three/drei`. Justification, per
`MASTER_PROMPT.md` §5 ("if one of these starts looking necessary, say why in one line"):
instanced rendering of 10,000 textured planes with a damped camera is not reachable with CSS
transforms, and the three surfaces that need it carry the product's reason to exist.

Budget: the R3F chunk stays at or under 180KB gzipped and loads only on a 3D surface. The grid
route's bundle must not grow at all — measured in CI, not asserted in prose.

Still deliberately absent (§5): Redis, a dedicated vector DB, Prisma, a client state manager,
an upload widget, a Python service, Docker.

## Open decisions deferred on purpose

- Embedding model and dimension are pinned at Slice 2 from what the Gateway actually offers;
  the `vector(1536)` in Slice 0 is sized for the common case and migrated if it differs.
- Post-processing (bloom, depth of field) is not in this spec. Revisit only after all three
  surfaces hold 60fps without it.
