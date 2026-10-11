# Visor — Setup

**Writing process analysis for Google Docs & Slides. No API, no account, no sign-in.**

---

## Install

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder

That is the entire setup. There is no OAuth client to configure, no Google Cloud
project, no API to enable, and no key to paste.

---

## Use

1. Open a Google Doc or Slides presentation **that you can edit**
2. Click **Visor** in the toolbar (or the Visor toolbar icon → *Open Visor*)
3. The side panel reads the document's edit history and renders it

If you already had the document open when you installed Visor, reload the tab
once so the content script attaches.

---

## Editors only

Visor shows revision history **only to users with edit access**, which is the
same rule Google Docs applies to its own version history. With view-only access
the panel shows a locked state and no analysis is performed — no contributors,
no timings, no replay, no recovered text.

The check fails closed on any negative signal. Where the page gives no clear
answer, Visor lets the document's own revision endpoint arbitrate; that endpoint
enforces the same permission server-side.

---

## How it reads history

Visor reads the document's native operational-transform mutation log — the
stream Google Docs itself uses for realtime collaboration — from the
`docs.google.com` origin, using the session you are already signed into.

```
GET /document/d/<id>/revisions/tiles?id=<id>&start=1&revisionBatchSize=1500
      &showDetailedRevisions=true&loadType=0&token=<t>&ouid=<u>
GET /document/d/<id>/revisions/load?id=<id>&start=<a>&end=<b>&token=<t>&ouid=<u>
```

Both need the session `token` the Docs client itself sends, read out of the page
(`"token"` next to `info_params`), plus `ouid` from `"docs-pid"`. Without the
token the endpoints refuse the request, which looks identical to a document with
no history. The tile index returns the total revision count outright
(`tileInfo[last].end`) and the author roster (`userMap`), so no probing is needed.
A `403` means the user lacks edit access.

Every edit is then replayed in order over a text buffer. That is why the numbers
are exact rather than estimated:

| Figure | How it is derived |
|---|---|
| Contributor share | Per-character authorship of the surviving text |
| Pastes | Single insert operations — observed, not inferred from file size |
| Recovered deletions | Text captured from the buffer at the moment it was removed |
| Active writing time | Sum of gaps between edits, capped at a 2-minute idle threshold |
| Replay | The op stream re-applied one edit at a time |
| Text origin | Share of characters that arrived as blocks from outside the document |
| Typing rate | Characters per second between consecutive keystrokes, and words per minute |

Nothing is sampled and nothing is estimated from file size.

### Internal and external pastes

A paste is classified by where its text came from, which the fold can answer
because the document's state at that moment is known:

- **External paste** — the text was not in the document beforehand.
- **Internal paste** — the same text was already present, either copied or cut
  from elsewhere in the document shortly before.

Signal charts all three shares — typed, internal pastes, external pastes — as
percentages of every character ever inserted. The interface says *internal
paste* and *external paste* throughout; "copied within", "moved within" and
"pasted in from outside" are gone.

**There is no score.** Signal reports one counted quantity: the share of
characters that arrived from outside the document. Deletion rate, typing cadence
and block sizes are reported beside it as measurements and contribute nothing to
that figure. An earlier version summed hand-picked weights against hand-picked
thresholds, which meant the headline number encoded opinions rather than the
document.

**What counts as a paste is derived per document.** Google batches fast
keystrokes into larger single operations, so one person's ordinary typing is
another's paste threshold. Visor measures how large an insert gets during
continuous typing in that document — the 99th percentile of insert sizes inside
a burst — and treats anything beyond it as not typed. A fast typist whose
keystrokes batch into twelve-character inserts is therefore not misread as
pasting. Cutting a paragraph and
pasting it lower down is ordinary editing, and scoring it as imported text
overstated the result — a document that was purely reorganised could previously
read as heavily pasted. Signal shows the split as its own chart, and each entry
in Evidence is labelled with its origin.

### Author identity

Each changelog row is `[ mutation, timestampMs, userId ]`, where `userId` is a
**string** and is the same key used by the `userMap` in the tile index — so the
name lookup is direct. Visor checks for that layout first and only falls back to
profiling the columns statistically if it does not hold, since an undocumented
format can change. The column is absent on a minority of rows; those edits are
attributed to an unknown author rather than discarded.

