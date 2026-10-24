# Hybrid groups, and better local/Cloud direct commands

Status: proposal for agreement (CONTRIBUTING: big changes are agreed first). No feature code in this branch.
Builds on `docs/design/cross-place-commands.md` and `scripts/mcp-other-place.ts`. "Verified" below means read in this
checkout; anything else is marked UNVERIFIED.

## 1. How things work today (verified)

**Groups ("rooms" in code).** A group is a `GroupRecord` (`server/store.ts:58`, from `WireGroup`, `shared/wire.ts:805`):
`id`, active `threadId`, `tasks[]` (independent threads), `memberIds: string[]` (bot ids local to this store),
`defaultResponder`, `bulletin`. Membership is pruned against the store's own bots (`store.ts:496-497`), so a member id
that is not a local bot is dropped today. The transcript is the group thread's messages in the same store
(`store.groupByThread`, `store.ts:856`). Who answers a user line: `roomResponders` (`store.ts:269`), `@everyone`, or an
`@Name` match of member names (`store.ts:225-240`), else `defaultResponder`. Room jobs run one at a time per thread with
a queue (`server/room-queue.ts:13-36`). Team/department sharing exports groups as a file with members by name
(`docs/team-sharing.md`), i.e. a copy, not a link.

**Bot-to-bot.** `coordinate_bots`, `list_bots`, `list_room_targets`, `post_to_room` are internal-capability routes
(`server/index.ts:14864` post_to_room appends a `role:"bot"` row and starts no turn; `index.ts:10568` tells bots to use
`coordinate_bots`). Reach is the server's own roster only: `canReachPeer`/`reachablePeers` (`server/peer-roster.ts:111-123`).
Received work is wrapped as data with provenance (`server/peer-provenance.ts:41-45` `workOrigin`: only a person's own
non-`peerAsk`, non-`relayed` line is "the user's request"; `CONSENT_RULE`, line 58: no bot message is an approval).
Delivery receipts (`server/peer-delivery.ts`) are queued / injected / failed.

**Where bots live.** A local server and a Cloud server are separate processes with separate origins, cookies, token
stores and data folders. Upstream is moving to One home: `electron/one-home.mjs:1-27` copies everything to My Cloud,
freezes this computer's server (`server/move-freeze.ts:1-5`, `MOVED_REFUSAL`), and after the switch "this computer
lends itself" (`one-home.mjs` header, `done` phase). A person can instead keep bots here (`keep`, `one-home.mjs:19-22`).
So in the end state a person has ONE live bot store (Cloud), plus a frozen copy. Hybrid groups therefore matter for:
(a) people who have not moved or chose `keep`, (b) the long tail of "my computer's apps/files/terminal, my Cloud's
always-on bots" which is exactly what lending already covers per-bot rather than per-group.

**Lending (Cloud acts on this computer).** Outbound only: Electron main long-polls the Cloud with the app's session
cookie plus a per-grant secret and a grant enforced on the computer (`electron/computer-sharing.mjs:331` `call("poll")`;
`docs/cloud-pro.md:767-779` "How it is enforced": no listening port). Lent jobs are apps/screen/files/terminal
(operation validation `computer-sharing.mjs:95-` ), not messages to a bot. A Cloud turn may use the lent computer only
if the harness proves the owner wrote every line (`server/cloud-lending.ts:1-4`, `cloudHomeLendingRefusal`, 31-65):
"rooms, delegated or peer turns and anything unprovable never can". Sleeping Cloud is honoured (`computer-sharing.mjs:263`,
`docs/cloud-pro.md:1471`).

**`ask_other_place_bot`.** MCP tool (`scripts/mcp-other-place.ts:44-61`) calling a Cloud's HTTP API with the person's
paired-device token: resolve bot, `POST /api/bots/:id/messages` with `sendId=ref`, scan the thread for the tagged line,
return the reply flagged `untrusted`. It is "not recommended yet" because of the OPEN RISK recorded in
`cross-place-commands.md` ("Security", lines ~100-108) and the file header (lines 6-7): the messages route has no
provenance field, so the ask lands as the person's OWN line on the Cloud, which the lending test treats as owner-proven;
a prompt-injected MCP client on this computer could therefore drive a Cloud bot that holds a lent computer. The origin
tag is text the harness does not read. Fix needed before recommending it: My Cloud must mark such lines.

