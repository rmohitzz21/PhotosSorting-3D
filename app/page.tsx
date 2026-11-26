import { auth, signIn, signOut, googleConfigured } from "../auth";
import Library from "./library";
export default async function Home() {
  const session = await auth();
  return (
    <>
      <header>
        <strong>
          <span className="mark">▧</span> Shoebox
        </strong>
        {session && (
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button>Sign out</button>
          </form>
        )}
      </header>
      {session ? (
        <Library />
      ) : (
        <main className="welcome">
          <div className="print">▧</div>
          <h1>Your photo library</h1>
          <p>
            Bring in a folder or Google Takeout archive to find photos and
            review duplicate copies.
          </p>
          {googleConfigured ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button className="primary">Continue with Google</button>
          </form>) : <p role="status">Google sign-in is awaiting setup. The app owner needs to configure the Google OAuth client ID and secret.</p>}
        </main>
      )}
      <footer>
        <a href="/privacy">Google Photos data and privacy</a>
      </footer>
    </>
  );
}

