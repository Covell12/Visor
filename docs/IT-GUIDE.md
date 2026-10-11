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
| `AllowDinosaurEasterEgg`, `URLBlocklist`… | your usual | Visor's lockdown works alongside your existing filtering, not instead of it. |

Optional, for high-stakes in-class writing:

- **Kiosk.** ChromeOS kiosk mode can run a single web app full screen on a dedicated device, if your exam-room setup supports it. For everyday in-class essays the simplest strong setup is a managed Chromebook with the policies above, the Visor tab in full screen (Visor asks for it), and the extension's lockdown on.
- **Allowed sites.** Teachers list the sites students may use in each locked assignment. Everything else, including AI sites, goes to Visor's blocked page.

## 3. What happens in a locked session

- The Visor tab asks for full screen when the session starts. Leaving full screen, switching to another tab or window, or going offline turns writing off immediately; the server records each pause with its reason and length, and the student sees the same timer the teacher sees.
- The extension installs declarativeNetRequest rules: Visor, Google sign-in and the allowed sites load; every other top-level page goes to `blocked.html`, which records the attempt ("lock-violation"). Tabs opening `chrome://extensions`, `chrome://settings` and similar browser pages are sent back to the Visor tab.
- The teacher's live board shows, per student: whether the extension is present and whether its lockdown is on, time away, pastes, and any AI-site visits or blocked attempts.

## 4. What Visor can't stop (and what it records instead)

Visor is honest about this so teachers can plan around it:

- **A second device.** A phone or another computer is outside Visor's view. Visor records how the essay was written (typing rhythm, pauses, pastes and where they came from), which makes text typed in from elsewhere visible as a pattern, but it can't see the other device.
- **Unmanaged machines.** Without the policies above a student can open an incognito window, another profile, or another browser. Locked sessions refuse to start without the extension, and the page records when the extension disappears mid-session, but a determined student on an unmanaged computer has ways around any browser extension.
- **Text pasted from outside Visor's view.** If a paste doesn't match anything the student copied during a session, Visor labels it "pasted from outside Visor's view" and shows it to the teacher, without guessing where it came from.
- **What students type on other sites.** The extension never records keystrokes on other sites, or page contents beyond the citation details of a page the student chose to cite.

Visor never labels writing as "AI-generated" or gives a probability. It shows what was measured and leaves the judgment to the teacher.

## 5. Data and retention

Research records are kept per class for the number of days the teacher sets (180 by default) and then deleted automatically. Teachers can delete a student's data for a class at any time; students can download their own data from their Profile. Details: the Visor privacy page (`/privacy`).
