# Visor for school IT: installing and locking down

This guide is for the person who manages Chromebooks or Chrome browsers at a school. It covers how to install the Visor extension for students, which Chrome policies make locked writing sessions hold, and, plainly, what Visor can and can't stop.

## What the extension does

Visor Classroom is a web app (`https://visor-ed.web.app`, or your school's own copy). Students write essays in its editor during a **writing session** that their teacher starts. The Visor Chrome extension is the session's companion:

- **Only during an active session**, and with a red **REC** badge on its toolbar icon, it records the student's research: searches, pages visited and for how long, text copied (a hash, the length and the first 140 characters), visits to AI sites, and citations added.
- In a **locked** session (an in-class essay) it keeps the student on the sites the teacher allowed and sends everything else to a "This site isn't allowed during your Visor session" page.
- It adds a **Cite this page** button and keeps the student's essay open in Chrome's side panel next to their research.
- Outside a session it records nothing. Its other feature, showing who wrote what in a Google Doc, reads only that document's history, in the student's own browser.

## 1. Force-install the extension (Google Admin)

1. Google Admin console → **Devices → Chrome → Apps & extensions → Users & browsers**.
2. Pick the organizational unit with your students.
3. Add the extension by its Chrome Web Store ID and set it to **Force install** (or **Force install + pin to browser toolbar**, so students see the REC badge).

The same setting as a policy, for managed Chrome browsers outside Google Admin (Windows GPO, macOS profiles):

```
ExtensionInstallForcelist = ["<extension-id>;https://clients2.google.com/service/update2/crx"]
```

A force-installed extension can't be turned off or removed by the student.

### Pre-grant the "read sites" permission

Recording research and enforcing the allowed-sites list need the extension's optional permission to see the sites a student visits (`<all_urls>`). Students are asked for it once, in a small Visor window, the first time they start a research-recorded session. To skip that prompt, allow it by policy for the extension (Admin console → the extension → **Permissions and URL access**, or the `ExtensionSettings` policy with `runtime_allowed_hosts: ["*://*/*"]`). A locked session won't start until the permission is granted, because Chrome only lets an extension redirect pages on sites it may see.

### If your Visor address isn't visor-ed.web.app

The extension only talks to the Visor addresses listed in two places that must match: `config.js` (`VISOR_WEB_ORIGINS`) and the `matches` of the `site-bridge.js` content script in `manifest.json`. A school running its own copy at another domain needs a build of the extension with that domain in both places (see `SETUP.md`).

## 2. Close the doors an extension can't

| Policy | Value | Why |
|---|---|---|
| `IncognitoModeAvailability` | `1` (disabled) | Extensions don't run in incognito windows unless allowed, so an incognito window is a browser with no Visor in it. |
| `DeveloperToolsAvailability` | `2` (never allowed) | Developer tools can change the page and its network requests. |
| `ExtensionInstallForcelist` | Visor (above) | The student can't turn the extension off. If it is turned off anyway (an unmanaged machine), the Visor page notices within about 15 seconds, records it, pauses a locked session and tells the student to turn it back on. |
| `BrowserGuestModeEnabled` / `BrowserAddPersonEnabled` | `false` | Guest windows and other profiles don't have the extension. |
| `GenAiDefaultSettings` | `2` (do not allow) | Turns off Chrome's own generative AI features by default, such as Gemini in Chrome, Google Lens and AI Mode ([policy reference](https://chromeenterprise.google/policies/gen-ai-default-settings/)). Visor blocks AI *sites*; these features are part of the browser itself. Check the policy page for the current list, and set a feature's own policy where you want something different. |
| `ExtensionInstallAllowlist` + `ExtensionInstallBlocklist` = `["*"]` | your approved extensions, Visor included | Students can't add other extensions. Grammar and AI writing helpers that come as extensions work inside web pages, so an allowlist is the only reliable way to keep them out of an essay. |
| `AllowDinosaurEasterEgg`, `URLBlocklist`… | your usual | Visor's lockdown works alongside your existing filtering, not instead of it. |

Optional, for high-stakes in-class writing:

- **Kiosk.** ChromeOS kiosk mode can run a single web app full screen on a dedicated device, if your exam-room setup supports it. For everyday in-class essays the simplest strong setup is a managed Chromebook with the policies above, the Visor tab in full screen (Visor asks for it), and the extension's lockdown on.
- **Allowed sites.** Teachers list the sites students may use in each locked assignment. Everything else, including AI sites, goes to Visor's blocked page.

## 3. What happens in a locked session

- The Visor tab asks for full screen when the session starts. Leaving full screen, switching to another tab or window, or going offline turns writing off immediately; the server records each pause with its reason and length, and the student sees the same timer the teacher sees.
- The extension installs declarativeNetRequest rules: Visor, Google sign-in and the allowed sites load; every other top-level page goes to `blocked.html`, which records the attempt ("lock-violation"). Tabs opening `chrome://extensions`, `chrome://settings` and similar browser pages are sent back to the Visor tab.
- With "Block AI sites" on (the default), the AI list also covers AI sites inside frames on other pages (a chat widget, a page that frames ChatGPT), and the AI answer modes of search engines that live at a search address rather than a site of their own: Google's AI Mode, Bing's Copilot search and DuckDuckGo's Duck.ai.
- **The side panel.** A teacher can let students switch to Chrome's side panel to research during a locked session: their essay moves into the panel, the Visor tab leaves full screen, and other sites (never AI sites) open while they research. That only lasts while the panel is on screen. If the student closes it, or puts another panel in its place (Chrome's own Gemini or Lens, another extension's), research mode ends within about 3 seconds: the allowed list applies again, the Visor tab comes to the front and asks for full screen, and the session records that the panel was closed. Being somewhere else (another app, the window minimized) doesn't count as closing it: writing pauses then anyway, and it's looked at again when the student comes back. Research mode can't begin without the panel on screen, and the session's end (a submit from the panel) is checked with the server first, so nothing is recorded for a session that's over.
- With "Block AI sites", the search engines' AI modes are also caught when a results page switches into them without loading a new page, or through an encoded address; the tab goes to the blocked page and the visit is recorded. An AI site reached through a redirect (a search result's link) is recorded once on the blocked page.
- If the extension's access to sites is withdrawn mid-session (only possible when it isn't force-installed with the access granted), pages it would have sent to the blocked page are blocked outright instead, and the teacher's live board shows "site access withheld from the extension".
- **Writing tools in the editor.** On assignments that block AI sites, Visor's editor sets the switches that grammar and writing tools honour (`writingsuggestions="false"` for the browser's own suggestions, and Grammarly's and LanguageTool's opt-outs), and records the name of any known writing tool that appears on the essay page anyway, asking the student to turn it off. Grammar checkers (Grammarly, LanguageTool, QuillBot, Wordtune…) count only when they attach to the essay, so a student who merely has one installed (including a school-installed one that honours the opt-out) isn't reported; AI chat sidebars (Sider, Monica, MaxAI, Merlin, HARPA) count when they're on the page. It records names only, and never reports a tool it doesn't know (a password manager, a translator).
- The teacher's live board shows, per student: whether the extension is present and whether its lockdown is on, time away, pastes, any AI-site visits or blocked attempts, a writing tool on the page, and a side panel closed mid-research.

