import { describe, expect, it, vi } from "vitest";
import { ASK_OTHER_PLACE_TOOL, askOtherPlaceBot, otherPlaceConfigured, otherPlaceOrigin, type OtherPlaceDeps } from "../scripts/mcp-other-place.ts";

type Rec = Record<string, any>;
const ENV = { OPENMAUSBOT_OTHER_PLACE_URL: "https://omb-t-0123456789ab.fly.dev", OPENMAUSBOT_OTHER_PLACE_TOKEN: "omb_sess_cloud" };
const REF = "ref-0123456789abcdef";

class Refusal extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, message = "refused") { super(message); this.status = status; }
}

interface Cloud { cloudHome?: boolean; bots?: Rec[]; messages?: Rec[]; job?: Rec; timedOut?: boolean; fail?: (path: string) => unknown; receipt?: Rec }

function cloud(options: Cloud = {}) {
  const seen: Array<{ path: string; method: string; origin?: string; auth?: string; body?: Rec }> = [];
  const state = { messages: options.messages ?? [] };
  const request = vi.fn(async (path: string, init: RequestInit = {}, origin?: string) => {
    seen.push({ path, method: init.method ?? "GET", origin, auth: (init.headers as Rec | undefined)?.Authorization, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const failure = options.fail?.(path);
    if (failure) throw failure;
    if (path.startsWith("/.well-known/")) return { capabilities: { cloudHome: options.cloudHome ?? true } };
    if (path === "/api/bots?messages=0") return { bots: options.bots ?? [{ id: "b1", name: "Researcher", threadId: "t1" }] };
    if (path.endsWith("/messages") && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      state.messages = [...state.messages, { id: "m1", role: "user", kind: "text", text: body.text }, { id: "m2", role: "bot", kind: "text", text: "Found 3 sources." }];
      return options.receipt ?? { message: { id: "m1", at: 1 } };
    }
    if (path.startsWith("/api/threads/t1/messages")) return { messages: state.messages };
    throw new Error(`unexpected ${path}`);
  });
  const waitForJob = vi.fn(async () => ({ job: options.job ?? { state: "completed" }, timedOut: options.timedOut ?? false }));
  const deps: OtherPlaceDeps = { request: request as any, waitForJob: waitForJob as any, env: ENV, newRef: () => REF };
  return { deps, seen, request, waitForJob };
}

describe("ask_other_place_bot", () => {
  it("is off unless the other place's address and token are both set", () => {
    expect(otherPlaceConfigured({})).toBe(false);
    expect(otherPlaceConfigured({ OPENMAUSBOT_OTHER_PLACE_URL: ENV.OPENMAUSBOT_OTHER_PLACE_URL })).toBe(false);
    expect(otherPlaceConfigured(ENV)).toBe(true);
    expect(ASK_OTHER_PLACE_TOOL.inputSchema.required).toEqual(["bot", "text"]);
  });

  it("only takes an https origin, or this computer over http", () => {
    expect(otherPlaceOrigin("https://omb-t-0123456789ab.fly.dev/")).toBe("https://omb-t-0123456789ab.fly.dev");
    expect(otherPlaceOrigin("http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    for (const bad of ["http://cloud.example.com", "https://user:pw@cloud.example.com", "https://cloud.example.com/api", "https://cloud.example.com/?x=1", "ftp://x", "nope"]) {
      expect(() => otherPlaceOrigin(bad), bad).toThrow();
    }
  });

  it("asks a bot by name, sends the cloud token only to the cloud, and returns the reply", async () => {
    const h = cloud();
    const result: Rec = await askOtherPlaceBot({ bot: "researcher", text: "find sources" }, h.deps);
    expect(result).toMatchObject({ status: "answered", place: "cloud", ref: REF, bot: { id: "b1", name: "Researcher" }, reply: "Found 3 sources." });
    expect(h.seen.every((call) => call.origin === ENV.OPENMAUSBOT_OTHER_PLACE_URL)).toBe(true);
    expect(h.seen.filter((call) => !call.path.startsWith("/.well-known/")).every((call) => call.auth === "Bearer omb_sess_cloud")).toBe(true);
    expect(h.seen.find((call) => call.path.startsWith("/.well-known/"))?.auth).toBeUndefined();
    const sent = h.seen.find((call) => call.method === "POST")!.body!;
    expect(sent).toMatchObject({ threadId: "t1", sendId: REF });
    expect(sent.text).toContain(`ref ${REF}`);
    expect(sent.text).toContain("find sources");
  });

  it("sends nothing to an address that is not a My Cloud home", async () => {
    const h = cloud({ cloudHome: false });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "not-your-cloud" });
    expect(h.seen.map((call) => call.path)).toEqual(["/.well-known/openmausbot/environment"]);
  });

  it("names the bots it has when the name is unknown or ambiguous, and sends nothing", async () => {
    const h = cloud({ bots: [{ id: "b1", name: "Twin", threadId: "t1" }, { id: "b2", name: "Twin", threadId: "t2" }] });
    expect(await askOtherPlaceBot({ bot: "Twin", text: "hi" }, h.deps)).toMatchObject({ status: "no-such-bot", hint: expect.stringContaining("use an id") });
    expect(await askOtherPlaceBot({ bot: "Nobody", text: "hi" }, h.deps)).toMatchObject({ status: "no-such-bot", hint: expect.stringContaining("Twin (b1)") });
    expect(h.seen.some((call) => call.method === "POST")).toBe(false);
  });

  it("hands an approval back to the person and never carries the reply as an answer", async () => {
    const card = { id: "m2", role: "bot", kind: "text", text: "Delete the folder?", card: { requestId: "r1" } };
    const withCard = cloud({ job: { state: "needs-input" } });
    const base = withCard.request.getMockImplementation()!;
    withCard.request.mockImplementation(async (path: string, init: RequestInit = {}, origin?: string) => {
      const answer = await base(path, init, origin);
      return path.startsWith("/api/threads/") ? { messages: [...answer.messages.slice(0, 1), card] } : answer;
    });
    const result: Rec = await askOtherPlaceBot({ bot: "b1", text: "clean up" }, withCard.deps);
    expect(result.status).toBe("needs-user");
    expect(result.hint).toContain("never given from here");
    expect(withCard.seen.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual(["/api/bots/b1/messages"]);
  });

  it("reports a wait that ran out, with the ref to ask again", async () => {
    const h = cloud({ timedOut: true, job: { state: "running" } });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi", timeout_seconds: 5 }, h.deps)).toMatchObject({ status: "timed-out", ref: REF, hint: expect.stringContaining("same ref") });
    expect(h.waitForJob).toHaveBeenCalledWith(expect.any(Function), "t1", expect.objectContaining({ timeoutMs: 5_000, scope: "job" }));
  });

  it("says queued when the bot's turn is busy and the message is not yet in the thread", async () => {
    const h = cloud({ receipt: { queued: true, queueId: "q1" } });
    const base = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (path: string, init: RequestInit = {}, origin?: string) => (path.startsWith("/api/threads/") ? { messages: [] } : base(path, init, origin)));
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "queued", queued: true });
  });

  it("says failed or stalled as the job does", async () => {
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ job: { state: "failed" } }).deps)).toMatchObject({ status: "failed" });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, cloud({ job: { state: "stalled" } }).deps)).toMatchObject({ status: "stalled" });
  });

  it("tells a sleeping or unreachable Cloud from a refusing one, and never retries by itself", async () => {
    for (const status of [503, 502, undefined]) {
      const h = cloud({ fail: (path) => (path === "/api/bots?messages=0" ? new Refusal(status) : undefined) });
      expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, h.deps)).toMatchObject({ status: "unreachable", hint: expect.stringContaining("same ref") });
      expect(h.request).toHaveBeenCalledTimes(2);
    }
    const denied = cloud({ fail: (path) => (path === "/api/bots?messages=0" ? new Refusal(401) : undefined) });
    expect(await askOtherPlaceBot({ bot: "b1", text: "hi" }, denied.deps)).toMatchObject({ status: "not-allowed" });
    const broken = cloud({ fail: (path) => (path === "/api/bots?messages=0" ? new Refusal(400, "bad") : undefined) });
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, broken.deps)).rejects.toThrow("My Cloud refused the ask: bad");
  });

  it("refuses bad input before any request", async () => {
    const h = cloud();
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi", ref: "short" }, h.deps)).rejects.toThrow("ref must be");
    await expect(askOtherPlaceBot({ bot: "b1", text: "x".repeat(4_001) }, h.deps)).rejects.toThrow("1-4000");
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, { ...h.deps, env: {} })).rejects.toThrow("off");
    await expect(askOtherPlaceBot({ bot: "b1", text: "hi" }, { ...h.deps, env: { ...ENV, OPENMAUSBOT_OTHER_PLACE_URL: "http://cloud.example.com" } })).rejects.toThrow("https");
    expect(h.request).not.toHaveBeenCalled();
  });
});