**Why authors are sometimes numbered instead of named.** The edit stream refers
to each author by an opaque per-document index — a number, not a person. Names
come from the roster in the `revisions/tiles` index, fetched as described above,
and from any roster embedded in the `revisions/load` response. When a name is
genuinely absent, the author is numbered in the order they first edited —
**Unknown 1**, **Unknown 2** — and anonymous editors are numbered separately.

**Email addresses are only shown when Google supplies them**, which is almost
never: the roster carries `{name, photo, color, anonymous}` and no address. An
earlier version tried to match authors to emails found elsewhere in the page by
display name; that was a guess and has been removed.

If the author column cannot be identified at all, every edit is grouped under a
single *All authors combined* entry rather than split into one phantom person per
revision. Totals, timings and replay stay exact in every case.

## Keeping the toolbar button alive

Docs rebuilds its toolbar as you work and takes Visor's button with it, so the
button has to be replaced when it disappears. How that watch is written matters
a great deal:

- **Never observe `<body>` with `subtree: true`.** Docs mutates its DOM on every
  keystroke, caret blink and scroll. A subtree observer on the body makes the
  browser record every one of those mutations and wake the content script for
  each batch, which visibly slowed the editor.
- **Never fight the toolbar indefinitely.** Docs owns that container and
  reconciles it. Re-inserting on every removal can turn into an insert/remove
  war running every frame — and since the button carries a `backdrop-filter`,
  each insert forces the compositor to re-snapshot the page behind it, which
  made the whole window flash black and white.

What it does instead: observes only the button's own parent (`childList`, no
subtree), coalesces to at most one check per animation frame, and counts
re-injections. After 6 within 10 seconds it concludes Docs is reconciling the
toolbar, stops observing, and moves to the floating fallback on `<body>`, which
nothing reconciles. A 3-second interval is the safety net for the one case the
observer cannot see: Docs removing the container the button lived in.

`upgradeLauncherPlacement()` handles the reverse — the toolbar is built in
stages, so a button that lands in the floating fallback during load is moved up
once a real spot appears. The retry timers previously did nothing at all: they
called `injectLauncher()`, which returns immediately when a button already
exists.

## Never read layout in a pointer handler

`getBoundingClientRect()` forces a synchronous layout. `pointermove` fires at
the display's refresh rate, so reading it there — then writing styles, which
invalidates layout again — makes the browser re-lay-out the whole document up
to 120 times a second. On the Docs page, whose DOM is enormous, that is why
everything hitched *while the mouse was moving* and was still when it was not.

Four handlers did this: the launcher's specular highlight (on the Docs page,
the worst of them), the side panel's document-wide specular highlight, the
growth chart's hover readout, and the replay scrubber.

The pattern they all use now: stash the coordinates, schedule one
`requestAnimationFrame`, and do the writes inside that frame. Listeners are
registered `{ passive: true }` so they can never block scrolling either.

**Coalescing to a frame was not enough on its own.** One forced layout of the
Docs DOM per frame still hitched. The rect is therefore cached — surfaces do
not move while the pointer is over them — measured when the pointer first
reaches one, and dropped on `scroll`, `resize`, or moving to a different
surface. A hundred pointer moves now cost **one** layout instead of a hundred.

**Write the custom property to the element that consumes it.** Custom
properties inherit, so setting `--mx` on the launcher invalidated the style of
everything inside it. It is written to `.visor-launch-glass`, which has no
children of its own.

Registering `--mx`/`--my` with `@property { inherits: false }` looks like the
tidy fix for that and is not: `.visor-launch-glass` reads the value from its
parent, and `.glass::before` is a pseudo-element, which resolves a
non-inheriting property to its initial value. Both highlights would flatten.

`test-pointer.js` enforces all of it across `content.js`, `sidepanel.js` and
`replay.js` — statically for `pointermove`, `mousemove`, `scroll` and `wheel`,
and behaviourally by driving 100 pointer moves and counting the layout reads.

## The panel belongs to one tab

There is **no `side_panel` key in the manifest**, deliberately. A
`default_path` there declares a panel for *every* tab, so any tab the worker
has not explicitly disabled inherits one — which is why switching tabs did not
close it, however carefully the per-tab options were managed. The path is
supplied per tab by `setOptions` instead, which is also why every one of those
calls must carry it.

