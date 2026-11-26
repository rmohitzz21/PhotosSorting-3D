"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Files, Folder, Images, Copy, HardDrive } from "lucide-react";
import PhotoGlobe, { type GlobePhoto } from "./photo-globe";
import { categories } from "../lib/categories";

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
    [folders, setFolders] = useState<{ name: string; count: number }[]>([]),
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
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(
    async (next: string | null) => {
      if (next && pending.current) return;
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      try {
        const params = new URLSearchParams({ limit: "200", tab });
        if (next) params.set("cursor", next);
        if (query.trim()) params.set("q", query.trim());
        if (category !== "All categories") params.set("category", category);
        const data = await json(
          await fetch("/api/library?" + params, {
            cache: "no-store",
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        setItems((previous) =>
          next ? [...previous, ...data.items] : data.items,
        );
        if (data.folders) setFolders(data.folders);
        setGroups(data.groups);
        // Only the first page carries a total; later pages leave it alone.
        if (data.total !== null) setTotal(data.total);
        setCursor(data.nextCursor);
      } catch (e) {
        if (!controller.signal.aborted)
          setStatus(e instanceof Error ? e.message : String(e));
      } finally {
        if (pending.current === controller) pending.current = null;
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

  const [sphere, setSphere] = useState<GlobePhoto[]>([]);
  const loadSphere = useCallback(async () => {
    try {
      const data = await json(
        await fetch("/api/library?view=sphere", { cache: "no-store" }),
      );
      setSphere(data.photos);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void loadSphere();
  }, [loadSphere]);
  const refresh = useCallback(async () => {
    await Promise.all([load(null), loadSphere()]);
  }, [load, loadSphere]);
  const loadMore = useCallback(() => {
    if (cursor) void load(cursor);
  }, [cursor, load]);
  const members = new Map<string, string>();
  for (const group of groups) {
    members.set(group.keeperId, "Keeper");
    for (const id of group.memberIds)
      if (id !== group.keeperId) members.set(id, "Extra copy");
  }
  const reclaim = groups.reduce(
    (sum, g) => sum + Number(g.bytesReclaimable),
    0,
  );

  return (
    <main
      className="organizer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload.current?.(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="title">
        <div>
          <h1>Sorting my camera roll</h1>
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
      <dl className="camera-stats">
        {Object.entries({
          "Files checked": total,
          Photos:
            total - (folders.find((f) => f.name === "Videos")?.count ?? 0),
          Videos: folders.find((f) => f.name === "Videos")?.count ?? 0,
          Folders: folders.length,
          Duplicates: groups.reduce((n, g) => n + g.memberIds.length - 1, 0),
          Reclaimable:
            (reclaim / 1e6).toLocaleString(undefined, {
              maximumFractionDigits: 1,
            }) + " MB",
        }).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="camera-board">
        <aside className="camera-folders">
          <h2>Photos</h2>
          <div className="camera-cards">
            {categories
              .filter((c) => c !== "Videos")
              .map((c) => (
                <button
                  key={c}
                  aria-pressed={c === category}
                  onClick={() => {
                    setTab("all");
                    setCategory(category === c ? "All categories" : c);
                  }}
                >
                  <strong>
                    <Folder />
                    {c}
                  </strong>
                  <span className="folder-film">
                    {Array.from({ length: 4 }, (_, i) => {
                      const photo = sphere.filter((p) => p.category === c)[i];
                      return photo ? (
                        <img key={i} alt="" src={"/api/thumb/" + photo.id} />
                      ) : (
                        <i key={i} />
                      );
                    })}
                  </span>
                </button>
              ))}
          </div>
        </aside>
        <PhotoGlobe photos={sphere} />
        <aside className="camera-folders">
          <h2>Videos</h2>
          <div className="camera-cards right-cards">
            <button
              aria-pressed={category === "Videos"}
              onClick={() => {
                setTab("all");
                setCategory(
                  category === "Videos" ? "All categories" : "Videos",
                );
              }}
            >
              <strong>
                <Folder />
                Videos
              </strong>
              <small>
                {folders.find((f) => f.name === "Videos")?.count ?? 0} items
              </small>
            </button>
            <button
              aria-pressed={tab === "duplicates"}
              onClick={() => {
                setCategory("All categories");
                setTab(tab === "duplicates" ? "all" : "duplicates");
              }}
            >
              <strong>
                <Copy />
                Duplicates
              </strong>
              <small>{groups.length} groups</small>
            </button>
          </div>
        </aside>
        <div className="camera-status" role="status">
          <span className={busy ? "active-dot" : "ready-dot"} />
          {status ||
            (busy
              ? "Processing photos…"
              : total
                ? "Library ready"
                : "Waiting for photos")}
        </div>
      </div>
      <details className="google-import">
        <summary>Import from Google Photos</summary>
        <Photos onImported={refresh} />
      </details>
      <div>
        <div className="organizer-results">
          {" "}
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
                  await refresh();
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
        </div>
      </div>
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
