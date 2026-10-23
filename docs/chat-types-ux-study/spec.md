# Chat types — living spec

The decision is [ADR 0023](../adr/0023-chat-types-and-hermes-home.md). The visual source is [01-chat-types.html](01-chat-types.html). Stack-side needs are in [change request 0002](../change-requests/0002-dm-context-budget.md).

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [index.html](index.html), [01-chat-types.html](01-chat-types.html) |
| Decision | [ADR 0023](../adr/0023-chat-types-and-hermes-home.md) (Accepted). Supersedes 0007 §1–3; amends 0008, 0009, 0014 |
| Upstream | [CR 0002](../change-requests/0002-dm-context-budget.md) (Phase 7b only; R1–R2 delivered 2 Oct 2026) |
| Started | 1 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Hermes name seam | Built; in-app check pending | — |
| 2 Conversation kinds and migration | Built; in-app check pending | 1 |
| 3 Typed rail, headers, ⌘N | Built; in-app check pending | 2 |
| 4 All chats | Built; in-app check pending | 3 |
| 5 Hermes in channels | Built; live gateway check pending | 1 (can run beside 3–4) |
| 6 Mentions and In channels | Built; in-app check pending | 3, 5 |
| 7a Long-thread tools for DMs | Built; in-app check pending | 3 |
| 7b DM context horizon | Built (R3 parts waiting); live check pending | CR 0002 R1–R2 |

## Goal

You always know which of the four conversation types you're in, and you can reach the others in one click. A Hermes chat is one of many titled sessions with the base agent. A channel is a room. A DM is one ongoing thread with a personality. A side chat is a session a personality ran outside its DM. Every @ you sent an agent in a channel can be found again, with the reply.

## Non-goals

- An Activity view for messages agents start themselves (scheduled runs, later reads). Deferred by ADR 0023 §11.
- Channel threads and group DMs (rejected on the study board).
- Branch, Edit and Retry in channels. These remain out of scope, as in the message-actions spec.
- Searching message text across chats. The gateway has no `session.search`, so All chats searches titles and agent names only until CR 0002 R4.
- Letting the user rename the built-in agent. The stack will fill the name later (CR 0002 R5).

## Thin-wrapper map

| Capability | Owner | Status today |
| --- | --- | --- |
| Base agent name, handle | Boundary's built-in agent record for now; the stack later (CR R5) | Hardcoded `Assistant` in the record plus about 7 renderer literals |
| Conversation kind | Boundary session meta (`hermes-agents` electron-store) | `dm` / `leftover` / `channel`, computed in `annotateThreadsWithAgents` |
| Transcripts, titles, lineage | Hermes (`session.*`) | Exists |
| Channel rooms, members, posts | Boundary overlay (0008/0009) | Exists |
| Mention index | Boundary, derived from channel history | **New.** No new store of transcript text |
| Seen-mentions watermark | Boundary electron-store | **New** |
| DM token budget and where the cut falls | Hermes (CR R1–R2) | Delivered as a stack overlay: `history_budget` on create/resume, the cut on `session.context_breakdown` |
| One-turn whole-thread override | Hermes (CR R3) | Missing |

---

## Phase 1 · Hermes name seam

Boundary-only, small. Ship first so every later phase reads the name from one place.

**Work**

1. **Built-in record.** In `hermesAgentStore.ts`, `BUILTIN_ASSISTANT` becomes `displayName: 'Hermes'`, `handle: 'Hermes'`, role `Default agent on this machine.` In `ensureBuiltin()`, migrate a stored built-in whose name and handle are still both `Assistant`. Keep the slug `assistant` (`BUILTIN_ASSISTANT_SLUG`).
2. **One reader.** Add `builtinAgent(agents)` in `src/shared/types/hermesChat.ts` (or a small `src/shared/hermesAgentIdentity.ts`). It returns the built-in record, falling back to a `BUILTIN_AGENT_FALLBACK` constant when the list hasn't loaded yet.
3. **Replace literals.** Swap each `'Assistant'` literal for the reader:
   - `WorkbenchChatScreen.tsx`: lines ~765, ~978, ~1198
   - `WorkbenchThread.tsx`: `speakerName` default, ~330, ~833
   - `hermesAgents.ts`: thread title, ~372
   - Check `renderer/setup/steps/index.ts:41`. It may name the stack rather than the agent; leave it if so.
   - Leave the placeholder "Wait for the assistant to come back…" alone; it refers to the stack.
