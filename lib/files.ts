import { unzipSync, strFromU8 } from "fflate";
export type Entry = { file: File; time?: string; geo?: string };
const media =
  /\.(jpg|jpeg|png|gif|webp|avif|heic|heif|tif|tiff|bmp|mov|mp4|m4v|webm|avi|mkv)$/i;
export async function entries(files: File[]): Promise<Entry[]> {
  const all: Entry[] = [];
  for (const file of files) {
    if (!/\.zip$/i.test(file.name)) {
      if (media.test(file.name) || /^(image|video)\//.test(file.type))
        all.push({ file });
      continue;
    }
    if (file.size > 512 * 1024 * 1024)
      throw Error("Choose a ZIP under 512 MB or import its extracted folder.");
    let size = 0,
      count = 0;
    const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (e) => {
        if (!media.test(e.name) && !e.name.endsWith(".json")) return false;
        size += e.originalSize;
        if (size > 768 * 1024 * 1024 || ++count > 2000)
          throw Error("Extract this archive and choose a smaller folder.");
        return true;
      },
    });
    for (const [path, bytes] of Object.entries(zip)) {
      if (!media.test(path)) continue;
      const name = path.split("/").pop()!;
      const entry: Entry = { file: new File([new Uint8Array(bytes)], name) };
      try {
        const data = JSON.parse(
          strFromU8(
            zip[path + ".supplemental-metadata.json"] ?? zip[path + ".json"],
          ),
        );
        if (data.photoTakenTime?.timestamp)
          entry.time = new Date(
            Number(data.photoTakenTime.timestamp) * 1000,
          ).toISOString();
        const p =
          data.geoDataExif?.latitude || data.geoDataExif?.longitude
            ? data.geoDataExif
            : data.geoData;
        if (p && (p.latitude || p.longitude))
          entry.geo = JSON.stringify({
            latitude: p.latitude,
            longitude: p.longitude,
            source: "sidecar",
          });
      } catch {
        /* Sidecars are optional. */
      }
      all.push(entry);
    }
  }
  if (!all.length || all.length > 500)
    throw Error("Choose between 1 and 500 photos or videos.");
  return all;
}
export async function prepare(entry: Entry, id: string, index: number) {
  const { file } = entry,
    form = new FormData(),
    video =
      /^video\//.test(file.type) ||
      /\.(mp4|mov|avi|webm|m4v|mkv)$/i.test(file.name);
  Object.entries({
    id: crypto.randomUUID(),
    import: id,
    index: String(index),
    bytes: String(file.size),
    kind: video ? "video" : "photo",
    name: file.name,
    time: entry.time || new Date(file.lastModified).toISOString(),
    geo: entry.geo || "",
  }).forEach(([k, v]) => form.set(k, v));
  try {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    form.set(
      "hash",
      Array.from(new Uint8Array(hash), (v) =>
        v.toString(16).padStart(2, "0"),
      ).join(""),
    );
    if (!video) {
      const bitmap = await createImageBitmap(file);
      try {
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas
          .getContext("2d")!
          .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.9),
        );
        if (blob) form.set("preview", blob);
      } finally {
        bitmap.close();
      }
    }
  } catch {
    /* Server records the unreadable item. */
  }
  return form;
}
