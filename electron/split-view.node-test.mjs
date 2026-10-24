import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appPermissionHandlers } from "./app-permissions.mjs";
import { cloudPageSenderAllowed } from "./cloud-home.mjs";
import { createSplitSetting, installSplitView, REASON_TEXT } from "./split-view-main.mjs";
import { createSplitView, PANE_TITLE, tilePair, unreachablePage, verifiedCloudOrigin } from "./split-view.mjs";

const require = createRequire(import.meta.url);
const { workspaceSenderAllowed } = require("./environments.cjs");
const { isLocalSender, setLocalOrigin } = require("./local-origin.cjs");

const LOCAL = "http://127.0.0.1:8799";
const CLOUD = "https://me.cloud.example";
const WORK = { x: 0, y: 25, width: 1801, height: 900 };
const MAIN_BOUNDS = { x: 10, y: 40, width: 1200, height: 700 };

class FakeContents extends EventEmitter {
  constructor() { super(); this.url = ""; this.openHandler = null; this.mainFrame = { url: "" }; }
  getURL() { return this.url; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}
class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
    this.normal = { ...this.bounds };
    this.webContents = new FakeContents();
    this.loaded = [];
    this.destroyed = false; this.maximized = false; this.fullScreen = false; this.visible = true; this.title = options.title ?? "";
  }
  isDestroyed() { return this.destroyed; }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return { ...(this.maximized ? this.normal : this.bounds) }; }
  setBounds(bounds) { this.bounds = { ...bounds }; if (!this.maximized) this.normal = { ...bounds }; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  isVisible() { return this.visible; }
  maximize() { this.maximized = true; this.bounds = { ...WORK }; }
  unmaximize() { this.maximized = false; this.bounds = { ...this.normal }; }
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
    rendererArguments: () => [`--omb-local-origin=${LOCAL}`], preload: "/app/preload.cjs", chrome: { frame: false }, icon: "/app/icon.png",
    minWidth: 400, minHeight: 300, allowHttp: state.allowHttp,
    closeOnHide: state.closeOnHide, openExternal: (url) => { if (!url.startsWith("https://")) throw new Error("refused"); opened.push(url); }, onChange: () => state.changes++,
  });
  return { main, panes, opened, state, view };
}

test("tilePair splits the work area with no gap and no overlap", () => {
  const { left, right } = tilePair(WORK);
  assert.deepEqual(left, { x: 0, y: 25, width: 900, height: 900 });
  assert.deepEqual(right, { x: 900, y: 25, width: 901, height: 900 });
});

test("only an https origin counts as a Cloud; http needs the developer override", () => {
  assert.equal(verifiedCloudOrigin("https://a.example/x?y"), "https://a.example");
  for (const bad of [null, "", "http://a.example", "javascript:alert(1)", "file:///etc", "data:text/html,x", "not a url"]) assert.equal(verifiedCloudOrigin(bad), null);
  assert.equal(verifiedCloudOrigin("http://localhost:3000/x", { allowHttp: true }), "http://localhost:3000");
  assert.equal(verifiedCloudOrigin("file:///etc", { allowHttp: true }), null);
  assert.equal(setup({ cloud: "http://me.example" }).view.why(), "no-cloud");
  assert.equal(setup({ cloud: "http://me.example", allowHttp: true }).view.why(), null);
});