4. **Reserve the handle.** `createHermesAgent` refuses a display name or handle that matches the built-in's (case-insensitive). Add `hermes` to `RESERVED_SLUGS`.

**AC**

- [ ] 1.1 Every surface that named the base agent "Assistant" now says "Hermes": rail, header, speaker line, @ menu, roster, inspector.
- [x] 1.2 An existing install shows "Hermes" after upgrade, and the built-in slug is still `assistant`.
- [x] 1.3 No renderer file names the base agent with a string literal (a grep test or lint rule covers it).
- [x] 1.4 Creating an agent named "Hermes" is refused with a clear message.
- [x] 1.5 Tests: store migration (stored Assistant → Hermes; a non-default stored record is untouched), reserved name.

---

## Phase 2 · Conversation kinds and migration

Main process only. The UI keeps working: the renderer maps the new kinds onto today's views until Phase 3.

**Work**

1. **Kinds.** `HermesConversationKind = 'hermes' | 'dm' | 'side' | 'channel'`. Remove `'leftover'`. Update `HermesLastOpened.kind` to `'hermes' | 'dm' | 'channel'`.
2. **Classify** in `annotateThreadsWithAgents`. Check channel first; it already wins. Then:
   - owned by the built-in → `hermes`
   - a personality's standing session → `dm`
   - any other session a personality owns → `side`

   Remove the "pick the newest Assistant session as its standing DM" block. The built-in no longer has a standing DM; drop its key from `standingDmByAgent` during migration. Sessions from other sources (Telegram, CLI, WebUI) are still claimed for the built-in, so they become Hermes chats and keep their `source`.
3. **Split create.**
   - `createHermesChat()` makes a built-in session titled "New chat" with kind `hermes`. It never touches the standing map.
   - `openAgentDm(slug)` returns the personality's standing session, creating one only if none exists. It never replaces an existing standing session.
   - Replace `createHermesChatThread`'s callers and IPC (`hermes-chat:create-thread`) with `hermes-chat:create-hermes-chat` and `hermes-chat:open-agent-dm`. Keep a shim in preload until Phase 3 lands.
4. **Branch.** `branchHermesChat` returns `hermes` when the parent belongs to the built-in, otherwise `side`. Parent agent and inference override are copied as today.
5. **Retire Keep as DM.**
   - Remove `promoteLeftoverToDm` and its IPC.
   - Rename `promoteLeftoverToChannel` to `makeChannelFromHermesChat` and only allow it on `hermes` sessions.
   - Per decision 9, the new channel starts with the built-in as a member. This replaces the "no auto-add" rule in 0009 §3.
6. **Last opened.** Record `hermes` and `dm` opens as well as channels. Default landing order: last opened, then the newest Hermes chat, then the empty Hermes composer. Never All chats or Mentions.

**AC**

- [ ] 2.1 After upgrade:
  - every former Assistant session (standing or leftover) and every external-source session lists as `hermes`
  - each personality's standing session lists as `dm`
  - every other personality session lists as `side`
  - nothing is lost or duplicated
