"use client";
import { useEffect, useState } from "react";
type Photo = {
  id: string;
  preview: boolean;
  filename: string;
  caption: string;
};
export default function PhotoOrbit({
  photos,
  total,
  loadMore,
}: {
  photos: Photo[];
  total: number;
  loadMore?: () => void;
}) {
  const [index, move] = useState(0),
    [playing, play] = useState(false);
  const count = photos.length,
    active = count ? index % count : 0;
  useEffect(() => {
    const policy = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => play(!policy.matches);
    sync();
    policy.addEventListener("change", sync);
    return () => policy.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!playing || count < 2) return;
    const timer = setInterval(
      () =>
        move((i) => (loadMore ? Math.min(i + 1, count - 1) : (i + 1) % count)),
      2600,
    );
    return () => clearInterval(timer);
  }, [playing, count, loadMore]);
  useEffect(() => {
    if (count && active >= count - 8) loadMore?.();
  }, [active, count, loadMore]);
  if (!count) return null;
  const step = (n: number) => {
    play(false);
    if (n > 0 && active === count - 1 && loadMore) {
      loadMore();
      return;
    }
    move((active + n + count) % count);
  };
  const radius = Math.min(3, Math.floor(count / 2));
  const offsets = Array.from(
    { length: Math.min(count, 2 * radius + 1) },
    (_, i) => i - radius,
  );
  return (
    <section
      className="orbit"
      aria-label="Animated 3D photo gallery"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          step(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="orbit-stage">
        {offsets.map((offset) => {
          const p = photos[(active + offset + count) % count];
          return (
            <div
              key={p.id}
              className="orbit-frame"
              aria-hidden={offset !== 0}
              style={{
                transform: `translateX(calc(-50% + ${offset * 49}%)) translateZ(${-100 * Math.abs(offset)}px) rotateY(${-28 * Math.sign(offset)}deg)`,
                zIndex: 10 - Math.abs(offset),
                opacity: 1 - Math.abs(offset) * 0.18,
              }}
            >
              {p.preview ? (
                <img src={"/api/thumb/" + p.id} alt={p.caption || p.filename} />
              ) : (
                <span>{p.filename}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="orbit-controls">
        <button
          aria-label="Previous photo"
          disabled={count < 2}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <span>
          {active + 1} / {total || count} · {photos[active].filename}
        </span>
        <button
          aria-label="Next photo"
          disabled={count < 2}
          onClick={() => step(1)}
        >
          ›
        </button>
        {count > 1 && (
          <button onClick={() => play(!playing)}>
            {playing ? "Pause" : "Play"}
          </button>
        )}
      </div>
    </section>
  );
}
