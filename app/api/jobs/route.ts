import { after } from "next/server";
import { drainPhotos } from "../../../lib/photo-picker";
import { enqueue, runBatch } from "../../../lib/jobs";
import { owner, db } from "../../../lib/db";
export const maxDuration = 300;
export async function POST(req: Request) {
  const user = await owner(),
    { id } = await req.json();
  await enqueue(user, id);
  return Response.json({ worked: await runBatch(user) });
}
export async function GET(req: Request) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get("authorization") !== "Bearer " + process.env.CRON_SECRET
  )
    return new Response(null, { status: 401 });
  const [session] =
    await db()`select owner,id from photo_sessions where state='fetching' and (lease_until is null or lease_until<now()) order by deadline limit 1`;
  if (session) {
    after(() => drainPhotos(session.owner, session.id));
    return Response.json({ resumed: true });
  }
  return Response.json({ worked: await runBatch() });
}
