# Security review: `extension-classroom-v1`

Reviewed: the Visor Chrome extension (4.5.0) at `65a2331` on `extension-classroom-v1`, all 82 files. The server's side of the extension API (`classroom-v1`, `server.js` and `public/ext.js`) was read only to judge the extension's trust decisions; it wasn't changed.

Line numbers below refer to the code as reviewed (`65a2331`). The fixes are in commit `05f5fa3` on branch `claude/nice-einstein-hysib3`, which is `extension-classroom-v1` plus the fixes.

## Summary

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | **High** | Any website can write fake AI-site visits and lock violations into a student's session record | Fixed |
| 2 | **Medium** | The Visor page can lift a locked session's lockdown (`DISCONNECT`, or `CONNECT` with a bad token) | Fixed |
| 3 | **Medium** (latent) | Session rules the server's answer leaves out are taken from the page | Fixed |
| 4 | Low | The extension token goes to whichever Visor address starts a session (builds from source) | Fixed |
| 5 | Low | Pages can plant fake "copy" events in the research record | Fixed |
| 6 | Low | Hardening: tokens handed to content scripts, a spoofable permission result, `config.js` web-accessible | Fixed |
| A | **Medium** | Revoking the extension token on the server lifts a locked session | Needs a server change or a product decision |
| B | Low | Navigations a page starts itself are recorded as the student's AI-site attempts | Recommendation |
| C | Low | Any site can tell the extension is installed | Recommendation |
| D | Low | The extension token is readable by content scripts | Recommendation |

Severity weighs who can do it and what it costs a student or teacher. #1 needs nothing but a page the student loads. #2, #3 and A need script running on the student's own Visor tab: a student with developer tools (an unmanaged computer) or a bookmarklet, attacking the lockdown.

---

## Fixed

### 1. Any website can write fake AI-site visits and lock violations into a session (High)

**Where:** `manifest.json:116-127` makes `blocked.html` web-accessible to `<all_urls>`. `blocked.js:5,10` reports whatever address follows `?u=`. `session-bg.js:1008-1026` records it with no check on who sent it.