## 4. What Visor can't stop (and what it records instead)

Visor is honest about this so teachers can plan around it:

- **A second device.** A phone or another computer is outside Visor's view. Visor records how the essay was written (typing rhythm, pauses, pastes and where they came from), which makes text typed in from elsewhere visible as a pattern, but it can't see the other device.
- **Unmanaged machines.** Without the policies above a student can open an incognito window, another profile, or another browser. Locked sessions refuse to start without the extension, and the page records when the extension disappears mid-session, but a determined student on an unmanaged computer has ways around any browser extension.
- **AI in another window or inside another extension.** The side panel's research mode follows the panel in its own window; an AI panel open in a second Chrome window, or an AI chat inside another extension's own popup, is outside Visor's rules. Chrome's generative AI policy and the extension allowlist above close these doors.
- **Writing tools Visor doesn't know.** A grammar or AI helper extension that ignores the opt-outs and isn't on Visor's list isn't noticed. What it puts into the essay still shows in the replay and the edit history (text that arrived without typing or a paste is marked "no keyboard or paste event"). The extension allowlist above closes this door.
- **Text pasted from outside Visor's view.** If a paste doesn't match anything the student copied during a session, Visor labels it "pasted from outside Visor's view" and shows it to the teacher, without guessing where it came from.
- **What students type on other sites.** The extension never records keystrokes on other sites, or page contents beyond the citation details of a page the student chose to cite.

Visor never labels writing as "AI-generated" or gives a probability. It shows what was measured and leaves the judgment to the teacher.

## 5. Data and retention

Research records are kept per class for the number of days the teacher sets (180 by default) and then deleted automatically. Teachers can delete a student's data for a class at any time; students can download their own data from their Profile. Details: the Visor privacy page (`/privacy`).