The worker tracks `openedFor`: the tab the panel was opened from. It is enabled
only for that tab, so switching to any other — including a different Google Doc
— closes it, and reloading clears the claim so the panel comes back closed
rather than reattaching to a document being rebuilt.

`info.status === 'loading'` is the reload signal. `info.url` on its own is the
in-place rewriting Docs does constantly and must never be treated as one.

Both entry points — the in-document button and the toolbar popup — go through
the worker's `OPEN_SIDE_PANEL` message. Calling `sidePanel.open()` directly
from the popup opened a panel that was never recorded as belonging to the tab,
so the next sync closed it again.

## Call `sidePanel.setOptions()` only when the answer changes

`tabs.onUpdated` fires with `info.url` on every URL rewrite, and Docs rewrites
its URL constantly. Calling `setOptions` on each one re-navigated the side
panel, blanking it for a few hundred milliseconds, several times a minute —
measured at 46 calls for 46 anchor changes. The worker now keeps a
`tabId -> enabled` map and calls only on a real transition.

Note where this does *not* show up: the panel is a separate document, so a
panel reload repaints nothing on the Docs page. DevTools paint flashing on the
page shows no green at all while it happens.

**`path` must still be sent on every call that is made.** A tab-specific entry
written with `enabled: true` and no path does *not* fall back to the manifest's
`default_path`: Chrome finds the tab entry, sees no usable panel, and
`sidePanel.open()` silently does nothing. Dropping `path` to avoid the
re-navigation is what stopped the toolbar button from opening anything. The
re-navigation was never the problem — the frequency was.

## Never compare `location.href` on a Docs page

Docs rewrites the URL constantly while you work: a heading anchor as you move
through the outline, `?tab=t.xxxx` when you switch document tabs, assorted
cursor and sharing state. None of it is a navigation.

The navigation watcher compared the whole href, so every one of those looked
like moving to a different document. It threw away the fetched log, the roster,
the fold cache and the HUD — several times a minute — forcing a complete
re-fetch and re-fold each time.

It was also the last of the flicker. A rebuilt HUD starts at `opacity: 0` and
fades in over 0.45s, so the bar vanished for a few hundred milliseconds and came
back. That is worth knowing for diagnosis: **a compositor-driven opacity
animation repaints nothing**, so DevTools paint flashing showed no green
anywhere while it was happening, which is what ruled out paint and pointed here.

Compare document identity instead — `getDocKind()` and `getFileId()`, both of
which read `location.pathname` only. `test-nav.js` covers the URL shapes Docs
actually produces.

## No backdrop-filter in the injected UI

This was the cause of the flicker, and it is a constraint on `content.css` only.

Chrome blurs a backdrop using **"extend" edge handling**: it guesses the pixels
outside the filtered element by repeating its edge pixels outward. A one-pixel
scroll changes those edge pixels, so the extension changes completely and the
blur resolves to a different colour on the very next frame. Docs repaints
continuously — the caret alone blinks about twice a second — so the blur never
settles. Each filtered element also costs a full readback of the destination
texture per frame, and there were six of them over the editor, including a
full-viewport one on the replay scrim.

Firefox and Safari do not do this; it is specific to Chrome's implementation.

The surfaces are opaque enough to look the same without it: `--v-surface` went
from 0.78 to 0.95, the launcher base from 0.72 to 0.93, and the replay scrim
from 0.42 to 0.68. Behind the HUD the page is white, and a heavy blur of white
is white, so the filter was buying very little for what it cost. Rendered side
by side over the same text, the before and after are indistinguishable.

**This applies to the extension's own pages too — there is no exemption.**

They looked exempt: separate documents, no editor repainting behind them. That
reasoning was wrong, and the answer was sitting in `glass.css` with a comment
explaining itself:

```css
/* Ambient light behind the glass, so the blur has something to chew on. */
.aurora i { filter: blur(72px); animation: visor-drift 18s infinite; }
```

Three blurred blobs drift behind every glass surface **forever**. So the
backdrop was never static — it changed on every frame, and each of the 29
filtered surfaces had to re-snapshot and re-blur it on every frame, for the
whole life of the panel. Moving the pointer added the specular gradient repaint
on top, which is why motion made it worse rather than causing it.

