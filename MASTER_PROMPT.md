# MASTER PROMPT — "Shoebox": a Google-connected AI photo brain

Paste everything below the line into Claude Code (or any coding agent) in an empty repo.
Rename `Shoebox` to whatever you want before pasting.

---

## 0. Mission

Build **Shoebox**, a web app where a person signs in with Google, hands over photos from
their Google Photos library, and gets back something far more useful than folders: a
searchable, de-duplicated, culled, OCR'd, trip-grouped library they can ask questions of in
plain language, and a concrete worklist of what to delete to reclaim storage.

Sorting into categories is table stakes — one feature out of eight. The product's reason to
exist is **"I can finally find anything, and I just got 14 GB back."**

Reference implementation to learn from, not copy: `https://github.com/sukralia/claude-photo-sorter`
(local Python + Claude Code CLI, folder-in → folders-out). Keep its good ideas (§3), drop its
architecture (§4).

---

## 1. HARD PLATFORM CONSTRAINTS — read this before designing anything

These are verified against Google's docs (checked 2026-11-25). Do not design around what you
remember about the Google Photos API; it changed. Getting this wrong invalidates the product.

1. **You cannot read a user's Google Photos library.** The `photoslibrary.readonly`,
   `photoslibrary.sharing` and `photoslibrary` scopes were **removed on 31 March 2025**.
   Any call using them now returns `403 PERMISSION_DENIED`. There is no partner tier, no
   workaround, no "request access" form that restores them for a general app.

2. **The only sanctioned path in is the Google Photos Picker API.**
   Scope: `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
   Flow: `sessions.create` → get `pickerUri` → send the user there (append `/autoclose` for
   web) → poll `sessions.get` until `mediaItemsSet === true` → `GET
   https://photospicker.googleapis.com/v1/mediaItems?sessionId=…` (paginate via
   `nextPageToken`). The user picks inside Google's own UI — they can select a whole album at
   once, so large imports are possible, but **the app never browses the library itself.**

3. **`baseUrl` lives 60 minutes and needs the Bearer token.** Picker `baseUrl`s expire after
   60 min (sooner if consent is revoked) and require the OAuth header — they are not public
   image URLs. Therefore: **during the session you must download and persist your own
   derivatives.** Store a 256px square thumb + a ~1600px working copy. After that window the
   bytes are gone unless the user re-picks. Design the ingest worker to finish inside the
   window and to re-request a session if it doesn't.

4. **Downloaded bytes have no GPS.** `baseUrl=d` returns EXIF *minus* location metadata, and
   `PickedMediaItem` metadata gives you `creationTime`, `mimeType`, width/height, camera
   make/model — **not** coordinates. So: time-based trip clustering works, true map pins do
   not. Get location only from (a) vision-inferred landmarks, labelled as a guess, or (b) a
   Google Takeout import, where the `.json` sidecars *do* carry `geoData`. Never show an
   inferred place as if it were a GPS fact.

5. **You cannot write sorted albums back into Google Photos.**
   `photoslibrary.appendonly` + `photoslibrary.edit.appcreateddata` only let you create albums
   and organise **media your app itself uploaded**. Existing library photos can never be added
   to an app-created album. Re-uploading to "write back" would duplicate the user's library —
   **forbidden, do not build it.** Outputs are: smart albums inside Shoebox, export to Google
   Drive, ZIP download, CSV/JSON manifest, and a delete-worklist the user executes themselves.

6. **Google Photos API apps require OAuth verification review** (plus Photos partner review).
   Plan for an unverified-app testing phase: build a working **Takeout / folder / drag-drop
   importer first**, so the product is fully demoable before any Google review clears.

7. **Google Drive is the loophole worth using.** Drive's read and write scopes are intact.
   Many people's photos live in Drive, and Drive is where sorted output can actually be
   written. Use `drive.file` (app-created files) for export; request read access only if the
   user asks to import from Drive.

### Consequence — the four ingest routes, all mapping to one internal pipeline

