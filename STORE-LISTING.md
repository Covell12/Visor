# Chrome Web Store — listing, written for search

Copy each block into the matching box in the Developer Dashboard.
Character counts are given where the box has a limit.

---

## How Chrome Web Store search actually works

Worth knowing before you touch anything, because it decides where effort pays:

- **There is no keywords or tags field.** It was removed years ago. Search
  indexes exactly three things you control: the **name**, the **summary**, and
  the **detailed description**.
- **The name carries by far the most weight.** A term in the name outranks the
  same term buried in paragraph six.
- **Everything else is behaviour**, not text: install count, rating and number
  of ratings, how recently you shipped an update, and how many people uninstall
  soon after installing. A listing gets you into the results; those decide where
  in the results you land.
- **Keyword stuffing is a policy violation.** Repeating terms unnaturally,
  padding with unrelated popular words, or listing competitors' names can get
  the item taken down. Everything below reads as normal prose on purpose — the
  terms are there because they describe the product.

So: pick the name carefully, front-load the summary, cover the real search
phrases naturally in the description, then get your first twenty reviews.

---

# 1. Store listing tab

## Product name  *(75 max — this is 48)*

**Already applied to `manifest.json` (4.0.0).** The store takes the item name from the
manifest, so it is not editable in the dashboard — changing it means re-zipping.

```
Visor — Writing Sessions & Google Docs History
```

Since 4.0.0 the extension is also the companion to Visor Classroom (writing
sessions, research, citations), so the name leads with that and keeps the Docs
history phrase people search for. The 3.6 name was *"Visor — Who Wrote What:
Google Docs History"*; the alternatives below are from before 4.0.0.

**Alternatives**, if you want a different emphasis:

| Name | Chars |
|---|---|
| `Visor – Google Docs Revision History` | 36 ← applied |
| `Visor – Revision History for Google Docs` | 40 |
| `Visor – Google Docs Revision History & Replay` | 45 |
| `Visor – Doc Revision History, Replay & Pastes` | 45 |

**One caveat on "Google Docs" in the name.** Using another company's trademark
descriptively is normally fine and plenty of extensions do it, but it is a
judgement call a reviewer can go either way on. If it gets flagged, `Visor –
Doc Revision History, Replay & Pastes` keeps most of the search value with none
of the trademark exposure.

## Summary  *(132 max — this is 127)*

**Already applied to `manifest.json`.** Pre-fills the dashboard from there.

```
See who wrote what in any Google Doc: replay, paste detection, color by author. Plus the companion to Visor Classroom sessions.
```

Leads with what most people search for, then says what else it is, so the
Classroom features aren't a surprise to a reviewer or a Docs user.

## Description  *(16,000 max — this is ~6,000)*

The first two lines are what shows in search previews, so they repeat the core
phrase and answer "what is this" immediately.

