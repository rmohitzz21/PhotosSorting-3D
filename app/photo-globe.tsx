"use client";
import { useEffect, useRef, useState } from "react";
import { Minus, Pause, Play, Plus } from "lucide-react";

export type GlobePhoto = { id: string; category: string };

const MIN_ZOOM = 0.65;
const MAX_ZOOM = 3.2;
/** Tiles overlap slightly so the surface reads as solid rather than dotted. */
const PACKING = 1.32;

/** Frame-rate independent approach to a target. */
const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

export default function PhotoGlobe({ photos }: { photos: GlobePhoto[] }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    angle = useRef(0),
    tilt = useRef(-0.16),
    spin = useRef(0),
    zoom = useRef(1),
    zoomTo = useRef(1),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    pinch = useRef(0);
  const [running, setRunning] = useState(false);
  const [level, setLevel] = useState(1);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setRunning(!media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  // Wheel zoom has to be a non-passive native listener, otherwise the browser
  // scrolls the page instead and preventDefault is ignored.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomTo.current = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoomTo.current * Math.exp(-e.deltaY * 0.0013)),
      );
      setLevel(zoomTo.current);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const el = canvas.current,
      ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let frame = 0,
      dead = false,
      last = 0,
      dirty = true,
      turn = 0,
      next = 0,
      pending = 0;
    // Never fewer than DENSITY tiles: a sphere built from a dozen squares reads
    // as a lumpy blob (measured ±6% off circular at 12 tiles, ±0.3% at 480).
    // A small library simply repeats across the surface.
    const DENSITY = 160;
    const count = photos.length
      ? Math.min(480, Math.max(DENSITY, photos.length))
      : DENSITY;
    const pick = (i: number) => (photos.length ? i % photos.length : 0);
    const tiles = Array.from({ length: count }, (_, i) => {
      const y = 1 - (2 * (i + 0.5)) / count,
        a = i * Math.PI * (3 - Math.sqrt(5)),
        r = Math.sqrt(1 - y * y);
      return {
        x: r * Math.cos(a),
        y,
        z: r * Math.sin(a),
        image: null as HTMLCanvasElement | null,
        index: pick(i),
        loaded: -1,
      };
    });
    function load() {
      while (!dead && pending < 6 && next < tiles.length && photos.length) {
        const tile = tiles[next++],
          index = tile.index,
          img = new Image();
        if (tile.loaded === index) continue;
        pending++;
        img.onload = () => {
          if (!dead && tile.index === index) {
            const mini = document.createElement("canvas");
            mini.width = mini.height = 64;
            mini.getContext("2d")?.drawImage(img, 0, 0, 64, 64);
            tile.image = mini;
            tile.loaded = index;
            dirty = true;
          }
          pending--;
          load();
        };
        img.onerror = () => {
          pending--;
          load();
        };
        img.src = "/api/thumb/" + photos[index].id;
      }
    }
    const resize = () => {
      const size = el.clientWidth;
      if (!size) return;
      el.width = el.height = Math.round(size * Math.min(devicePixelRatio, 2));
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    load();
    let prevAngle = NaN,
      prevTilt = NaN,
      prevZoom = NaN;

    function draw(time: number) {
      if (dead || !el || !ctx) return;
      frame = requestAnimationFrame(draw);
      if (!last) last = time;
      const dt = Math.min((time - last) / 1000, 0.05);
      last = time;
      if (dt <= 0) return;

      const dragging = pointers.current.size > 0;
      if (running && !dragging && !document.hidden)
        angle.current += dt * 0.18;
      // Momentum: a flick keeps turning and eases out instead of stopping dead.
      if (!dragging && spin.current) {
        angle.current += spin.current * dt;
        spin.current = damp(spin.current, 0, 3.2, dt);
        if (Math.abs(spin.current) < 0.002) spin.current = 0;
      }
      zoom.current = damp(zoom.current, zoomTo.current, 9, dt);
      if (Math.abs(zoom.current - zoomTo.current) < 0.0005)
        zoom.current = zoomTo.current;

      if (
        !dirty &&
        angle.current === prevAngle &&
        tilt.current === prevTilt &&
        zoom.current === prevZoom
      )
        return;
      prevAngle = angle.current;
      prevTilt = tilt.current;
      prevZoom = zoom.current;
      dirty = false;

      const rotation = Math.floor(Math.abs(angle.current) / (Math.PI * 2));
      if (rotation !== turn && photos.length > count) {
        turn = rotation;
        tiles.forEach((t, i) => {
          t.index = (turn * count + i) % photos.length;
        });
        next = 0;
        load();
      }

      const width = el.width,
        mid = width / 2,
        radius = width * 0.382 * zoom.current,
        ca = Math.cos(angle.current),
        sa = Math.sin(angle.current),
        ct = Math.cos(tilt.current),
        st = Math.sin(tilt.current);
      ctx.clearRect(0, 0, width, width);

      // Square tiles sized to cover the sphere's surface. An orthographic
      // projection of a sphere is an exact circle, and centred square tiles
      // extend equally in x and y, so the silhouette stays circular.
      const base = Math.min(
        radius * 0.42,
        radius * 2 * Math.sqrt(Math.PI / count) * PACKING,
      );

      const points = tiles
        .map((t) => {
          const x = t.x * ca + t.z * sa,
            z = t.z * ca - t.x * sa;
          return { t, x, y: t.y * ct - z * st, z: t.y * st + z * ct };
        })
        .sort((a, b) => a.z - b.z);

      for (const p of points) {
        const depth = (p.z + 1) / 2,
          // Gentle falloff: a strong one bulges the front and breaks the circle.
          size = base * (0.78 + 0.32 * depth),
          x = mid + p.x * radius - size / 2,
          y = mid + p.y * radius - size / 2;
        ctx.globalAlpha = photos.length
          ? 0.34 + 0.66 * depth
          : 0.12 + 0.4 * depth;
        ctx.fillStyle = photos.length ? "#414049" : "#494552";
        ctx.fillRect(x, y, size, size);
        if (p.t.image)
          ctx.drawImage(
            p.t.image,
            x + size * 0.03,
            y + size * 0.03,
            size * 0.94,
            size * 0.94,
          );
      }
      ctx.globalAlpha = 1;
    }
    frame = requestAnimationFrame(draw);
    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [photos, running]);

  const nudgeZoom = (factor: number) => {
    zoomTo.current = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, zoomTo.current * factor),
    );
    setLevel(zoomTo.current);
  };

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  return (
    <section className="globe-center" aria-label="Rotating photo sphere">
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={
          photos.length +
          " photos in a rotating sphere. Drag or use arrow keys to rotate, plus and minus to zoom."
        }
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            angle.current += e.key === "ArrowLeft" ? -0.16 : 0.16;
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            tilt.current = Math.max(
              -1.1,
              Math.min(1.1, tilt.current + (e.key === "ArrowUp" ? -0.12 : 0.12)),
            );
          }
          if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            nudgeZoom(1.25);
          }
          if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            nudgeZoom(0.8);
          }
          if (e.key === "0") {
            e.preventDefault();
            zoomTo.current = 1;
            setLevel(1);
          }
        }}
        onDoubleClick={() => {
          zoomTo.current = 1;
          setLevel(1);
        }}
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          spin.current = 0;
          if (pointers.current.size === 2) pinch.current = spread();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const previous = pointers.current.get(e.pointerId);
          if (!previous) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            // Pinch to zoom: the ratio of finger spread maps straight onto scale.
            const now = spread();
            if (pinch.current > 0) {
              zoomTo.current = Math.min(
                MAX_ZOOM,
                Math.max(MIN_ZOOM, zoomTo.current * (now / pinch.current)),
              );
              setLevel(zoomTo.current);
            }
            pinch.current = now;
            return;
          }
          const dx = e.clientX - previous.x;
          angle.current += dx * 0.012;
          // Remember the flick so release can carry it.
          spin.current = dx * 0.55;
          tilt.current = Math.max(
            -1.1,
            Math.min(1.1, tilt.current + (e.clientY - previous.y) * 0.009),
          );
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = 0;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = 0;
        }}
      />
      <div className="globe-controls">
        <button
          className="globe-toggle"
          aria-label={running ? "Pause sphere rotation" : "Play sphere rotation"}
          onClick={() => setRunning(!running)}
        >
          {running ? <Pause /> : <Play />}
        </button>
        <button
          className="globe-toggle"
          aria-label="Zoom in"
          disabled={level >= MAX_ZOOM - 0.001}
          onClick={() => nudgeZoom(1.25)}
        >
          <Plus />
        </button>
        <button
          className="globe-toggle"
          aria-label="Zoom out"
          disabled={level <= MIN_ZOOM + 0.001}
          onClick={() => nudgeZoom(0.8)}
        >
          <Minus />
        </button>
      </div>
    </section>
  );
}
