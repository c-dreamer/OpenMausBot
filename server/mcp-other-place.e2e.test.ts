// The whole ask against a real fixture server (fake engine) standing in for My Cloud. Its descriptor is the only thing
// rewritten, since a Cloud home cannot be started here; the routes, the idempotent send and the wait are the server's own.
import { expect, it } from "vitest";
import { FIXTURE_STARTER_BOT_NAME, launchVerificationServer } from "../scripts/control-omb.ts";
import { waitForJob } from "../scripts/mcp-server.ts";
import { askOtherPlaceBot } from "../scripts/mcp-other-place.ts";

it("asks a bot on the other place once, even when asked twice, and reads its reply", async () => {
  const fixture = await launchVerificationServer({});
  try {
    const url = fixture.info.url;
    const sent: string[] = [];
    const request = async (path: string, init: RequestInit = {}) => {
      if (path.startsWith("/.well-known/")) return { capabilities: { cloudHome: true } };
      const headers = { "content-type": "application/json", origin: url };
      if (init.method === "POST") sent.push(path);
      const response = await fetch(`${url}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
      return response.json();
    };
    const deps = { request, waitForJob: waitForJob as any, env: { OPENMAUSBOT_OTHER_PLACE_URL: url, OPENMAUSBOT_OTHER_PLACE_TOKEN: "unused" } };
    const ref = "e2e-ask-0123456789ab";
    const first: Record<string, any> = await askOtherPlaceBot({ bot: FIXTURE_STARTER_BOT_NAME, text: "say hello", ref, timeout_seconds: 60 }, deps);
    expect(first.status).toBe("answered");
    expect(first.reply.length).toBeGreaterThan(0);
    const second: Record<string, any> = await askOtherPlaceBot({ bot: FIXTURE_STARTER_BOT_NAME, text: "say hello", ref, timeout_seconds: 60 }, deps);
    expect(second.status).toBe("answered");
    expect(sent).toEqual([`/api/bots/${first.bot.id}/messages`, `/api/bots/${first.bot.id}/messages`]);
    const thread = await request(`/api/threads/${first.taskId}/messages?limit=100`) as { messages: Array<{ role: string; text?: string }> };
    expect(thread.messages.filter((line) => line.role === "user" && line.text?.includes(`ref ${ref}.`))).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 120_000);
