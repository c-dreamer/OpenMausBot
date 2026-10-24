// The real request path against real servers: the local token never leaves, redirects are not followed, and the whole ask
// works against a real fixture server (fake engine) standing in for My Cloud, whose descriptor is the only thing rewritten.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { FIXTURE_STARTER_BOT_NAME, launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForJob } from "../scripts/mcp-server.ts";
import { askOtherPlaceBot } from "../scripts/mcp-other-place.ts";

const LOCAL = "omb_sess_LOCAL_SECRET";
const servers: Server[] = [];
afterEach(async () => {
  delete process.env.OPENMAUSBOT_TOKEN;
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
});

async function listen(handler: (req: IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; json?: unknown }) {
  const seen: Array<{ path: string; headers: IncomingMessage["headers"] }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      const answer = handler(req, body);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json", ...answer.headers });
      res.end(JSON.stringify(answer.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const envFor = (origin: string) => ({ OPENMAUSBOT_OTHER_PLACE_URL: origin, OPENMAUSBOT_OTHER_PLACE_TOKEN: "omb_sess_OTHER" });
const DESCRIPTOR = { capabilities: { cloudHome: true } };

it("never sends the local token to the other place on any call", async () => {
  process.env.OPENMAUSBOT_TOKEN = LOCAL;
  const rows: Array<Record<string, unknown>> = [];
  const peer = await listen((req, body) => {
    const path = req.url ?? "";
    if (path.startsWith("/.well-known/")) return { json: DESCRIPTOR };
    if (path === "/api/bots?messages=0") return { json: { bots: [{ id: "b1", name: "Researcher", threadId: "t1" }] } };
    if (req.method === "POST") {
      rows.push({ id: "u1", role: "user", kind: "text", text: JSON.parse(body).text }, { id: "a1", role: "bot", kind: "text", text: "Hello." });
      return { status: 202, json: { message: { id: "u1" } } };
    }
    if (path.startsWith("/api/threads/t1/job")) return { json: { state: "completed", version: "v1", since: 1 } };
    if (path.startsWith("/api/threads/t1/messages")) return { json: { messages: rows, hasMore: false } };
    return { status: 404 };
  });
  const result: Record<string, any> = await askOtherPlaceBot({ bot: "Researcher", text: "hi", timeout_seconds: 5 }, { env: envFor(peer.origin), waitForJob });
  expect(result).toMatchObject({ status: "answered", reply: "Hello." });
  expect(peer.seen.length).toBeGreaterThan(4);
  for (const call of peer.seen) {
    expect(JSON.stringify(call.headers), call.path).not.toContain(LOCAL);
    expect(call.headers.authorization, call.path).toBe(call.path.startsWith("/.well-known/") ? undefined : "Bearer omb_sess_OTHER");
  }
});

it("does not follow a redirect, and replays nothing to the place it points at", async () => {
  process.env.OPENMAUSBOT_TOKEN = LOCAL;
  const elsewhere = await listen(() => ({ json: DESCRIPTOR }));
  for (const redirected of ["/.well-known/openmausbot/environment", "/api/bots?messages=0"]) {
    const hop = await listen((req) => (req.url === redirected
      ? { status: 307, headers: { location: `${elsewhere.origin}/api/bots?messages=0` } }
      : { json: DESCRIPTOR }));
    const result: Record<string, any> = await askOtherPlaceBot({ bot: "b1", text: "hi", timeout_seconds: 5 }, { env: envFor(hop.origin), waitForJob });
    expect(result.status, redirected).toBe("unreachable");
  }
  expect(elsewhere.seen).toEqual([]);
});

it("asks a bot once through the real routes, even when asked twice", async () => {
  const fixture = await launchVerificationServer({});
  try {
    const url = fixture.info.url;
    const sent: string[] = [];
    const viaFixture = (async (input: any, init: RequestInit = {}) => {
      const path = String(input).slice(url.length);
      if (path.startsWith("/.well-known/")) return new Response(JSON.stringify(DESCRIPTOR));
      if (init.method === "POST") sent.push(path);
      const { authorization: _unused, ...headers } = init.headers as Record<string, string>;
      return fetch(input, { ...init, headers: { ...headers, origin: url } });
    }) as typeof fetch;
    const deps = { fetch: viaFixture, waitForJob, env: envFor(url) };
    const ref = "e2e-ask-0123456789ab";
    const first: Record<string, any> = await askOtherPlaceBot({ bot: FIXTURE_STARTER_BOT_NAME, text: "say hello", ref, timeout_seconds: 60 }, deps);
    expect(first.status).toBe("answered");
    const second: Record<string, any> = await askOtherPlaceBot({ bot: FIXTURE_STARTER_BOT_NAME, text: "say hello", ref, timeout_seconds: 60 }, deps);
    expect(second).toMatchObject({ status: "answered", taskId: first.taskId });
    expect(sent).toEqual([`/api/bots/${first.bot.id}/messages`]);
  } finally {
    await fixture.close();
  }
}, 120_000);
