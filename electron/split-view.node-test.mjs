import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSplitSetting, installSplitView } from "./split-view-main.mjs";
import { createSplitView, PANE_TITLE, tilePair, verifiedCloudOrigin } from "./split-view.mjs";

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://me.cloud.example";
const WORK = { x: 0, y: 25, width: 1801, height: 900 };
const MAIN_BOUNDS = { x: 10, y: 40, width: 1200, height: 700 };

class FakeContents extends EventEmitter {
  constructor() { super(); this.url = ""; this.openHandler = null; }
  getURL() { return this.url; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
    this.webContents = new FakeContents();
    this.loaded = [];
    this.destroyed = false; this.maximized = false; this.fullScreen = false; this.title = options.title ?? "";
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  setTitle(title) { this.title = title; }
  loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
  close() { this.destroyed = true; this.emit("closed"); }
}

function setup(over = {}) {
  const main = new FakeWindow(MAIN_BOUNDS);
  main.webContents.url = `${LOCAL}/`;
  const panes = [];
  const opened = [];
  const state = { enabled: true, cloud: CLOUD, changes: 0, ...over };
  class PaneWindow extends FakeWindow { constructor(options) { super(options); panes.push(this); } }
  const view = createSplitView({
    BrowserWindow: PaneWindow, screen: { getDisplayMatching: () => ({ workArea: state.workArea ?? WORK }) },
    enabled: () => state.enabled, main: () => (state.noMain ? null : main), localOrigin: () => LOCAL, cloudOrigin: () => state.cloud,
    rendererArguments: () => [`--omb-local-origin=${LOCAL}`], preload: "/app/preload.cjs", chrome: { frame: false }, minWidth: 400,
    closeOnHide: state.closeOnHide, openExternal: (url) => { if (!url.startsWith("https://")) throw new Error("refused"); opened.push(url); }, onChange: () => state.changes++,
  });
  return { main, panes, opened, state, view };
}

test("tilePair splits the work area with no gap and no overlap", () => {
  const { left, right } = tilePair(WORK);
  assert.deepEqual(left, { x: 0, y: 25, width: 900, height: 900 });
  assert.deepEqual(right, { x: 900, y: 25, width: 901, height: 900 });
});

test("only an http(s) origin counts as a Cloud", () => {
  assert.equal(verifiedCloudOrigin("https://a.example/x?y"), "https://a.example");
  for (const bad of [null, "", "javascript:alert(1)", "file:///etc", "data:text/html,x", "not a url"]) assert.equal(verifiedCloudOrigin(bad), null);
});

test("the split setting is off until chosen, and a broken record is off", () => {
  assert.equal(createSplitSetting({ read: () => { throw new Error("unreadable"); }, write: () => {} }).enabled(), false);
  assert.equal(createSplitSetting({ read: () => ({ enabled: "yes" }), write: () => {} }).enabled(), false);
  let saved = null;
  const setting = createSplitSetting({ read: () => ({}), write: (value) => { saved = value; } });
  assert.equal(setting.enabled(), false);
  setting.set(true);
  assert.deepEqual(saved, { enabled: true });
  assert.equal(setting.enabled(), true);
  assert.equal(createSplitSetting({ read: () => ({ enabled: true }), write: () => {} }).enabled(), true);
  const unwritable = createSplitSetting({ read: () => ({}), write: () => { throw new Error("disk full"); } });
  unwritable.set(true);
  assert.equal(unwritable.enabled(), true);
});

test("it opens nothing while the setting is off", () => {
  const { view, panes, main } = setup({ enabled: false });
  assert.deepEqual(view.open(), { ok: false, reason: "off" });
  assert.equal(panes.length, 0);
  assert.deepEqual(main.bounds, MAIN_BOUNDS);
});

test("it opens nothing unless the main window shows this computer and My Cloud is verified", () => {
  const away = setup();
  away.main.webContents.url = `${CLOUD}/`;
  assert.equal(away.view.open().reason, "main-not-local");
  assert.equal(setup({ cloud: null }).view.open().reason, "no-cloud");
  assert.equal(setup({ cloud: "javascript:1" }).view.open().reason, "no-cloud");
  assert.equal(setup({ cloud: LOCAL }).view.open().reason, "no-cloud");
  assert.equal(setup({ noMain: true }).view.open().reason, "no-window");
  const full = setup();
  full.main.fullScreen = true;
  assert.equal(full.view.open().reason, "fullscreen");
  assert.equal(full.panes.length, 0);
});

test("a screen too narrow for two halves is refused before anything moves", () => {
  const narrow = setup({ workArea: { x: 0, y: 0, width: 700, height: 500 } });
  assert.equal(narrow.view.open().reason, "too-narrow");
  assert.equal(narrow.panes.length, 0);
  assert.deepEqual(narrow.main.bounds, MAIN_BOUNDS);
});

test("open tiles both windows and loads the verified Cloud origin, whatever it is asked", () => {
  const { view, panes, main, state } = setup({ cloud: `${CLOUD}/some/path?x=1` });
  assert.deepEqual(view.open("https://evil.example", { url: "https://evil.example" }), { ok: true });
  assert.deepEqual(main.bounds, { x: 0, y: 25, width: 900, height: 900 });
  const [pane] = panes;
  assert.deepEqual(pane.bounds, { x: 900, y: 25, width: 901, height: 900 });
  assert.deepEqual(pane.loaded, [CLOUD]);
  assert.equal(pane.title, PANE_TITLE);
  assert.equal(state.changes, 1);
  assert.equal(view.open().reason, "open");
  assert.equal(panes.length, 1);
});

test("the pane is sandboxed and isolated, names the local origin, and never carries the remote-client or company flags", () => {
  const { view, panes } = setup();
  view.open();
  const prefs = panes[0].options.webPreferences;
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.preload, "/app/preload.cjs");
  assert.deepEqual(prefs.additionalArguments, [`--omb-local-origin=${LOCAL}`]);
  assert.equal(prefs.webviewTag, undefined);
});