test("split view is off unless the environment variable or the settings file says so", () => {
  const unreadable = () => { throw new Error("unreadable"); };
  assert.equal(createSplitSetting({ read: unreadable }).enabled(), false);
  assert.equal(createSplitSetting({ read: () => ({ enabled: "yes" }) }).enabled(), false);
  assert.equal(createSplitSetting({ read: () => ({}), env: { OMB_SPLIT_VIEW: "0" } }).enabled(), false);
  assert.equal(createSplitSetting({ read: unreadable, env: { OMB_SPLIT_VIEW: "1" } }).enabled(), true);
  assert.equal(createSplitSetting({ read: () => ({ enabled: true }) }).enabled(), true);
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
  assert.equal(pane.options.icon, "/app/icon.png");
  assert.equal(pane.options.minHeight, 300);
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

test("an unreachable Cloud shows one fixed page with a link back to the pinned origin; an aborted load or a subframe failure is ignored", () => {
  const { view, panes } = setup();
  view.open();
  const contents = panes[0].webContents;
  contents.emit("did-fail-load", {}, -3, "aborted", CLOUD, true);
  contents.emit("did-fail-load", {}, -105, "name not resolved", CLOUD, false);
  assert.deepEqual(panes[0].loaded, [CLOUD]);
  contents.emit("did-fail-load", {}, -105, "name not resolved", CLOUD, true);
  assert.equal(panes[0].loaded.length, 2);
  const page = decodeURIComponent(panes[0].loaded[1].split(",").slice(1).join(","));
  assert.match(page, /^<!doctype html>/);
  assert.deepEqual([...page.matchAll(/href="([^"]*)"/g)].map((match) => match[1]), [CLOUD]);
  assert.equal(page.includes("<script"), false);
  const hostile = decodeURIComponent(unreachablePage('https://x.example"><script>1</script>').split(",").slice(1).join(","));
  assert.equal(hostile.includes("<script"), false);
});

test("closing the pane puts the main window back, unless the person moved it (within 2 px counts as unmoved)", () => {
  const first = setup();
  first.view.open();
  first.view.close();
  assert.deepEqual(first.main.bounds, MAIN_BOUNDS);
  assert.equal(first.view.isOpen(), false);
  assert.equal(first.state.changes, 2);
  const nudged = setup();
  nudged.view.open();
  nudged.main.setBounds({ x: 1, y: 26, width: 899, height: 901 });
  nudged.view.close();
  assert.deepEqual(nudged.main.bounds, MAIN_BOUNDS);
  const moved = setup();
  moved.view.open();
  moved.main.setBounds({ x: 5, y: 5, width: 800, height: 600 });
  moved.view.close();
  assert.deepEqual(moved.main.bounds, { x: 5, y: 5, width: 800, height: 600 });
});

test("a maximized main window comes back maximized with its normal size, and while split its saved state is the unsplit one", () => {
  const { view, main } = setup();
  main.maximized = true;
  main.bounds = { ...WORK };
  main.normal = { ...MAIN_BOUNDS };
  assert.equal(view.unsplit(main), null);
  view.open();
  assert.equal(main.maximized, false);
  assert.deepEqual(main.bounds, { x: 0, y: 25, width: 900, height: 900 });
  assert.deepEqual(view.unsplit(main), { bounds: MAIN_BOUNDS, maximized: true });
  assert.equal(view.unsplit({}), null);
  view.close();
  assert.equal(main.maximized, true);
  assert.deepEqual(main.normal, MAIN_BOUNDS);
  assert.equal(view.unsplit(main), null);
});

test("a main window hidden in the tray is never maximized or shown by the restore", () => {
  const { view, main } = setup();
  main.maximized = true;
  main.normal = { ...MAIN_BOUNDS };
  view.open();
  main.visible = false;
  view.close();
  assert.equal(main.maximized, false);
  assert.deepEqual(main.bounds, MAIN_BOUNDS);
});

test("the pane closes with the main window, when it goes full screen, and on Windows when it hides to the tray", () => {
  const gone = setup();
  gone.view.open();
  gone.main.emit("closed");
  assert.equal(gone.view.isOpen(), false);
  const full = setup();
  full.view.open();
  full.main.emit("enter-full-screen");
  assert.equal(full.view.isOpen(), false);
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

function wired(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "split-view-"));
  const main = new FakeWindow(MAIN_BOUNDS);
  main.webContents.url = `${LOCAL}/`;
  const panes = [];
  const told = [];
  let refreshed = 0;
  class PaneWindow extends FakeWindow { constructor(options) { super(options); panes.push(this); } }
  const file = join(dir, "split-view.json");
  const split = installSplitView({ file, env: over.env ?? {}, refreshMenu: () => refreshed++, notify: (text) => told.push(text), blocked: () => over.blocked === true,
    BrowserWindow: PaneWindow, screen: { getDisplayMatching: () => ({ workArea: WORK }) },
    main: () => main, localOrigin: () => LOCAL, cloudOrigin: () => ("cloud" in over ? over.cloud : CLOUD), rendererArguments: () => [], preload: "p", openExternal() {} });
  return { split, main, panes, told, file, refreshed: () => refreshed, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the real wiring gives no menu by default, none to a blocked window, and one when switched on", () => {
  const off = wired();
  try { assert.equal(off.split.menu(), null); } finally { off.done(); }
  const blocked = wired({ env: { OMB_SPLIT_VIEW: "1" }, blocked: true });
  try { assert.equal(blocked.split.menu(), null); } finally { blocked.done(); }
  const viaEnv = wired({ env: { OMB_SPLIT_VIEW: "1" } });
  try { assert.equal(typeof viaEnv.split.menu().onOpen, "function"); } finally { viaEnv.done(); }
  const viaFile = wired();
  try {
    writeFileSync(viaFile.file, JSON.stringify({ enabled: true }));
    assert.equal(viaFile.split.menu().open, false);
  } finally { viaFile.done(); }
});

test("the open command is a fixed action that opens the pane, and says why in plain words when it cannot", () => {
  const ok = wired({ env: { OMB_SPLIT_VIEW: "1" } });
  try {
    ok.split.menu().onOpen();
    assert.equal(ok.panes.length, 1);
    assert.deepEqual(ok.told, []);
    assert.equal(ok.split.menu().open, true);
    ok.split.menu().onClose();
    assert.equal(ok.split.menu().open, false);
    assert.ok(ok.refreshed() >= 2);
  } finally { ok.done(); }
  const away = wired({ env: { OMB_SPLIT_VIEW: "1" } });
  try {
    away.main.webContents.url = `${CLOUD}/`;
    away.split.menu().onOpen();
    away.main.webContents.url = `${LOCAL}/`;
    away.main.fullScreen = true;
    away.split.menu().onOpen();
    assert.deepEqual(away.told, [REASON_TEXT["main-not-local"], REASON_TEXT.fullscreen]);
    assert.equal(away.panes.length, 0);
  } finally { away.done(); }
  const signedOut = wired({ env: { OMB_SPLIT_VIEW: "1" }, cloud: null });
  try {
    signedOut.split.menu().onOpen();
    assert.deepEqual(signedOut.told, [REASON_TEXT["no-cloud"]]);
  } finally { signedOut.done(); }
});

test("a page in the pane is denied everything main keys to the main window", () => {
  const { view, panes, main } = setup();
  view.open();
  const pane = panes[0].webContents;
  pane.url = `${CLOUD}/`;
  pane.mainFrame = { url: `${CLOUD}/` };
  main.webContents.url = `${CLOUD}/`;
  main.webContents.mainFrame = { url: `${CLOUD}/` };
  const fromPane = { sender: pane, senderFrame: pane.mainFrame };
  const fromMain = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const context = { contents: main.webContents, homeOrigin: CLOUD, activeOrigin: CLOUD };
  assert.equal(cloudPageSenderAllowed(fromMain, context), true);
  assert.equal(cloudPageSenderAllowed(fromPane, context), false);
  const state = { environments: [{ id: "c", kind: "remote", origin: CLOUD, name: "My Cloud" }], activeId: "c" };
  assert.equal(workspaceSenderAllowed(fromMain, main.webContents, state, LOCAL), true);
  assert.equal(workspaceSenderAllowed(fromPane, main.webContents, state, LOCAL), false);
  setLocalOrigin(LOCAL);
  try { assert.equal(isLocalSender(fromPane), false); } finally { setLocalOrigin(null); }
  const permissions = appPermissionHandlers({ rendererOrigin: () => LOCAL, mainContents: () => main.webContents, cloudHomeOrigin: () => CLOUD,
    activeRemoteOrigin: () => CLOUD, activeRemoteMicrophone: () => true, homeOrigin: () => CLOUD });
  const ask = (contents, permission, details) => permissions.check(contents, permission, CLOUD, { isMainFrame: true, ...details });
  assert.equal(ask(main.webContents, "notifications"), true);
  assert.equal(ask(pane, "notifications"), false);
  assert.equal(ask(main.webContents, "clipboard-sanitized-write"), true);
  assert.equal(ask(pane, "clipboard-sanitized-write"), false);
  assert.equal(ask(main.webContents, "media", { mediaTypes: ["audio"] }), true);
  assert.equal(ask(pane, "media", { mediaTypes: ["audio"] }), false);
});
