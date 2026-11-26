import { db } from "./db";
import { encodeCursor, decodeCursor } from "./cursor.ts";

export type LibraryQuery = {
  user: string;
  cursor?: string | null;
  limit?: number;
  category?: string | null;
  q?: string | null;
  tab?: string | null;
};

/** The highest possible keyset position, so the first page's predicate matches every row. */
const TOP_SORT_AT = "infinity";
const TOP_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

export async function libraryPage({
  user,
  cursor,
  limit,
  category,
  q,
  tab,
}: LibraryQuery) {
  const size = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const after = decodeCursor(cursor);
  // ponytail: substring match preserves today's behaviour. Slice 2 replaces this
  // with pgvector + full-text fusion; the shape of the return value does not change.
  const term = q?.trim() ? "%" + q.trim() + "%" : null;
  const wanted = category && category !== "All categories" ? category : null;
  const duplicatesOnly = tab === "duplicates";
  const sql = db();
  const rows = await sql`
    select id,filename,kind,category,caption,tags,state,sort_at,
           thumb is not null as preview
    from media
    where owner=${user}
      and (sort_at,id) < (${after?.sortAt ?? TOP_SORT_AT}::timestamptz,${after?.id ?? TOP_ID}::uuid)
      and (${wanted}::text is null or category=${wanted})
      and (${term}::text is null or filename ilike ${term} or category ilike ${term}
           or caption ilike ${term} or tags ilike ${term})
      and (${!duplicatesOnly} or id in (select unnest(member_ids) from dupe_groups where owner=${user}))
    order by sort_at desc, id desc
    limit ${size + 1}`;
  const page = rows.slice(0, size) as {
    id: string;
    sort_at: Date | string;
    [key: string]: unknown;
  }[];
  // count(*) over the whole library costs more than the page query itself, and the
  // total cannot change mid-scroll. Only the first page pays for it.
  const [counted] = after
    ? [{ n: null }]
    : await sql`select count(*)::int as n from media where owner=${user}`;
  const last = page[page.length - 1];
  return {
    items: page.map(({ sort_at, ...visible }) => visible),
    nextCursor: rows.length > size && last ? encodeCursor(last) : null,
    total: counted.n as number | null,
  };
}
