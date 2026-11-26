# Shoebox

Phase 1 imports local photo folders and Google Takeout archives. The browser hashes originals and sends previews to the server. Private Vercel Blob storage holds thumbnails and working copies. Videos have placeholders and support exact duplicate detection.

## Run and deploy

Use Node 24 and `npm ci`. Apply `schema.sql` to a Neon database. Connect a private Vercel Blob store, then configure the variables in `.env.example` locally or in the Vercel project. Generate a random Auth.js secret and register the Google OAuth web client callback at `https://YOUR-DOMAIN/api/auth/callback/google`. Local development uses `http://localhost:3000/api/auth/callback/google`.

Run `npm run dev` locally, `npm test` for acceptance fixtures, and `npm run build` for a production build. Select the Next.js preset and Node 24 when deploying to Vercel.

AI labeling is disabled by default. Before enabling it, verify Gateway model access and set a conservative upper bound for a single 72-item call in BATCH_MAX_USD. The monthly reservation includes all three permitted attempts. Configure CRON_SECRET for authenticated job recovery. The browser drains active batches during import. The fallback cron runs daily.

Takeout ZIP import currently accepts archives up to 512 MB and 500 media items. Larger archives can be extracted and imported in smaller folders. GPS and capture dates are read from matching JSON sidecars inside ZIPs.

## Google Photos Picker and OAuth review

Apply the updated schema before deploying Phase 2. Enable **Google Photos Picker API** in the Cloud project that owns the existing web OAuth client. Add a test user to the consent screen. The integration reuses the Auth.js callback and requests Photos permission from the import screen. Keep AUTH_SECRET stable because it protects stored Google tokens.

Review submission draft for the Photos scope:

> Shoebox lets a user choose personal photos and videos in the Google Photos Picker for duplicate review, categorization and CSV export. The requested scope creates a selection session, reads the items the user chooses, retrieves previews, and closes the session. The app stores private derivatives. Users can delete imported data and stored authorization tokens in the library.

For the review recording, start signed out, sign in, open the Photos import, show incremental consent and the requested scope, pick two items, confirm the cost, and show the duplicate review, CSV export and data deletion controls. Register the deployed homepage and /privacy URL under the verified domain. The project owner must supply the support address, deployment URLs and recording in Google Auth Platform's Verification Center. Submission is pending.

The selection is limited to 500 items per import. Shoebox saves completed items and resumes outstanding downloads while their addresses remain valid. An expired selection asks the user to pick the remaining items again. Google omits original sizes, so the reclaimable total includes only copies with known sizes. Repeated selections skip previously imported Google media IDs.

[Configure the Picker API](https://developers.google.com/photos/overview/configure-your-app) · [OAuth verification submission](https://support.google.com/cloud/answer/13461325) · [Partner program eligibility](https://developers.google.com/photos/partner-program/overview)
# PhotosSorting-3D