test("the pane may not leave the Cloud origin, by navigation or redirect, and its links open in the browser", () => {
  const { view, panes, opened } = setup();
  view.open();
  const contents = panes[0].webContents;
  const prevented = (event, url) => { let blocked = false; contents.emit(event, { preventDefault: () => { blocked = true; } }, url); return blocked; };
  assert.equal(prevented("will-navigate", `${CLOUD}/chat`), false);
  assert.equal(prevented("will-navigate", `${LOCAL}/`), true);
  assert.equal(prevented("will-redirect", "https://elsewhere.example/"), true);
  assert.equal(prevented("will-redirect", `${LOCAL}/api`), true);
  assert.equal(prevented("will-navigate", "javascript:alert(1)"), true);
  assert.deepEqual(contents.openHandler({ url: "https://docs.example/x" }), { action: "deny" });
  assert.deepEqual(contents.openHandler({ url: `${LOCAL}/` }), { action: "deny" });
  assert.deepEqual(contents.openHandler({ url: "file:///etc/passwd" }), { action: "deny" });
  assert.deepEqual(opened, ["https://docs.example/x"]);
});

test("a subframe in the pane may not load the local server", () => {
  const { view, panes } = setup();
  view.open();
  const prevented = (url, isMainFrame) => { let blocked = false; panes[0].webContents.emit("will-frame-navigate", { url, isMainFrame, preventDefault: () => { blocked = true; } }); return blocked; };
  assert.equal(prevented(`${LOCAL}/`, false), true);
  assert.equal(prevented("https://embed.example/", false), false);
  assert.equal(prevented(`${LOCAL}/`, true), false);
});

