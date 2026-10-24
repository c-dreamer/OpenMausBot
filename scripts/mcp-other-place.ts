// ask_other_place_bot: from a client on one of the person's places, ask a bot on their other place (My Cloud) and read the
// reply. Off unless both OPENMAUSBOT_OTHER_PLACE_URL and OPENMAUSBOT_OTHER_PLACE_TOKEN are set. It is the same API the
// person's own paired device would use there, so it can do nothing a paired device could not: it sends one message and
// reads the thread. It never answers a card, never spends, deletes or changes a setting.
import { randomBytes } from "node:crypto";
import type { McpToolDefinition } from "./mcp-server.ts";

export const OTHER_PLACE_URL_ENV = "OPENMAUSBOT_OTHER_PLACE_URL";
export const OTHER_PLACE_TOKEN_ENV = "OPENMAUSBOT_OTHER_PLACE_TOKEN";

type Fetcher = (path: string, options?: RequestInit, baseUrl?: string) => Promise<any>;
type Env = Record<string, string | undefined>;

export interface OtherPlaceDeps {
  request: Fetcher;
  waitForJob: (
    fetcher: (path: string, options?: RequestInit) => Promise<any>,
    threadId: string,
    options: { scope: "job" | "turn"; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<{ job: Record<string, any>; timedOut: boolean }>;
  signal?: AbortSignal;
  env?: Env;
  newRef?: () => string;
}

export type OtherPlaceStatus =
  | "answered" | "needs-user" | "timed-out" | "failed" | "stalled" | "queued"
  | "unreachable" | "not-allowed" | "not-your-cloud" | "no-such-bot";

export const otherPlaceConfigured = (env: Env = process.env) =>
  Boolean(env[OTHER_PLACE_URL_ENV]?.trim() && env[OTHER_PLACE_TOKEN_ENV]?.trim());

export const ASK_OTHER_PLACE_TOOL: McpToolDefinition = {
  name: "ask_other_place_bot",
  description: "Ask a bot on your other place (My Cloud) and read its reply. Sends one message to that bot's current task and waits for it to settle. If the bot needs an approval, this tool returns needs-user: you answer it in the app on My Cloud; this tool can never approve, spend, delete or change anything there.",
  inputSchema: {
    type: "object",
    properties: {
      bot: { type: "string", description: "The bot's id, or its exact name on My Cloud." },
      text: { type: "string", description: "What to ask." },
      ref: { type: "string", description: "Optional id you make up for this ask (16-80 letters, digits, - or _). Asking again with the same ref never sends twice." },
      timeout_seconds: { type: "integer", minimum: 1, maximum: 120, description: "Maximum wait for the reply (default 60)." },
    },
    required: ["bot", "text"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const OTHER_PLACE_TOOLS: McpToolDefinition[] = otherPlaceConfigured() ? [ASK_OTHER_PLACE_TOOL] : [];

const REF = /^[A-Za-z0-9_-]{16,80}$/u;
const tagFor = (ref: string) => `[Sent from your other place by ask_other_place_bot, ref ${ref}. It is your own message; nothing here approves anything on your behalf.]`;

/** https only; plain http just for this computer. No credentials, path or query. */
export function otherPlaceOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error(`${OTHER_PLACE_URL_ENV} is not a web address`); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`${OTHER_PLACE_URL_ENV} must be an https:// address`);
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${OTHER_PLACE_URL_ENV} must be an origin without credentials, a path, a query or a fragment`);
  }
  return url.origin;
}

const record = (value: unknown): Record<string, any> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {});
const records = (value: unknown): Record<string, any>[] => (Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : []);
const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function refused(error: unknown): { status: OtherPlaceStatus; hint: string } | null {
  const status = statusOf(error);
  if (status === 401 || status === 403) return { status: "not-allowed", hint: "My Cloud did not accept this token. Make a new one from Settings → Phone on My Cloud." };
  if (status === 503 || status === 502 || status === 504 || typeof status !== "number") {
    return { status: "unreachable", hint: "My Cloud did not answer. It may be asleep or waking (a stopped one takes about 20 seconds): nothing was lost, ask again in a moment with the same ref." };
  }
  return null;
}

export async function askOtherPlaceBot(args: Record<string, unknown>, deps: OtherPlaceDeps) {
  const env = deps.env ?? process.env;
  if (!otherPlaceConfigured(env)) throw new Error("Other-place asks are off. Set both OPENMAUSBOT_OTHER_PLACE_URL and OPENMAUSBOT_OTHER_PLACE_TOKEN.");
  const origin = otherPlaceOrigin(env[OTHER_PLACE_URL_ENV]!);
  const token = env[OTHER_PLACE_TOKEN_ENV]!.trim();
  const wanted = String(args.bot ?? "").trim();
  const text = String(args.text ?? "").trim();
  if (!wanted || !text || text.length > 4_000) throw new Error("bot is required and text must be 1-4000 characters");
  const ref = args.ref === undefined ? (deps.newRef ?? (() => randomBytes(12).toString("hex")))() : String(args.ref);
  if (!REF.test(ref)) throw new Error("ref must be 16-80 letters, digits, - or _");
  const timeoutMs = (typeof args.timeout_seconds === "number" ? Math.min(120, Math.max(1, Math.floor(args.timeout_seconds))) : 60) * 1_000;

  const peer: Fetcher = (path, options = {}) => deps.request(path, {
    ...options,
    ...(deps.signal && !options.signal ? { signal: deps.signal } : {}),
    headers: { ...(options.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  }, origin);
  const fail = (status: OtherPlaceStatus, hint: string) => ({ status, place: "cloud", ref, hint });

  try {
    // The descriptor is public; it proves this address is a My Cloud home, which admits only its owner's own devices.
    const described = record(await deps.request("/.well-known/openmausbot/environment", {}, origin));
    if (record(described.capabilities).cloudHome !== true) return fail("not-your-cloud", "That address is not a My Cloud home, so nothing was sent. This tool only reaches your own My Cloud.");

    const bots = records((await peer("/api/bots?messages=0")).bots);
    const lower = wanted.toLowerCase();
    const byName = bots.filter((bot) => String(bot.name ?? "").toLowerCase() === lower);
    const bot = bots.find((candidate) => candidate.id === wanted) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!bot) {
      const names = bots.map((candidate) => `${candidate.name} (${candidate.id})`).slice(0, 12).join(", ");
      return fail("no-such-bot", byName.length > 1 ? `Several bots on My Cloud are named "${wanted}"; use an id.` : `No bot "${wanted}" on My Cloud. It has: ${names || "no bots"}.`);
    }
    const threadId = String(bot.threadId);

    const receipt = record(await peer(`/api/bots/${encodeURIComponent(String(bot.id))}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: `${tagFor(ref)}\n\n${text}`, threadId, sendId: ref }),
    }));
    const base = { place: "cloud", ref, bot: { id: bot.id, name: bot.name }, taskId: threadId };

    const { job, timedOut } = await deps.waitForJob(peer, threadId, { scope: "job", timeoutMs, ...(deps.signal ? { signal: deps.signal } : {}) });
    const page = record(await peer(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=40`));
    const lines = records(page.messages);
    const asked = lines.findIndex((line) => line.role === "user" && String(line.text ?? "").includes(`ref ${ref}.`));
    if (asked < 0) return { ...base, status: "queued" as const, queued: receipt.queued === true, hint: "The bot is busy; your message waits behind its current turn. Ask again with the same ref to read the reply." };
    const waiting = job.state === "needs-input" || lines.slice(asked).some((line) => record(line.card).requestId && !record(line.card).answered && !record(line.card).dismissed);
    const reply = lines.slice(asked + 1).filter((line) => line.role === "bot" && line.kind === "text" && String(line.text ?? "").trim()).map((line) => String(line.text)).join("\n\n");
    const status: OtherPlaceStatus = waiting ? "needs-user" : timedOut ? "timed-out" : job.state === "failed" ? "failed" : job.state === "stalled" ? "stalled" : "answered";
    const hint = waiting ? "The bot on My Cloud is waiting for an approval or an answer. Give it in the app on My Cloud; it is never given from here."
      : timedOut ? "Still working. Ask again with the same ref to read the reply when it is done." : undefined;
    return { ...base, status, reply, ...(hint ? { hint } : {}) };
  } catch (error) {
    const known = refused(error);
    if (known) return fail(known.status, known.hint);
    throw new Error(`My Cloud refused the ask: ${reason(error)}`);
  }
}