- [x] 2.2 Migration is idempotent and survives a restart mid-way (it is derived on each list, apart from dropping the built-in's standing key).
- [x] 2.3 Creating a Hermes chat never changes any DM. Opening a personality's DM twice returns the same session.
- [x] 2.4 Branching a Hermes chat gives `hermes`. Branching a personality's DM gives `side` with that agent.
- [x] 2.5 Make channel works on Hermes chats only, and the resulting room has Hermes as a member.
- [x] 2.6 Tests: the `annotateThreadsWithAgents` matrix (channel / built-in / standing / non-standing / external source / unknown owner), the create split, branch kinds, last-opened fallback.

---

## Phase 3 · Typed rail, headers, ⌘N

The main visible change. Follow [01-chat-types.html](01-chat-types.html): states `hermes`, `channel`, `dm`.

**Work**

1. **Split the screen.** `WorkbenchChatScreen.tsx` is 1,375 lines. Move the rail into `ChatRail.tsx` and the conversation-type helpers into `conversationKinds.ts`: `conversationMeta(thread, agents)` replaces `recentJumpMeta`, plus `conversationTitle` and `kindLabel`. No behaviour change in this step; commit it alone.
2. **`ConversationMark`**: one component with `kind` and `agent` props. It draws:
   - Hermes: a sparkle in a rounded square, `--wb-hermes`
   - channel: `#` in an outlined square
   - DM: a filled circle with the agent's initial and `agentGlyphColor`
   - side chat: a dashed circle in the agent's color

   Sizes are 14 (section header), 18 (row) and 24 (header). Add the tokens to `workbench.css` (0018), with a light-theme value for `--wb-hermes`.
3. **Rail.**
   1. Top rows: **All chats** and **Mentions**. Mentions has no count until Phase 6, and the row is hidden until then.
   2. **Hermes** section: title, `⌘N` hint, `+`. The five newest Hermes chats, with source tags (`hermesSessionSourceLabel`), then *All Hermes chats…*.
   3. **Channels**: unchanged apart from the mark.
   4. **Direct messages**: personalities only; the built-in never appears. `+` opens the roster in "message an agent" mode, and picking an agent calls `openAgentDm`. Then *All agents…*.
   5. Empty states:
      - no Hermes chats: "Start a chat with Hermes · ⌘N"
      - no personalities: "No agents yet" with New agent
4. **⌘N and Hermes +** always call `createHermesChat`, whatever is open (`useAppCommand('new-chat')`, currently `handleNewDm`). The menu label "New Chat" stays.
5. **Header identity.** `wb-thread-head` becomes two lines, with the mark on the left:

   | Kind | Line 1 | Line 2 |
   | --- | --- | --- |
   | Hermes | chat title | *Hermes chat · started {time}* |
   | Channel | `#slug` | *Channel · posts are for the room, @ asks someone now* |
   | DM | agent name | *Direct message · one ongoing thread since {date}* |
   | Side chat | title | *Side chat with {agent}*, plus "from {parent}" when branched |

   Header actions:
   - Hermes chats get New chat (⌘N) and Make channel.
   - DMs keep Add to channel.
   - Side chats get *Open DM with {agent}*.
6. **Composer placeholders:**
   - Hermes: "Ask Hermes anything"
   - DM: "Message {agent}"
   - Side chat: "Message {agent} · side chat"
   - Channel: unchanged
7. **Inspector (0014).** In `inspectorTabs.ts`:
   - `hermes` → Session + Project (default Project)
   - `side` → Agent + Project (default Agent)
   - `dm` → Agent + Project
   - channel → Room + Project

   The Session tab drops Keep as DM. Update the conversation keys (`hermes:`, `side:`, `dm:`, `channel:`).
8. **Prev/next thread (⌘[ / ⌘]).** Walk the rail order: Hermes rows, then channels, then DMs.

**AC**

- [x] 3.1 The rail shows All chats, the Hermes section (≤5 rows, newest first, source tags), Channels and DMs, in the mock's order. The built-in is never listed under DMs.
- [x] 3.2 Every header names the kind in words, and its mark matches the rail row's.
- [x] 3.3 ⌘N from any conversation opens a new Hermes chat. DMs `+` never creates a second thread for an agent.
- [x] 3.4 Side chats open with their own header and a working *Open DM with {agent}*.
- [x] 3.5 Inspector tabs follow the new table. Keep as DM is gone everywhere.
- [x] 3.6 Light and dark both match the mock. Marks pass 3:1 against the panel.
- [x] 3.7 Tests: rail grouping and limits, `conversationMeta` for each kind, `inspectorTabsFor`, the ⌘N handler, the DM `+` picker.

---

## Phase 4 · All chats

Replaces the Recent pane. Mock state `all`.

**Work**

1. `centerMode: 'recent'` → `'all-chats'`. Add `AllChatsPane.tsx`, reusing `groupThreadsByRecency`.
2. **Search** filters, on the client, over title, agent name and channel slug (non-goal: message text).
3. **Filters**:
   - kind chips (All, Hermes, Channels, DMs, Side chats)
   - an agent menu (Hermes and each personality; matches the thread owner, or channel membership for rooms)
   - a source menu (App, Telegram, CLI, WebUI, API: whatever `source` values are present)

   Filters reset when the pane opens from the top row. *All Hermes chats…* opens it with the Hermes chip on.
4. **Rows**: mark, title, the `conversationMeta` line and time. Group headers stay Today / Yesterday / ….
5. **Never land here** (0007 rule). Selecting a row leaves All chats.

**AC**

- [x] 4.1 All chats lists every conversation of every kind, newest first, grouped by day.
- [x] 4.2 The kind, agent and source filters combine. Search narrows within them. An empty result says which filters are on and offers Clear.
- [x] 4.3 *All Hermes chats…* opens with only Hermes chats.
- [x] 4.4 The app never opens on All chats after ready or a restart.
- [x] 4.5 Tests: filter combinations, search fields, deep-link filter, empty state.

---

## Phase 5 · Hermes in channels

Small. It can run beside Phases 3–4 once Phase 1 has landed.

**Work**

1. **Membership.**
   - Remove the `!agent.builtIn` gate on roster *Add to channel* (`AgentSheets.tsx:203`).
   - Room tab Add member and the @ "not in channel" row include Hermes.
   - New channel (`ChannelSheets.tsx`) starts with Hermes checked; the user can uncheck it.
2. **Wake.** `runChannelWakeTurns` already resolves the built-in to `profile: null`. Confirm with a live turn that Hermes speaks with its default profile, the speaker is recorded as `assistant`, and chain wakes to and from Hermes work.
3. **Display.** Hermes replies in rooms show the Hermes mark and "Hermes · member". In a room, the @ menu describes Hermes as "Hermes · default agent".
4. **Guardrails.** Hermes never answers a post, never acts as a receipt or system voice (0009), and sends nothing without an @.

**AC**

- [x] 5.1 A new channel has Hermes as a member unless it's unchecked, and a room with zero members still works.
- [ ] 5.2 `@Hermes` in a channel wakes the default profile, and its reply is attributed to Hermes.
- [x] 5.3 Hermes can be added or removed from any room's members.
- [x] 5.4 A post (no @) never produces a Hermes reply.
- [ ] 5.5 Tests: create defaults, member normalisation including the built-in, wake routing for the built-in, chain wake to and from Hermes. Plus one live check against the gateway.

---

## Phase 6 · Mentions and In channels

Mock states `mentions` and `dm-ch`. Channels only; DMs never appear (ADR 0023 §11).

**Work**

1. **Index (main): `hermesMentions.ts`.** For each channel, walk the merged room history (`finishChannelHistory`). For each user line with `delivery: 'woke'`:
   - The mentions are `parseMemberMentions(text, members ∪ built-in)`.
   - Collect the assistant turns up to the next user line.
   - For each mentioned agent, the reply is that agent's first turn, matched by speaker `agentSlug`. Chain-woken turns from other agents don't count as replies to your @.
   - Emit `MentionRecord { id, channelId, channelSlug, sessionId, agentSlug, text, at, anchor, reply?: { text, at, rowId? } }`. Here `id` is the post id plus the agent slug, and `anchor` is the post id or the row id.

   Cache per channel, keyed by the room's `updatedAt`. Store nothing but the cache: the transcript and posts stay where they are (0009).
2. **IPC.**
   - `hermes-chat:list-mentions { agentSlug?, channelId?, status? }`
   - `hermes-chat:mentions-summary` returns `{ unseen }`
   - `hermes-chat:mark-mentions-seen`

   The seen watermark is `mentionsSeenAt` in the `hermes-agents` store. "Unseen" means replies newer than the watermark. Recompute the summary when a channel turn ends (`hermes-chat:end` on a channel session) and on load.
3. **Mentions pane** (`MentionsPane.tsx`):
   - agent chips: All, Hermes, then each personality
   - filters: *Unseen* and *Waiting*
   - cards with the room, time, your text with the @ highlighted, the reply clamped to 2 lines, and a status pill (*Replied*, *No reply yet*, *New reply*)

   Opening the pane marks everything seen.
4. **Card actions.**
   - *Open in #room*: opens the channel and scrolls to the anchor. This needs a `focusMessage` prop on `WorkbenchThread`; scroll to the matching row or post id, and if neither is found, open at the bottom.
   - *Continue in DM*: opens the agent's DM with the exchange as a quote chip (reuses message-actions P4 quotes).
   - For Hermes it is *Continue in a Hermes chat*: a new Hermes chat with the quote chip.
   - *Ask again* (waiting cards): opens the room with `@{agent} ` and the original text in the composer, unsent.
5. **DM tabs.** The DM header gets *Messages | In channels {n}*. In channels is `MentionsPane` locked to that agent with channel chips. The tab isn't persisted and resets to Messages when the agent changes.
6. **Rail row.** Show the Mentions row, with the unseen count when it's above 0.
7. **"Replied later"** stays out until the stack can reply to a post later (0009). The status type leaves room for it.

**AC**

- [x] 6.1 Every `@agent` you sent in any channel appears once per mentioned agent, newest first, with that agent's reply or *No reply yet*.
- [x] 6.2 Chain-woken replies and posts never appear as your mentions. DM messages never appear.
- [x] 6.3 The agent's In channels tab shows exactly that agent's cards, filterable by channel.
- [x] 6.4 The rail count is unseen replies only. It clears when Mentions is opened and survives a restart.
- [x] 6.5 Open in #room lands on the message. Continue in DM and Continue in a Hermes chat carry the exchange as a quote. Ask again pre-fills without sending.
- [x] 6.6 Tests:
  - index building: single and multiple mentions, chain wakes, no reply, posts, a member removed later, the built-in
  - cache invalidation
  - the watermark
  - pane filters
  - DM tab reset

---

## Phase 7a · Long-thread tools for DMs

Unblocked. It makes one ongoing thread usable before the horizon exists.

**Work**

1. *Ongoing since {date}* sits at the top of the DM log. *Jump to date* opens a small date list built from the day dividers (message-actions P1). Choosing a day scrolls to it, loading older history if the thread pages.
2. *Search this DM* opens a find bar that matches loaded messages client-side, with next/previous and Esc to close. This is a scoped version of the deferred ⌘F; it binds ⌘F only in DMs.

**AC**

- [x] 7a.1 Jump to date reaches any day in a DM of several hundred messages.
- [x] 7a.2 Search this DM highlights matches and steps through them. Esc restores the composer focus.
- [x] 7a.3 Tests: date index, search stepping, ⌘F scoped to DMs.

---

## Phase 7b · DM context horizon

**CR 0002 R1–R2 delivered 2 Oct 2026; R3 still open.** Feature-detect. Draw nothing unless the stack reports the cut (ADR 0023 §7).

**Work**

1. Read the budget and the first included row id from the stack (CR R2) after each DM turn and on open.
2. Draw a dashed line before that row:

   > {Agent}'s next reply sees from here down · about {used} of {budget} tokens · Include earlier

   Messages above the line render at reduced opacity, still selectable and copyable. If the cut is a compression summary, the line says *Earlier messages are summarised for {agent}*.
3. The composer chip reads *Context: recent · {budget}*. Its menu:
   - Recent (default)
   - *The whole thread, once* (CR R3, shown only if supported)
   - *Pick messages…* (CR R3 pins, later)
4. *Include earlier* on the line is the same as choosing *whole thread, once*.

**AC**

- [x] 7b.1 With CR R2 in place, the line sits exactly at the stack's first included row and moves as the thread grows.
- [x] 7b.2 Without R2, nothing is drawn and the chip is hidden.
- [ ] 7b.3 *Whole thread, once* applies to one reply and then resets, and the chip says so. *(Waits on CR R3; hidden until then.)*
- [ ] 7b.4 Tests: line placement from the reported row id, summary wording, feature detection, the one-turn reset. *(All but the one-turn reset, which waits on R3.)*

---

## Decisions log

1. **Name:** Hermes, read from the built-in record. Slug stays `assistant`. (ADR 0023 §8)
2. **Hermes in channels:** yes, pre-checked on New channel. (§9)
3. **DM window:** a token budget, owned by the stack. (§7) Boundary sends 8,000 tokens for DMs (Phase 7b).
4. **Old personality sessions:** side chats. (§10)
5. **Mentions:** channels only. Activity is deferred. (§11)
6. **Make channel** stays, on Hermes chats only. Keep as DM is removed.
