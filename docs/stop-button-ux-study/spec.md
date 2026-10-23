# Run control: living spec

The visual source is this kit: **A · Morph** in [01-run-control.html](01-run-control.html). Backend facts come from [backend-notes.md](backend-notes.md).

| | |
| --- | --- |
| Status | Proposed, awaiting review |
| Visuals | [index.html](index.html), [01-run-control.html](01-run-control.html) (variant A Morph) |
| Backend | [backend-notes.md](backend-notes.md) (checked against `hermes-agent v2026.9.14`) |
| Started | 1 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Run button, Stop markers, Continue | Built; live check pending | — |
| 2 Enter mid-run: Send now, Queue, Always queue | Not started | 1 |
| 3 Add to this run (steer) | Not started; spike first | 2 |

## Goal

Stop appears only while an agent is working. It sits in the same corner as Send, so that spot always holds the one action that matters right now. Typing while the agent works is safe: you choose whether your message interrupts the run, joins it, or waits for it. Hermes's record stays the source of truth. The desktop owns only what Hermes can't: the editable queue, and a local note of how each reply ended.

## Non-goals

- **Stop all in channels** and a per-member Stop on each running reply. These belong to the separate channel investigation. The one constraint from it is already met: the queue is stored per session.
- Reordering the queue by drag, and syncing a queue across devices or to WebUI.
- Token-exact resume. Continue is a new turn that reads the saved partial (see [backend-notes.md](backend-notes.md)).
- Hermes's own redirect (`busy_input_mode: interrupt`). Send now is a clean interrupt plus a new turn instead (decision 1).
- Changing approval behavior. Stop during an approval still denies it, per ADR 0006.

## Thin-wrapper map

| Need | Hermes provides | Boundary adds |
| --- | --- | --- |
| Stop | `session.interrupt`. The partial is saved, the server queue is cleared, approvals are denied. | The run button, the "Stopped" marker, and a local note of how the reply ended. |
| Continue | `prompt.submit` with `display_kind: "hidden"` | A fixed continue instruction and a reply-only run (no user bubble). |
| Send now | `session.interrupt`, then `prompt.submit` | Waits for Hermes to confirm the turn ended, then sends. Adds the "Interrupted" marker. |
| Queue | `prompt.submit` with `queued: true` (drain-safe) | The queue itself: chips, edit and remove, pausing on Stop, draining on completion, Always queue. |
| Add to this run | `session.steer`. Accepted means `queued` (lands at the next tool boundary), otherwise `rejected` or 4010. A leftover steer becomes the next user turn on its own. | The steer chip inside the running reply, a fallback to Queue, and **attaching to a turn Hermes started on its own** (Phase 3). |

## Decisions (confirm before Phase 1)

1. **Send now = interrupt, then a new turn. Not Hermes's redirect.** The chat runs on assistant-ui's LocalRuntime, which handles one run at a time. A redirect keeps the old turn alive and pushes your message inside it, which LocalRuntime can't show cleanly. Interrupting first gives a clean transcript: partial reply (Interrupted), your message, new reply. The agent still sees its partial, because Hermes saves it on interrupt. *Recommended.*
2. **The queue is per chat and survives switching chats.** It is held above the runtime mount and keyed by session id. It drains only while that chat is open. If you leave mid-run, the queue waits and the chip says "Sends when you return". *Recommended over* draining in the background from main: that would send messages you can't see, and they would only appear on reload.
3. **Remember how a reply ended across reloads.** Hermes saves the partial text but not why it stopped, so a reload would drop the markers. Store `{sessionId, rowId} → 'stopped' | 'interrupted' | 'stopped-empty'` in the main store (`hermesAgentStore`), next to `sessionSpeakers`. *Recommended:* it's small and contains no message text.
4. **Menu order and keys:** **Send now** ⌘↵ · **Add to this run** ⌥↵ · **Queue** ↵ (default, highlighted) · **Keep editing** Esc. The rows run from most to least disruptive. The shortcuts also work with the menu closed, so ⌘↵ mid-run always sends now and ⌥↵ always adds.
5. **Continue adds a new reply directly under the stopped one**, with no user bubble. Merging it into the same message would need a resumable run in LocalRuntime; Phase 1's spike checks whether `startRun` can take an assistant parent. *Fallback:* a visible "Continue" prompt.

---

## Phase 1 · Run button, Stop markers, Continue

**Where:** `WorkbenchThread.tsx` (composer, about lines 1073–1250), `workbench.css` (`.wb-stop`, `.wb-composer`), `hermesChatModelAdapter.ts`, `hermesChatSessions.ts` (cancel), `MessageActions.tsx` (reply footer), `hermesAgentStore.ts` (markers).

