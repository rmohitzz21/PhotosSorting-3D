import { db, owner } from "../../../lib/db";
import { libraryPage } from "../../../lib/library";
import { readGroups } from "../../../lib/dupe-store";
import { erasePreviews } from "../../../lib/preview-store";
export async function GET(req: Request) {
  const user = await owner(),
    params = new URL(req.url).searchParams;
  if (params.get("view") === "sphere") {
    const photos =
      await db()`select id,category from media where owner=${user} and kind='photo' and thumb is not null order by sort_at desc,id desc`;
    return Response.json(
      { photos },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const page = await libraryPage({
    user,
    cursor: params.get("cursor"),
    limit: Number(params.get("limit")) || 200,
    category: params.get("category"),
    q: params.get("q"),
    tab: params.get("tab"),
  });
  const folders =
    page.total === null
      ? null
      : await db()`
    select category as name,count(*)::int as count from media where owner=${user}
    group by category order by count(*) desc,category`;
  return Response.json({ ...page, folders, groups: await readGroups(user) });
}
export async function DELETE() {
  const user = await owner(),
    sql = db();
  await sql`update users set deleting=true where id=${user}`;
  const active =
    await sql`select id from media where owner=${user} and state='uploading' union all select id from photo_sessions where owner=${user} and lease_until>now()`;
  if (active.length)
    return new Response("An upload is finishing. Try deleting again shortly.", {
      status: 409,
    });
  await erasePreviews(user);
  const count = await sql`select count(*) as n from media where owner=${user}`;
  await sql`delete from users where id=${user}`;
  return Response.json({ removed: Number(count[0].n) });
}
