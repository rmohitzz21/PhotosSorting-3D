import { after } from "next/server";
import { auth } from "../../../auth";
import {
  photoStatus,
  stepPhotos,
  drainPhotos,
} from "../../../lib/photo-picker";
import { ConnectPhotos } from "../../../lib/picker-protocol";
export const maxDuration = 300;
export async function GET() {
  const user = (await auth())?.user?.id;
  if (!user) return new Response(null, { status: 401 });
  return Response.json(await photoStatus(user), {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function POST(req: Request) {
  const user = (await auth())?.user?.id;
  if (!user) return new Response(null, { status: 401 });
  if (
    req.headers.get("origin") !== new URL(process.env.AUTH_URL || req.url).origin ||
    !req.headers.get("content-type")?.startsWith("application/json")
  )
    return new Response(null, { status: 403 });
  const { action, id, estimate } = await req.json();
  if (
    !["start", "advance", "confirm", "cancel"].includes(action) ||
    (action !== "start" && typeof id !== "string")
  )
    return new Response(null, { status: 400 });
  try {
    const status = await stepPhotos(user, action, id, estimate);
    if (action === "confirm" && status.state === "fetching")
      after(() => drainPhotos(user, id));
    return Response.json(status);
  } catch (e) {
    if (e instanceof ConnectPhotos)
      return Response.json({ connect: true });
    const message =
      e instanceof Error &&
      [
        "This selection exceeds your monthly labeling budget.",
        "The estimate changed. Review it again.",
      ].includes(e.message)
        ? e.message
        : null;
    return Response.json(
      {
        message: message ?? "Google Photos import paused. Resume to try again.",
      },
      { status: message ? 409 : 503 },
    );
  }
}

