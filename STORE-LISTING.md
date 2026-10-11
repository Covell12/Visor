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

## Product name  *(45 max — this is 36)*

**Already applied to `manifest.json`.** The store takes the item name from the
manifest, so it is not editable in the dashboard — changing it means re-zipping.

```
Visor – Google Docs Revision History
```

Brand first, then the two phrases people actually type. Was
*"Visor – Writing Process Analyzer"* — accurate, but nobody searches for it.

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

## Summary  *(132 max — this is 121)*

**Already applied to `manifest.json`.** Pre-fills the dashboard from there.

```
Google Docs revision history: who wrote what, character-by-character replay, paste detection, and recovered deleted text.
```

Leads with the exact-match phrase, then the four things people search for by
feature. No filler adjectives — every word is a term someone might type.

## Description  *(16,000 max — this is ~4,100)*

The first two lines are what shows in search previews, so they repeat the core
phrase and answer "what is this" immediately.

```
Visor shows you the full revision history of a Google Doc — who wrote what, when they wrote it, what was pasted in, and what was deleted along the way.

Open any Google Doc or Google Slides file you can edit, click Visor, and the document's entire edit history is reconstructed and replayed in your browser. No account, no API key, no sign-in.


SEE WHO WROTE WHAT

Attribution is per character. Every surviving character is traced back to the edit that inserted it, so each contributor's share is counted, not estimated. For every author: characters written, characters deleted, active writing time, and typing speed in words per minute.

If two people worked on a document at once, you can see exactly which parts each of them wrote.


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


NO ACCOUNT, NO API, NO SIGN-IN

Visor uses no Google API, no OAuth flow and no API key. There is nothing to create, paste or configure. It reads the document you already have open, using the session you are already signed in to, and computes everything locally.


PRIVACY

Visor makes no request to any host other than the document you have open. Nothing is uploaded, stored remotely or shared. No server, no telemetry, no analytics. The analysis happens in the tab and is discarded when you close it. The only thing saved is your light or dark theme preference.


EDITORS ONLY

Visor shows revision history only to people with edit access — the same rule Google Docs applies to its own version history. With view-only access the panel shows a locked state and performs no analysis.


Light and dark themes included. Works on Google Docs and Google Slides.
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
Visor has one purpose: to show how a Google Docs or Google Slides file that the user can already edit was written over time.

Everything in the extension serves that purpose. It reads the revision history of the document open in the current tab, replays those edits in order in the browser, and presents the result — per-character contributor attribution, pastes, recovered deletions, writing sessions, activity statistics, and a character-by-character replay — in a side panel.

Visor does not modify documents, does not run on any site other than Google Docs and Google Slides, and sends no data anywhere.
```

## Permission justifications

### `storage`

```
Used to remember one value: the user's light or dark theme choice, saved in chrome.storage.local under the key "visor_theme". That is the only thing Visor writes to storage. No document content, no analysis results, no personal data and nothing identifying a user is stored, and nothing is synced or transmitted.
```

### `sidePanel`

```
Visor's entire interface is a Chrome side panel. This permission is required to open the panel beside the document and to enable it only on Google Docs and Google Slides tabs, so that the panel does not appear on unrelated sites.
```

### `tabs`

```
Used to read the URL of the active tab so Visor can tell whether it is a Google Docs or Google Slides document, and therefore whether to enable its side panel and which tab to send messages to. The URL is matched against https://docs.google.com/document/ and https://docs.google.com/presentation/ and used for nothing else.

Visor does not read browsing history, does not inspect the contents of other tabs, and does not observe anything outside the document being analysed. The permission is also used to open the Chrome Web Store listing in a new tab when the user clicks the "Rate Visor" button.
```

### Host permission — `https://docs.google.com/document/*` and `https://docs.google.com/presentation/*`

```
Visor's function is to analyse the writing history of a Google Docs or Google Slides file. To do that, its content script has to run on the document page and read that page's own revision history from the same origin — https://docs.google.com/document/<id>/revisions/... — using the session the user is already signed in to. Google returns that history only to users with edit access, and Visor enforces the same rule.

The permission is scoped to the two URL paths where documents live. It is not requested for any other site, and not for the rest of docs.google.com. Visor makes no request to any host other than the document the user has open, and no data leaves the browser: the analysis is computed in the tab and discarded when the tab closes.
```

### Are you using remote code?

```
No, I am not using remote code
```

Supporting note if a box is offered:

```
All code ships inside the package. Visor loads no script from any remote source, uses no eval or new Function on fetched text, and has no backend.
```

## Data usage

**Tick nothing.** Chrome defines "collect" as transmitting data off the user's
device, and Visor transmits nothing — the document is read in the tab, analysed
in the tab, and discarded when the tab closes. The only value it persists is the
theme preference, which is not user data.

Then tick all three certifications:

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

Not required while no data-usage box is ticked. If the dashboard insists on one,
a GitHub Gist is enough — ask and the policy text can be regenerated.

---

# 3. Distribution tab

| Field | Value |
|---|---|
| Visibility | **Public** (or **Unlisted** for a link-only soft launch) |
| Distribution | All regions |
| Pricing | Free |

---

# 4. After it is live — the part that actually moves ranking

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
