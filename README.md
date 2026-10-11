# Visor (v6)

See who actually did the work. Teachers create a project and add their students. Visor combines the group's meeting recordings with their Google Docs or Slides history into a fair, evidence-based report of who contributed what.

**New in v6:**
- **Runs on Firebase.** Hosting serves the site, Cloud Functions runs the server, Firestore keeps accounts and projects, and Cloud Storage keeps recordings (private).
- **People choose their school.** Pick a school that's already on Visor, type the name of a new one, or leave it blank. Email addresses no longer decide anything. Teachers add students from their school by name, or anyone by typing their full email address.
- Recordings upload in 4 MB pieces, so files up to 60 MB work through Firebase Hosting.
- **Gemini runs through Vertex AI** in the same project: no API key, billed on the project's normal Google Cloud billing, and covered by the spending cut-off.

## Put it on Firebase

You need: a Google account, a card for the Blaze plan (a class-sized app stays inside the free allowances), Node.js 22 or newer, and the Terminal app.

### 1. Install the Firebase tools (once)

```bash
npm install -g firebase-tools
firebase login
```

### 2. Create the Firebase project (in your browser)

1. Go to **console.firebase.google.com** → **Create a project**. At the bottom of the first screen, choose **add Firebase to an existing Google Cloud project** and pick the project that has your Google sign-in OAuth client. That keeps your Google client ID, API key and Drive picker working without changes.
2. **Upgrade to Blaze:** the gear icon → **Usage and billing** → **Details & settings** → **Modify plan** → **Blaze**. Then set a budget alert (for example $1) so you're emailed if anything ever costs money.
3. **Firestore:** **Build → Firestore Database → Create database**. If asked, choose **Standard edition**. Location: **nam5 (United States)**. Start in **production mode**.
4. **Storage:** **Build → Storage → Get started**. Location: **US-CENTRAL1** (the free allowance only applies in US-CENTRAL1, US-EAST1 and US-WEST1). Start in **production mode**.

### 3. Fill in the settings

In this folder, copy `.env.example` to a new file named `.env` and paste in the same three Google values you used on Vercel: `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID`.

### 4. Turn on Vertex AI

Visor uses Gemini through Vertex AI, signed in as its own server, so there's no Gemini key to manage. In **console.cloud.google.com** (same project), search for **Vertex AI API** in the top bar → **Enable**.

### 5. Deploy (in Terminal, inside this folder)

```bash
npm install
firebase use --add
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy
```

- `firebase use --add` asks which project; pick the one from step 2 and call it `default`.
- `secrets:set` only matters if you switch to a Gemini API key (`GEMINI_VIA=apikey` in `.env`). The deploy still expects the secret to exist, so if you've never set it, paste any placeholder text such as `unused`.
- The first deploy takes a few minutes and may ask to turn on some Google APIs (say yes) and how long to keep old build images (the default is fine). If it fails on the `transcribe` function with a permissions or Eventarc message, wait 3 minutes and run `firebase deploy` again. Google is still setting up permissions for the new project.
- When it finishes it prints **Hosting URL: https://YOUR-PROJECT.web.app**. That's the site.

### 6. Point Google sign-in at the new address

In **console.cloud.google.com** (same project):
- **APIs & Services → Credentials → your OAuth client → Authorized JavaScript origins:** add `https://YOUR-PROJECT.web.app` and `https://YOUR-PROJECT.firebaseapp.com`.
- **APIs & Services → Credentials → your API key → Website restrictions:** add `https://YOUR-PROJECT.web.app/*`.
- **Google Auth Platform → Branding:** change the home page, privacy policy (`/privacy`) and terms (`/terms`) links to the new address, and add `YOUR-PROJECT.web.app` under **Authorized domains**.

### 7. Point the Chrome extension at the new address

In the extension's `sidepanel.js`, change `VISOR_WEB_URL` to `https://YOUR-PROJECT.web.app`, raise the version in `manifest.json`, and upload the update. In the Chrome Web Store listing, change the privacy policy URL to `https://YOUR-PROJECT.web.app/privacy`.

### Optional: shut off spending at a limit

Blaze has no built-in spending cap, and a budget alert only sends email. `index.js` includes a `stopBilling` function that removes billing from the project when spending passes a budget you set. That stops every charge, and it also takes the site offline until you link billing again. Google warns that after billing is removed, resources "might be irretrievably deleted" and recovery isn't guaranteed, so treat this as an emergency brake: accounts and recordings could be lost. Google's cost figures arrive hours late, so the final bill can end up somewhat over the amount; set the budget lower than what you can accept.

After `firebase deploy` (which creates the `visor-budget` topic), in **console.cloud.google.com**:

1. **Turn on the Cloud Billing API:** search for "Cloud Billing API" in the top search bar → **Enable**.
2. **Find the server's account name:** **IAM & Admin → IAM**, and copy the entry that ends in `-compute@developer.gserviceaccount.com`.
3. **Let it turn billing off:** **Billing → Account management** → **Add principal** → paste that name → role **Billing Account Administrator** → Save.
4. **Create the budget:** **Billing → Budgets & alerts → Create budget**. Scope: this project. Amount: your limit (for example $5). Under **Manage notifications**, tick **Connect a Pub/Sub topic to this budget**, and choose this project and the topic `visor-budget`. Save.

To check it's connected: `firebase functions:log --only stopBilling` shows a line like "$0 of $5 used; nothing to do" a few times a day.

To bring the site back after a cut-off: **Billing → Account management → My projects** → the project's ⋮ menu → **Change billing** → pick your billing account.

### Updating later