**What happens:** `blocked.html` has to be web-accessible for the lockdown's declarativeNetRequest redirects to reach it. That also lets any page frame it or open it. The extension's ID is public (it's the Web Store ID; the web app hardcodes it in `public/ext.js:12`).

During a session, a page the student visits can include a hidden frame like this:

```html
<iframe src="chrome-extension://<id>/blocked.html?u=https://claude.ai/" style="opacity:0"></iframe>
```

The frame runs as an extension page and sends `VISOR_BLOCKED`. The service worker then queues `ai-site` (blocked) for an AI address, or `blocked` for any other address. The server turns these into the session's `ai-site` and `lock-violation` events (`server.js:4031-4032`), which appear on the teacher's live board.

Three details make it worse:

- The page that does this can be an ad or widget frame inside an allowed page, because the lockdown only redirects top-level pages.
- The service worker recorded even addresses that no rule blocks.
- A framed copy could also be clickjacked into "Back to my writing", which navigates or closes the tab hosting it.

**Impact:** fabricated evidence of AI use against a student, in a product whose purpose is evidence of how work was done.

**Shown in real Chromium**, using the original code with a fake Visor server and an "attacker" site on another origin. Two hidden frames produced `ai-site: https://claude.ai/forged-frame` and `blocked: http://127.0.0.1:3001/` in the session's queue.

**Fix:**

- Each session gets a random 128-bit key, kept in `chrome.storage.session`, which content scripts can't read.
- Every way to the blocked page carries the key: DNR rule redirects (`lockdown.js` `blockedUrl`, `?k=<key>&u=\0`) and the `tabs.update` redirects.
- `VISOR_BLOCKED` is recorded only from `blocked.html` at the top of its tab (`frameId === 0`) with the session's key. Everything else gets `{ reason: null }` and records nothing.
- `VISOR_BACK_TO_WRITING` acts only for a top-level `blocked.html`.
- The key survives a re-sent `SESSION_START` (a page reload) and is new for each session.

### 2. The Visor page can lift a locked session's lockdown (Medium)

**Where:** `session-bg.js:518-522` (`DISCONNECT`) and `session-bg.js:512-517` (`CONNECT`).

**What happens:** `SESSION_END` deliberately asks the server before ending anything ("A page can't lift the rules by saying so"). `DISCONNECT` did not: it removed the token and ended the session at once. Ending the session clears the declarativeNetRequest rules and stops research capture.

`CONNECT` had the same effect one beat later. It replaced the token, the server answered the next beat with 401, and `disconnectedByServer()` ended the session.

From the Visor tab, either takes one line:

```js
postMessage({ source: 'visor-page', type: 'DISCONNECT', id: 'x' }, location.origin)
```

That works from developer tools, or from a bookmarklet on machines where developer tools are disabled by policy. AI sites then load and aren't recorded. The server only notices the missing beats after about 2.5 minutes.

This contradicts `docs/IT-GUIDE.md`: "a locked session can't be ended from the page."

**Shown in real Chromium:** on the original code, `DISCONNECT` returned `ok` and the lockdown rules went from 13 to 0.

**Fix:**

- While a session runs, `DISCONNECT` asks the server first, as `SESSION_END` does. It goes through only if the server says the session is over, or no longer accepts the token.
- `CONNECT` can't replace a live token while a session runs. It's still allowed if the connection is already gone, since the session ends at its next beat anyway.

The web app's own Disconnect button keeps working, because it revokes the token on the server first (see A).

### 3. Session rules the server leaves out are taken from the page (Medium, latent)

**Where:** `session-bg.js:149`, `settings = { ...settings, ...ack.settings }`, where `settings` is what the page sent.

**What happens:** the server's `extSessionSettings` (`server.js:3975`) returns the stored values as they are. `res.json` drops keys whose value is `undefined`, so for any policy key an assignment doesn't store, the page's value survives the merge.

For example, a page sending `blockedSites: []` for an assignment with no stored list turns off blocking and recording for every AI site on the default list. Search-engine AI modes stay blocked.

New assignments get every key from `defaultWriting()`. Exposure depends on assignments saved before a setting existed, or on a missing assignment record (`a?.writing || {}`). I couldn't check stored data.

**Fix:** when the server sends settings, the policy keys come only from it: `mode`, `researchTracking`, `allowedSites`, `blockedSites`, `blockAiSites`, `citationStyle`, `oneClickCite` and `panelBrowsing`. A missing key stays unset; `blockedSites` then falls back to the default AI list.

The page still supplies what's only displayed, plus `research`, which panel presence and the beat already check. A server too old to send settings at all still gets the page's values, as before. That covers servers from before `d0c3803` on `classroom-v1`.

The honest page sends the same raw values the server does (`wsExtSettings` in `public/writer-session.js`), so legitimate sessions don't change.

### 4. The token goes to whichever Visor address starts a session (Low)

**Where:** `session-bg.js:144` uses `sender.origin` as the API base for the ack, and the session's beats and research uploads follow it. Nothing compared it with the address the token was issued on. `PING` already did (`sameVisorSite`).

**What happens:** in builds loaded from source, `http://localhost:3000` is a Visor address (`config.js:21`, `manifest.json:69`). Port 3000 is the default port for many local dev servers. Any page on it could send `SESSION_START` and receive the student's `X-Visor-Token` (30 days), followed by their research stream. The Web Store build is not affected, because `tools/build-release.js` strips localhost and fails if it survives.

**Fix:** `sessionStart` refuses a session from a different Visor site, and `visorApi` never sends the token to a site other than the one it was issued on. Visor's public addresses still count as one site.

### 5. Pages can plant fake "copy" events in the research record (Low)

**Where:** `research-capture.js:20`.

**What happens:** the copy listener didn't check `isTrusted`. A page could select any text and dispatch its own `copy` event. The session would record the student copying that text from that page: its first 140 characters and a hash. The editor uses this to say where pastes came from.

**Fix:** only the browser's own copy events count.

### 6. Hardening (Low)

- **`VISOR_PANEL_STATE`** (`background.js:48`, `session-bg.js:1183`) returned the session token and the extension token to any sender, content scripts included. Content scripts live in sites' pages, and they can't otherwise read the session token, which is kept in `chrome.storage.session`. It now answers only extension pages.
- **`VISOR_PERMISSION_RESULT`** (`background.js:52`) took `granted: true` from any sender and switched recording on. It now counts only from `permission.html`, and only as far as `chrome.permissions.contains` agrees.
- **`config.js`** was web-accessible to every site. Only extension pages load it, so it no longer is.

---

## Not fixed: needs a decision, or a change in the web app

### A. Revoking the extension token lifts a locked session (Medium)

The web app's Disconnect button (`extDisconnect`, `public/ext.js:119`) calls `DELETE /api/ext/token` (`server.js:3944`), which revokes every extension token the person has. Page script can make the same request with the session cookie.

The extension's next beat then gets 401, and `session-bg.js:272` ends the session, clearing the rules. The fix for #2 makes the page's own word insufficient, but this path goes through the server, so it remains. The server does know about it: the token was revoked, and the session pauses after about 2.5 minutes without beats. Until then, AI-site visits aren't recorded.

Options, best first:

1. **Server:** refuse to revoke extension tokens while the person has a running locked session, or record it on the live board as an integrity event ("extension disconnected mid-session").
2. **Extension:** after a 401 in a locked session, keep the rules (and keep queueing research) until the student reconnects and the server confirms the session is over. Visor's own pages stay reachable for reconnecting, and a browser restart already clears stale rules. This changes what students see, so it's a product decision.

Also in the web app: if the extension refuses `CONNECT` mid-session, the Connect page shows "The extension didn't answer" (`extConnect`). The extension's answer carries a clearer `error` the page could show.

### B. Navigations a page starts itself are recorded as attempts (Low)

Any page can navigate itself, or open a window, to an AI site. The extension records an `ai-site` attempt either way, and can't tell it from a click by the student. The student does see it happen, because their tab lands on the blocked page. With #1 fixed, this is the only way a third party can still put AI-site entries in the record.

**Suggestion:** record `transitionType` and `transitionQualifiers` from `webNavigation.onCommitted` (for example `client_redirect`) so the teacher sees "opened by a page".

### C. Any site can tell the extension is installed (Low)

`blocked.html`, `blocked.js`, `blocked.css` and `logo.png` can be fetched by every site, so any site can detect Visor. `"use_dynamic_url": true` would prevent it. It needs testing with declarativeNetRequest redirects first, and the web app's own `storeCopyRunning()` (`public/ext.js:47`) relies on fetching `logo.png` at the static ID.

### D. The extension token is readable by content scripts (Low, defense in depth)

The token is kept in `chrome.storage.local`, which every content script can read. During research-recorded sessions, content scripts run on every site, so a renderer compromise on any site could read it.

Moving it to `chrome.storage.session` (trusted contexts only) closes that, at the cost of reconnecting after each browser restart.

---

## What was checked and held up

- **HTML rendering:** every `innerHTML` sink that shows document or page data escapes it. That covers `content.js`, `sidepanel.js`, `replay.js` and `sessionpanel.js` (contributor names, pasted and deleted text, tab titles, project names), and `mailto:` is forced on email links. MV3's default CSP blocks inline script on extension pages anyway.
- **Messaging:** every `postMessage` channel checks its source window, and the token handoff to the panel's frame is addressed to its origin both ways. This includes the site bridge, the page probe, AWARE, the replay frame (targeted at the extension origin) and the session panel frame.
- **Site bridge:** it checks `e.source` and `e.origin` and allows a fixed list of message types. The worker re-checks the sender's address, and presence is read from the isolated world, which the page can't fake.
- **No dynamic code:** no `eval`, `new Function` or remotely loaded script. Docs revision requests go to fixed `docs.google.com` endpoints.
- **Builds:** the release build strips `localhost` and fails if it survives. The Docs-only build drops all Classroom files and permissions.
- **Data leaving the browser:** the Docs report sent to Visor leaves out pasted and deleted text, AWARE's map and diagnostics.
- **Secrets:** there are no credentials in the repository or its history. The store listing has `[STUDENT PASSWORD]`-style placeholders only.

## Verification

- **Unit tests:** all 15 test files pass, 522 checks. 27 checks are new: 20 in `test-session-panel-switch.js`, 4 in `test-lockdown-rules.js`, and 3 in the new `test-research-capture.js`.
- **Regression proof:** the new checks were also run against the original code. Apart from those that test the new key itself, they fail exactly where the flaws are:
  - forged blocked-page events recorded, and a framed copy closing the tab hosting it;
  - `DISCONNECT` and `CONNECT` lifting the lock;
  - the page's `blockedSites: []` winning;
  - the token sent to `localhost:3000`;
  - tokens handed to a content script;
  - recording switched on by a bare `granted: true`;
  - synthetic copies reported.
- **Builds:** `tools/build-release.js` and `tools/build-docs.js` both build cleanly.
- **Real Chromium:** Playwright with the unpacked extension, site access granted as the IT guide's policy does, a fake Visor server on `localhost:3000`, and an "attacker" site on another origin, in an open session that blocks AI sites:

| | Original | Fixed |
|---|---|---|
| Lockdown rules accepted by Chrome | 13 | 13, each redirect carrying the key |
| Visit to `https://chatgpt.com/c/1?x=1&y=2` | redirected, recorded once | redirected to `blocked.html?k=<key>&u=https://chatgpt.com/c/1?x=1&y=2`, recorded once, AI wording shown |
| Attacker site frames and opens `blocked.html` | fake `ai-site` (claude.ai) and fake `blocked` recorded | nothing recorded |
| Page sends `DISCONNECT` mid-session | `ok`; rules 13 → 0; session gone | refused (`stillActive`); 13 rules stay |

Before publishing: bump `manifest.json`'s version (the Web Store needs a higher one) and build with `tools/build-release.js`.