| Route | Scope / mechanism | Status |
|---|---|---|
| Google Photos Picker | `photospicker.mediaitems.readonly` | primary, post-verification |
| Google Takeout zip | file upload, reads `.json` sidecars (GPS!) | build first, no review needed |
| Local folder / drag-drop | browser `File`/`webkitdirectory` | build first |
| Google Drive folder | `drive.readonly` (optional, incremental consent) | phase 3 |

Ingest normalises all four into the same `media_items` rows. Everything downstream is
source-agnostic.

---

## 2. Who this is for

Someone with 8,000–60,000 photos who has given up. Non-technical. On a phone half the time.
They do not care about categories; they care about *finding the receipt*, *deleting the junk*,
and *seeing the trip again*. Every screen must make sense to a person who has never heard the
word "embedding".

---

## 3. Keep these ideas from the reference repo

- **Contact-sheet batching.** Tile ~24–30 thumbnails into one JPEG with each tile stamped with
  its id, then ask one vision call to label the whole sheet. This is a ~25× cost reduction vs
  per-image calls and it is the single most important technique to carry over.
- **Two-tier duplicate detection.** Exact (content hash) + perceptual hash near-match, **with
  the pixel-diff guard**: screenshots of the same app have near-identical perceptual hashes,
  so for PNG/screenshot pairs additionally require >0.4% of preview pixels to differ before
  calling them distinct. Skipping this guard makes every settings screenshot a "duplicate".
- **Never touch originals.** Read-only, always, no exceptions.
- **Resumable batches.** Persist each batch's result so an interrupted job resumes instead of
  restarting.
- **Editable categories with natural-language rules.** The category list is data
  (`key, kind, label, emoji, rule`), the `rule` string is what the model reads, and the user
  can rename/add/describe categories. Keep one photo and one video catch-all.
- **Type safety between media kinds.** A video must land in a video category, a photo in a
  photo category; coerce violations to the catch-all rather than trusting the model.
- **Plain-language status.** "Shoebox needs a short break" beats a stack trace.

## 4. Drop these

Local Python scripts, the `claude -p` CLI subprocess fan-out, the `127.0.0.1` dashboard, the
APFS-clone copy step, filesystem folders as the primary output, and `work/*.json` as the
database. All replaced by §5.

---

## 5. Stack — these are decisions, not options

The reference repo's stack is **Python 3.9+ / Pillow / imagehash / `http.server` / vanilla JS**,
with the `claude` CLI shelled out to as the model runtime. None of it survives the move to a
multi-user web app. Shoebox's stack:

| Layer | Choice | Package(s) | Why this and not the alternative |
|---|---|---|---|
| Framework | Next.js 16, App Router, TypeScript | `next`, `react`, `typescript` | Server Components + Server Actions means no separate API layer to maintain |
| Runtime | Vercel, Fluid Compute, Node 24 | — | 300s timeouts and instance reuse suit batch image work; **no Edge-only code** |
| Auth | Auth.js v5, Google provider | `next-auth` (v5) | One config file; `openid email profile` at sign-in, Photos/Drive scopes requested **incrementally** at Import with a one-line reason. Refresh tokens encrypted, revocation handled |
| Database | Postgres + `pgvector` (Neon via Vercel Marketplace) | `drizzle-orm`, `@neondatabase/serverless` | One store for rows, full-text **and** vectors. Drizzle for typed queries + migrations |
| Object storage | Vercel Blob, **private** | `@vercel/blob` | Thumbs + 1600px working copies only. **Never store originals** — they stay in Google Photos; we keep derivatives and metadata |
| Background jobs | `jobs` table + Vercel Queues | check the current Queues package; **fall back to the `jobs` table drained by a cron Function** if it isn't available on this account | Queues is public beta — the table is the source of truth either way, so the fallback costs nothing |
| Progress to UI | SSE from a Route Handler reading the job row | — | Polling 50k-item imports is wasteful; WebSockets are overkill for one-way progress |
| Models | Vercel AI Gateway, plain `"provider/model"` strings | `ai` (AI SDK v6) | Vision labelling on `"anthropic/claude-sonnet-5"`; escalate hard batches, never downgrade. One text-embedding model for search. **No provider SDKs wired directly** — the Gateway gives failover and spend tracking for free |
| Model output validation | Zod schemas on every model response | `zod` | §7.4 and §11.5 depend on this: malformed JSON must degrade, not crash |
| Image processing | `sharp` | `sharp` | Thumbs, working copies, contact-sheet composition, sharpness/exposure metrics, pHash/dHash. Not ImageMagick, not a Python sidecar |
| UI | Tailwind v4 + shadcn/ui | `tailwindcss`, shadcn CLI, `lucide-react` | Dark mode from day one |
| Large grids | Virtualised list | `@tanstack/react-virtual` | Assume 50,000 tiles; a plain `.map()` will not survive |
| Local file ingest | Native `<input type="file" webkitdirectory multiple>` | — | No upload library needed for Phase 1 |