test("an unreachable Cloud shows one fixed page; an aborted load or a subframe failure is ignored", () => {
  const { view, panes } = setup();
  view.open();
  const contents = panes[0].webContents;
  contents.emit("did-fail-load", {}, -3, "aborted", CLOUD, true);
  contents.emit("did-fail-load", {}, -105, "name not resolved", CLOUD, false);
  assert.deepEqual(panes[0].loaded, [CLOUD]);
  contents.emit("did-fail-load", {}, -105, "name not resolved", CLOUD, true);
  assert.equal(panes[0].loaded.length, 2);
  assert.match(panes[0].loaded[1], /^data:text\/html/);
  assert.equal(panes[0].loaded[1].includes("cloud.example"), false);
});

test("closing the pane puts the main window back, unless the person moved it", () => {
  const first = setup();
  first.view.open();
  first.view.close();
  assert.deepEqual(first.main.bounds, MAIN_BOUNDS);
  assert.equal(first.view.isOpen(), false);
  assert.equal(first.state.changes, 2);
  const moved = setup();
  moved.view.open();
  moved.main.setBounds({ x: 5, y: 5, width: 800, height: 600 });
  moved.view.close();
  assert.deepEqual(moved.main.bounds, { x: 5, y: 5, width: 800, height: 600 });
  const big = setup();
  big.main.maximized = true;
  big.view.open();
  assert.equal(big.main.maximized, false);
  big.view.close();
  assert.equal(big.main.maximized, true);
});

test("the pane closes with the main window, and on Windows when the main window hides to the tray", () => {
  const gone = setup();
  gone.view.open();
  gone.main.emit("closed");
  assert.equal(gone.view.isOpen(), false);
  const hidden = setup({ closeOnHide: true });
  hidden.view.open();
  hidden.main.emit("hide");
  assert.equal(hidden.view.isOpen(), false);
  const kept = setup();
  kept.view.open();
  kept.main.emit("hide");
  assert.equal(kept.view.isOpen(), true);
});

test("a window that cannot be made leaves the main window as it was", () => {
  const main = new FakeWindow(MAIN_BOUNDS);
  main.webContents.url = `${LOCAL}/`;
  const view = createSplitView({ BrowserWindow: class { constructor() { throw new Error("boom"); } }, screen: { getDisplayMatching: () => ({ workArea: WORK }) },
    enabled: () => true, main: () => main, localOrigin: () => LOCAL, cloudOrigin: () => CLOUD, rendererArguments: () => [], preload: "p", openExternal() {} });
  assert.deepEqual(view.open(), { ok: false, reason: "failed" });
  assert.deepEqual(main.bounds, MAIN_BOUNDS);
  assert.equal(view.isOpen(), false);
});

test("the menu commands: off by default, the toggle persists and closes an open split, open is a fixed action", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "split-view-"));
  try {
    const main = new FakeWindow(MAIN_BOUNDS);
    main.webContents.url = `${LOCAL}/`;
    const panes = [];
    let refreshed = 0;
    class PaneWindow extends FakeWindow { constructor(options) { super(options); panes.push(this); } }
    const file = join(dir, "split-view.json");
    const split = installSplitView({ file, refreshMenu: () => refreshed++, BrowserWindow: PaneWindow, screen: { getDisplayMatching: () => ({ workArea: WORK }) },
      main: () => main, localOrigin: () => LOCAL, cloudOrigin: () => CLOUD, rendererArguments: () => [], preload: "p", openExternal() {} });
    assert.deepEqual({ ...split.menu(), onToggle: 0, onOpen: 0, onClose: 0 }, { enabled: false, open: false, canOpen: false, onToggle: 0, onOpen: 0, onClose: 0 });
    split.menu().onOpen();
    assert.equal(panes.length, 0);
    split.menu().onToggle();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, true);
    assert.equal(split.menu().canOpen, true);
    split.menu().onOpen();
    assert.equal(panes.length, 1);
    assert.equal(split.menu().open, true);
    split.menu().onToggle();
    assert.equal(split.menu().open, false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, false);
    assert.ok(refreshed >= 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
