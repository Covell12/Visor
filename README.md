# Visor Classroom (v7)

A writing and research platform for middle and high school classes. Students write in Visor's own editor during teacher-started writing sessions (in-class essays that replace handwritten ones, or homework); Visor records the whole writing process, and the Visor Chrome extension records research during the session, keeps locked sessions on allowed sites, and adds citations in one click. Around that: classes and rosters, group projects (the original Visor: Google Docs history, Drive import, meeting recordings, an AI-written contribution summary), and recorded class discussions.

Visor shows what was measured (what was typed, pasted, from where, when, how long the student was away) and leaves the judgment to the teacher. It never labels writing as AI-generated or gives a probability. Gemini is used only to transcribe recordings and to write the group-project and discussion summaries, and every AI-written passage says so.

**New in v7 (Visor Classroom):**
- **Classes:** create, rename, archive, delete; a join code (rotate it, close joining); add students by email, with invites for addresses that don't have an account yet (they join when they sign up); extra time per student; optional Google Classroom roster import.
- **Assignments:** Writing (presets: *In-class essay (locked)* and *Homework essay (open)*), Group project, Discussion. Publish / unpublish, duplicate to another class.
- **Visor Writer** (`/write/:id`): a Quill editor where every edit becomes an op the server applies to its own copy of the text; writing sessions with focus pauses, time limits, session windows, accommodations, paste rules, offline queueing, a lease so only one surface (the tab or the extension's side panel) writes at a time, and citations with Works Cited in MLA, APA or Chicago. Each source gets a reliability grade, A to D, with its reasons (`public/source-grade.js`: rules about the kind of site and whether it names an author and a date; no AI, nothing fetched).
- **Teacher tools:** a live session board (pause, message, add time, end, for one student or everyone), and a review page per essay: the document with "Color by source", a keystroke replay, a process report built on the same engine as the extension, the research log, feedback and scores, and print / save as PDF.
- **Group projects in classes:** one project per group, with the group's Google Doc linked; the connected extension sends that Doc's history automatically.
- **Class discussions:** record in the browser (10-minute segments) or upload; voices matched to the roster; measured talk time, turns and who-follows-whom; a labelled AI-written summary.
- **Privacy:** research retention per class (180 days by default), teachers delete a student's data, students download their own data, an under-13 gate at sign-up. See `/privacy`.

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

The extension only talks to the Visor addresses it lists, in two places that must match exactly:

1. `extension/config.js`: add `https://YOUR-PROJECT.web.app` (and the `firebaseapp.com` one) to `VISOR_WEB_ORIGINS`, and set `VISOR_DEFAULT_ORIGIN` to it.
2. `extension/manifest.json`: add `https://YOUR-PROJECT.web.app/*` (and `https://YOUR-PROJECT.firebaseapp.com/*`) to the `matches` of the content script whose `js` is `site-bridge.js`.

Raise the version in `manifest.json`, then make the upload in the extension folder with `node tools/build-release.js dist/visor-release dist/visor-release.zip` and upload `dist/visor-release.zip`. Never upload the source folder: it also trusts `http://localhost:3000` (for local testing), which the release build takes out. In the Chrome Web Store listing, change the privacy policy URL to `https://YOUR-PROJECT.web.app/privacy`. The same applies to a custom domain: list it in both places. (The server needs nothing for this: `/api/ext/*` accepts any `chrome-extension://` origin, without cookies.)

### Optional: shut off spending at a limit

Blaze has no built-in spending cap, and a budget alert only sends email. `index.js` includes a `stopBilling` function that removes billing from the project when spending passes a budget you set. That stops every charge, and it also takes the site offline until you link billing again. Google warns that after billing is removed, resources "might be irretrievably deleted" and recovery isn't guaranteed, so treat this as an emergency brake: accounts and recordings could be lost. Google's cost figures arrive hours late, so the final bill can end up somewhat over the amount; set the budget lower than what you can accept.

After `firebase deploy` (which creates the `visor-budget` topic), in **console.cloud.google.com**:

1. **Turn on the Cloud Billing API:** search for "Cloud Billing API" in the top search bar → **Enable**.
2. **Find the server's account name:** **IAM & Admin → IAM**, and copy the entry that ends in `-compute@developer.gserviceaccount.com`.
3. **Let it turn billing off:** **Billing → Account management** → **Add principal** → paste that name → role **Billing Account Administrator** → Save.
4. **Create the budget:** **Billing → Budgets & alerts → Create budget**. Scope: this project. Amount: your limit (for example $5). Under **Manage notifications**, tick **Connect a Pub/Sub topic to this budget**, and choose this project and the topic `visor-budget`. Save.

To check it's connected: `firebase functions:log --only stopBilling` shows a line like "$0 of $5 used; nothing to do" a few times a day.

To bring the site back after a cut-off: **Billing → Account management → My projects** → the project's ⋮ menu → **Change billing** → pick your billing account.

### Optional: deploy automatically from GitHub

`.github/workflows/deploy.yml` runs `firebase deploy` every time you push to the `web-app` branch.

1. **A deploy account:** in **console.cloud.google.com** (your Firebase project) → **IAM & Admin → Service Accounts → Create service account**. Name it `github-deploy`. Give it the roles **Editor** and **Service Account User**. Then open it → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Treat it like a password: never put it in the repo.
2. **Two GitHub secrets:** your repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `FIREBASE_SERVICE_ACCOUNT`: paste the whole contents of the `.json` file.
   - `VISOR_ENV`: paste the whole contents of your `.env` file.
3. **Push.** The **Actions** tab shows each deploy. Delete the downloaded `.json` file afterwards.

If the key is ever exposed, delete it on the service account's **Keys** tab and make a new one.

### Updating later

Edit the files, then run `firebase deploy` again. For page-only changes (anything in `public/`), `firebase deploy --only hosting` is faster. To see server errors: `firebase functions:log`.

## Run it on your computer

```bash
npm install
npm start
```

Then open http://localhost:3000. Put `GEMINI_API_KEY` (and `SESSION_SECRET` if you share the server) in a file named `.env.local`. Data goes in `data/` (an embedded database and the audio files). Without a Gemini key everything works except transcription and the AI-written summaries, which say they're unavailable.

### With the extension

1. Start the web app (above). For quick testing, `VISOR_DEV_LOGIN=1 npm start` and sign in at `http://localhost:3000/dev/login?email=…` (an account with that email must exist).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, and choose the `extension/` folder next to this one: a checkout of this repository's `extension` branch (from this folder, `git worktree add ../extension extension` makes one). `http://localhost:3000` is already in its `config.js` and `manifest.json`.
3. Sign in to the web app as a student and open **Connect extension** on Home (`/extension/connect`).
4. Open a writing assignment and start a session: the extension's icon shows **REC**, its side panel holds your essay, and **Cite this page** (or Alt+Shift+C) cites the page you're on.

### Settings (`.env`, `.env.local`)

| Variable | What it does |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY`, `GOOGLE_APP_ID` | Sign in with Google and the Drive picker (as before). |
| `CLASSROOM_IMPORT=1` | Turns on **Import from Google Classroom** on a class's Students tab (needs `GOOGLE_CLIENT_ID`, and the Classroom API enabled for that OAuth client with the scopes `classroom.courses.readonly`, `classroom.rosters.readonly`, `classroom.profile.emails`). The browser gets the token from Google and sends only email addresses to Visor; the token never reaches the server. Off: the button is shown disabled with an explanation. |
| `VISOR_DEV_LOGIN=1` | Local only: `GET /dev/login?email=…`. Never works on Firebase. |
| `GEMINI_BASE_URL`, `VERTEX_BASE_URL`, `DRIVE_API_BASE` | Point at stand-in services (tests). |
| `VISOR_AUDIO_DIR`, `PGLITE_DIR` | Where local recordings and the embedded database go (tests use temp folders). |

### Tests

```bash
npm test
```

`node:test`, no framework: the op model, sessions and pauses, paste origins, citations, the process report on the shared engine, discussions, both data stores (Firestore through an in-memory stand-in), and the whole classroom flow over HTTP on a temporary local database. Nothing reaches Firebase, Google or Gemini (one test runs a stand-in Gemini on this machine).

### Keeping shared code in step

- `npm run sync-engine` copies `../extension/changelog.js` (the one analysis engine) to `lib/engine/` and `public/engine/`, and the browser modules the server shares (`cite-format.js` as `lib/cite.js`, `doc-format.js`, `assignment-text.js`, `source-grade.js`) from `public/` to `lib/`. It runs before every deploy; without the extension next to this folder it keeps the committed copies. `test/engine-sync.test.js` and `test/cite.test.js` check the copies match.
- Two things are also kept by hand in the extension: the reliability grade (copy `public/source-grade.js` to the extension's `source-grade.js`) and the AI-site list (`lib/sites.js` here, `DEFAULT_AI_SITES` in the extension's `config.js`). With the extension next to this folder, `test/source-grade.test.js` and `test/engine-sync.test.js` fail if either differs.
- `npm run vendor` copies Quill 2.0.3 from `node_modules` into `public/vendor/quill/` (committed: school filters often block CDNs).

## How it works: Visor Classroom

1. **Classes.** A teacher creates a class and shares its join code, or adds students by email. Students join with the code (at sign-up or later). Students confirm they're 13 or older, or were signed up by their school.
2. **Writing assignments.** Locked (in class: Visor extension required, full screen, students kept to allowed sites, pasting only from their own essay, AI sites blocked) or open (homework: everything recorded, little blocked). Time limits count every session together and include each student's extra time.
3. **Writing sessions.** The student starts a session in the editor. Writing is on only while their Visor tab (or the extension's side panel) has focus and holds the editing lease; leaving it pauses writing at once, and the server records the pause with its reason and length. Every edit is an op (`lib/writing.js`) checked and applied by the server; the op log, in 500-op chunks with snapshots every 2,000 ops, is what the replay and the process report read.
4. **Research.** During a session the extension records searches, pages and time on them, copies, AI sites and citations (`/api/ext/research`). A paste whose text matches something the student copied in the last 3 hours is linked to that page; anything else is "pasted from outside Visor's view".
5. **Review.** The teacher's live board shows every student as they write. After submission, the review page shows the essay (and where each part of it came from), a replay, the process report (the extension's engine run on the op log, plus sessions, pastes, typing and rule-based notes for the teacher), the research log, and feedback.
6. **Group projects and discussions** reuse the project features below; discussions add measured talk time and turns.

## How it works: projects

1. **Accounts.** Sign up with email and password, or with Google. Pick Student or Teacher. Choosing a school is optional and can be changed any time in Profile settings. If someone signs in with Google using an email that already has a password account, Google has proven they own the email, so the account switches to Google sign-in only and the old password stops working.
2. **Teachers create projects** and add students: by name for students who picked the same school (at least 2 letters, up to 10 matches), or by full email address for anyone.
3. **Resources tab.** Anyone in the project can add:
   - **Document data from the Visor extension.** On the extension's Overview tab, under **Send to Visor**, pick the project (once the extension is connected) or type the project code (the `#` chip, which only teachers see). A connected student's linked group Doc is sent automatically. Re-sending the same document replaces the earlier report.
   - **From Google Drive.** Pick a Doc or Slides file in Google's picker. Visor diffs its saved revisions and credits each change to whoever saved it.
   - **Audio**, by uploading a file or recording in the browser. The server converts the sound to a small MP3 (so Chrome's WebM, Safari's MP4 and phone videos all work the same way), Gemini transcribes it and separates the voices, then Visor asks "Who is this?" for each voice.
4. **Clicking a document** opens the same tabs as the extension's side panel: Overview (totals, growth, activity by day and hour), People, Timeline (writing sessions, or Drive saves), Evidence (each paste and deletion: who, when, how big; the text stays in the extension) and Signal (how the text arrived). Reports sent from extension versions before 3.1 show fewer of these; sending again fills them in.
5. **Analysis tab.** The teacher runs it. Visor combines every document report and transcript, adds each student's writing habits (typed vs. pasted, external pastes, active time, sessions, typing speed) across all their documents, and Gemini writes the report. The teacher chooses whether students can see it.

## How it runs on Firebase

| Piece | What it does |
|---|---|
| Hosting | Serves `public/`. Sends `/api/**`, `/privacy` and `/terms` to the `api` function. |
| `api` function | The Express app in `server.js`. |
| `transcribe` function | Starts when `api` writes a job to `visor_jobs`; downloads the recording (or one 10-minute part of a class discussion), has Gemini transcribe it, saves the result. |
| `sweep` function | Daily (Cloud Scheduler): deletes extension research older than each class's retention period. |
| Firestore | `visor/core` (accounts, schools, projects, classes), `visor_resources`, `visor_analyses`, `visor_rec_<kind>` (assignments, student documents, op chunks, sessions, research, discussions, feedback, extension tokens), `visor_meta/session` (the cookie-signing secret, made automatically). Rules block all browser access. `firestore.indexes.json` holds the one composite index (research by class and date, for the sweep). |
| Cloud Storage | `audio/…` recordings. Rules block all browser access; people play recordings through the signed-in `/api` route. |
| `stopBilling` function | Optional spending cut-off; see "shut off spending at a limit". |
| Vertex AI | Gemini: transcribes recordings (read straight from Cloud Storage) and writes the analysis. The server signs in as its own service account. |
| Secret Manager | `GEMINI_API_KEY`, only used with `GEMINI_VIA=apikey`. |

## Files

```
index.js             Firebase entry: the api, transcribe, sweep and stopBilling functions
server.js            Express app: route sections only (accounts, schools, projects, resources,
                     Gemini, analysis, classes, assignments, writing, extension API, discussions)
lib/classes.js       Classes, join codes, invites, accommodations
lib/assignments.js   Writing / group / discussion assignments, presets, settings
lib/writing.js       The op model: applyOp, batches, chunks, snapshots
lib/sessions.js      Writing sessions: start checks, beats, pauses, deadlines, timeouts
lib/process.js       The process report (engine on the op log + measured facts + notes)
lib/research.js      Research events, paste-origin matching
lib/discussion.js    Discussion stats, segment hints, the AI summary's prompt and checks
lib/sites.js         The default AI-site list
lib/cite.js          Citation formatting (a copy of public/cite-format.js)
lib/engine/          The analysis engine (a copy of extension/changelog.js)
scripts/             sync-engine.js, vendor.js
test/                node:test tests
docs/                TEACHER-QUICKSTART.md
firebase.json        Hosting rewrites, function settings, rules files
firestore.rules      Deny all browser access
storage.rules        Deny all browser access
lib/platform.js      Firebase or local?
lib/repo.js          Picks the data store: repoFirestore.js on Firebase, repoSql.js locally
lib/audioStorage.js  Recordings: Cloud Storage or data/audio, uploaded in pieces
lib/audioFormats.js  The recording types Visor accepts (the page gets the same list)
lib/audioConvert.js  Converts a recording to a small MP3 for Gemini (ffmpeg-static)
lib/session.js       The signed sign-in cookie (__session)
lib/reports.js       Turns extension, Drive and older reports into one report shape
lib/drive.js         Google Drive revisions → who added/removed what
lib/legalPages.js    /privacy and /terms
public/              index.html, app.js, app.css, logos; Visor Classroom: router.js, classes.js,
                     assignments.js, writer.js, writer-session.js, review.js, replay-web.js,
                     live.js, discussions.js, cite-format.js, ext.js, classroom.css,
                     engine/changelog.js, vendor/quill/
```

## Limits and notes

- **Recordings:** up to 60 MB each: MP3, M4A, WAV, WebM, OGG, FLAC, AAC or AIFF audio, or MP4/MOV video (only the sound is used). Any other type is refused with a message saying which types work, before anything uploads. If a file has the right ending but no readable sound (damaged, or a video with no audio), the recording says so instead of transcribing. Transcription can run for up to 9 minutes per recording. If it fails, the recording shows **Try again**; a recording that transcribed fine can't be re-run.
- **Abandoned uploads:** if someone closes the page partway through an upload, its pieces stay in the `uploads/` folder of Cloud Storage. Optional tidy-up: in Google Cloud Console → Cloud Storage → your bucket → **Lifecycle** → add a rule to delete objects with the prefix `uploads/` after 1 day.
- **Hosting waits 60 seconds** for the server. Uploads and transcription are built around that. If an analysis takes longer, the page keeps checking and shows it when it's ready.
- **Scale:** the server runs at most 10 copies at once (`maxInstances` in `index.js`), which caps cost. All accounts and projects share one compressed Firestore document, which has room for many thousands of accounts.
- **Cost:** Firebase's free allowances cover a class easily. Gemini (Vertex AI) is billed on the same Google Cloud billing account, roughly 4¢ per 30-minute recording and 1¢ per analysis with Flash-Lite.
- **If Gemini fails:** "Vertex AI API has not been used" → step 4 wasn't done (or wait a few minutes after enabling). "Permission … aiplatform.endpoints.predict denied" → in **IAM & Admin → IAM**, give the account ending in `-compute@developer.gserviceaccount.com` the role **Vertex AI User**. Details: `firebase functions:log`.
- **Running on your computer** still uses a Gemini API key from `.env.local`.
- **Coming from Vercel:** accounts and projects made on the Vercel site are not copied over. People sign up again on the new address.
- **If you change what Visor collects,** update `lib/legalPages.js`. That page is the privacy policy linked from Google's sign-in screen.
- **Testing:** `VISOR_DEV_LOGIN=1 npm start` enables `GET /dev/login?email=…` for password-free local testing. It never works on Firebase. `GEMINI_BASE_URL` and `DRIVE_API_BASE` can point at stand-in services. `npm test` runs the test suite.
- **Framing:** the extension's side panel frames `/write/…`, so pages are served with `Content-Security-Policy: frame-ancestors 'self' chrome-extension:` (in `server.js` and in `firebase.json`). There's no `X-Frame-Options`.
- **Writing limits:** 500 ops per batch, 50,000 characters per insert, 400,000 characters per document; research batches of 200 events, 30 a minute per session.

## Email: password resets and school invites

Visor sends password reset links and school invites from an email account (`lib/mail.js`). Until one is set up, **Forgot password?** tells people to email the contact address instead, and facilitators copy invite links rather than sending them. Any SMTP account works. Brevo's free plan suits school invites (300 emails a day), and a Gmail app password also works for a few.

1. Create a free account at brevo.com. Add `visor-ed.com` as a sending domain and put the DNS records it gives you on the domain, so school mail filters accept the messages.
2. Under **SMTP & API**, create an SMTP key. Add these to `.env`, using the login Brevo shows:

   ```
   MAIL_HOST=smtp-relay.brevo.com
   MAIL_PORT=587
   MAIL_USER=your-brevo-login
   MAIL_FROM="Visor" <invites@visor-ed.com>
   ```

3. Store the key as a secret, pasting it when asked:

   ```
   firebase functions:secrets:set MAIL_PASSWORD --project visor-ed
   ```

4. In `index.js`, uncomment the `MAIL_PASSWORD` line, add it to `api`'s `secrets`, and deploy `functions:visor:api`.

When a day's limit runs out, the invites page says how many went and the rest can be sent the next day. Links in emails use `PUBLIC_URL`, or https://visor-ed.com if that isn't set.

To use another account, also set `MAIL_USER`, `MAIL_HOST`, `MAIL_PORT` or `MAIL_FROM`. For a local run with nothing sent, set `MAIL_TRANSPORT=memory`: the link prints in the server's log.

