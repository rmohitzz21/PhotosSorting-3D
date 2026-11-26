import { auth } from "../auth";
export { db } from "./database";
export async function owner() {
  const session = await auth();
  if (!session?.user?.id) throw Error("Sign in to open your library.");
  return session.user.id;
}
