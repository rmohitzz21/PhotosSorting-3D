import { db } from "./db";
import { accessToken } from "./photo-tokens";
import {
  duration,
  expiry,
  fetchPreview,
  listPicked,
  pickerLimit,
  PickerExpired,
  ConnectPhotos,
  GoogleUnavailable,
  type Picked,
} from "./picker-protocol";
import { savePreview } from "./save-preview";
import { importCost } from "./import-cost";
import { enqueue } from "./jobs";

type Selection = Picked & { local: string };
const terminal = ["done", "repick", "cancelled"];
export async function photoStatus(user: string) {
  const [s] =
    await db()`select id,state,picker_uri,completed,errors,next_poll,jsonb_array_length(selected) as count from photo_sessions where owner=${user}`;
  if (!s) return { state: "idle" };
  return {
    id: s.id,
    state: s.state,
    uri: s.state === "picking" ? s.picker_uri : undefined,
    completed: s.completed,
    errors: s.errors,
    count: s.count,
    estimate: importCost(s.count).estimate,
    delay: Math.max(600, new Date(s.next_poll ?? 0).getTime() - Date.now()),
  };
}
export async function stepPhotos(
  user: string,
  action: string,
  expectedId?: string,
  expectedCost?: number,
) {
  const sql = db(),
    lease = crypto.randomUUID();
  if (action === "start") {
    await accessToken(user);
    await sql`insert into photo_sessions(owner,id,state) select id,${crypto.randomUUID()},'creating' from users where id=${user} and not deleting on conflict(owner) do update set id=excluded.id,state='creating',remote_id=null,picker_uri=null,selected='[]',next_poll=null,expires=null,deadline=null,completed=0,errors=0 where photo_sessions.state=any(${terminal}::text[]) and (photo_sessions.lease_until is null or photo_sessions.lease_until<now())`;
  }
  const [s] =
    await sql`update photo_sessions set lease=${lease},lease_until=now()+interval '90 seconds' where owner=${user} and (${expectedId ?? null}::uuid is null or id=${expectedId ?? null}::uuid) and (lease_until is null or lease_until<now()) and exists(select 1 from users where id=${user} and not deleting) returning *`;
  if (!s) return photoStatus(user);
  const selected = s.selected as Selection[];
  async function finish(state: string) {
    if (state === "done" || state === "repick" || state === "cancelled") {
      // Keep downloaded items eligible for labeling even when the remaining links expire.
      await sql`update imports set expected=(select count(*) from media where import_id=${s.id}) where id=${s.id} and owner=${user}`;
      await enqueue(user, s.id);
    }
    await sql`update photo_sessions set state=${state},selected='[]',picker_uri=null,next_poll=null where lease=${lease}`;
  }
  try {
    if (terminal.includes(s.state)) return await photoStatus(user);
    const token = await accessToken(user);
    async function api(path: string, method = "GET", body?: unknown) {
      const response = await fetch(
        "https://photospicker.googleapis.com/v1/" + path,
        {
          method,
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        },
      );
      if (response.status === 401) throw new ConnectPhotos();
      if ([403, 404, 410].includes(response.status) && method !== "POST")
        throw new PickerExpired();
      if (!response.ok) throw new GoogleUnavailable();
      return response;
    }
    const path = "sessions/" + encodeURIComponent(s.remote_id ?? "");
    async function clean() {
      if (s.remote_id) await api(path, "DELETE").catch(() => {});
    }
    if (action === "cancel") {
      await clean();
      await finish("cancelled");
    } else if (s.state === "creating") {
      const remote = await (
        await api("sessions", "POST", {
          pickingConfig: { maxItemCount: String(pickerLimit) },
        })
      ).json();
      const end =
        remote.expireTime ?? new Date(Date.now() + 3600000).toISOString();
      await sql`update photo_sessions set remote_id=${remote.id},picker_uri=${remote.pickerUri.replace(/\/$/, "") + "/autoclose"},state='picking',expires=${end},poll_until=${new Date(Math.min(Date.parse(end), Date.now() + duration(remote.pollingConfig?.timeoutIn, 3600000))).toISOString()},next_poll=${new Date(Date.now() + duration(remote.pollingConfig?.pollInterval, 5000)).toISOString()} where lease=${lease}`;
    } else if (
      new Date(s.expires).getTime() <= Date.now() ||
      (s.deadline && new Date(s.deadline).getTime() <= Date.now())
    ) {
      await clean();
      await finish("repick");
    } else if (s.state === "picking") {
      if (new Date(s.poll_until).getTime() <= Date.now()) {
        await clean();
        await finish("repick");
      } else if (new Date(s.next_poll).getTime() <= Date.now()) {
        const status = await (await api(path)).json();
        if (status.mediaItemsSet)
          await sql`update photo_sessions set state='listing',next_poll=null where lease=${lease}`;
        else
          await sql`update photo_sessions set next_poll=${new Date(Date.now() + duration(status.pollingConfig?.pollInterval, 5000)).toISOString()},poll_until=least(poll_until,${new Date(Date.now() + duration(status.pollingConfig?.timeoutIn, 3600000)).toISOString()}::timestamptz) where lease=${lease}`;
      }
    } else if (s.state === "listing") {
      const deadline = expiry(Date.now(), s.expires);
      const picked = await listPicked(s.remote_id, api);
      const existing =
        await sql`select google_id from media where owner=${user} and google_id=any(${picked.map((p) => p.id)}::text[]) and state<>'error'`;
      const known = new Set(existing.map((r) => r.google_id));
      const fresh = picked
        .filter((p) => !known.has(p.id))
        .map((p) => ({ ...p, local: crypto.randomUUID() }));
      if (!fresh.length) {
        await clean();
        await finish("done");
      } else
        await sql`update photo_sessions set state='confirm',deadline=${new Date(deadline).toISOString()},selected=${JSON.stringify(fresh)}::jsonb where lease=${lease}`;
    } else if (s.state === "confirm" && action === "confirm") {
      const { estimate, enabled, limit } = importCost(selected.length);
      if (expectedCost !== estimate)
        throw Error("The estimate changed. Review it again.");
      const reserved =
        await sql`with charged as (insert into budgets(owner,month,amount) select ${user},date_trunc('month',now()),${estimate}::numeric where ${estimate}::numeric<=${limit}::numeric on conflict(owner,month) do update set amount=budgets.amount+excluded.amount where budgets.amount+excluded.amount<=${limit}::numeric returning owner), batch as (insert into imports(id,owner,expected,source,model_enabled) select ${s.id},owner,${selected.length},'picker',${enabled} from charged returning id) update photo_sessions set state='fetching' from batch where photo_sessions.id=batch.id returning batch.id`;
      if (!reserved.length)
        throw Error("This selection exceeds your monthly labeling budget.");
    } else if (s.state === "fetching") {
      const done =
        await sql`select google_id from media where import_id=${s.id}`;
      const known = new Set(done.map((r) => r.google_id));
      const todo = selected
        .map((item, position) => ({ item, position }))
        .filter(({ item }) => !known.has(item.id))
        .slice(0, 8);
      const outcomes = await Promise.allSettled(
        todo.map(async ({ item, position }) => {
          const kind = item.type === "VIDEO" ? "video" : "photo",
            name = item.mediaFile.filename || "Selected item";
          let preview,
            failed = false;
          try {
            let bytes: Buffer | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                bytes = await fetchPreview(
                  item.mediaFile.baseUrl,
                  new Date(s.deadline).getTime(),
                  token,
                );
                break;
              } catch (error) {
                if (error instanceof PickerExpired) throw error;
                if (
                  !(
                    error instanceof GoogleUnavailable ||
                    error instanceof TypeError ||
                    error instanceof DOMException
                  ) ||
                  attempt === 2
                )
                  throw Error("Preview unavailable");
                await new Promise((resolve) =>
                  setTimeout(resolve, 500 * 2 ** attempt),
                );
              }
            }
            if (!bytes) throw Error("Preview unavailable");
            preview = await savePreview(user, item.local, bytes);
          } catch (error) {
            if (
              error instanceof PickerExpired ||
              error instanceof GoogleUnavailable ||
              error instanceof TypeError ||
              error instanceof DOMException
            )
              throw error;
            failed = true;
          }
          // Google gives derivative bytes only. Keep original size and content hash unknown.
          await sql`insert into media(id,owner,import_id,filename,kind,bytes,google_id,category,state,position,taken_at,sort_at,thumb,work,pixels,phash,screenshot)
       values(${item.local},${user},${s.id},${name},${kind},null,${item.id},${kind === "video" ? "Videos" : "Other photos"},${failed ? "error" : "ready"},${position},${item.createTime ?? null},coalesce(${item.createTime ?? null}::timestamptz,'-infinity'),${preview?.small ?? null},${preview?.large ?? null},${preview?.pixels ?? null},${kind === "photo" ? (preview?.phash ?? null) : null},${item.mediaFile.mimeType === "image/png" || /screenshot/i.test(name)})
       on conflict(owner,google_id) where google_id is not null do update set id=excluded.id,import_id=excluded.import_id,position=excluded.position,state=excluded.state,thumb=excluded.thumb,work=excluded.work,pixels=excluded.pixels,phash=excluded.phash where media.state='error'`;
        }),
      );
      const [n] =
        await sql`select count(*)::int as total,count(*) filter(where state='error')::int as errors from media where import_id=${s.id}`;
      await sql`update photo_sessions set completed=${n.total},errors=${n.errors} where lease=${lease}`;
      if (
        outcomes.some(
          (o) => o.status === "rejected" && o.reason instanceof PickerExpired,
        )
      ) {
        await clean();
        await finish("repick");
      } else if (outcomes.some((o) => o.status === "rejected"))
        throw new GoogleUnavailable();
      else if (n.total >= selected.length) {
        await clean();
        await finish("done");
      }
    }
  } catch (error) {
    if (error instanceof PickerExpired) await finish("repick");
    else throw error;
  } finally {
    await sql`update photo_sessions set lease=null,lease_until=null where lease=${lease}`;
  }
  return photoStatus(user);
}

// Continue a confirmed import after the response. A return visit or cron run
// can claim the same durable session if this invocation reaches its time limit.
export async function drainPhotos(user: string, id: string) {
  const end = Date.now() + 190000;
  let failures = 0;
  while (Date.now() < end) {
    try {
      const status = await stepPhotos(user, "advance", id);
      if (status.state !== "fetching" || status.id !== id) return;
      failures = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      if (error instanceof ConnectPhotos || ++failures > 3) return;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** failures));
    }
  }
}
