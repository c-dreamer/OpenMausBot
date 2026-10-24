# Split view: This computer and My Cloud side by side

Status: proposal plus a first slice behind an off-by-default setting. Line numbers are `electron/main.mjs` at this commit unless a file is named.

## What is asked

One desktop window shows one place at a time (the Server menu or the This computer | My Cloud switch). The owner wants both at once, each with its own bot's chat, like panes in AgentDeck or Zellij.

## How the window works today (the constraints)

1. **One window, one webContents, one place.** `mainWindow` is a single global (148). `createWindow` makes the only `BrowserWindow` with the shared `preload.cjs` and no partition (2061-2082), so the default session, and so the Cloud's cookie, is shared. It then loads `rendererOrigin()` (the local server, 1303) or the active remote's origin (2290-2298). Switching is `navigateMainWindow(url)` = `mainWindow.loadURL` (1626, 1735-1752): the local page is destroyed when the Cloud loads, and back.
2. **"Which place" is one persisted field.** `environmentsState.activeId` (1483) decides `activeRemote()`/`activeEnvironment()` (environments.cjs:395-408), the navigation allow-list (`workspaceNavigationAllowed` allows exactly `activeEnvironment(...).origin ?? localOrigin`, environments.cjs:89), the window title (79), the permission handlers (`activeRemoteOrigin`) and `did-fail-load` (2152, falls back to Local). Every `will-navigate`/`will-redirect` of the main window runs through that allow-list (2125-2135).
3. **Page identity is origin plus "is it the main window".** The preload decides the bridge from `location.origin === --omb-local-origin` (preload.cjs:39-40): the local page gets everything, any other page `REMOTE_SAFE` (41), plus `updater` when `update:offered` says yes and `HOME_PAGE` keys when `home:page` says yes (68). Main re-checks on every call, two ways:
   - `localOnly`/`senderIsLocal` (local-origin.cjs:28): origin only, any window.
   - `workspaceSenderAllowed` (environments.cjs:98), `cloudPageSenderAllowed` (cloud-home.mjs:317) and so `cloudPageAsking` (2675) and `updaterPageAllowed` (2686): the sender must be `mainWindow.webContents`' main frame **and** its origin must be the active remote / My Cloud. `cloudPageAsking` returns "local", "cloud" or null; every Cloud-page channel (one-home, home window, lending, plan, updater, prefs) hangs off it.
   So a page in any second window fails those checks and is treated as having no desktop powers beyond the origin-only ones. That is the right default for a pane, and it is why a pane cannot silently inherit the main window's Cloud powers.
4. **Everything else assumes one place on screen.** `homeWindow` (home-window.mjs:168, built 2713) owns waking My Cloud, the retry/offline/sign-in screens and `window()` is `mainWindow`; the "One home" ownership rules (frozen local copy, `rendererOrigin()` vs `cloudOrigin()`) read it. `sendToPage` (242) navigates the main window to the right place before delivering chat links and package installs. Unread badge and notifications: `desktop:unread-count` ignores any sender but `mainWindow` (1475); notification, microphone and clipboard grants require `contents === mainContents()` (app-permissions.mjs:82-90). Lending dialogs use `mainWindow` (2736). The updater is attached per `createWindow` window (2098). Single-instance (232) and `second-instance` (297) activate `mainWindow`; `allWindowsClosedQuit` counts all windows. The bot list and chat are plain pages of each server's own origin, so they are already independent per origin (each loads its own bots over its own `/api`).

## Approaches

**A. Two `WebContentsView` panes in one window** (the repo already uses `WebContentsView` for the desktop viewer, 1435, with a random partition prefix). Pros: one window, real panes, a divider, one title bar. Cons: it changes what a window *is*: `mainWindow.webContents` is the page every check above compares against, so each of those (about thirty sites) must learn "which pane"; `homeWindow` must drive a view instead of a window; `createWindow`'s guards (navigation, frames, permissions, title) move per view; a separate partition per pane would cut the pane off from the sign-in cookie that `homeWindow` and lending set on `session.defaultSession` (many uses in main.mjs), so each pane would need its own sign-in. Highest risk of a Cloud page ending up with the local page's `mainWindow` identity. Large change in a pinned 3.3k-line file.

**B. Renderer-side split** (one local renderer talks to both servers). Pros: no Electron window work. Cons: the local page would have to hold a cross-origin Cloud session (cookies are per origin; CORS and CSRF are designed against exactly this), the Cloud serves its own, versioned UI, and the page that has the full bridge would then execute Cloud-supplied data, or the Cloud UI would have to be embedded in an `<iframe>` inside the privileged page, which the app deliberately blocks (2137-2149, "no page may embed the local server, or any saved server, in this preload-bearing window"). Rejected on security.

