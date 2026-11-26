import { owner, db } from "../../../../lib/db";
export const maxDuration = 60;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await owner(),
    { id } = await params,
    sql = db();
  const [batch] =
    await sql`select expected from imports where id=${id} and owner=${user}`;
  if (!batch) return new Response(null, { status: 404 });
  let stopped = false;
  const stream = new ReadableStream({
    async start(controller) {
      let previous = "";
      try {
        for (let t = 0; t < 25 && !request.signal.aborted && !stopped; t++) {
          const [p] =
            await sql`select count(*) filter(where state<>'uploading')::int as received,count(*) filter(where state='error')::int as errors from media where import_id=${id} and owner=${user}`;
          const data = JSON.stringify({ ...p, total: batch.expected });
          if (data !== previous && !stopped) {
            controller.enqueue(
              new TextEncoder().encode("data: " + data + "\n\n"),
            );
            previous = data;
          }
          if (p.received >= batch.expected) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } finally {
        if (!stopped) controller.close();
      }
    },
    cancel() {
      stopped = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store",
    },
  });
}