Edit the files, then run `firebase deploy` again. For page-only changes (anything in `public/`), `firebase deploy --only hosting` is faster. To see server errors: `firebase functions:log`.

## Run it on your computer

```bash
npm install
npm start
```

Then open http://localhost:3000. Put `GEMINI_API_KEY` (and `SESSION_SECRET` if you share the server) in a file named `.env.local`. Data goes in `data/` (an embedded database and the audio files).

## How it works

1. **Accounts.** Sign up with email and password, or with Google. Pick Student or Teacher. Choosing a school is optional and can be changed any time in Profile settings. If someone signs in with Google using an email that already has a password account, Google has proven they own the email, so the account switches to Google sign-in only and the old password stops working.
2. **Teachers create projects** and add students: by name for students who picked the same school (at least 2 letters, up to 10 matches), or by full email address for anyone.
3. **Resources tab.** Anyone in the project can add:
   - **Document data from the Visor extension.** On the extension's Overview tab, type the project code (the `#` chip, which only teachers see) under **Send to Website**. Re-sending the same document replaces the earlier report.
   - **From Google Drive.** Pick a Doc or Slides file in Google's picker. Visor diffs its saved revisions and credits each change to whoever saved it.
   - **Audio**, by uploading a file or recording in the browser. Gemini transcribes it and separates the voices, then Visor asks "Who is this?" for each voice.
4. **Clicking a document** opens the same tabs as the extension's side panel: Overview (totals, growth, activity by day and hour), People, Timeline (writing sessions, or Drive saves), Evidence (each paste and deletion: who, when, how big; the text stays in the extension) and Signal (how the text arrived). Reports sent from extension versions before 3.1 show fewer of these; sending again fills them in.
5. **Analysis tab.** The teacher runs it. Visor combines every document report and transcript, adds each student's writing habits (typed vs. pasted, external pastes, active time, sessions, typing speed) across all their documents, and Gemini writes the report. The teacher chooses whether students can see it.

## How it runs on Firebase

| Piece | What it does |
|---|---|
| Hosting | Serves `public/`. Sends `/api/**`, `/privacy` and `/terms` to the `api` function. |
| `api` function | The Express app in `server.js`. |
| `transcribe` function | Starts when `api` writes a job to `visor_jobs`; downloads the recording, has Gemini transcribe it, saves the result. |
| Firestore | `visor/core` (accounts, schools, projects), `visor_resources`, `visor_analyses`, `visor_meta/session` (the cookie-signing secret, made automatically). Rules block all browser access. |
| Cloud Storage | `audio/…` recordings. Rules block all browser access; people play recordings through the signed-in `/api` route. |
| `stopBilling` function | Optional spending cut-off; see "shut off spending at a limit". |
| Vertex AI | Gemini: transcribes recordings (read straight from Cloud Storage) and writes the analysis. The server signs in as its own service account. |
| Secret Manager | `GEMINI_API_KEY`, only used with `GEMINI_VIA=apikey`. |

## Files

```
index.js             Firebase entry: the api, transcribe and stopBilling functions
server.js            Express app: accounts, schools, projects, resources, Gemini, analysis
firebase.json        Hosting rewrites, function settings, rules files
firestore.rules      Deny all browser access
storage.rules        Deny all browser access
lib/platform.js      Firebase or local?
lib/repo.js          Picks the data store: repoFirestore.js on Firebase, repoSql.js locally
lib/audioStorage.js  Recordings: Cloud Storage or data/audio, uploaded in pieces
lib/session.js       The signed sign-in cookie (__session)
lib/reports.js       Turns extension, Drive and older reports into one report shape
lib/drive.js         Google Drive revisions → who added/removed what
lib/legalPages.js    /privacy and /terms
public/              index.html, app.js, app.css, logos
```

## Limits and notes

- **Recordings:** up to 60 MB each (MP3, M4A, WAV, WebM, OGG). Transcription can run for up to 9 minutes per recording. If it fails, the recording shows **Try again**; a recording that transcribed fine can't be re-run.
- **Abandoned uploads:** if someone closes the page partway through an upload, its pieces stay in the `uploads/` folder of Cloud Storage. Optional tidy-up: in Google Cloud Console → Cloud Storage → your bucket → **Lifecycle** → add a rule to delete objects with the prefix `uploads/` after 1 day.
- **Hosting waits 60 seconds** for the server. Uploads and transcription are built around that. If an analysis takes longer, the page keeps checking and shows it when it's ready.
- **Scale:** the server runs at most 10 copies at once (`maxInstances` in `index.js`), which caps cost. All accounts and projects share one compressed Firestore document, which has room for many thousands of accounts.
- **Cost:** Firebase's free allowances cover a class easily. Gemini (Vertex AI) is billed on the same Google Cloud billing account, roughly 4¢ per 30-minute recording and 1¢ per analysis with Flash-Lite.
- **If Gemini fails:** "Vertex AI API has not been used" → step 4 wasn't done (or wait a few minutes after enabling). "Permission … aiplatform.endpoints.predict denied" → in **IAM & Admin → IAM**, give the account ending in `-compute@developer.gserviceaccount.com` the role **Vertex AI User**. Details: `firebase functions:log`.
- **Running on your computer** still uses a Gemini API key from `.env.local`.
- **Coming from Vercel:** accounts and projects made on the Vercel site are not copied over. People sign up again on the new address.
- **If you change what Visor collects,** update `lib/legalPages.js`. That page is the privacy policy linked from Google's sign-in screen.
- **Testing:** `VISOR_DEV_LOGIN=1 npm start` enables `GET /dev/login?email=…` for password-free local testing. It never works on Firebase. `GEMINI_BASE_URL` and `DRIVE_API_BASE` can point at stand-in services.
