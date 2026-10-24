import { jsonFile } from "./desktop-prefs.mjs";
import { createSplitView } from "./split-view.mjs";

export const SPLIT_ENV = "OMB_SPLIT_VIEW";

/** Why the split did not open, in the words the person sees. */
export const REASON_TEXT = Object.freeze({
  "main-not-local": "The main window is not showing This computer. Switch it to This computer first.",
  "no-cloud": "My Cloud is not signed in on this computer yet, so there is nothing to show beside it.",
  "no-window": "There is no main window to put the split beside.",
  fullscreen: "Leave full screen first; the split needs two windows side by side.",
  "too-narrow": "This screen is too narrow for two windows side by side.",
  open: "The split is already open.",
  failed: "The second window could not be opened.",
  unavailable: "Split view is not available in this window.",
});

/** On only when asked for: the environment variable `OMB_SPLIT_VIEW=1`, or `{"enabled":true}` in the settings file. */
export function createSplitSetting({ read, env = {} }) {
  return {
    enabled() {
      if (env[SPLIT_ENV] === "1") return true;
      try { return read()?.enabled === true; } catch { return false; }
    },
  };
}

/**
 * Wires the setting, the second window and the menu entries. Everything the menu does is a fixed action in main; no page
 * can call it.
 * @param {{ file: string, env?: Record<string, string | undefined>, refreshMenu(): void, notify(text: string): void } & Omit<Parameters<typeof createSplitView>[0], "enabled" | "onChange">} deps
 * @returns {{ menu(): { open: boolean, onOpen(): void, onClose(): void } | null, unsplit(win: unknown): { bounds: object, maximized: boolean } | null }}
 *   `menu()` is null unless the feature is on and this window can use it.
 */
export function installSplitView({ file, env = process.env, refreshMenu, notify, ...deps }) {
  const setting = createSplitSetting({ ...jsonFile(file), env });
  const view = createSplitView({ ...deps, enabled: setting.enabled, onChange: refreshMenu });
  return {
    menu: () => (setting.enabled() && !(deps.blocked?.() ?? false) ? {
      open: view.isOpen(),
      onOpen: () => { const result = view.open(); if (!result.ok) notify(REASON_TEXT[result.reason] ?? REASON_TEXT.failed); },
      onClose: () => view.close(),
    } : null),
    unsplit: view.unsplit,
  };
}
