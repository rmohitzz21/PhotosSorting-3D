export type Cursor = { sortAt: string; id: string };

/** Opaque, URL-safe cursor. base64url of JSON so ids containing separators are safe. */
export function encodeCursor(row: { sort_at: Date | string; id: string }) {
  const sortAt =
    row.sort_at instanceof Date ? row.sort_at.toISOString() : String(row.sort_at);
  return Buffer.from(JSON.stringify([sortAt, row.id])).toString("base64url");
}

export function decodeCursor(value: unknown): Cursor | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [sortAt, id] = parsed;
    if (typeof sortAt !== "string" || typeof id !== "string" || !id) return null;
    return { sortAt, id };
  } catch {
    return null;
  }
}
