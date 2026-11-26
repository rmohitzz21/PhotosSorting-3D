"use server";
import { auth, signIn } from "../auth";
import { pickerScope } from "../lib/picker-protocol";
export async function connectPhotos() {
  const session = await auth();
  if (!session?.user?.id) throw Error("Sign in first.");
  await signIn(
    "google",
    { redirectTo: "/?photos=connected" },
    {
      scope: "openid email profile " + pickerScope,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      login_hint: session.user.email ?? session.user.id,
    },
  );
}
