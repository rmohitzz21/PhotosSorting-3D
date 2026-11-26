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
            {unknownSizes && "Google Photos does not report original sizes. "}
            Review the extra copies and export your list. You decide which
            originals to delete.
          </p>
        </section>
      )}
    </>
  );
}
