# Message actions — living spec

The visual source is this kit: option **D · Right bubble** in [01-user-actions.html](01-user-actions.html), and [02-assistant-actions.html](02-assistant-actions.html). Keyboard ideas ([03-shortcuts.html](03-shortcuts.html)) are out of scope for now. Stack-side needs are in [change request 0001](../change-requests/0001-message-actions.md).

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [index.html](index.html), [01-user-actions.html](01-user-actions.html) (variant D), [02-assistant-actions.html](02-assistant-actions.html) |
| Upstream | [CR 0001](../change-requests/0001-message-actions.md) |
| Started | 29 Sep 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Layout, time, copy | Merge-ready | — |
| 2 Edit and retry | Built; live check pending | CR 0001 R1 — done |
| 3 Branch | Built; live check pending | CR 0001 R2 declined; text seed until upstream `up_to_row_id` |
| 4 Reply extras | Built (items 1–3 + Files line); item 4 blocked | Item 4: inference Phase 4 and CR 0001 R5 (declined upstream) |

## Goal

Every message shows its time and the next useful verbs on hover, without cluttering the log at rest. You can fix a prompt, re-run a reply, or fork the conversation without losing what was there before. The agent's own record, in Hermes, stays the source of truth.

## Non-goals

- Keyboard shortcuts, the ⌘/ sheet, message focus, and ⌘F (study C). The one exception is Esc on the inline editor, which comes with the editor.
- Thumbs up/down, deleting messages, share links.
- Retrying as another agent.
- Edit, Retry and Branch in channels (0008). Channel user posts live in Boundary's local overlay, not in the Hermes transcript, so truncation targets would not line up. Channels get the layout, time and Copy only.
- Edit, Retry and Branch on HTTP-fallback threads. These have no gateway session. They get Copy and time only.

## Thin-wrapper map

Where each piece lives. Boundary does rendering, IPC and the mapping between the two. Hermes owns transcripts, lineage and versions.

| Capability | Owner | Status today |
| --- | --- | --- |
| Message timestamp | Hermes `TranscriptMessage.timestamp` | **Exists. Boundary drops it** in `mapTranscriptMessages` (`hermesGatewaySession.ts`) |
| Durable message id | Hermes `TranscriptMessage.row_id` | **Exists. Boundary drops it** |
| Edit / retry | Hermes `prompt.submit` truncate params + `confirm_truncate` | Exists upstream. Boundary only sends `session_id` + `text` |
| Branch | Hermes `session.branch` / `session.create` + `parent_session_id` | Exists. The cut-point semantics are unclear → CR R2 |
| Versions (‹ 2 / 2 ›) | Should be Hermes (alternates) → CR R3 | Interim: assistant-ui local runtime, in memory |
| Live-turn row id | Should be Hermes → CR R4 | Interim: refresh from `session.history` |
| Per-turn provider | Should be Hermes → CR R5 | Later |
| Hover row, bubble layout, tooltips, day dividers | Boundary renderer | New |
| Copy, quote, save to folder, reveal in Finder | Boundary (clipboard / fs / shell on the host) | New. User actions on the host, not agent actions |

---

## Phase 1 · Layout, time, copy

Boundary-only. No stack dependency.

**Work**

1. **ADR 0021 · Right-aligned user turns.** Amends 0020. User turns hug the column's right edge, fit to their text, up to 80% of the column. Text stays left-aligned inside. Agent turns stay full width. Channels follow the same rule. Add it to the ADR tree.
2. **Carry time and row id through.**
   - Add optional `timestamp?: number` (unix seconds) and `rowId?: number` to `HermesChatMessage` (`src/shared/types/hermesChat.ts`).
   - Map them in `mapTranscriptMessages` (`hermesGatewaySession.ts`) and in `mapWebuiMessages` (`hermesWebuiSessions.ts`) when present.
   - In `HermesChatRuntimeProvider.tsx`, hydrate `initialMessages` with `createdAt` and `metadata.custom.rowId`. Live turns get `createdAt` from the local runtime.