The give-away: closing the side panel stopped the flicker, and opening the
replay window — which loads the same stylesheet — restarted it.

The aurora blobs are already blurred to 72px, so a further backdrop blur over
them was contributing nothing visible. Rendered side by side over the same
aurora, with and without, the two are indistinguishable — which is why the
surface opacities here did not need raising the way `content.css` did.

The aurora itself stays, but **static**. Each blob is blurred to 72px and the
old keyframes scaled them, so every frame Chrome re-rasterised a very large
blur at a new scale — three of them, for the life of the panel and the replay,
whether or not anyone was looking. The drift was 3–4% over 18–33 seconds and
imperceptible; the colour wash it existed to provide is intact, painted once.

The replay scrim is **fully opaque**. It covers the viewport while the replay is
open, and Docs behind it never stops repainting, so any alpha below 1 made the
browser composite the live page through it on every one of those repaints.

`test-css.js` now checks all four stylesheets.

### Bulk-editing CSS: check the structure, not just the string

Removing the filters with `s/backdrop-filter:[^;]*;//` corrupted `glass.css`.
`[^;]*` matches newlines, so on

```css
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
```

it ran from `backdrop-filter:` in the *condition* all the way to the next
semicolon several lines below, leaving `@supports (  }`. Everything after that
point was dropped by the parser — including `.aurora`'s `position: fixed`,
which turned it into an in-flow grid item that stole the replay window's `1fr`
row and squashed the document view to nothing.

It went unnoticed because the checks asked "is the property gone?" and it was.
`test-css.js` now also verifies every stylesheet parses: braces balance, no
at-rule head runs into a close brace, no rule left empty.

### Fixed overlays get their own compositing layer

Removing the blur left a residual shimmer. A fixed, translucent, shadowed
element over a scrolling page is re-rastered against whatever is beneath it on
every scroll frame; promoted to its own layer it is rastered once and the page
scrolls underneath. So `#visor-hud`, `#visor-replay-overlay`,
`.visor-launch-floating` and the collapsed tab all carry `will-change`.

Two rules go with it:

- **Only ever on the fixed element itself.** `will-change: transform` makes an
  element the containing block for `position: fixed` descendants, which would
  anchor them to it instead of the viewport. This is the same hazard that keeps
  `#visor-hud-tab` a sibling on `<body>` rather than a child of `#visor-hud`.
- **Not while the element is invisible.** `#visor-hud-tab` sits in the DOM at
  `opacity: 0` for the whole session, so its promotion lives on `.is-shown`;
  unconditional, it would hold a GPU layer for something nobody can see.

`test-css.js` checks both — every fixed root promoted somewhere, and the tab's
base rule not promoted.

## Cost on the page

Everything Visor computes runs on the Google Docs page's own main thread and
heap, so allocation matters more than wall-clock. Two things dominate, and both
are now handled:

**The fold runs over a gap buffer, not a string.** It used to do
`buf.slice(0, at) + text + buf.slice(at)` per operation, which allocates a fresh
copy of the whole document every edit — on a 10,000-edit document, over 200 MB
of throwaway strings. Holding the text split at the edit position makes a run of
edits at one place a plain append, which V8 does without copying, and the buffer
is flattened only when something needs the whole string: a keyframe, a paste
comparison, or the final text. Measured on a realistic 10,162-edit stream:
**45 garbage collections down to 17**, fold+analyze 41 ms → 33 ms median. The
time was never the problem; the garbage was.

`textAt()` replays forward from a keyframe and had the same flaw, so it uses a
gap buffer too.

**Folds are cached per tab selection**, up to three. Switching scope re-folded
the entire log every time, including switching back to a tab just viewed.

Two hazards to keep in mind if you touch this:

- The fold writes its filtered ops onto the shared entry objects as `_norm`.
  Anything reading them afterwards must read `steps[i]._norm`, not
  `entries[i]._norm` — the latter belongs to whichever fold ran most recently,
  so a cached timeline would replay a different tab's text. `test-perf.js`
  covers this.
- The cache must be cleared whenever the log changes: a re-fetch, a navigation
  to another document, or an access downgrade.