**Deliberately absent, don't add them:** Redis, a dedicated vector DB (Pinecone/Weaviate/
Qdrant), Prisma, a client state manager (Redux/Zustand), an upload widget, a Python service,
Docker, and any ORM-adjacent codegen step. If one of these starts looking necessary, say why
in one line before installing it.

Pin exact versions at scaffold time from what `npm` actually resolves — do not trust version
numbers written in this document.

---

## 6. Data model (start here, migrate as needed)

```
users            id, google_sub, email, name, created_at, deleted_at
connections      id, user_id, provider, scopes[], refresh_token_enc, revoked_at
imports          id, user_id, source('picker'|'takeout'|'local'|'drive'), session_id,
                 item_count, state, started_at, finished_at
media_items      id, user_id, import_id, google_media_id, filename, mime, kind('photo'|'video'),
                 bytes, width, height, duration_s, taken_at, camera, content_hash, phash,
                 thumb_url, work_url, geo(nullable), geo_source('sidecar'|'inferred'|null),
                 state, error
labels           media_id, category_key, confidence, source('model'|'user'|'rule'), created_at
analysis         media_id, caption, tags[], ocr_text, quality jsonb(sharpness, exposure,
                 eyes_closed, duplicate_of_best), doc jsonb(vendor, doc_date, total, currency,
                 doc_type), embedding vector(…)
dupe_groups      id, user_id, kind('exact'|'near'), keeper_id, member_ids[], bytes_reclaimable
events           id, user_id, trip/story grouping: title, start, end, member_ids[], cover_id
categories       user_id, key, kind, label, emoji, rule, sort_order   -- per-user, seeded
audit_log        user_id, action, detail, at    -- every export, delete-list, scope grant
```

Index: `media_items(user_id, taken_at)`, HNSW on `analysis.embedding`, GIN on
`to_tsvector(caption || ocr_text || tags)`.

---

## 7. The pipeline

```
import → fetch (60-min window!) → derive → fingerprint → dedupe
      → sheet-label (cheap, all items) → deep-pass (expensive, selective)
      → embed → cluster → present
```

1. **fetch** — stream each picked item via `baseUrl` with the Bearer token. Concurrency ~8,
   retry with backoff, never block the whole import on one bad item (mark `state='error'`,
   keep the row). Persist `=w256-h256-c` thumb and `=w1600` working copy to Blob immediately.
2. **derive** — `sharp`: content hash, pHash, sharpness (variance of Laplacian), exposure
   histogram. Videos: thumbnail from the first readable frame; if no frame decoder is
   available, a placeholder — and **never let identical placeholders become a duplicate
   group**.
3. **dedupe** — exact by content hash; near by pHash Hamming distance ≤ 4 within the same
   `kind`, plus the screenshot pixel-diff guard. Keeper = largest bytes, then shortest
   filename. Nothing is deleted — groups are *proposals*.
