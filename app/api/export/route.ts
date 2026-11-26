import { owner, db } from "../../../lib/db";
import { readGroups } from "../../../lib/dupe-store";
export async function GET() {
  const user = await owner();
  // The CSV covers the whole library, so it does not reuse the paginated display
  // query. It selects only the columns the file needs.
  const items = await db()`
    select id,filename,category,caption,bytes from media
    where owner=${user} order by sort_at desc, id desc`;
  const groups = await readGroups(user);
  const duplicates = new Map(
    groups.flatMap((g) =>
      g.memberIds
        .filter((id) => id !== g.keeperId)
        .map((id) => [id, g.keeperId] as const),
    ),
  );
  const escape = (v: unknown) => {
    let s = String(v ?? "");
    if (/^[\s]*[=+@-]|^[\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const records = [
    ["id", "filename", "category", "caption", "bytes", "duplicate_of"],
    ...items.map((r) => [
      r.id,
      r.filename,
      r.category,
      r.caption,
      r.bytes,
      duplicates.get(r.id),
    ]),
  ];
  await db()`insert into audit_log(owner,action) select id,'csv_export' from users where id=${user}`;
  return new Response(
    records.map((r) => r.map(escape).join(",")).join("\r\n"),
    {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": 'attachment; filename="shoebox.csv"',
      },
    },
  );
}