`analyze()` is ~31 ms and its largest part, `buildProvenance`, is ~15 ms. Both
were measured, not guessed; per-phase timings taken during a run are unreliable
because collection gets billed to whichever phase happens to trigger it.

## The in-document HUD: build once, update in place

`renderHUD()` must never rebuild the bar wholesale. It is called every time the
tab scope changes from the side panel, and `.vh-glass` carries
`backdrop-filter: blur(26px)`. Destroying and re-creating a backdrop-filtered
element makes Chrome rebuild the backdrop root; over Docs' very large
composited layers that re-rasterises the whole page, which showed up as the
document flashing and briefly vanishing whenever the panel was used.

So `ensureHUD()` creates the shell exactly once and wires its handlers once,
and `updateHUD()` writes values into the existing nodes. Parts that come and go
— the external-share flag, the tab filter — are hidden with the `hidden`
attribute rather than removed, and `#visor-hud [hidden]` forces `display: none`
because several of them set `display` themselves. The contributor chips are the
one subtree that is re-rendered, and only when the roster or its shares
actually change, so the entry animation does not replay on every update.

Measured on a 10,162-revision document: a full re-fold is ~85 ms and the
analysis crosses the message boundary at ~69 KB compacted, so neither was the
cause. The cost was compositing, not computation.

## Appearance

Visor opens in **light theme** by default. The sun/moon button in the panel header
switches to dark behind a colour wash that spreads from the button, and the choice
is saved — it survives reloads and browser restarts. The side panel, the replay
window and the in-document HUD all follow it. The system colour scheme is
deliberately not consulted, so the theme never changes out from under you.

The in-document bar collapses to a small tab in the bottom-right corner; click it
to bring the bar back.

In **Evidence**, pastes and recovered deletions can be sorted by newest, largest,
or person — sorting by person groups each author's items together, largest first.

## Writing sessions

**Timeline** groups edits into sessions. A session is a continuous stretch of
work on the *document*, so it ends only after five minutes with no edits —
**an author change does not break one.** Two people writing at the same time
belong to the same session, and every one of them is named on it, largest
contributor first. The rail colour and the session's headline author are
whoever wrote the most in it.

## A single edit

Clicking a session in **Timeline** opens that edit on its own: when it happened,
how long it took, exactly what text was added — with nothing from the
surrounding document — and a replay of just that text appearing at its original
pace. Pasted blocks are outlined so they are distinguishable from typing at a
glance. Below it, any text removed during the same session, and a per-operation
list showing the pause that preceded each keystroke.

## Activity statistics

**Expand** beside the heatmap opens the full activity view:

- Headline figures — days worked on, edits per active day, busiest day, most
  common hour, longest single session, longest gap between writing days.
- **Activity over time**, groupable by hour, day, week, month or year. Every
  grouping is re-binned from the same per-day data, so the totals always agree.
- **Who wrote it** — a donut of each author's share, measurable by characters
  written, number of edits, or active time. The three can disagree, and the
  difference is informative: a large share of characters with little active time
  usually means pasted text.
- **Time of day** and **day of week** distributions across the whole document.
- **Every writing day** — one row per day, each with its own 24-hour profile
  showing when during that day the work happened, plus that day's edit counts,
  active time, pastes and per-author breakdown.

Active time is credited to the day the earlier edit belongs to, so a session
running past midnight does not award the whole gap to one side.

The toolbar button follows the **page's** appearance, not Visor's theme. Docs
renders its toolbar light even when Visor is dark, so matching Visor there would
paint light text onto a light toolbar.

## Document tabs

If the file uses Google Docs tabs, Visor can narrow every figure to one tab.
There is a filter in the in-document bar (its menu opens upward), a selector at
the top of the side panel that states what you are looking at underneath it, and
a tab picker in the replay.

The side-panel selector is a dropdown of Visor's own rather than a native
`<select>`: a native one cannot take the glass treatment, and its popup is drawn
by the operating system in the operating system's colours, so it ignored the
theme entirely. It keeps the listbox keyboard contract — arrows, Home/End,
Enter, Escape, type-ahead aside — and closes on an outside click. Because it is
absolutely positioned, `.v-scope` carries a `z-index` so the menu paints over
the tab bar beneath it.

