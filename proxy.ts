import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const configured = process.env.AUTH_URL;
  if (!configured) return NextResponse.next();
  const canonical = new URL(configured);
  const host = request.headers.get("host");
  if (canonical.hostname === "localhost" && host === "127.0.0.1:" + canonical.port) {
    const destination = new URL(request.nextUrl.pathname + request.nextUrl.search, canonical);
    return NextResponse.redirect(destination, 307);
  }
  return NextResponse.next();
}
