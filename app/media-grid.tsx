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