**Tabs are called "chapters" internally**, which is why nothing in the payload
ever says "tab". The mutation stream carries both the tab structure and the
per-tab attribution:

| Op | Meaning |
|---|---|
| `mkch` | the document's first tab — id is always `t.0`, name at `d[0][1]` |
| `ac` | a tab was added — id at `d[0]`, name at `d[1][1]` |
| `ucp` | a tab was renamed — id at `d[0]`, name at `d[1][1][1]` |
| | the **first tab has no id**: its slot is an empty string, e.g. `["", [[], [1, "Draft 1"]]]` |
| `dc` | a tab was deleted — id at `d[0]` |
| `nm` | retargets its child mutation (`nmc`) at the tab named in `nmr[1]` |

An edit wrapped in `nm` belongs to that tab; anything unwrapped belongs to the
first tab, `t.0`. So the tab list and every edit's tab both come out of the same
stream — nothing is guessed, and the tab roster is exact even for tabs that were
later renamed or deleted.

The first tab is addressed by an *empty* id slot rather than by `t.0`, so an
empty slot is read as the root tab. Treating it as a malformed operation is what
discarded that tab's rename and left it showing "Tab 1".

As a backstop, when an operation's tab id is genuinely unreadable but it still
carries a name, that name is kept as an orphan rather than discarded, and applied to a tab still wearing a
Docs default — but only when the pairing is forced (exactly one such tab and
exactly one unclaimed name). Discarding those names is what left a renamed first
tab showing "Tab 1".

A selected tab is folded from its own ops alone, because a tab's edits index into
that tab's own buffer — slicing it out of the whole-document fold would misplace
every position after the first omitted edit.

---

## Packaging

**Validate the manifest with Chrome itself before uploading.** A store upload
that fails "automated installation testing" tells you nothing about why; Chrome
tells you the exact line:

```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --pack-extension=<unzipped-copy> --no-message-box
```

Silence and a `.crx` means the manifest is valid. It uses the same parser as
Chrome on Linux, so it catches platform-independent manifest errors locally.

**`web_accessible_resources[].matches` takes origin-level patterns only.**
`https://docs.google.com/*` is accepted; `https://docs.google.com/document/*`
is rejected with *"Invalid match pattern"* and the package will not install.
This is unlike `host_permissions` and `content_scripts.matches`, which both
accept paths and are narrowed to `/document/*` and `/presentation/*`. Narrowing
all three together is what broke the first upload.

The folder is the package. Two things to know before zipping it:

- **Exclude `*.md`.** `SETUP.md` and `COPY-FORM.md` are working documents, not
  extension resources; every file in the ZIP is readable at
  `chrome-extension://<id>/<name>`.
- **Icons are generated, not hand-drawn.** `icons/icon{16,48,128}.png` are cut
  from `logo.png` — square, transparent, at their declared sizes. They were
  once a single 320×300 file reused for all three, which the Web Store rejects.
  Regenerating them means rescaling from `logo.png`, never editing the icons in
  place.

Visor declares no data collection in the store listing, and that is accurate:
it transmits nothing, so no privacy-policy URL is required.

## Privacy

Visor makes no request to any host other than the document you have open.

- No Google APIs, no OAuth, no scopes, no consent screen
- No accounts, no server, no telemetry, no analytics
- Nothing is uploaded, stored remotely, or shared
- Analysis happens in the tab and is discarded when you close it

The only host permission is `https://docs.google.com/*`.

---

## Caveats

This uses an internal Google endpoint rather than a documented API. It is what
makes the accuracy possible, and it carries two consequences worth knowing:

1. **Google can change the payload shape without notice.** The parser is written
   to degrade to partial data rather than to zero data, but a large change would
   need a fix.
2. **It is undocumented**, so it is outside the terms that cover the published
   Drive and Docs APIs.

---

## Troubleshooting

**"Reload the document tab to attach Visor"**
→ The tab was open before Visor was installed. Reload it.

**"Revision history is for editors"**
→ You have view access. This is intentional; ask the owner for edit access.

**Visor button missing from the toolbar**
→ Reload the document. If toolbar injection fails it appears as a floating
button in the bottom-right corner instead.

**Replay is slow on a very large document**
→ Use the `max` speed button, or drag the scrubber. Paste markers on the
scrubber jump straight to the notable moments.