```
See the full revision history of any Google Doc: who wrote what, when, what was pasted in, and what was deleted along the way. Visor is also the companion to Visor Classroom, where students write essays in writing sessions their teacher starts.


GOOGLE DOCS HISTORY

Open any Google Doc or Google Slides file you can edit, click Visor, and the document's entire edit history is reconstructed and replayed in your browser. No API key, no sign-in needed for this part.


SEE WHO WROTE WHAT

Attribution is per character. Every surviving character is traced back to the edit that inserted it, so each contributor's share is counted, not estimated. For every author: characters written, characters deleted, active writing time, and typing speed in words per minute.

If two people worked on a document at once, you can see exactly which parts each of them wrote.


AWARE MODE — COLOR THE DOCUMENT BY AUTHOR

Turn on AWARE and the text inside the Google Doc itself takes each author's color, on your screen only. Nothing in the document changes and nobody else sees it. A panel beside the page lists everyone in their color: hide or show anyone with a click, highlight text pasted from outside the document in yellow, and text pasted from within it in light blue.

Percentages leave out pasted text by default, so they show who wrote the document rather than who brought text into it. Each kind of paste has its own switch.


REPLAY THE DOCUMENT BEING WRITTEN

Watch the document type itself out, character by character, at the pace it was actually written. Scrub to any moment, speed it up, or jump straight to a marker at each paste. It is the closest thing there is to looking over someone's shoulder while they wrote.


PASTE DETECTION — INTERNAL VERSUS EXTERNAL

Visor separates text pasted in from outside the document from text copied or moved around inside it. This distinction matters: moving a paragraph is ordinary editing, not plagiarism, and Visor never counts it against anyone. Only text that was not already in the document is reported as having come from elsewhere.

What counts as a paste is measured per document rather than fixed, because Google batches fast typing into larger operations — so a quick typist is not misread as pasting.


RECOVER DELETED TEXT

Text that was written and then removed is still in the edit stream, even though it appears in no export or download of the document. Visor lists it, with who deleted it and when.


WRITING SESSIONS AND TIMESTAMPS

Every edit is timestamped, and Visor groups them into writing sessions — continuous stretches of work, listing everyone who wrote during each. Open a session on its own to see when it started, how long it took, exactly what text was added, and a replay of just that passage.

Was it written over three weeks or in one panic at 2am? The activity view answers that: days worked on, busiest day, most common hour, longest single sitting, longest gap between writing days, plus activity charted by hour, day, week, month or year.


DOCUMENT TABS

If the file uses Google Docs tabs, every figure — contributors, pastes, replay, statistics — can be narrowed to a single tab.


WHO IT IS FOR

Teachers and instructors checking how a submission came together. Editors and managers seeing who contributed what to a shared draft. Writers curious about their own process. Anyone who has ever opened Google Docs version history, found it useless for answering "who actually wrote this", and wanted the real record.


THERE IS NO SCORE

Visor reports one counted quantity: the share of characters that arrived from outside the document. Deletion rate, typing cadence and block sizes are shown beside it as measurements and feed into nothing. There is no rating model and no weighting, because a number built from hand-picked weights tells you about the weights, not the document.

Treat what you see as evidence to discuss, never as a verdict on a person.


FOR VISOR CLASSROOM WRITING SESSIONS

Connect the extension to your Visor account once. Then, only while a writing session is running (the Visor icon shows a red REC):

• Your essay sits in Chrome's side panel next to the pages you're researching.
• Cite this page (or Alt+Shift+C) reads the page's author, title and date and adds an MLA, APA or Chicago citation to your essay and its Works Cited.
• If the assignment records research, the research you do for the essay is recorded for your teacher: your searches, the pages you visit and how long, and text you copy, so a paste can show where it came from.
• In a locked, in-class session, sites your teacher didn't allow (and AI sites) show a "not allowed" page instead.

Outside a session, none of that runs. Group projects: if your teacher linked your group's Google Doc, opening it sends its figures and its editors' names and email addresses, never its text, to your group's project.


NO API, NO SIGN-IN FOR DOCS HISTORY

The Docs history uses no Google API, no OAuth flow and no API key. It reads the document you already have open, using the session you are already signed in to, and computes everything locally.


PRIVACY

Docs history: the analysis happens in the tab and is discarded when you close it; nothing leaves the browser unless you choose Send to Visor (or your group's linked Doc sends its figures, never its text, to your project). Writing sessions: research is sent only to the Visor Classroom account you connected, only during a session, and only for assignments that record research. No keystrokes on other sites, no passwords, no page contents beyond what a student copies or cites, no telemetry, no analytics. Visor never labels writing as AI-generated. Full policy: https://visor-ed.web.app/privacy


EDITORS ONLY

Visor shows revision history only to people with edit access — the same rule Google Docs applies to its own version history. With view-only access the panel shows a locked state and performs no analysis.


Light, dark and system themes included. Works on Google Docs and Google Slides.
```

### The search terms this covers, and where

Every one of these appears in natural prose above — check before editing that
you are not deleting the only instance of something:

`revision history` · `Google Docs revision history` · `edit history` ·
`document history` · `version history` · `who wrote what` · `contributor` ·
`per-character attribution` · `replay` · `character by character` ·
`paste detection` · `copied and pasted` · `plagiarism` · `deleted text` ·
`recover deleted` · `timestamps` · `writing sessions` · `typing speed` ·
`words per minute` · `writing process` · `Google Slides` · `document tabs` ·
`teachers` · `students` · `editors`

## Category

```
Education
```

*(Second choice: Workflow & Planning. Education is the better bet for search —
the teacher/instructor audience is the one actively hunting for this.)*

## Language

```
English (United States)
```

## Store icon

`icons/icon128.png` — already 128×128 with transparency.

## Screenshots  *(1280×800 or 640×400 · at least 1, up to 5)*

Screenshots do not affect search ranking, but they heavily affect whether
someone installs after finding you — which does. **Put a caption band across
the top of each image**; the store shows them small, and unlabelled UI reads as
noise.

