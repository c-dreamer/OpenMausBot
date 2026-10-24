import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { sidebarDefaultWidth } from "../src/components/SidebarResizeHandle";
import { SIDEBAR_INLINE } from "../src/lib/use-media-query";

const require = createRequire(import.meta.url);
const { MIN_BOUNDS } = require("./window-state.cjs");

/** The narrowest chat column a half of the split may leave next to a default-width sidebar. */
const CHAT_COLUMN_MIN = 480;

describe("split view keeps the bot sidebar inline in both halves", () => {
  const inlineFrom = Number(/min-width:\s*(\d+)px/.exec(SIDEBAR_INLINE)?.[1]);
  const widest = Math.max(sidebarDefaultWidth("comfortable", true), sidebarDefaultWidth("comfortable", false), sidebarDefaultWidth("compact", false));

  it("reads the renderer's breakpoint", () => {
    expect(inlineFrom).toBeGreaterThan(0);
    expect(widest).toBe(320);
  });

  it("each half is at least the inline breakpoint, so neither sidebar turns into a drawer", () => {
    expect(MIN_BOUNDS.width).toBeGreaterThanOrEqual(inlineFrom);
  });

  it("each half leaves a usable chat column next to the widest default sidebar", () => {
    expect(MIN_BOUNDS.width - widest).toBeGreaterThanOrEqual(CHAT_COLUMN_MIN);
  });
});
