import { enqueue } from "../../../lib/jobs";
import { db, owner } from "../../../lib/db";
import { savePreview } from "../../../lib/save-preview";
import { importCost } from "../../../lib/import-cost";
import { seedRows } from "../../../lib/categories";
export async function POST(req: Request) {
  const user = await owner(),
    sql = db();
  if (req.headers.get("content-type")?.includes("application/json")) {
    const { count, confirm } = await req.json();
    if (!Number.isInteger(count) || count < 1 || count > 500)
      return new Response("Choose up to 500 items.", { status: 400 });
    const { enabled, estimate, limit } = importCost(count);
    if (!confirm) return Response.json({ estimate, enabled });
    await sql`insert into users(id) values(${user}) on conflict do nothing`;
    for (const row of seedRows(user))
      await sql`insert into categories(owner,key,kind,label,emoji,rule,sort_order)
        values(${row.owner},${row.key},${row.kind},${row.label},${row.emoji},${row.rule},${row.sort_order})
        on conflict(owner,key) do nothing`;
    const id = crypto.randomUUID();
    const inserted =
      await sql`with charged as (insert into budgets(owner,month,amount) select id,date_trunc('month',now()),${estimate}::numeric from users where id=${user} and not deleting and ${estimate}::numeric<=${limit}::numeric on conflict(owner,month) do update set amount=budgets.amount+excluded.amount where budgets.amount+excluded.amount<=${limit}::numeric returning owner) insert into imports(id,owner,expected,model_enabled) select ${id},owner,${count},${enabled} from charged returning id`;
    return inserted.length
      ? Response.json({ id })
      : new Response(
          "Import paused. Your monthly budget or account deletion prevents this import.",
          { status: 409 },
        );
  }
  const form = await req.formData(),
    id = String(form.get("id")),
    batch = String(form.get("import")),
    name = String(form.get("name")).slice(0, 500),
    kind = form.get("kind") === "video" ? "video" : "photo";
  const file = form.get("preview"),
    hash = String(form.get("hash") || ""),
    index = Number(form.get("index")),
    time = (form.get("time") as string) || null;
  const reserved =
    await sql`insert into media(id,owner,import_id,filename,kind,bytes,hash,category,state,position,taken_at,sort_at,geo) select ${id},i.owner,i.id,${name},${kind},${Number(form.get("bytes"))},${hash || null},${kind === "video" ? "Videos" : "Other photos"},'uploading',${index},${time},coalesce(${time}::timestamptz,'-infinity'),${(form.get("geo") as string) || null}::jsonb from imports i join users u on u.id=i.owner where i.id=${batch} and i.source is distinct from 'picker' and i.owner=${user} and not u.deleting and ${index} between 0 and i.expected-1 on conflict do nothing returning id`;
  if (!reserved.length)
    return new Response("Item already received or import closed.", {
      status: 409,
    });
  try {
    if (!(file instanceof File)) {
      await sql`update media set state=${kind === "video" && hash ? "ready" : "error"} where id=${id}`;
      await enqueue(user, batch);
      return Response.json({ id });
    }
    const input = Buffer.from(await file.arrayBuffer());
    const { small, large, pixels, phash } = await savePreview(user, id, input);
    await sql`update media set thumb=${small},work=${large},pixels=${pixels},phash=${phash},screenshot=${/\.png$|screen.?shot/i.test(name)},state='ready' where id=${id}`;
  } catch {
    await sql`update media set state='error' where id=${id}`;
  }
  await enqueue(user, batch);
  return Response.json({ id });
}