In this order, because the first is the thumbnail:

1. **Replay mid-run** — the most distinctive thing Visor does. Caption:
   *"Watch the document being written, character by character."*
2. **People** — two or three named contributors with bars and WPM. Caption:
   *"See exactly who wrote what."*
3. **Signal** — the External Pastes gauge and origin donut. Caption:
   *"Tell pasted-in text from text moved around inside the document."*
4. **Timeline / single edit** — the edit sheet with added text and op list.
   Caption: *"Every edit, timestamped, down to the keystroke."*
5. **Overview** — metrics, growth chart, heatmap. Caption:
   *"When the work actually happened."*

Use a document with real history and more than one author. Light theme reads
better at thumbnail size.

## Small promo tile *(440×280)* · Marquee *(1400×560)*

Optional, and neither affects search. The small tile is the only one worth
making: it is required to be considered for category features, which is real
traffic.

## Official URL / Homepage URL / Support URL

Optional. A support URL that works — even a GitHub issues page — reduces angry
one-star reviews from people with no other way to reach you, and ratings do
feed ranking.

---

# 2. Privacy practices tab

## Single purpose description

```
Visor has one purpose: to show how a piece of writing was made.

It does that in two places. For a Google Docs or Google Slides file the user can already edit, it reads the document's revision history and shows who wrote what and when, in a side panel. For an essay written in Visor Classroom (the Visor web app), it is the writing session's companion: while the session runs it records the research the student does for it, keeps a locked in-class session on the sites the teacher allowed, keeps the essay in the side panel, and adds citations. Outside a session those features are off.

Visor does not modify Google documents and never labels writing as AI-generated.
```

## Permission justifications

### `storage`

```
Stores the user's display preferences (light, dark or matching the computer; whether AWARE mode is on and whose colours and which pastes it shows; whether percentages leave out pasted text); the token that connects the extension to the user's Visor Classroom account (set when they connect on the Visor website); and, during a writing session only, the session's state and the queue of research events waiting to be sent. Session data is kept in chrome.storage.session and cleared when the session ends. Preferences stay on the user's computer.
```

### `scripting`

```
During a Visor writing session that records research, registers a small script on websites that notices when the student copies text (so a later paste into their essay can show where it came from); it is unregistered when the session ends. When the student clicks "Cite this page", it reads that page's title, author and date to build the citation and shows a short note on the page.
```

### `webNavigation`

```
During a Visor writing session, records which pages the student visits and searches they make, with time on each page, for their teacher's research log, and notes when the student opens an AI site (including one the session blocks). It also reports whether the student is still on Visor, or on another tab, window, app or desktop, without naming what's there. Not used outside a session.
```

### `contextMenus`

```
Adds "Cite this page with Visor" to the right-click menu, only while a writing session is running.
```

### `declarativeNetRequest`

```
In a locked (in-class) writing session, shows Visor's "This site isn't allowed during your Visor session" page instead of sites the teacher didn't allow and AI sites. In a session where the teacher chose to block AI sites, it does the same for AI sites only. The rules are installed when the session starts and removed when it ends.
```

### `alarms`

```
Once a minute during a writing session, sends the queued research events to the Visor server and confirms the session is still running.
```

### `activeTab`

```
Lets the Alt+Shift+C shortcut and the right-click item read the citation details (title, author, date) of the page the student is on when they ask to cite it.
```

### `sidePanel`

```
Visor's interface is a Chrome side panel: the Docs history panel beside a Google Doc, and during a writing session the panel holding the student's essay and the cite button.
```

### `tabs`

```
Reads the address of the active tab so Visor can tell whether it is a Google Docs or Google Slides document, turn on its side panel there and message the right tab. Also finds an open Visor site tab when connecting, and opens the Chrome Web Store listing when the user clicks Rate Visor.

During a Visor writing session it also keeps the session panel on every tab, records each page's address and title for the research log, sends tabs on sites a locked session doesn't allow to Visor's "not allowed" page, and returns the student to their essay if they move to another tab or Chrome window in a locked session with no allowed sites. Outside a session, Visor keeps no record of the pages the user visits.
```

### Host permissions — one box for all of them

The dashboard has a single box covering the two Google paths, the Visor site's
content script and the optional `<all_urls>`.

