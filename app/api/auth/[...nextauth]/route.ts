import type { NextRequest } from "next/server";
import { handlers } from "../../../../auth";

export function GET(request: NextRequest) {
  // Direct visits go to the sign-in form. Auth.js starts OAuth through POST.
  if (request.nextUrl.pathname.replace(/\/$/, "") === "/api/auth/signin/google")
    return new Response(null, { status: 303, headers: { Location: "/", "Cache-Control": "no-store" } });
  if (request.nextUrl.pathname === "/api/auth/callback/google" &&
      !request.nextUrl.searchParams.has("code") && !request.nextUrl.searchParams.has("error")) {
    return new Response(null,{status:303,headers:{Location:"/signin-error?error=IncompleteCallback","Cache-Control":"no-store"}});
  }
  return handlers.GET(request);
}
export const POST = handlers.POST;

