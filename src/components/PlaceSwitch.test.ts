// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";
import { PlaceSwitch } from "./PlaceSwitch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const w = window as unknown as { ogb?: unknown };

describe("PlaceSwitch", () => {
  it("highlights the current place and keeps the power line in My Cloud's tooltip", () => {
    const html = renderToStaticMarkup(createElement(PlaceSwitch, { active: "cloud", power: "Always on", onGo: () => {} }));
    expect(html).toMatch(/data-place="local"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-place="local"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*title="My Cloud · Always on"|title="My Cloud · Always on"[^>]*aria-pressed="true"/);
    expect(html).toContain('<span class="sr-only">Always on</span>');
    expect(html).toContain(">This computer<");
  });

  it("truncates a long label instead of overflowing a narrow bar", () => {
    const html = renderToStaticMarkup(createElement(PlaceSwitch, { active: "local", onGo: () => {} }));
    expect(html.match(/min-w-0 truncate/g)).toHaveLength(2);
    expect(html).toContain("overflow-hidden");
  });
});

describe("DesktopWorkspaceSwitcher with both places", () => {
  let host: HTMLDivElement;
  let root: Root;
  const mount = async (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const go = vi.fn(() => Promise.resolve());
    w.ogb = { workspaces: { state: () => Promise.resolve(state), menu: () => Promise.resolve(), go }, ...extra };
    await act(async () => { root.unmount(); root = createRoot(host); root.render(createElement(DesktopWorkspaceSwitcher, { inline: true })); });
    return go;
  };
  const button = (place: string) => host.querySelector<HTMLButtonElement>(`[data-place="${place}"]`);
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); delete w.ogb; });

  it("shows This computer left of My Cloud, highlights where you are, and switches with one click", async () => {
    const go = await mount({ local: true, name: "This computer", cloud: { active: false } });
    const [first, second] = [...host.querySelectorAll("[data-place]")];
    expect(first.getAttribute("data-place")).toBe("local");
    expect(second.getAttribute("data-place")).toBe("cloud");
    expect(button("local")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("cloud")!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { button("local")!.click(); });
    expect(go).not.toHaveBeenCalled();
    await act(async () => { button("cloud")!.click(); });
    expect(go).toHaveBeenCalledExactlyOnceWith("cloud");
  });

  it("highlights My Cloud when it is the active place and switches back to this computer", async () => {
    const go = await mount({ local: false, name: "My Cloud", origin: "https://me.example", cloud: { active: true } });
    expect(button("cloud")!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { button("local")!.click(); });
    expect(go).toHaveBeenCalledExactlyOnceWith("local");
  });

  it("reads Always on from the real plan, and Sleeps when idle when the plan sleeps", async () => {
    await mount({ local: true, name: "This computer", cloud: { active: false } }, { cloudPlan: { state: () => Promise.resolve({ status: "paid", tier: "pro" }) } });
    expect(button("cloud")!.title).toBe("My Cloud · always on");
    await mount({ local: true, name: "This computer", cloud: { active: false } }, { cloudPlan: { state: () => Promise.resolve({ status: "paid", tier: "pro", sleeps: true }) } });
    expect(button("cloud")!.title).toBe("My Cloud · sleeps when idle");
  });

  it("is the plain dropdown when there is only one place", async () => {
    await mount({ local: true, name: "This computer" });
    expect(button("local")).toBeNull();
    expect(host.querySelector("[aria-haspopup=menu]")).not.toBeNull();
  });

  it("says so when the switch fails and keeps the dropdown reachable", async () => {
    const go = await mount({ local: true, name: "This computer", cloud: { active: false } });
    go.mockRejectedValueOnce(new Error("x"));
    await act(async () => { button("cloud")!.click(); });
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    expect(host.querySelector("[aria-haspopup=menu]")).not.toBeNull();
  });
});