## 2. What is missing (the owner's two asks)

1. Direct commands: a local bot cannot message a Cloud bot as a bot (only an external MCP client can), and the Cloud
   cannot message a local bot at all (lending carries no message kind). No place-qualified addressing, no audit.
2. Hybrid group: one transcript that local and Cloud bots both read and write. Impossible today: `memberIds` are
   store-local and `post_to_room`/`coordinate_bots` resolve against one roster.

## 3. Options for hybrid groups

**A. Cloud hosts the group; local bots join as lent "remote members".** The group record, `threadId` and transcript live
on My Cloud. A member entry can be `{ place: "computer", remoteBotId, label }` instead of a local bot id. When a turn is
due for such a member, the Cloud queues a `bot-turn` job on the existing lending poll; the desktop (Electron main)
picks it up outbound, hands it to the local server, runs the local bot, and posts the reply back over the same
authenticated channel. Pros: one transcript and one ordering authority (the existing room queue); no new inbound path;
reuses the lending grant, power gate and outbound auth; local content leaves only when a local bot speaks in that group.
Cons: group exists only while a Cloud exists; Cloud must be awake; a new job kind on the poll; local bot needs a
"remote room turn" entry point that does not exist (UNVERIFIED how `startTurn` would accept a transcript it does not own).

**B. Federate two group stores** (each place keeps a copy; sync rows both ways). Pros: works with either side offline.
Cons: two writers, ordering/dedupe/edit conflicts, duplicated `@everyone` triggering (both sides respond), two queue
authorities, transcript copies on two machines (privacy and retention doubled), and a sync protocol with no precedent
for live data in this repo (`cloud-sync-*` syncs Files, not threads; UNVERIFIED for threads). Highest risk, rejected.

**C. A relay proxy bot per place.** Each place has a stub bot "Researcher (on My Cloud)" whose turns forward to the
other place (like `ask_other_place_bot`, but server-side). Pros: no change to group semantics; works with today's
`memberIds`. Cons: needs a server-held credential for the other place, which the design forbids (the only Cloud
credential lives in Electron main, `electron/cloud-send-main.mjs:27`); the proxy's replies arrive as a bot's text in a
room, so there is no per-bot identity, @mention matching sees only the stub name; every hybrid group needs hand-made
stubs; each stub is a confused-deputy surface. Also reintroduces the unmarked-line risk above.

## 4. Recommendation: A, as an owner-only, flagged, Cloud-hosted group with lent remote members

Reasoning in one line: A keeps one writer and one transcript, reuses the only already-reviewed outbound bridge, and
makes the trust rules enforceable at one place (the Cloud) rather than reconciled across two.

### 4.1 Data model (proposed)

On the Cloud's `GroupRecord` add an optional `remoteMembers: RemoteMember[]` kept OUT of `memberIds` so existing
pruning (`store.ts:496`) and every consumer of `memberIds` is untouched:

```
RemoteMember { key: string        // "computer:<grantId>:<remoteBotId>", stable, never a local bot id
               place: "computer"
               grantId: string    // the lending grant that carries it (computer-sharing.mjs)
               remoteBotId: string
               name: string       // display + @mention; unique among all members, else suffixed "(Mac)"
               lastSeen?: number }
```

Roster of lendable bots comes from the desktop: on each poll/heartbeat it reports `{id, name}` of bots the person has
ticked "can join Cloud groups" (new per-bot opt-in, default off). Nothing else about the bot (prompt, skills, memory,
files, model) is sent. `roomResponders` gets remote members as candidates (name matching only); the responder result
splits into local ids and remote keys.

### 4.2 Transcript

The Cloud stores the whole transcript (single source of truth). The local server stores NOTHING of the group by
default: a remote turn runs in a local thread marked `hybrid:<groupId>` that holds the rendered context the Cloud sent
for that turn plus the bot's reply (so the person can open "what did my bot see" locally). UNVERIFIED: whether a
per-turn ephemeral thread is acceptable to the local store/usage ledger; needs a spike.

### 4.3 Delivery of a message to a local bot (no inbound port)

1. Cloud room engine picks remote member M for a turn (mention, `@everyone`, default responder, `coordinate_bots`).
2. It writes a `bot-turn` job `{jobId, groupId, memberKey, context, request, requestOrigin}` into the grant's job queue
   (same queue the poll drains, `computer-sharing.mjs:331`). `context` is the last N group lines (bounded, redacted with
   `shared/redact.ts`, each line prefixed with sender and place) plus the room bulletin; `jobId` is the idempotency key.
