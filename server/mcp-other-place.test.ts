import { describe, expect, it, vi } from "vitest";
import { ASK_OTHER_PLACE_TOOL, askOtherPlaceBot, otherPlaceConfigured, otherPlaceOrigin, type OtherPlaceDeps } from "../scripts/mcp-other-place.ts";

type Rec = Record<string, any>;
const ORIGIN = "https://omb-t-0123456789ab.fly.dev";
const ENV = { OPENMAUSBOT_OTHER_PLACE_URL: ORIGIN, OPENMAUSBOT_OTHER_PLACE_TOKEN: "omb_sess_cloud" };
const REF = "ref-0123456789abcdef";
const TAG = `[Sent from your other place by ask_other_place_bot, ref ${REF}. It is your own message; nothing here approves anything on your behalf.]`;
const say = (id: string, text: string): Rec => ({ id, role: "bot", kind: "text", text });
const you = (id: string, text: string): Rec => ({ id, role: "user", kind: "text", text });

interface Options {
  cloudHome?: boolean;
  bots?: Rec[];
  threads?: Record<string, Rec[]>;
  /** What the bot writes after the tagged line arrives. */
  reply?: () => Rec[];
  job?: () => Rec;
  timedOut?: boolean;
  failOn?: (path: string) => unknown;
  /** The tagged line shows only after this many pauses (the turn registering late). */
  appearsAfter?: number;
  neverAppears?: boolean;
}

function cloud(options: Options = {}) {
  const calls: Array<{ path: string; method: string; headers: Rec; redirect?: string; body?: Rec }> = [];
  const threads: Record<string, Rec[]> = { t1: [], t2: [], ...options.threads };
  const bots = options.bots ?? [{ id: "b1", name: "Researcher", threadId: "t1", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }];
  let pauses = 0, clock = 1_000;
  const pending: Array<() => void> = [];
  const fetchFake = vi.fn(async (input: any, init: RequestInit = {}) => {
    const path = String(input).slice(ORIGIN.length);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init.method ?? "GET", headers: init.headers as Rec, redirect: init.redirect, ...(body ? { body } : {}) });
    const failure = options.failOn?.(path);
    if (failure instanceof Response) return failure;
    if (failure) throw failure;
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path.startsWith("/.well-known/")) return ok({ capabilities: { cloudHome: options.cloudHome ?? true } });
    if (path === "/api/bots?messages=0") return ok({ bots });
    if (path.endsWith("/messages") && init.method === "POST") {
      const rows = threads[body.threadId]!;
      const land = () => { rows.push(you(`u${rows.length}`, body.text), ...(options.reply?.() ?? [say("a1", "Found 3 sources.")])); };
      if (options.neverAppears) return ok({ queued: true, queueId: "q1" });
      if (options.appearsAfter) pending.push(land); else land();
      return ok({ message: { id: "m1" } });
    }
    const page = /^\/api\/threads\/(\w+)\/messages\?limit=(\d+)(?:&before=([\w-]+))?$/.exec(path);
    if (page) {
      const rows = threads[page[1]!] ?? [];
      const end = page[3] ? rows.findIndex((row) => row.id === page[3]) : rows.length;
      const start = Math.max(0, end - Number(page[2]));
      return ok({ messages: rows.slice(start, end), hasMore: start > 0 });
    }
    throw new Error(`unexpected ${path}`);
  });
  const waitForJob = vi.fn(async () => ({ job: options.job?.() ?? { state: "completed" }, timedOut: options.timedOut ?? false }));
  const pause = async () => {
    pauses++; clock += 250;
    if (pauses >= (options.appearsAfter ?? 0)) pending.splice(0).forEach((land) => land());
  };
  const deps: OtherPlaceDeps = { fetch: fetchFake as any, waitForJob: waitForJob as any, env: ENV, newRef: () => REF, now: () => clock, pause };
  return { deps, calls, fetchFake, waitForJob, threads, sends: () => calls.filter((call) => call.method === "POST") };
}