3. **User message (D).** In `UserMessage` (`WorkbenchThread.tsx`), drop the "You" label in DMs and add the `.wb-msg.is-user` right-bubble styles to `workbench.css`, using the tokens from 0018. Add a hover row under the bubble's right edge using `ActionBarPrimitive.Root`, always mounted and revealed with CSS. The row holds:
   - the time: a new `MessageTime` component showing the local time, with the full date and seconds in its tooltip
   - `ActionBarPrimitive.Copy`, with a check and "Copied" for 1.4s
   - slots for Edit and Branch, hidden until Phases 2–3
4. **Assistant message.** Add a row under the prose, aligned left. The latest reply's row stays visible. Copy for now. Time sits at the right end on hover. (Model name deferred; see Log.)
5. **Day dividers.** Show "Today", "Yesterday" or a date between messages whose local days differ. Render them inside the message component by comparing with the previous message's `createdAt`. Skip them when either time is missing.
6. **Code blocks.** Turn on Streamdown's built-in code-block copy (`controls`) and style it to match the kit, so the copy button is always visible.
7. **Reveal rules.** Keep a 60ms show delay. Show the row on `:focus-within` for keyboard users. The row sits in the 28px message gap and never reflows text. Hide the row while a message is streaming.

**AC**

- [x] 1.1 User turns are right-aligned, sized to their text up to 80% of the column, with text left-aligned inside. Assistant turns are unchanged.
- [x] 1.2 Hovering a prompt shows the time and Copy under the bubble's right edge. Moving the pointer away hides them. Nothing moves.
- [x] 1.3 The time tooltip shows the full date and seconds. Reloaded history shows the times Hermes stored. Messages with no stored time show no time and no gap.
- [x] 1.4 The latest reply's row is always visible. Older replies show theirs on hover. No row appears while a reply is streaming.
- [x] 1.5 Copy on a prompt or reply puts markdown on the clipboard and confirms. The code-block Copy copies only the code.
- [x] 1.6 Day dividers appear between messages from different local days.
- [x] 1.7 Tab reaches every row button, and the row is visible while it has focus.
- [x] 1.8 Light and dark themes both match the kit.
- [x] 1.9 Unit tests cover timestamp and row-id mapping for gateway and WebUI rows, including missing fields.

---

## Phase 2 · Edit and retry

Uses upstream truncation. Feature-detect until CR R1 is answered.

**Work**

1. **The renderer knows what Hermes holds.** `serverPath.ts` keeps the chain of runtime messages Hermes has, created with each runtime mount and seeded from hydrated history (fixed ids `hist-N`, with row ids). The adapter plans every run against it: a path that extends the chain is a normal send; one that stops at a prompt Hermes has is a rewind (Edit or Retry); one that leaves the chain earlier is an older version and is refused. No count or intent flag is involved, so turns added by another client can never trigger a cut.
2. **Payload.** `HermesChatStartPayload.rewind` carries the replaced turn: user ordinal, row id when known, and its text.
3. **Main confirms before cutting.** `startHermesChatStream` re-reads `session.history` right before the turn and plans with `hermesRewind.ts`: the row id is preferred; a live turn without one is found by ordinal; the stored text must still match; a turn Hermes never received becomes a plain send. Anything uncertain is refused (`rewind-stale` / `rewind-unsupported`), never guessed. The cut goes out as `truncate_before_row_id` + `confirm_truncate`, plus `confirm_empty_truncate` for the first prompt. Ordinal-only truncation is never sent (Hermes refuses it on durable sessions).
4. **No silent fallback.** A refused or failed rewind reports a readable error on the reply. It never falls back to an HTTP turn Hermes would not see. `rewind-unsupported` and HTTP-fallback chats turn Edit and Retry off for that chat.
5. **Edit UI.**
   - `ActionBarPrimitive.Edit` opens an `EditComposer` in place, widened to the full column.
   - The caption reads "Sends as version N. The reply below stays with version N−1".
   - Cancel / Esc and Send / ⌘↵ work in the editor.
   - Later messages dim to 38% while editing.
