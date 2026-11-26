"use client";
import { useEffect, useRef, useState } from "react";
import { Archive, FolderPlus } from "lucide-react";
import { entries, prepare } from "../lib/files";
import { json } from "./fetch-json";

export default function ImportPanel({
  busy,
  setBusy,
  setStatus,
  onImported,
  onReady,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setStatus: (status: string) => void;
  onImported: () => Promise<void>;
  onReady?: (upload: (selection: File[]) => Promise<void>) => void;
}) {
  const [transfer, setTransfer] = useState<{
    done: number;
    total: number;
  } | null>(null);
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
      setTransfer({ done: 0, total: batch.length });
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
        setTransfer({
          done: Math.min(i + 3, batch.length),
          total: batch.length,
        });
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
      setTransfer(null);
      setBusy(false);
      if (files.current) files.current.value = "";
      if (folder.current) folder.current.value = "";
    }
  }
  // Republish the closure when `busy` flips so the page-level drop handler
  // never calls a stale `upload`.
  useEffect(() => {
    onReady?.(upload);
  }, [busy]);
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
      {transfer && (
        <div className="transfer-meter" role="status">
          <span>
            Uploading {transfer.done} of {transfer.total}
          </span>
          <progress
            aria-label="Photo upload progress"
            value={transfer.done}
            max={transfer.total}
          />
        </div>
      )}
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
