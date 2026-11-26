import { saveGrant } from "./lib/photo-tokens";
import { pickerScope } from "./lib/picker-protocol";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
export const googleConfigured = Boolean(process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim());
export const { handlers, auth, signIn, signOut } = NextAuth({
  pages: { error: "/signin-error" },
  providers: googleConfigured ? [
    Google({ checks: ["pkce","state","nonce"], authorization: { params: { scope: "openid email profile", response_mode: "query" } } }),
  ] : [],
  callbacks: {
    async jwt({ token, account }) {
      if (
        account?.scope?.split(" ").includes(pickerScope) &&
        account.access_token
      )
        await saveGrant(
          account.providerAccountId,
          account.access_token,
          account.expires_at ?? 0,
          account.refresh_token,
        );
      if (account) token.sub = account.providerAccountId;
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub!;
      return session;
    },
  },
});