4. **sheet-label** — contact sheets of 24 stamped tiles, 3 sheets per request, 4 requests in
   flight. One JSON object back per request: `{id: {category, caption, tags[], flags[]}}`.
   Validate every id, enforce kind-matching, retry a sheet up to 3× then mark its items
   `needs_review` — never silently drop them. Persist per-batch for resume.
5. **deep-pass — the selective expensive tier.** Only for items where accuracy pays:
   `flags` containing `document|receipt|ticket|id|whiteboard` get a single-image OCR +
   field-extraction call (vendor, date, total, currency, doc type) with a strict schema.
   Everything else stops at tier 1. This two-tier split is the core cost design.
6. **embed** — embed `caption + tags + ocr_text` into `analysis.embedding`.
   `ponytail: text-embedding over captions, not true multimodal — purely visual queries
   ("blurry orange sunsets") will degrade; swap in a multimodal image embedding when search
   quality is the complaint, the schema already holds it.`
7. **cluster** — trips/stories from gaps in `taken_at` (new event after a >6h gap with ≥8
   items, merged within 36h), titled by the model from member captions. Add geo only when
   `geo_source='sidecar'`.

**Cost guard, non-negotiable:** estimate before every job (`items / 72` requests × unit cost),
show the number, and hard-stop at a per-user monthly ceiling set in env. Log actual spend per
job. A runaway import must be impossible, not merely unlikely.

---

## 8. The eight powers (this is the product)

1. **Smart sort** — editable categories, every item placed, kind-safe, one-click correction
   that re-trains nothing but is remembered as `source='user'` and always wins.
2. **Ask your library** — a search box that takes "the hotel receipt from Bangkok", "Mum at
   the beach", "screenshots about taxes". Hybrid: pgvector cosine + Postgres full-text over
   caption/tags/OCR, time and category filters parsed out of the query. Results in <400ms.
3. **Reclaim space** — duplicate groups and junk (blurry, dark, failed shots, year-old
   screenshots, memes) presented as *"Delete these 2,140 items → 14.2 GB back"*, with a
   reviewable grid, keeper marked, and an exportable list. **Shoebox never deletes anything in
   Google Photos.** It hands over a worklist + a CSV; the user executes it. Say so plainly on
   the screen.
4. **Best-of culling** — within a burst, rank by sharpness/exposure/eyes-open and propose one
   keeper. The single most-loved feature in every photo tool ever built. Keep the rejects
   visible, never hidden.
5. **Receipt & document intelligence** — the deep-pass output becomes a real table: vendor,
   date, amount, type. Filterable, sortable, exportable to CSV. *"Every hotel receipt in 2026:
   ₹184,300 across 11 stays."* This is the feature that makes a photo sorter feel like a tool
   instead of a toy.
6. **Trips & stories** — auto-grouped events with a cover, a count, a date range, a generated
   one-paragraph recap, and a shareable read-only page (expiring link, off by default).
7. **Browse axes** — timeline, categories, trips, documents, duplicates. Four tabs, not a
   sidebar of thirty.
8. **Export** — to a Google Drive folder tree (`drive.file`), a ZIP, or `manifest.csv` +
   `manifest.json` mirroring the sorted structure. Export writes an `audit_log` row.

**Deferred on purpose: face recognition.** It is the obvious ninth power and it is a legal
minefield (biometric data under GDPR Art. 9, Illinois BIPA, Texas CUBI). Ship without it.
When you do build it: opt-in per user with an explicit consent screen, embeddings deletable
independently, no cross-user matching ever, region-gated. Put it behind a flag and leave the
schema room.

---

## 9. Non-negotiables

1. **Originals are read-only.** Shoebox never deletes, moves, or modifies anything in Google
   Photos, Drive, or on disk. Every destructive-looking feature produces a *proposal* the user
   executes. This is the trust the whole product rests on; it is not negotiable for any feature.