```
Google Docs and Slides (docs.google.com/document/* and /presentation/*): Visor's content script runs on the document page and reads that page's own revision history from the same origin, using the user's existing sign-in. Google returns it only to users with edit access. The analysis is computed in the tab; only names, email addresses and counted figures, never document text, go to the user's own Visor project.

Visor website (visor-ed.com, visor-ed.web.app, visor-ed.firebaseapp.com): a small script lets the site connect the extension to the user's account and start writing sessions.

All sites (<all_urls>, optional): requested once, from a click, at a student's first session that records research. It records research on the sites they visit and enforces a locked session's allowed sites, and is not used outside a session. It reads page addresses and titles, text the student copies, and citation details, never keystrokes or form fields. If declined, research isn't recorded.
```

### Are you using remote code?

```
No, I am not using remote code
```

Supporting note if a box is offered:

```
All extension code ships inside the package. Visor loads no script from any remote source and uses no eval or new Function on fetched text. During a writing session the side panel shows the student's essay by framing the Visor website (an ordinary web page in an iframe); no code from it runs in the extension's context.
```

## Data usage

Since 4.0.0, tick what writing sessions send to the Visor web app:

- ☑ **Web history** — pages visited and searches made during a writing session.
- ☑ **User activity** — when the student copies text on a page during a session, and time on each page.
- ☑ **Website content** — text the student copies during a session (its length, a hash and the first 140 characters), and the title, author and date of a page they cite.
- ☑ **Authentication information** — the token that connects the extension to the student's Visor account.

- ☑ **Personally identifiable information** — the names and email addresses of a Doc's editors, as shown in its history, in a report sent to a Visor project.

Nothing is collected outside a writing session, except reports to a Visor
project: one a user chooses to send, or, for a Doc linked to their group
project, sent automatically when a connected student opens it. Reports carry
names, addresses and counted figures, never document text. AWARE, the
percentage settings and everything else on Docs stay on the user's computer.

Then tick all three certifications:

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

Required since 4.0.0:

```
https://visor-ed.web.app/privacy
```

---

# 3. Test instructions tab

Reviewers can't see writing sessions without an account, and an item they can't
test gets rejected. Make one teacher and one student account on the live site
with email and password, join the student to a class with a published locked
assignment, then fill in the details below. Use throwaway addresses and
passwords used nowhere else; they stay valid until the review is done.

```
Visor has two parts.

GOOGLE DOCS HISTORY (no account needed)
Open any Google Doc you can edit that has some edit history, click the Visor button or the bar at the bottom, and open the side panel. Turn on AWARE on the bar to color the text by author.

VISOR CLASSROOM WRITING SESSIONS (test account below)
1. Go to https://visor-ed.web.app and sign in with email and password:
   Student: [STUDENT EMAIL] / [STUDENT PASSWORD]
2. Open https://visor-ed.web.app/extension/connect and click Connect the Visor extension.
3. Open the class [CLASS NAME], then the assignment [ASSIGNMENT NAME], then Open the editor, then Start writing session. Allow research recording when asked.
4. The Visor icon shows REC. Open a site that isn't on the allowed list, such as https://example.com: it shows Visor's "not allowed" page. Open https://chatgpt.com: it's blocked too.
5. Right-click a page and choose Cite this page with Visor, or press Alt+Shift+C.
6. End the session: the block is lifted, and nothing is recorded any more.

To see what the teacher sees: [TEACHER EMAIL] / [TEACHER PASSWORD].
```

---

# 4. Distribution tab

| Field | Value |
|---|---|
| Visibility | **Public** (or **Unlisted** for a link-only soft launch) |
| Distribution | All regions |
| Pricing | Free |

---

# 5. After it is live — the part that actually moves ranking

The listing gets you into the result set. These decide your position in it:

1. **First reviews matter disproportionately.** An item with 4 reviews ranks
   below one with 40 on the same terms. The in-panel "Rate Visor" prompt is
   already built; pointing it at your real review URL
   (`https://chromewebstore.google.com/detail/<ID>/reviews`) once you have the
   ID is the single highest-value ten minutes left in this project.
2. **Ship updates.** Recency is a ranking input, and a listing untouched for a
   year sinks regardless of quality.
3. **Watch the uninstall rate.** Anything that makes people remove Visor within
   a day of installing costs more than any keyword gains — which is why the
   view-only lock state needs to explain itself clearly rather than just fail.
4. **External links help.** Chrome Web Store listings are indexed by Google
   Search, so a Reddit thread, a blog post or a teachers' forum mention pulls
   traffic that store search never will.