6. **Retry UI.** `ActionBarPrimitive.Reload` on replies. No ▾ menu until Phase 4: it would hold one option.
7. **Versions.** `BranchPickerPrimitive` (‹ n / m ›, `hideWhenSingleBranch`) shows in the row. It stays visible whenever there is more than one version, and "edited" shows next to it. Older versions can be viewed and copied, not continued: Hermes keeps only the latest (CR R3 declined). A note above the composer says so, and sending from one is refused without calling main.
8. **Persistence (interim).** Versions last as long as the open chat. When CR R3 lands, load alternates through a `ThreadHistoryAdapter` and remove this note.
9. **Guards.** Hide Edit and Retry in channels, on HTTP-fallback threads, and while a turn is running.

**AC**

- [ ] 2.1 Editing a prompt resubmits it, and the agent's next reply shows it did not see the old version: its context was truncated on the server.
- [x] 2.2 Retry re-runs a reply from the same prompt. The old reply stays reachable via ‹ 1 / 2 › while the chat is open.
- [x] 2.3 An older version can be viewed and copied but not continued; the UI says why, and nothing is sent.
- [x] 2.4 Reloading a chat shows the server's current path. Earlier versions are gone until CR R3, and the UI does not claim otherwise.
- [x] 2.5 Edit and Retry are hidden in channels, on HTTP-fallback threads, during a running turn, and on gateways without truncate support.
- [x] 2.6 Tests cover run planning (append / rewind / older version), main's target check (row id, ordinal, text, missing turn, first prompt), the truncate parameters sent, gateway refusals without HTTP fallback, recovery after a failed send, and an end-to-end edit then retry.

---

## Phase 3 · Branch

Revised 30 Sep 2026 after Phase 2, before any Phase 3 code. Stopgap: branches copy text only (CR 0001 R2 declined; upstream `up_to_row_id` pending).

**What Branch does**

- **From a prompt:** a new chat holding everything above that prompt, with the prompt waiting in the composer, unsent.
- **From a reply:** a new chat holding everything up to and including that reply, with an empty composer.
- The source chat is never changed. No model call happens until you send.

**Work**

1. **Seed from what you see.** The renderer builds the seed from the visible message path (role and text) up to the cut. This is the same content Hermes would copy under the text-only stopgap. It also works on **older versions**, so Branch is how you continue version 1 after an edit (the gap left by R3). When upstream `up_to_row_id` ships, messages Hermes still holds switch to a server-side fork that keeps tool rows. Older versions keep the text seed.
2. **IPC.** Add `hermes-chat:branch` with `{ parentSessionId, agentSlug, seed: HermesChatMessage[], title? }`, returning `{ sessionId, title }`. Main:
   - calls `session.create` with the seed, the agent's profile and `parent_session_id` (extend `createSessionWithSeed`)
   - records the branch on the new session's meta: parent id, seeded message count, branch time
   - copies the parent's agent slug and inference override (a new copy helper; `migrateSessionInference` moves instead of copying)
   - titles it "<parent title> · branch" and remembers it as a local thread