1. **Remove `.wb-stop`** from the cluster. Add a `RunButton` inside the textarea's bottom-right corner, with `textarea` padding-right to clear it. It is one element whose glyph and label change, so keyboard focus survives the switch:
   - idle, empty → Send, dimmed, `aria-disabled`.
   - idle, typed → Send, solid. Clicking sends (the composer gains a Send button it never had).
   - running (`thread.isRunning`) → Stop ■, with a ring tracing around it.
   - approval pending → Stop, ring paused and amber. Tooltip: "Stop · denies the pending request".
   - restarting, connecting, offline prompt → hidden (nothing to stop, can't send).
2. **Double-click guard:** ignore Stop for 350 ms after the send that started the run.
3. **Esc precedence:** the mid-run menu (Phase 2) closes first, then the mention list, then the selection-quote popover. Only when none is open does Esc stop a run. Esc stops only from inside the chat pane (composer or transcript), never from sheets or Settings. This extends the existing handler at `WorkbenchThread.tsx:707`.
4. **Reduced motion:** no ring spin, no glyph crossfade.
5. **How a reply ended:** the adapter records a reason when it aborts (`stopped`, or `interrupted` from Phase 2). If the reply has no text yet, it records `stopped-empty`. Reasons are kept in a context alongside the server path and persisted per decision 3 once the reply's `rowId` is known (refreshed from `session.history`, as Edit already does).
6. **Markers under the reply** (replacing the hover footer's resting state for that message):
   - **Stopped by you** · elapsed · **Continue** · **Retry**: a grey square glyph, neutral text.
   - **Stopped before Hermes replied** · **Retry**: no body; the empty sentinel is never shown.
   - **Interrupted by your next message** (Phase 2): a ↳ glyph, no Continue (the conversation has moved on), reply text ending in a fade. Retry stays in the normal hover row.
7. **Continue:** a reply-only run. The adapter sees a `continue` intent and asks main to `prompt.submit` a fixed instruction ("Continue from where you stopped. Do not repeat what you already wrote.") with `display_kind: "hidden"`. **Spike:** can `runtime.thread.startRun({ parentId: <stopped reply id> })` add an assistant message under an assistant parent without breaking the server path? If not, use decision 5's fallback.
8. **Main cancel waits for Hermes.** `handleHermesChatCancel` resolves once `message.complete` arrives with `status: "interrupted"`, or after 3 s. Today `endOnce('cancel')` fires immediately, which Phase 2's Send now can't rely on.
9. **ADR 0022 · Run control in the composer** (Proposed). It supersedes the "always shows … Stop" clause of ADR 0004 and leaves ADR 0006's "Stop still cancels" unchanged.

**Acceptance**

- [x] 1.1 No Stop control is visible while idle, anywhere in the chat.
- [x] 1.2 Send and Stop occupy the same spot. Starting or ending a run moves nothing else in the composer.
- [x] 1.3 Esc stops a run only when no menu or popover is open. Esc in a mention list only closes the list.
- [x] 1.4 A double-click on Send never stops the run it started.
- [x] 1.5 A stopped reply shows "Stopped by you" with Continue (Retry in the reply row). A stop before any text shows "Stopped before Hermes replied".
- [ ] 1.6 Continue produces a reply that picks up from the partial, with no user bubble. *(Live Hermes.)*
- [ ] 1.7 Markers survive a reload. *(Live Hermes.)*
- [ ] 1.8 Stop during an approval denies it (unchanged), and the tooltip says so.
- [x] 1.9 Screen readers hear "Send message" or "Stop response", and "Response stopped" after a stop.

## Phase 2 · Enter mid-run: Send now, Queue, Always queue

**Where:** `WorkbenchThread.tsx` (key handling, menu, queue chips), a new `runQueue.ts` store (decision 2), `ProductSettingsScreen.tsx` (a new **Chat** section), `hermesAgentStore.ts` and IPC (`chatPrefs`), `hermesChatSessions.ts` (`queued` flag).

1. **Enter with text while running** opens the menu above the run button: Send now, Queue, Keep editing. Add to this run arrives in Phase 3, and its row is hidden until then. Queue is preselected, so Enter twice queues. Arrow keys move the selection. Clicking outside closes the menu and keeps the draft.
2. **If the run ends while the menu is open,** the menu closes, the draft stays, and the next Enter sends.
3. **Send now:** abort with reason `interrupted`, wait for Phase 1.8's confirmation, then append the draft through the runtime (a normal send). The old reply gets the Interrupted marker.
4. **Queue:** the draft becomes a dashed chip above the input ("Next", then "Queued 2"…), each chip with **Edit** (back to the composer) and **×**. When a run completes (status `complete`) and the chat is open, the head is sent through the runtime with `queued: true`. Main keeps listening when `prompt.submit` returns `status: "queued"` instead of treating the turn as started.
5. **Stop pauses the queue.** Chips turn solid amber ("Paused") and the head gains **Send now**. Stop never sends or deletes queued messages. Sending a new message by hand while paused leaves the queue paused.
6. **Leaving the chat mid-run** (decision 2): the chips read "Sends when you return". On return, an idle chat drains immediately.
7. **Always queue:** a footer checkbox in the menu, "Always queue · don't ask", plus **Settings → Chat → "When you send while an agent is replying": Ask each time / Always queue**. With Always queue on, Enter mid-run queues directly and announces "Queued". ⌘↵ still sends now, and queue chips gain **Send now** (and **Add to this run** after Phase 3), so nothing is lost by turning the menu off.
8. **Where it applies:**
   - **DMs:** everything.
   - **Channels:** Queue and Send now act on the session your message addresses. A channel wake that addressed several members is one run, so Stop ends that wake only. Add to this run is hidden in channels.
   - **HTTP-fallback threads:** Queue and Send now only.

**Acceptance**

- [ ] 2.1 Enter mid-run never sends immediately unless you choose Send now (by menu or ⌘↵).
- [ ] 2.2 Pressing Enter twice queues and never interrupts.
- [ ] 2.3 Queued messages send in order, each after the previous reply completes.
- [ ] 2.4 Stop pauses the queue and loses nothing. Send now on a paused chip sends it.
- [ ] 2.5 Switching chats keeps each chat's queue, and it drains on return.
- [ ] 2.6 The Always queue choice persists across restarts and can be changed in Settings.
- [ ] 2.7 After Send now, the agent's next reply shows it saw the partial. *(Live Hermes.)*
- [ ] 2.8 The Interrupted and Stopped markers are visually distinct (glyph, wording, Continue only on Stopped).

## Phase 3 · Add to this run (steer)

**Spike first (½ day, live Hermes):**

- **Reload view.** How does an accepted steer appear in `session.history` after a reload? Hermes injects it as a standalone user row after the newest tool result; check whether the desktop shows it as a user bubble in the middle of a reply.
- **Leftover steers.** A steer that lands after the last tool step is re-queued by Hermes and **runs as a new turn the desktop didn't start**. Today no client run is listening for it, so it would only appear after a reload. Prototype an **attach run**: the adapter opens a run that listens without submitting. Then check how main can tell this happened, either by comparing history after `message.complete` or by seeing `message.delta` for a session with no active run.

**Build (after the spike):**

1. **Menu row and ⌥↵:** "Add to this run · Hermes reads it after its current step". Shown only on gateway DMs while running.
2. **IPC `hermes-chat:steer`** calls `session.steer`.
   - `queued` (accepted): add a "You added: …" chip inside the running reply, at the point it was sent.
   - `rejected` or 4010: queue it instead, with a notice: "Hermes couldn't take that mid-run, so it's queued."
3. **Leftover steer:** use the spike's attach mechanism. The steer text appears as a user turn, followed by Hermes's reply.
4. **Queue chips** gain **Add to this run** while a run is active.

**Acceptance**

- [ ] 3.1 An added message reaches the agent without stopping the run, and the reply reflects it. *(Live Hermes.)*
- [ ] 3.2 A steer that arrives too late still gets a visible reply without a reload. *(Live Hermes.)*
- [ ] 3.3 A rejected steer is queued, never dropped.
- [ ] 3.4 After a reload, the steered text appears once, in a sensible place. *(Live Hermes.)*

---

## Verification

- **Unit tests** (vitest, existing suites):
  - run-button states and the Esc precedence table.
  - the 350 ms guard.
  - `runQueue` (order, pause, per-session, drain-on-return).
  - adapter abort reasons.
  - main cancel waiting for `interrupted` (with a stubbed gateway).
  - steer status handling.
  - `chatPrefs` persistence.
- **Browser harness** (`renderer-harness`, stubbed IPC) walk-throughs per phase, in dark and light, at narrow widths.
- **Live Hermes checks** are the items marked *(Live Hermes)*. They are listed here so they aren't forgotten, as happened in the message-actions Phase 2.
- Update existing tests that look for the old Stop button (`WorkbenchChatScreen.test.tsx`).

## Risks

- **LocalRuntime is single-run.** Send now and draining the queue need the previous run to end fully before the next send. Phase 1.8 (cancel waits for Hermes) is the guard.
- **Turns Hermes starts on its own** (leftover steers, and any server-side drain) are invisible to the desktop today. Phase 3's spike owns this. If the attach run doesn't pan out, Add to this run ships only while a tool is running, when a steer is sure to be consumed.
- **Marker persistence needs a `rowId` for each reply.** It reuses Edit's history refresh. Until then, a marker lives only in memory.
