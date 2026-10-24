// Split view, first slice: a second window beside the main one that shows My Cloud while the main window shows This
// computer (docs/design/split-view.md, option C). Electron's classes arrive as arguments so the placement and the guards
// are testable without Electron.
//
// Security: the main window and its machinery (home-window.mjs, the sender checks that compare against mainWindow) are not
// touched. The other window gets the same preload, but main's handlers answer only the main window's frame, so a page in
// the pane reaches the remote-safe subset at most; the preload sees the local origin as an argument and never treats the
// Cloud as local. The pane's address is the verified Cloud origin read in main when it opens (never a value from a page),
// the pane may not leave that origin, and it never gets the remote-client flag.

export const PANE_TITLE = "OpenMausBot — My Cloud (split)";

const SAME_PX = 2;
const originOf = (url) => { try { const origin = new URL(url).origin; return origin === "null" ? null : origin; } catch { return null; } };
const sameBounds = (a, b) => ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= SAME_PX);
const escaped = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The work area cut in two: this computer on the left, the other place on the right. */
export function tilePair(workArea) {
  const half = Math.floor(workArea.width / 2);
  return {
    left: { x: workArea.x, y: workArea.y, width: half, height: workArea.height },
    right: { x: workArea.x + half, y: workArea.y, width: workArea.width - half, height: workArea.height },
  };
}

/** A Cloud origin main verified, as an https origin (http only when a developer asks for it); anything else is no Cloud. */
export function verifiedCloudOrigin(value, { allowHttp = false } = {}) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (allowHttp && url.protocol === "http:") ? url.origin : null;
  } catch { return null; }
}

/** What the pane shows when the Cloud did not answer; its one link goes to the pinned origin, which the pane may open. */
export function unreachablePage(origin) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset=utf-8><title>My Cloud</title><body style="font:15px system-ui;background:#070707;color:#ddd;padding:2em">My Cloud did not answer. If it is asleep, wake it in the main window.<p><a style="color:#9cf" href="${escaped(origin)}">Try again</a></p>`)}`;
}

/**
 * @param {{
 *   BrowserWindow: new (options: object) => any,
 *   screen: { getDisplayMatching(bounds: object): { workArea: object } },
 *   enabled(): boolean,
 *   blocked?(): boolean,
 *   main(): any,
 *   localOrigin(): string,
 *   cloudOrigin(): string | null,
 *   rendererArguments(): string[],
 *   preload: string,
 *   chrome?: object,
 *   icon?: string,
 *   minWidth?: number,
 *   minHeight?: number,
 *   allowHttp?: boolean,
 *   closeOnHide?: boolean,
 *   openExternal(url: string): void,
 *   onChange?(): void,
 *   log?(line: string): void,
 * }} deps `main()`: the main window; `cloudOrigin()`: My Cloud as main verified it; `rendererArguments()`: the main
 * window's own preload arguments (they name the local origin); `closeOnHide`: the main window hides to the tray instead of
 * closing (Windows); `openExternal(url)`: validates and opens a link in the browser; `allowHttp`: a developer's Cloud over http.
 */
export function createSplitView(deps) {
  const { BrowserWindow, screen, enabled, blocked = () => false, main, localOrigin, cloudOrigin, rendererArguments, preload, chrome = {}, icon,
    minWidth = 0, minHeight = 0, allowHttp = false, closeOnHide = false, openExternal, onChange = () => {}, log = () => {} } = deps;
  let pane = null;
  let restore = null;

  const mainAlive = () => { const win = main(); return win && !win.isDestroyed() ? win : null; };
  const mainShowsLocal = (win) => originOf(win.webContents.getURL()) === originOf(localOrigin());
  const cloud = () => verifiedCloudOrigin(cloudOrigin(), { allowHttp });

  /** Why the split cannot open now, or null. */
  function why() {
    if (!enabled()) return "off";
    if (blocked()) return "unavailable";
    if (pane) return "open";
    const win = mainAlive();
    if (!win) return "no-window";
    if (!mainShowsLocal(win)) return "main-not-local";
    const origin = cloud();
    if (!origin || origin === originOf(localOrigin())) return "no-cloud";
    if (win.isFullScreen()) return "fullscreen";
    return null;
  }

  function guard(contents, pinned) {
    contents.setWindowOpenHandler(({ url }) => {
      try { openExternal(url); } catch { log("split: a link was refused"); }
      return { action: "deny" };
    });
    const stay = (event, url) => { if (originOf(url) !== pinned) event.preventDefault(); };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("will-frame-navigate", (details) => {
      if (!details.isMainFrame && originOf(details.url) === originOf(localOrigin())) details.preventDefault();
    });
    contents.on("did-fail-load", (_event, code, _text, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) void pane?.loadURL(unreachablePage(pinned)).catch(() => {});
    });
  }

  const api = {
    why,
    isOpen: () => pane !== null,
    /** While the split is open: what the main window's saved state should say (its size before the split), else null. */
    unsplit: (win) => (restore && win === main() ? { bounds: restore.bounds, maximized: restore.maximized } : null),
    /** The pane's address is never a parameter: it is the Cloud main verified now. */
    open() {
      const reason = why();
      if (reason) return { ok: false, reason };
      const win = mainAlive();
      const pinned = cloud();
      const { left, right } = tilePair(screen.getDisplayMatching(win.getBounds()).workArea);
      if (left.width < minWidth) return { ok: false, reason: "too-narrow" };

      const maximized = win.isMaximized();
      restore = { bounds: maximized ? win.getNormalBounds() : win.getBounds(), maximized, left };
      if (maximized) win.unmaximize();
      win.setBounds(left);

      let created;
      try {
        created = new BrowserWindow({
          ...right,
          minWidth,
          minHeight,
          ...(icon ? { icon } : {}),
          title: PANE_TITLE,
          backgroundColor: "#070707",
          autoHideMenuBar: true,
          ...chrome,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, additionalArguments: rendererArguments() },
        });
      } catch (error) {
        log(`split: the window could not be made (${error?.message ?? error})`);
        win.setBounds(restore.bounds);
        if (restore.maximized && win.isVisible()) win.maximize();
        restore = null;
        return { ok: false, reason: "failed" };
      }
      pane = created;
      created.setTitle(PANE_TITLE);
      created.webContents.on("page-title-updated", (event) => { event.preventDefault(); created.setTitle(PANE_TITLE); });
      guard(created.webContents, pinned);
      const closeWithMain = () => api.close();
      win.once("closed", closeWithMain);
      win.once("enter-full-screen", closeWithMain);
      if (closeOnHide) win.once("hide", closeWithMain);
      created.once("closed", () => {
        win.removeListener("closed", closeWithMain);
        win.removeListener("enter-full-screen", closeWithMain);
        win.removeListener("hide", closeWithMain);
        if (pane === created) pane = null;
        const kept = restore;
        restore = null;
        if (kept && !win.isDestroyed() && sameBounds(win.getBounds(), kept.left)) {
          win.setBounds(kept.bounds);
          if (kept.maximized && win.isVisible()) win.maximize();
        }
        onChange();
      });
      void created.loadURL(pinned).catch(() => {});
      onChange();
      return { ok: true };
    },
    close() {
      const current = pane;
      if (current && !current.isDestroyed()) current.close();
    },
  };
  return api;
}