3. **Placement: Recent, not nested.** ADR 0007 keeps the rail as people: one standing DM per agent, other chats in Recent, no chats nested under an agent. A branch is therefore a leftover: it appears in Recent (today's group) with a "Branch of <parent>" subtitle. Its header offers the existing **Keep as DM** and **Make channel**. The study mock's nested rail row (01, Branched state) is overridden.
4. **Parent link.** Add `parentId?: string` to `HermesChatThreadSummary`, read from `parent_session_id` in `session.list`, falling back to the local branch record. Recent and the thread head use it for "Branch of <parent>", linking back.
5. **Thread.**
   - Open the new chat straight away.
   - Show a "Branched from <parent> · <time>" divider after the copied messages (the seeded count from the branch record), reusing the switch-mark style.
   - Copied messages show **no times**: seeding drops them, and Hermes's stamps would all read as the branch time. The divider carries the time.
   - A toast says "Branched into a new chat" with **Go back**.
   - **Draft handoff:** the chat screen keeps a pending draft for the new session, and the thread puts it in the composer once on mount (`aui.composer.setText`).
6. **Actions.** Branch joins both rows (prompt: after Edit; reply: after Retry).
   - Unlike Edit and Retry, it shows on older versions and on messages Hermes doesn't hold.
   - Hidden in channels, on HTTP-fallback chats (no gateway to create the session) and mid-turn.
   - The project needs no work: it is global UI state and applies to whichever chat is open.

**AC**

- [x] 3.1 Branching from a prompt opens a new chat with the history above that prompt, and the prompt waiting in the composer. No model call happens until you send.
- [x] 3.2 Branching from a reply opens a new chat that includes that reply, with an empty composer.
- [x] 3.3 The branch appears in Recent as "Branch of <parent>", and its header links back. The parent chat is unchanged.
- [x] 3.4 The branch keeps the parent's agent, project and inference override.
- [x] 3.5 Branching from an older version continues that version in the new chat.
- [ ] 3.6 The agent in the branch answers with the copied context. Tool rows are not copied (text-only stopgap), and copied messages show no times.
- [x] 3.7 Tests cover the seed cut for prompts and replies (including older versions), the parent link and meta copy, draft handoff, and hiding rules.

---

## Phase 4 · Reply extras

Boundary-only, except the other-provider retry.

**Work**

1. **Overflow ⋯** holds:
   - **Copy as plain text** (strips the markdown)
   - **Quote in reply**
   - **Save to <project>…**: a save dialog that defaults to the bound project's host folder and writes `.md`. Hidden when no project is bound.
2. **Quote a selection.** Selecting text in a reply shows a Quote / Copy popover. Quoting adds a removable quote block above the composer, sent as a markdown blockquote.
3. **Tool cards.** Hovering a tool card shows **Reveal** (`shell.showItemInFolder`) and **Copy path**, using the existing host-path mapping (`hermesToolPaths`). Both are hidden when the path is not under a mounted project.
4. **Retry with another provider.** Only when inference Phase 4 and CR R5 have landed. The row shows cost and a "leaves this machine" line, and is disabled in a privacy-locked project.

**AC**

- [x] 4.1 Copy as plain text contains no markdown syntax.
- [x] 4.2 A quoted selection arrives in the sent message as a blockquote, and can be removed before sending.
- [x] 4.3 Save writes a `.md` file into the project folder by default, and never outside a location the user picked.
- [x] 4.4 Reveal opens Finder at the file the agent wrote. It is hidden for paths Boundary cannot map to the host. *(From the Files line under a finished reply, per decision 4c, and from tool cards while a turn runs.)*

---

## Decisions to confirm

1. **Versions are in memory until CR R3.** Recommended. The alternative is Boundary persisting versions itself, which would make it own transcript state and would drift from WebUI.
2. **Branch text-only interim until CR R2.** Recommended. The alternative is waiting for R2 before shipping Branch.
3. **Channels get layout, time and Copy only in v1.** Recommended until channel posts live in the Hermes transcript.
4. **Where files the agent touched live after a turn.** Tool cards are progress (ADR 0006) and disappear when the turn ends, so Reveal / Copy path is only reachable mid-turn. Options: (a) keep it that way; (b) leave the last turn's tool cards visible, which revises 0006; (c) add a quiet "Files" line under the finished reply listing what the turn wrote, with Reveal / Copy path, and keep tool cards as progress. **Chosen: (c)** (30 Sep 2026).

## Test plan

- Unit tests (vitest), next to `src/main/services/assistant/hermes/__tests__/hermesChatSessions.test.ts`: mapping, truncate target, branch seed, capability detection.
- Visual check in the running app against the kit at 1000px and 1440px, in both themes, for each phase's states.
