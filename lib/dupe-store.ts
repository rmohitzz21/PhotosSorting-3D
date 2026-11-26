import { createHash } from "node:crypto";
import { db } from "./db";
import { duplicateGroups, type Fingerprint } from "./duplicates.ts";

/**
 * A group's id is derived from its membership, not randomly generated, so that
 * rebuilding after a later import keeps the same id for the same set of photos.
 * Stable ids are what let a user's keeper choice survive a rebuild.
 */
function groupId(memberIds: string[]) {
  const h = createHash("sha1")
    .update([...memberIds].sort().join(","))
    .digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type StoredGroup = {
  id: string;
  kind: string;
  keeperId: string;
  memberIds: string[];
  bytesReclaimable: number;
  unknownSizes: number;
};

/** Recompute groups for one owner and replace that owner's stored rows. Returns the count. */
export async function rebuildGroups(user: string) {
  const sql = db();
  const rows = await sql`
    select id,filename,kind,bytes,hash,phash,pixels,screenshot from media
    where owner=${user} and state='ready' and thumb is not null`;
  const groups = duplicateGroups(rows as Fingerprint[]);
  // A keeper the user picked earlier wins over the computed one, as long as it
  // is still a member of the group.
  const previous = new Map(
    (
      await sql`select id,keeper_id from dupe_groups where owner=${user}`
    ).map((r) => [r.id as string, r.keeper_id as string]),
  );
  await sql`delete from dupe_groups where owner=${user}`;
  for (const group of groups) {
    const memberIds = group.map((r) => r.id);
    const id = groupId(memberIds);
    const chosen = previous.get(id);
    const keeper =
      (chosen && group.find((r) => r.id === chosen)) || group[0];
    const copies = group.filter((r) => r.id !== keeper.id);
    await sql`
      insert into dupe_groups(id,owner,kind,keeper_id,member_ids,bytes_reclaimable,unknown_sizes)
      values(${id},${user},
             ${group.every((r) => r.hash && r.hash === group[0].hash) ? "exact" : "near"},
             ${keeper.id},${memberIds},
             ${copies.reduce((sum, r) => sum + Number(r.bytes ?? 0), 0)},
             ${copies.filter((r) => r.bytes === null).length})`;
  }
  return groups.length;
}

export async function readGroups(user: string): Promise<StoredGroup[]> {
  const rows = await db()`
    select id,kind,keeper_id,member_ids,bytes_reclaimable,unknown_sizes
    from dupe_groups where owner=${user} order by bytes_reclaimable desc, id`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    keeperId: r.keeper_id,
    memberIds: r.member_ids,
    bytesReclaimable: Number(r.bytes_reclaimable),
    unknownSizes: Number(r.unknown_sizes),
  }));
}

/** Promote a member to keeper and recompute what the group reclaims. */
export async function setKeeper(user: string, groupId: string, keeperId: string) {
  const sql = db();
  const [group] =
    await sql`select member_ids from dupe_groups where id=${groupId} and owner=${user}`;
  if (!group) throw Error("That duplicate group was not found.");
  if (!group.member_ids.includes(keeperId))
    throw Error("That photo is not a member of this group.");
  const sizes = await sql`
    select coalesce(sum(bytes),0)::bigint as total,
           count(*) filter (where bytes is null)::int as unknown
    from media where owner=${user} and id = any(${group.member_ids}) and id<>${keeperId}`;
  await sql`
    update dupe_groups set keeper_id=${keeperId},
      bytes_reclaimable=${String(sizes[0].total)}::bigint,
      unknown_sizes=${sizes[0].unknown}
    where id=${groupId} and owner=${user}`;
}