2. **No re-uploading to Google Photos.** Ever. (See §1.5.)
3. **Derivatives only, with a real delete.** "Delete my data" removes Blob objects, rows, and
   tokens, within one request, and says what it removed. Build it in phase 1, not phase 5.
4. **Private by default.** No public bucket URLs. Thumbs served through an authenticated route
   or signed short-lived URL. Share links are explicit, expiring, and revocable.
5. **Incremental scopes with honest copy.** Never request Photos or Drive at sign-in. Each
   request states what it reads and why, in one sentence a non-developer understands.
6. **Costs are visible and capped.** §7.
7. **Degrade, never fail.** No vision model → categories unknown but import still works. No
   video decoder → placeholder thumbs. One unreadable file → one error row, not a dead job.
8. **Accessibility is not phase 5.** Keyboard-navigable grid, focus states, alt text from
   captions, respects `prefers-reduced-motion`, contrast ≥ 4.5:1.

---

## 10. Build order

**Phase 1 — the vertical slice. Ship this before anything else.**
Google sign-in → drag-drop or Takeout-zip import of ~500 items → derive, dedupe, sheet-label →
grid UI by category with a working search box → duplicate review with a space-reclaimed number
→ CSV export → delete-my-data. Deployed on Vercel, working on a phone.
*Done means: a stranger signs in, imports a folder, searches "receipt", finds one, and sees a
GB number — with no terminal and no instructions.*

**Phase 2 — Google Photos Picker.** Picker session flow, the 60-minute fetch window, resumable
imports, OAuth verification submission started.

**Phase 3 — the powers.** Deep-pass documents + the document table, best-of culling, trips &
stories, Drive export, share pages.

**Phase 4 — polish & scale.** 50k-item virtualised grid, incremental re-import, background
re-analysis when categories change, cost dashboard, optional faces behind a flag.

Each phase ends deployed and usable. Never leave the main branch in a state where import is
broken.

---

## 11. Acceptance checks — write these as you build, not after

Not a test suite for its own sake; the smallest set that fails loudly if the logic breaks.

1. **Dedupe:** a fixture of 10 images — 2 byte-identical, 2 resized copies, 2 near-identical
   app screenshots that are *genuinely different screens* — yields exactly 2 groups and does
   **not** group the screenshots.
2. **Kind safety:** a label response putting a video in a photo category coerces to the video
   catch-all and records `source='model'` + a review flag.
3. **Batch resume:** kill the worker mid-import; restarting completes without re-labelling
   finished batches and without losing items.
4. **Expiry:** a `baseUrl` older than 60 minutes produces a clean "re-pick needed" state, not
   a 403 loop.
5. **Malformed model output:** truncated JSON, extra prose, unknown ids, missing ids — none
   crash the job; missing ids end as `needs_review`.
6. **Search:** a known receipt image is findable by its vendor name after ingest.
7. **Delete-my-data:** afterwards, zero rows and zero blobs for that user. Assert it.
8. **Cost guard:** an import exceeding the ceiling stops before spending, with a clear message.

---

## 12. How to work

- **Decide, don't ask.** Pick sensible defaults for anything not specified here and note the
  choice in one line. Only stop for: Google Cloud credentials, a Vercel/DB provisioning
  decision that costs money, or a product change that contradicts §1 or §9.
- **Smallest thing that works.** Reach for Postgres before a new service, `sharp` before a new
  dependency, a native `<input type="file" webkitdirectory>` before an upload library. No
  abstraction with one implementation. No config for a value that never changes.
- **Mark deliberate shortcuts** with a `ponytail:` comment naming the ceiling and the upgrade
  path, like the embedding note in §7.6.
- **Read before you write.** When a change touches the pipeline, trace the whole path first —
  a small diff in the wrong stage is a second bug.
- **Report honestly.** If a phase check fails, say so with the output. Never claim a phase is
  done because the code compiles.

Start with Phase 1. Scaffold the Next.js app, wire Google sign-in, and get one real folder of
photos into the grid before building anything in §8 beyond power 1.