describe("ask_other_place_bot", () => {
  it("is off unless the other place's address and token are both set", () => {
    expect(otherPlaceConfigured({})).toBe(false);
    expect(otherPlaceConfigured({ OPENMAUSBOT_OTHER_PLACE_URL: ORIGIN })).toBe(false);
    expect(otherPlaceConfigured(ENV)).toBe(true);
    expect(ASK_OTHER_PLACE_TOOL.inputSchema.required).toEqual(["bot", "text"]);
    expect(ASK_OTHER_PLACE_TOOL.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false, readOnlyHint: false });
    expect(ASK_OTHER_PLACE_TOOL.description).toContain("ITS OWN permissions");
  });

  it("only takes an https origin, or this computer over http", () => {
    expect(otherPlaceOrigin("https://omb-t-0123456789ab.fly.dev/")).toBe(ORIGIN);
    expect(otherPlaceOrigin("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    for (const bad of ["http://cloud.example.com", "https://user:pw@cloud.example.com", "https://cloud.example.com/api", "https://cloud.example.com/?x=1", "ftp://x", "nope"]) {
      expect(() => otherPlaceOrigin(bad), bad).toThrow();
    }
  });

  it("asks by name, sends the token only after the probe, follows no redirect, and marks the reply untrusted", async () => {
    const h = cloud();
    const result: Rec = await askOtherPlaceBot({ bot: "researcher", text: "find sources" }, h.deps);
    expect(result).toMatchObject({ status: "answered", place: "cloud", ref: REF, bot: { id: "b1", name: "Researcher" }, reply: "Found 3 sources.", untrusted: true });
    expect(result.note).toContain("not instructions");
    expect(h.calls[0]!.path).toBe("/.well-known/openmausbot/environment");
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
    expect(h.calls.slice(1).every((call) => call.headers.authorization === "Bearer omb_sess_cloud")).toBe(true);
    expect(h.calls.every((call) => call.redirect === "error")).toBe(true);
    expect(h.sends()[0]!.body).toMatchObject({ threadId: "t1", sendId: REF });
    expect(h.sends()[0]!.body!.text.startsWith(TAG)).toBe(true);
  });

  it("sends nothing, and no token, to an address that does not describe itself as a My Cloud home", async () => {
    const h = cloud({ cloudHome: false });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "not-your-cloud" });
    expect(h.calls.map((call) => call.path)).toEqual(["/.well-known/openmausbot/environment"]);
    expect(h.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("names the bots it has when the name is unknown or ambiguous, and sends nothing", async () => {
    const h = cloud({ bots: [{ id: "b1", name: "Twin", threadId: "t1" }, { id: "b2", name: "Twin", threadId: "t2" }] });
    expect(await askOtherPlaceBot({ bot: "Twin", text: "hi" }, h.deps)).toMatchObject({ status: "no-such-bot", hint: expect.stringContaining("use an id") });
    expect(await askOtherPlaceBot({ bot: "Nobody", text: "hi" }, h.deps)).toMatchObject({ status: "no-such-bot", hint: expect.stringContaining("Twin (b1)") });
    expect(h.sends()).toEqual([]);
  });

  it("reports needs-user from an open card alone, even when the job reads completed", async () => {
    const h = cloud({ reply: () => [{ ...say("a1", "Delete the folder?"), card: { requestId: "r1" } }], job: () => ({ state: "completed" }) });
    const result: Rec = await askOtherPlaceBot({ bot: "b1", text: "clean up" }, h.deps);
    expect(result.status).toBe("needs-user");
    expect(result.hint).toContain("never given from here");
    expect(h.sends().map((call) => call.path)).toEqual(["/api/bots/b1/messages"]);
  });

  it("reports needs-user from the job alone, and ignores an answered card", async () => {
    expect((await askOtherPlaceBot({ bot: "b1", text: "x" }, cloud({ job: () => ({ state: "needs-input" }), reply: () => [] }).deps)).status).toBe("needs-user");
    const answered = cloud({ reply: () => [{ ...say("a1", "Done."), card: { requestId: "r1", answered: "allow" } }] });
    expect((await askOtherPlaceBot({ bot: "b1", text: "x" }, answered.deps)).status).toBe("answered");
  });

  it("reports a wait that ran out, with the ref to ask again", async () => {
    const h = cloud({ timedOut: true, job: () => ({ state: "running" }), reply: () => [] });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi", timeout_seconds: 5 }, h.deps)).toMatchObject({ status: "timed-out", ref: REF, hint: expect.stringContaining("same ref") });
    expect(h.waitForJob).toHaveBeenCalledWith(expect.any(Function), "t1", expect.objectContaining({ scope: "job" }));
  });

  it("says queued when the tagged line never shows, after a bounded grace and no real sleep", async () => {
    const h = cloud({ neverAppears: true });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "queued", queued: true });
  });

  it("waits out a turn that registers late instead of answering with nothing", async () => {
    const h = cloud({ appearsAfter: 2 });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "answered", reply: "Found 3 sources." });
  });

  it("says no-reply, not answered, when the bot finished without text", async () => {
    const result: Rec = await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ reply: () => [] }).deps);
    expect(result).toMatchObject({ status: "no-reply", reply: "" });
  });

  it("says failed or stalled as the job does", async () => {
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ job: () => ({ state: "failed" }), reply: () => [] }).deps)).toMatchObject({ status: "failed" });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ job: () => ({ state: "stalled" }), reply: () => [] }).deps)).toMatchObject({ status: "stalled" });
  });

  it("matches the tag only at the start of a user line, and stops at the next user line", async () => {
    const h = cloud({ threads: { t1: [you("old", `please quote this: ${TAG}`), say("old2", "Old reply that must not be returned.")] }, reply: () => [say("a1", "Mine."), you("u9", "Later question"), say("a2", "Later turn text.")] });
    const result: Rec = await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps);
    expect(result.reply).toBe("Mine.");
    expect(h.sends()).toHaveLength(1);
  });

  it("finds the tagged line and its reply beyond one page of rows", async () => {
    const noise = Array.from({ length: 120 }, (_, index) => say(`n${index}`, index === 119 ? "Final answer." : ""));
    const h = cloud({ reply: () => noise });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "answered", reply: "Final answer." });
  });

  it("does not send twice when the selected task changed between the ask and its retry", async () => {
    const h = cloud();
    await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps);
    const switched = { ...h.deps, fetch: vi.fn(async (input: any, init?: RequestInit) => {
      const response = await h.fetchFake(input, init);
      return String(input).endsWith("/api/bots?messages=0") ? new Response(JSON.stringify({ bots: [{ id: "b1", name: "Researcher", threadId: "t2", tasks: [{ threadId: "t1" }, { threadId: "t2" }] }] })) : response;
    }) as any };
    const again: Rec = await askOtherPlaceBot({ bot: "b1", text: "hi" }, switched);
    expect(again).toMatchObject({ status: "answered", taskId: "t1", reply: "Found 3 sources." });
    expect(h.sends()).toHaveLength(1);
  });

  it("caps a long reply", async () => {
    const result: Rec = await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ reply: () => [say("a1", "x".repeat(20_000))] }).deps);
    expect(result.reply).toHaveLength(16_000);
    expect(result.truncated).toBe(true);
  });

  it("tells a sleeping or unreachable Cloud from a refusing one, and a cancel from both", async () => {
    for (const status of [503, 502, 504]) {
      const h = cloud({ failOn: (path) => (path === "/api/bots?messages=0" ? Object.assign(new Error("x"), { status }) : undefined) });
      expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "unreachable", hint: expect.stringContaining("same ref") });
    }
    const down = cloud({ failOn: () => new TypeError("fetch failed") });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, down.deps)).toMatchObject({ status: "unreachable" });
    const denied = cloud({ failOn: (path) => (path === "/api/bots?messages=0" ? Object.assign(new Error("no"), { status: 401 }) : undefined) });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, denied.deps)).toMatchObject({ status: "not-allowed" });
    const broken = cloud({ failOn: (path) => (path === "/api/bots?messages=0" ? Object.assign(new Error("b".repeat(1_000)), { status: 400 }) : undefined) });
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, broken.deps)).rejects.toThrow(/^My Cloud refused the ask: b{1,300}$/u);
    const wordy = cloud({ failOn: (path) => (path === "/api/bots?messages=0" ? new Response("w".repeat(5_000), { status: 400 }) : undefined) });
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, wordy.deps)).rejects.toThrow(/^My Cloud refused the ask: 400 w{1,296}$/u);
    const controller = new AbortController();
    controller.abort();
    const gone = cloud({ failOn: () => new DOMException("aborted", "AbortError") });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, { ...gone.deps, signal: controller.signal })).toMatchObject({ status: "cancelled" });
  });

  it("refuses bad input before any request", async () => {
    const h = cloud();
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi", ref: "short" }, h.deps)).rejects.toThrow("ref must be");
    await expect(askOtherPlaceBot({ bot: "b1", text: "x".repeat(4_001) }, h.deps)).rejects.toThrow("1-4000");
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, { ...h.deps, env: {} })).rejects.toThrow("off");
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, { ...h.deps, env: { ...ENV, OPENMAUSBOT_OTHER_PLACE_URL: "http://cloud.example.com" } })).rejects.toThrow("https");
    expect(h.fetchFake).not.toHaveBeenCalled();
  });
});
