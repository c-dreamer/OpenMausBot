# Commands between this computer and My Cloud

Status: proposal for agreement. Only the first slice (below) is code.

## Where things stand

A person's bots live in one place at a time. After the move to My Cloud this computer's server is frozen
(`server/move-freeze.ts:24`), so "bots on both sides" means: a desktop that has not moved yet, a Cloud that is
open beside a running local server, or a person who reaches the Cloud from a script or another client.

Today nothing lets a bot or a client on one place address a bot on the other:

- `coordinate_bots`, `list_bots` and rooms see only the server's own roster (`server/index.ts:14093`,
  `server/peer-roster.ts:116`). A hand-off cannot name a bot elsewhere.
- Send to My Cloud copies things one way, by id, then freezes this side (`electron/cloud-send.mjs:1-18`). It
  carries bots, chats, rooms, skills, routines, logins; it never carries a command or a live turn.
- The one live Cloud-to-computer bridge is lending: the desktop polls the Cloud outbound only and enforces a grant
  (`docs/cloud-pro.md` "How it is enforced"; `electron/computer-sharing.mjs:331`). It lends apps, screen, files,
  terminal. It does not carry a message to a bot.
- The only Cloud credential on the computer lives in Electron main (`electron/cloud-send-main.mjs:27`: the
  Admin's one-time code redeemed into an owner session). The local server never holds one.
- The control CLI and MCP server take `--url`/`OPENMAUSBOT_URL` plus one token (`scripts/mcp-server.ts:33`,
  `server/headless/main.ts`), so one client speaks to one place. Two places need two processes.
- Needs-you cards, push and the event stream belong to the server that owns the thread; the Cloud power gate
  keeps a sleeping Cloud quiet (`server/cloud-power.ts:70`).

Identity is solid on the Cloud side: it is personal (`server/cloud-owner.ts:9`), it admits only the owner's
admin-scoped devices, and the lent Mac accepts a turn only when the harness can prove the owner wrote every line
(`server/cloud-lending.ts:31-65`).

## Gaps, by value

1. A local bot or client cannot send a task to a named Cloud bot and get the result back.
2. No addressing by place: ids are server-local and names collide across places.
3. An approval for work on the other place has nowhere to go: it is a card on that place's thread only.
4. No record on this side that an ask was made, answered, or failed. No cross-place audit.
5. No clear "asleep or waking" answer; today a call just times out.
6. Ordering and retry: a script that retries can double-send unless it uses `send_id`.
7. Cloud-to-computer commands: the Cloud cannot ask a computer bot anything (lending does not carry it).

## Protocol

**Address.** `place/bot`, with place `here` or `cloud`; a bot is an id or an exact name. `cloud` means the one
Cloud this person's app is signed in to. There is no third place and no other account.

**Who may send.** A caller holding the person's own credential for the target place: a paired device token (or the
owner session Electron main mints from the Admin's code). A Cloud home refuses everything else already
(`cloud-owner.ts`). A teammate's bot, a guest, a webhook, a routine run by someone else, a bot in a shared room:
never. A bot-to-bot ask crosses only from a turn the harness proves is the owner's (the `cloudHomeLendingRefusal`
test, applied to the sending place).

**Kinds, in order of arrival.**

1. `ask`: one message to the bot's current task; the reply is that task's bot text after the message. Sent with a
   `ref` used as the server's `sendId`, so repeating it never sends twice; the line carries the ref visibly.
2. `status`: the bot's busy flag and the job state, read only.
3. `run routine`: start an existing routine by id; the routine's own approval level applies.

**Never across places without the person at that place's screen:** approve or answer a card, remember a grant,
spend or raise a spend cap, delete, share computer access or change lending, change settings, credentials,
logins, models, routines' schedules, or pair a device. No kind above can express them, and an `ask` that makes the
target bot need one stops as `needs-user`.

**Approvals.** The target bot's card appears on the target place's Needs-you list as it does for any turn. The
caller gets `needs-user` and a hint; it can wait again after the person answers where they are. A sender never
auto-approves: no message from a bot is an approval (`server/peer-provenance.ts:CONSENT_RULE`).

**Asleep Cloud.** A request to a sleeping Cloud is an ordinary request and wakes it (Fly wakes for any inbound
request; a stopped machine takes about 20 s, `docs/cloud-pro.md` "Sleeping homes"). The caller bounds its wait,
and on no answer returns `unreachable` with "asleep or waking, ask again with the same ref". Nothing is queued
on the caller's side. The Cloud-to-computer direction must use the same rule lending uses: no request while the
session says asleep.

**Delivery.** At least once with idempotent send (`ref`/`sendId`), at most one message per ref, replies read by
scanning after the tagged line. Ordering is per target thread: a busy bot queues the message behind its turn
(`queued`). Timeouts: 1-120 s wait, never longer than one tool call; a longer job is polled by the same ref.

**Audit.** The message in the target thread carries the origin tag and ref, so the person sees on the target
place what came from the other. A later slice adds one line in the sender's thread ("asked Researcher on My Cloud")
and an entry in each place's activity log (as `lending-activity.jsonl` does: action and target, never content).

**Cloud to computer (design only).** Reuse the lending shape: the desktop already polls the Cloud outbound and
enforces a grant on this side. A second job kind `ask` on that poll, opt-in with its own switch next to "Let my
bots use this Mac", delivered to the local server through Electron main and subject to the same owner-only turn
rule. Not in the first slice.

**Bot-to-bot (design only).** A `place` argument on `coordinate_bots`/`list_bots`, resolved in Electron main so
the server never holds the other place's credential. Needs the maintainer's agreement on a server-to-main channel
(the login hand-off port, `server/login-handoff.ts`, is the precedent).

## Security

- A compromised Cloud can answer an ask with hostile text. The reply comes back as tool output, which the
  calling client must treat as data (a bot-initiated ask would wrap it as a report, `reportNote`). It cannot reach this computer: the Cloud has no inbound path, and the
  lending bridge validates every job against the grant on this side.
- A hostile local page cannot call the tool: it is an MCP/CLI tool in a process the person configured with a
  token in its environment, not a browser route. The token is sent only to the configured origin, which must be
  https and must describe itself as a Cloud home before anything is sent.
- No escalation: the ask is one `POST /api/bots/:id/messages`, which any paired device of the person can already
  make. It adds no route and no scope. An injected local bot cannot obtain the token: it is not in the bot's
  environment (the first slice runs in the person's MCP client, not in a bot's tool surface).
- Open risk: a message sent with the person's token is the person's line on the Cloud, so a Cloud conversation
  that received one can still qualify for lending. The origin tag is text, not a harness marker. Before any
  bot-initiated ask, the Cloud must mark such lines as peer lines (`peerAsk`), which already take a conversation
  out of lending (`cloud-lending.ts:55-65`).

## First slice (this branch)

`ask_other_place_bot`, an MCP tool in `scripts/mcp-other-place.ts`, off unless `OPENMAUSBOT_OTHER_PLACE_URL` and
`OPENMAUSBOT_OTHER_PLACE_TOKEN` are set. One direction (this computer to My Cloud), kind `ask` only, no server or
Electron change. Not done: bot-initiated asks, Cloud to computer, `status`, `run routine`, audit on the sender side.
