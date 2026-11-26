export const pickerScope =
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
export const pickerLimit = 500;
export class PickerExpired extends Error {}
export class ConnectPhotos extends Error {}
export class GoogleUnavailable extends Error {}

export function duration(value: string | undefined, fallback: number) {
  return value && /^\d+(\.\d+)?s$/.test(value)
    ? Number(value.slice(0, -1)) * 1000
    : fallback;
}
export function expiry(issued: number, sessionExpiry: string) {
  return Math.min(issued + 3600000, Date.parse(sessionExpiry));
}
export type Picked = {
  id: string;
  createTime?: string;
  type: string;
  mediaFile: { filename: string; mimeType: string; baseUrl: string };
};
export async function listPicked(
  session: string,
  request: (path: string) => Promise<Response>,
) {
  const items = new Map<string, Picked>();
  const seen = new Set<string>();
  let page = "";
  do {
    if (seen.has(page)) throw new Error("Repeated Google Photos page.");
    seen.add(page);
    const query = new URLSearchParams({ sessionId: session, pageSize: "100" });
    if (page) query.set("pageToken", page);
    const response = await request("mediaItems?" + query);
    const data = await response.json();
    for (const item of data.mediaItems ?? []) items.set(item.id, item);
    if (items.size > pickerLimit)
      throw new Error("Selection exceeds the import limit.");
    page = data.nextPageToken ?? "";
  } while (page);
  return [...items.values()];
}
export async function fetchPreview(
  base: string,
  deadline: number,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  if (!Number.isFinite(deadline) || Date.now() >= deadline)
    throw new PickerExpired();
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    !/(^|\.)googleusercontent\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("Invalid media address.");
  const response = await fetcher(base + "=w1600-h1600", {
    headers: { Authorization: "Bearer " + token },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(18000),
  });
  if ([401, 403, 404, 410].includes(response.status)) throw new PickerExpired();
  if (response.status === 429 || response.status >= 500)
    throw new GoogleUnavailable();
  if (!response.ok) throw Error("Image unavailable.");
  return Buffer.from(await response.arrayBuffer());
}