3. The desktop poll returns the job. Electron main validates it against the grant (grant has `groupMembers: true`,
   member still opted-in, size caps) and calls the local server over loopback with a fresh per-job capability. No Cloud
   token is ever passed to the local server; no local token is ever sent to the Cloud (the poll already uses the
   grant secret, not a local token).
4. Local bot runs at its OWN approval level with NO lent-computer extras beyond what it already has locally (see 4.5).
5. Reply text (or "needs-you" / "failed") is POSTed back by Electron main with `jobId`; Cloud appends one `role:"bot"`
   row attributed to M with `place:"computer"` and a visible "on this computer" badge. Duplicate `jobId` replies are
   ignored; a job not completed within a bound (default 10 min, UNVERIFIED sensible) becomes "no reply".

### 4.4 Identity and trust

- Owner-only: the group is a personal Cloud group (`server/cloud-owner.ts:9`); remote members are only addable by the
  owner from an admin-scoped device and only to the group on the Cloud the lending grant is bound to. Teammates, guests,
  webhooks and shared rooms can not add, mention-trigger from outside, or see remote members (feature refused in
  team/shared rooms in slice 1).
- Local bot output is DATA to Cloud bots: wrapped with `peerProvenanceNote`-style framing and `untrusted`, `peerAsk`
  set so it never counts as the owner's line (`peer-provenance.ts:41-45`, `cloud-lending.ts` `personOf`). Cloud bot
  output is data to local bots the same way: the `context` arrives as a report, never as the user's request; only the
  person's own typed line (carried as `requestOrigin: user` and re-proven by the Cloud) is "the user's request".
- No consent by text: `CONSENT_RULE` applies in both directions. A local bot's "approved" in group text approves nothing
  on the Cloud and vice versa.
- No token crossing places; the lending grant secret stays in Electron main.
- The key lending rule is unchanged and extended: `cloudHomeLendingRefusal` already refuses lent-computer use for any
  turn that is a room/peer turn or whose thread holds other people's words. A hybrid group thread contains bot-authored
  rows, so Cloud bots in it can NOT use the lent computer, and a remote member's turn can not either (the local bot
  runs with local powers only, as if the person had messaged it, but see Q2). Cloud-bot text can therefore never reach
  local computer powers through the lending bridge. The one new surface is "Cloud text becomes input to a local bot's
  turn"; that is prompt-injection exposure to the local bot, bounded by that bot's own approval level.
- Prompt-injection stance: all cross-place text is delimited, labelled by place, never merged into system instructions,
  size-capped and secret-redacted on the way out of the computer. Approval cards for a local bot's tool use appear on
  the computer (and on the Cloud only as "waiting for you on your computer"); nothing is approvable from the other place.

What a hybrid group MAY do: carry text and attachments the person already put in the group; let remote members reply;
show status. MAY NOT: approve or answer cards cross-place; change lending/grants/settings; spend or raise caps; run
routines; pair devices; read local files other than what the local bot itself reads under its own permissions; start
turns on local bots that are not opted-in members.

### 4.5 Offline and sleep

