import { get } from "../../../../lib/preview-store";
import { db, owner } from "../../../../lib/db";
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await owner(),
    { id } = await params;
  const [row] =
    await db()`select thumb from media where id=${id} and owner=${user}`;
  if (!row?.thumb) return new Response(null, { status: 404 });
  const blob = await get(row.thumb, { access: "private" });
  return new Response(blob?.stream ?? null, {
    status: blob?.statusCode ?? 404,
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
    },
  });
}

