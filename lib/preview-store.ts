import * as blob from "@vercel/blob";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { localData, dataDirectory } from "./database";
function location(key: string) {
  if (!/^[\w-]+\/[\w-]+\/(thumb|work)\.jpg$/.test(key))
    throw Error("Invalid preview key");
  return path.join(dataDirectory, "previews", key);
}
export async function save(key: string, bytes: Buffer) {
  if (!localData)
    return (
      await blob.put(key, bytes, {
        access: "private",
        contentType: "image/jpeg",
        allowOverwrite: true,
        addRandomSuffix: false,
      })
    ).pathname;
  const dest = location(key);
  await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  await writeFile(dest, bytes, { mode: 0o600 });
  return key;
}
export async function get(key: string, _options: { access: "private" }) {
  if (!localData) return blob.get(key, _options);
  try {
    return {
      stream: new Response(new Uint8Array(await readFile(location(key)))).body,
      statusCode: 200,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function erasePreviews(user: string) {
  if (localData) {
    if (!/^[\w-]+$/.test(user)) throw Error("Invalid owner");
    await rm(path.join(dataDirectory, "previews", user), {
      recursive: true,
      force: true,
    });
    return;
  }
  let cursor: string | undefined;
  do {
    const page = await blob.list({ prefix: user + "/", cursor });
    if (page.blobs.length) await blob.del(page.blobs.map((b) => b.url));
    cursor = page.cursor;
  } while (cursor);
}
