import { jsonFile } from "./desktop-prefs.mjs";
import { createSplitView } from "./split-view.mjs";

/** The setting that turns split view on. Off until the person chooses it; a record that cannot be read or written is off. */
export function createSplitSetting({ read, write }) {
  let on = null;
  return {
    enabled() {
      if (on !== null) return on;
      try { on = read()?.enabled === true; } catch { on = false; }
      return on;
    },
    set(value) {
      on = value === true;
      try { write({ enabled: on }); } catch {}
    },
  };
}

/**
 * Wires the setting, the second window and the menu entries. Everything the menu does is a fixed action in main; no page
 * can call it.
 * @param {{ file: string, refreshMenu(): void } & Omit<Parameters<typeof createSplitView>[0], "enabled" | "onChange">} deps
 * @returns {{ menu(): { enabled: boolean, open: boolean, canOpen: boolean, onToggle(): void, onOpen(): void, onClose(): void } }}
 */
export function installSplitView({ file, refreshMenu, ...deps }) {
  const setting = createSplitSetting(jsonFile(file));
  const view = createSplitView({ ...deps, enabled: setting.enabled, onChange: refreshMenu });
  return {
    menu: () => ({
      enabled: setting.enabled(),
      open: view.isOpen(),
      canOpen: view.why() === null,
      onToggle: () => { const next = !setting.enabled(); setting.set(next); if (!next) view.close(); refreshMenu(); },
      onOpen: () => { view.open(); refreshMenu(); },
      onClose: () => view.close(),
    }),
  };
}
