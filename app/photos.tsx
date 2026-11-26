"use client";
import { useEffect, useRef, useState } from "react";
import { connectPhotos } from "./photo-consent";

type Status = {
  state: string;
  id?: string;
  uri?: string;
  completed?: number;
  count?: number;
  errors?: number;
  estimate?: number;
  delay?: number;
};
export default function Photos({
  onImported,
}: {
  onImported: () => Promise<void>;
}) {
  const [s, set] = useState<Status>({ state: "idle" }),
    [message, msg] = useState(""),
    [busy, working] = useState(false),
    [connect, grant] = useState(false);
  const attempts = useRef(0),
    fresh = useRef(onImported);
  fresh.current = onImported;
  async function step(action: string, current = s, automatic = false) {
    working(true);
    msg("");
    try {
      const r = await fetch("/api/photos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          id: action === "start" ? undefined : current.id,
          estimate: current.estimate,
        }),
      });
      const data = await r.json();
      if (data.connect) {
        grant(true);
        return;
      }
      if (!r.ok) {
        if (automatic && r.status === 503 && attempts.current++ < 3) {
          set({ ...current, delay: 2000 * 2 ** attempts.current });
          return;
        }
        throw Error(data.message || "Couldn’t reach Google Photos.");
      }
      attempts.current = 0;
      set(data);
      if (
        data.completed !== current.completed ||
        data.state === "done" ||
        data.state === "repick"
      )
        await fresh.current();
      if (data.state === "done" && data.completed) {
        while (
          (
            await (
              await fetch("/api/jobs", {
                method: "POST",
                body: JSON.stringify({ id: data.id }),
              })
            ).json()
          ).worked
        )
          await fresh.current();
      }
    } catch (e) {
      msg(e instanceof Error ? e.message : "Import paused.");
    } finally {
      working(false);
    }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/photos", { cache: "no-store" })
      .then(async (r) => {
        if (r.ok && active) set(await r.json());
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (
      busy ||
      connect ||
      message ||
      !["creating", "picking", "listing", "fetching"].includes(s.state)
    )
      return;
    const timer = setTimeout(
      () => void step("advance", s, true),
      s.delay ?? 800,
    );
    return () => clearTimeout(timer);
  }, [s, busy, connect, message]);
  const ended = ["idle", "done", "repick", "cancelled"].includes(s.state);
  return (
    <section aria-label="Google Photos import">
      <h2>Import from Google Photos</h2>
      <p>
        Choose up to 500 photos and videos. Shoebox saves private previews to
        help you find receipts and review duplicate copies.
      </p>
      {connect ? (
        <form action={connectPhotos}>
          <p>Allow Shoebox to read the items you select in Google Photos.</p>
          <button>Connect Google Photos</button>
        </form>
      ) : ended ? (
        <button disabled={busy} onClick={() => step("start")}>
          {s.state === "repick"
            ? "Pick remaining items again"
            : "Choose from Google Photos"}
        </button>
      ) : (
        <>
          {s.state === "picking" && s.uri && (
            <a href={s.uri} target="_blank" rel="noreferrer">
              Open Google Photos to select items
            </a>
          )}
          {s.state === "confirm" && (
            <>
              <p>
                {s.count} new items · Estimated maximum labeling cost $
                {s.estimate?.toFixed(3)}.
                {!!s.estimate &&
                  " Importing sends contact sheets of previews to the AI provider through Vercel AI Gateway for captions and categories."}
              </p>
              <button disabled={busy} onClick={() => step("confirm")}>
                Import selection
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => step("cancel")}>
            Cancel import
          </button>
        </>
      )}
      <p role="status">
        {message ||
          {
            picking: "Waiting for your selection…",
            listing: "Reading your selection…",
            fetching: `Saved ${s.completed} of ${s.count} items.`,
            done: `Import finished. ${s.completed} new items, ${s.errors} unavailable previews.`,
            repick: `Selection expired. ${s.completed} items were saved. Pick again to continue.`,
          }[s.state]}
      </p>
      {message && !ended && !connect && (
        <button disabled={busy} onClick={() => step("advance")}>
          Resume
        </button>
      )}
    </section>
  );
}
