export default function Privacy() {
  return (
    <main>
      <a href="/">Back to Shoebox</a>
      <h1>Google Photos data</h1>
      <p>
        Shoebox uses your Google account identifier to keep your library
        private. When you connect Google Photos, Shoebox reads the items you
        select, their filenames and capture times. It stores encrypted
        authorization tokens, private previews, duplicate fingerprints and
        organization results. Temporary download addresses support interrupted
        imports.
      </p>
      <p>
        Vercel hosts Shoebox and its private preview storage. Neon stores
        library records. When AI labeling is enabled, the import confirmation
        shows the estimated cost and explains that preview sheets go through
        Vercel AI Gateway for labeling.
      </p>
      <p>
        Use Delete my data in your library to remove saved items, previews and
        stored tokens. You can also revoke Shoebox access in your Google
        Account’s third-party connections.
      </p>
      <p>
        Shoebox uses information received from Google Photos APIs in accordance
        with the Google API Services User Data Policy, including its Limited Use
        requirements.{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
      </p>
    </main>
  );
}