**C. A second window tiled beside the first.** Pros: both windows keep exactly today's single-place semantics. The main window, `homeWindow`, `mainWindow`, notifications and updater are untouched. The second window is a plain browser-like window of the other place, fail-closed by item 3. Cons: two OS windows (own title bars, may be moved independently), no shared divider; the second window has no desktop extras (no notifications, voice, lending, updater, badge) because those are keyed to `mainWindow`; it does not wake a sleeping Cloud.

| | Security | State / sync | Cost / risk |
|---|---|---|---|
| A | Needs every sender check re-keyed; one miss gives the Cloud local powers | `activeId` and `homeWindow` become per-pane | high |
| B | Merges trust domains; rejected | n/a | high |
| C | Pane is a non-main window: item 3 denies it every `mainWindow`-keyed power; pinned to one origin | Nothing shared except the cookie jar; each page keeps its own selected bot | low |

## Recommendation

Do C first, as an opt-in, and treat A as the later "proper" version only if C proves the feature is wanted. The first slice (implemented here, `electron/split-view.mjs`, `split-view-main.mjs`, `split-view.node-test.mjs`):

- A **Split View** menu next to View. Its check "Experimental: Show Two Places Side by Side" (file `split-view.json` in the app data folder, default off) reveals **Show My Cloud Beside This Computer** and **Close the Split**.
- Opening requires the main window to be showing This computer's page, My Cloud to be known (`myCloud()`: the origin the Admin's session verified, or the one remembered for the signed-in account, the same sources `switchEnvironment` and `homeWindow` use) and a non-fullscreen window, and a display wide enough that each half is at least the window minimum width (`MIN_BOUNDS.width`, 840 px, so a display at least 1680 px wide). The main window is moved to the left half of its display, a second window is created on the right half and loads the verified Cloud origin. The address is read in main when the menu item runs; nothing from a page can name it.
- The pane is sandboxed, context-isolated, gets the same preload with the local origin as an argument (so the Cloud counts as non-local), and never the remote-client or company flags. It may not navigate or redirect off the Cloud origin, cannot embed the local server in a subframe, opens links in the browser, shows a fixed page if the Cloud does not answer.
- Close the pane (or the main window; on Windows when it hides to the tray) and the main window returns to its old size, unless the person moved it meanwhile.

Not the full `switchEnvironment` path: that path also wakes an asleep Cloud and signs in again, and that machinery is bound to `mainWindow` (item 4). The slice therefore opens only the verified home origin, shares the existing sign-in cookie, and shows a "did not answer" page otherwise; waking stays a main-window action.

## How a person uses it (the full feature)

1. A **Split** button next to the This computer | My Cloud switch (`src/components/DesktopWorkspaceSwitcher.tsx`) calls a fixed main-process action (no URL argument). In the slice it is the menu item; a button needs a new `workspaces`-style bridge entry on the local page only.
2. Left is This computer, right is My Cloud. Each side shows the bot that page last had selected; the pages keep that themselves, per origin. Choosing a bot on a side is the normal sidebar of that side. (Later: a "show this bot on the other side" action using the existing chat links, desktop-chat-links.md, delivered to the target pane by main.)
3. Layout memory: the slice remembers only the on/off setting. Remembering "split was open", the divider position and re-opening at launch is a follow-up, because restore must run after `homeWindow` has decided the home.
4. Close one side with the Close the Split command or the pane's close button; the other side continues alone, as today.

## Deliberately out of scope

Showing two bots of the same place; a draggable divider; Cloud on the left; a team's Cloud or another saved server in the pane; waking an asleep Cloud from the pane; notifications, voice, lending, updater prompts and the unread badge for the pane; dragging a chat between sides; changing `activeId` semantics, `homeWindow`, the preload or any sender check; the in-renderer Split button.

## Open risks

- **One home.** Once a person's bots have moved to My Cloud, this computer's copy is frozen, never shown (home-window.mjs header, "this computer's frozen copy is never shown once its bots moved") and the main window is the Cloud. The slice then reports "main window is not on this computer" and does nothing. It serves people whose bots are still here (before the move, or who stay hybrid). Whether split view should mean something after the move (for example Cloud beside a team's Cloud, option A territory) is a product question for the owner.

- Two windows are two places in the OS window list; the main window's saved size is the half size if the app quits with the split open. The pane closes with the main window and restores the size first.
- If the person switches the main window to My Cloud while the pane is open, both show the Cloud. Harmless, but the pane is not closed for them.
- Sign-out of the Cloud in the main window leaves the pane on the Cloud's own sign-in page, not closed.
- Verified only by unit tests with fake Electron classes: placement on real multi-monitor and HiDPI setups, tray behaviour on Windows and focus/Mission Control on macOS need a hands-on pass (see the PR description).