- Local offline (app closed, asleep, grant off, no poll for > 2 poll intervals): member shows "offline" in the
  member list; a mention gets an immediate system row "<name> is offline; not delivered". DEFAULT: DROP, not queue, in
  slice 1 (a stale queued order running hours later on a person's computer is the worse failure). Optional later: queue
  with a short TTL (e.g. 5 min) and explicit "send when back" button.
- Cloud asleep: the group is not reachable, which is the same as today for a Cloud; the desktop honours the existing
  power gate and does not poll a sleeping Cloud (`computer-sharing.mjs:263`). Opening the group wakes it.
- Mid-turn disconnect: result is lost-or-late; the Cloud marks the row "no reply (computer went away)"; the local
  reply, if it completes, is held in Electron main and retried with the same `jobId` for a bounded time.

### 4.6 Privacy: what leaves the computer

Only: the opted-in bot's `{id, name}`; its reply text (and attachments the owner opts to allow, none in slice 1). Not:
its prompt, memory, skills, files, tool output or other threads, except as quoted by the bot in its reply (the person
should be told this when opting a bot in; local bots can paste anything they read). Cloud to computer: the bounded
group context for that turn. The Cloud already holds the group transcript, so the new exposure is local replies stored on
the Cloud and Cloud context stored in a local ephemeral thread.

### 4.7 Failure modes

Duplicate delivery (idempotent `jobId`); two members answering an `@everyone` (existing queue serialises, remote
member is one more line item in `roomQueue`); name collisions with local-store members (suffix); grant revoked while a
job is in flight (job refused at the Electron validation step, row says "computer access was turned off"); Cloud
changes machine/account (existing grant-binding ends lending, members go offline, `docs/cloud-pro.md:775-779`); local
server frozen after One-home (members are removed: a frozen server admits no turns, `move-freeze.ts:1-5`, and the
bots should be Cloud bots by then); clock skew (rows ordered by the Cloud's receive time).

## 5. Better direct commands (independent of groups, smaller)

Order: (1) make My Cloud mark ask lines from another place so they are NOT owner-proven for lending (resolves the open
risk, needed before `ask_other_place_bot` can be recommended); (2) add `status` to the tool; (3) Cloud to computer
`ask` as a second job kind on the lending poll, opt-in, which is the same plumbing hybrid groups need, so build it once
as `bot-turn`; (4) `place` argument on `list_bots`/`coordinate_bots` resolved in Electron main (needs a server-to-main
channel; precedent `server/login-handoff.ts`, per cross-place doc).

## 6. Rollout

Flag `OMB_HYBRID_GROUPS` (server) AND a desktop setting, both off by default; per-bot opt-in; per-group add. Not
shown in team/shared rooms. Telemetry: counts only, never content (like `lending-activity.jsonl`, action and target).

## 7. Minimal first slice (shippable, testable)

One direction, one bot, no UI redesign:
1. Cloud: `remoteMembers` on the group record + flag + the `bot-turn` job kind and result route, text only, drop-on-offline.
2. Desktop: validate job against grant + opt-in, run the local bot via loopback, return reply.
3. Cloud room engine: remote member as mention/default-responder target; badge and offline row in the transcript.
4. Marker for ask lines (section 5.1) lands first, because it fixes a pre-existing hole the slice depends on.
Not in slice: attachments, queueing, cards, `@everyone` fan-out to remote members, team rooms, rejoin after move.

## 8. Test plan

- Unit: `roomResponders` with remote candidates; job validation (bad grant, un-opted bot, oversize, duplicate `jobId`);
  redaction of context; `cloudHomeLendingRefusal` still refuses a hybrid thread (extend `server/cloud-lending.test.ts`).
- Server e2e with the fake engine (skill verify-omb): two servers in-process, grant, remote member replies, offline
  drop row, revoked grant mid-job; verify no local token appears in any Cloud request and no Cloud token in loopback calls.
- Electron node tests beside `computer-sharing`/`cloud-lending.node-test.mjs`: poll returns `bot-turn`, validation, retry.
- Adversarial: Cloud bot text "approve the pending card" / "run this command on the Mac" in group; assert no card
  answered, no lent-computer operation, local bot receives it only as labelled data.

## 9. Open questions for Milind Soni

1. Given One home, is a hybrid group worth building for the `keep` / not-yet-moved population, or should the effort go
   to making Cloud bots reach this computer better (lending) and skip local bots as group members?
2. Should a remote member's local turn get ANY lent powers, or strictly the local bot's ordinary ones (recommended)?
3. Local ephemeral thread per hybrid turn vs a persistent local mirror of the group (privacy vs usefulness)?
4. Drop vs short-TTL queue when the computer is offline; what TTL?
5. Is a per-bot "can join Cloud groups" opt-in the right granularity, or per group?
6. Agree the ask-line marker (5.1) as a prerequisite and as its own PR?
7. Teams: should hybrid ever work in shared rooms (this design says no)?

## 10. Not verified

How a local turn can be started from a transcript it does not own (`startTurn`, `index.ts:7607` takes local thread ids);
whether the lending job queue/poll can carry a new job kind without a contract-version bump; Cloud-side behaviour of
`sendId` with remote turns; whether usage/billing ledgers handle a turn whose thread is ephemeral; real wake latency
under the poll; Windows/Linux parity of the desktop path; the exact current Admin-side contract for lending grants.
