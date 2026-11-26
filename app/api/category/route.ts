import { safeCategory } from "../../../lib/categories";
import { db, owner } from "../../../lib/db";
export async function POST(req: Request) {
  const user = await owner(),
    { id, category } = await req.json(),
    sql = db();
  const [row] =
    await sql`select kind from media where owner=${user} and id=${id}`;
  if (!row || safeCategory(row.kind, category).review)
    return new Response(null, { status: 400 });
  await sql`update media set category=${category},source='user',review=false where id=${id} and owner=${user}`;
  return Response.json({ ok: true });
}
