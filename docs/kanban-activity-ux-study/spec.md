# Task activity: living spec

The visual source is [01-task-activity.html](01-task-activity.html). Backend facts come from [backend-notes.md](backend-notes.md).

| | |
| --- | --- |
| Status | Accepted 14 Oct 2026; Phases 1 and 2 shipped; Phase 3 built |
| Visuals | [index.html](index.html), [01-task-activity.html](01-task-activity.html) |
| Backend | [backend-notes.md](backend-notes.md) (checked against `hermes-agent v2026.9.14`) |
| Started | 14 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Kanban feed, working-now signals, task page | Shipped 14 Oct 2026 | — |
| 2 Tasks list, task cards in the DM | Shipped 17 Oct 2026 | 1 |
| 3 Steer, unblock, stop, notifications | Built; live check pending | 1 |

## The problem

You ask the Orchestrator for something long. It files kanban tasks and replies "on it". From then on Boundary shows nothing. The dispatcher runs each task as a separate `hermes chat` process. Boundary can't see that process: its working dot tracks only turns it started, and the chat lists hide `kanban` sessions (see [backend-notes.md](backend-notes.md)). LM Studio shows the model busy, so the only clue that work is happening comes from outside the app.

A person handing work to an agent needs four answers, in this order:

1. **Is anything working right now?** You should see this from any screen, without opening anything.
2. **What is it working on, and where did it come from?** Name the task, the agent and the conversation that asked for it.
3. **Is it actually making progress, or stuck?** Show liveness, the current step and the latest output.
4. **Does it need me?** Surface a question, a review or a failure, and make the action one click.

## Goal

Every running kanban task is visible from anywhere in the app, opens in one click to a page that shows it is alive, what it is doing and what it produced, and pulls you in only when it needs you. Hermes's board stays the source of truth. Boundary stores nothing but a cursor and which notifications you have seen.

## Non-goals

- **A drag-and-drop board.** Hermes's dashboard already has one (`/kanban`). Boundary links to it for bulk triage instead of rebuilding columns.
- **Creating or editing tasks by hand.** The Orchestrator files tasks from chat. A "New task" form can come later.
- **Live token streaming from workers.** No such stream exists (backend gap 1).
- **Worker transcripts in the chat lists.** Workers are not conversations. A finished run links to its transcript from the task page only.

## The layered answer

| Question | Surface | Where |
| --- | --- | --- |
| Is anything working? | Working dot on the Chat icon (already exists, now fed by worker runs). A **Working now** section at the top of the chat rail, one row per running task. A working dot on the assignee's DM row. | Rail, everywhere |
| What is it, where from? | **Task cards** in the conversation that filed them (the `kanban_create` tool call renders as a live card). The task page header names the agent, the workspace and "Filed in *Orchestrator DM*". | Transcript, task page |
| Is it progressing? | The task page **liveness strip**: "Working · 14m · last activity 6s ago · now: running `npm test`". It turns amber when quiet past a threshold and red when the run crashes or times out. Below it, the **activity timeline** (events and comments) and a **Console** disclosure with the stdout tail. | Task page |
| Does it need me? | A **Needs you** group at the top of the rail and the Tasks list, with an amber count on the Tasks row. On the task page, a needs-input card styled like `ApprovalInterrupt`. An OS notification when the app is in the background. | Rail, task page, OS |

## Thin-wrapper map

| Need | Hermes provides | Boundary adds |
| --- | --- | --- |
| Live board state | `GET /board` to seed, then `WS /events?since=<cursor>` | `hermesKanban.ts` in main: one connection, reconnect with a fresh ticket, broadcast to windows (as `hermesRunningTurns.ts` does). |
| Running workers | `GET /workers/active` (`last_heartbeat_at`, `started_at`) | A refetch on `claimed`/`spawned`/`completed`/`crashed` events and every 20 s while any run is live. Liveness is computed from `last_heartbeat_at`. |
| Task page | `GET /tasks/{id}` (events, runs, comments, result) | The page itself. It merges events and comments into one timeline and hides `heartbeat` events except those carrying a note. |
| Console | `GET /tasks/{id}/log?tail=200` | Polls every 3 s only while the Console is open and the run is live. The view follows the tail. |
| Steer | `POST /tasks/{id}/comments` (injected into the running worker) | The composer on the task page, labelled for what it does. |
| Unblock / review | `POST …/comments` + `PATCH /tasks/{id}` (status → `ready`) | A needs-input card: **Reply and resume**, **Mark done**, **Open in board**. |
| Stop / retry | `POST /runs/{id}/terminate`, `POST /tasks/{id}/reclaim` | A run menu in the page header. Stop asks for confirmation. |
| Origin link | `tasks.session_id` (the session that created the task) | "Filed in …" in the header, and task cards in that transcript matched by task id from the `kanban_create` tool result. |

## Decisions (confirm before Phase 1)

1. **The task page lives in the center pane** (a new `centerMode: 'task'`, like `mentions` and `project`), not in the right inspector. The console and the timeline need the full 720 px column. The inspector would cramp them and fight with the conversation it sits beside. *Recommended.*
2. **The Tasks list is a grouped list, not columns.** The groups are **Needs you** (blocked, review, triage), **Running**, **Up next** (ready, todo, scheduled) and **Done** (the last 7 days). This matches the chat workbench's centered column (ADR 0020) and answers "what's happening" before "what's on the board". An **Open board** link goes to the Hermes dashboard for drag-and-drop. *Recommended over* a column board in Boundary.
3. **Working now sits in the rail and only appears while something runs.** It is capped at 3 rows plus "+N more", above Hermes chats. When nothing runs it takes no space. *Recommended over* a permanent "Tasks" section, which would be empty most of the time.
4. **Quiet thresholds:** "last activity" turns amber after 3 min without a heartbeat and red at `claim_expires`. The dispatcher reclaims a run then anyway. These mirror CR 0004's turn-liveness reasoning (one long local-model call can be silent for minutes).
5. **The console is collapsed by default, with its newest line promoted into the liveness strip ("now: …").** You get LM Studio's "it's doing something" at a glance without a wall of logs. *Recommended over* an always-open console.
6. **Notifications:** *needs you* (blocked with `needs_input`, review requested, crashed or gave up) always notifies when the app is in the background. *Done* notifies only for tasks filed in a conversation you sent from in the last 24 h. Clicking a notification opens the task page.

---

## Phase 1 · Kanban feed, working-now signals, task page

**Where:**
- new `src/main/services/assistant/hermes/hermesKanban.ts` (+ IPC in `hermesChatIpc.ts`)
- new `src/renderer/product/chat/kanbanActivity.ts` (a store like `runningTurns.ts`)
- `ChatRail.tsx`, `ProductIconRail.tsx`
- new `TaskPane.tsx`
- `WorkbenchChatScreen.tsx` (center mode)
- `workbench.css`

1. **Feed (main):**
   - Seed with `GET /board`, then open `WS /events?since=<latest_event_id>` with a ticket from `hermesDashboardAuth`.
   - On close, back off and reconnect with a fresh ticket from the last cursor.
   - Keep `{tasks by id, active runs}` in memory and broadcast a slim summary to windows: `id, title, status, assignee, workspace_path, session_id, started_at, last_heartbeat_at, block_kind`.
   - **No bodies, results or log text in the broadcast.** The renderer fetches those per task on demand.
2. **Feed off when there's no board:** if the plugin route answers 404 (an older stack, or the plugin disabled), the feed stays off and every surface below renders nothing.
3. **Signals:**
   - `ProductIconRail` shows its dot when a chat turn **or** a worker run is live.
   - `ChatRail` gains **Working now** (decision 3) and a **Tasks** nav row beside All chats and Mentions. The row shows a running count and an amber needs-you count.
   - DM rows show the working dot while that agent's profile has a live run, with the tooltip "Working on *title*".
4. **Task page** (`centerMode: 'task'`, `taskId`):
   - **Header:** title, status pill, assignee, workspace path (opens the folder), "Filed in *conversation*" (links back), elapsed time.
   - **Liveness strip** (decision 4).
   - **Body:** what done looks like (the task body), the activity timeline, Console (decision 5) and, when done, the Result (the summary plus files written).
   - **Earlier runs:** a "Run 2 of 2" switcher when there is more than one run.
5. **Privacy:** nothing from bodies, summaries, events or logs reaches `console.*`, the debug log files or telemetry. Log ids and statuses only.

**Acceptance**
- [x] 1.1 A task the dispatcher starts while Boundary is open shows in Working now and on the Chat icon within 2 s of its `spawned` event.
- [x] 1.2 Clicking a Working now row opens the task page. The strip's "last activity" updates at least every 30 s while the worker runs.
- [x] 1.3 A worker silent for 3 min turns the strip amber, and a crashed or timed-out run turns it red with Retry.
- [x] 1.4 Killing and restarting the dashboard reconnects the feed with no missed events (cursor resume).
- [ ] 1.5 With the kanban plugin absent, no errors repeat in the log and no Tasks UI appears.
- [x] 1.6 Grep of the debug log after a run finds no task body, summary or log text.

## Phase 2 · Tasks list, task cards in the DM

1. **Tasks list** (`centerMode: 'tasks'`): decision 2's groups, filtered by the rail's project (a task belongs to a project when its `workspace_path` sits inside the project's folder). It has an "All projects" toggle and **Open board**.
2. **Task cards:** in any transcript, a `kanban_create` tool call whose result holds a task id renders as a compact card (title, assignee, live status) instead of a raw tool row. Clicking it opens the task page. Several creates in one turn stack into one card group, "3 tasks filed".
3. **Finished line:** when a task filed in a conversation finishes, that conversation shows a quiet marker on its next open: "*Audit licenses* finished · View result". It is rendered from the feed, not posted into the chat.

**Acceptance**
- [x] 2.1 Tasks list group counts match `GET /board`, and a status change moves a row within 2 s.
- [x] 2.2 The Orchestrator DM shows a live card for each task it filed, and the card's status matches the task page.
- [x] 2.3 Reloading the DM keeps the cards (they come from the tool rows, not local state).

## Phase 3 · Steer, unblock, stop, notifications

1. **Composer on the task page:** the placeholder reads "Add a note for the worker. It reads it at its next step." It posts a comment. While no run is live, the button reads **Comment**.
2. **Needs-input card** (styled like `ApprovalInterrupt`): shows the block reason, a reply box, **Reply and resume** (comment, then `PATCH status=ready`), **Mark done**, and **Open in board**. Review requests get **Approve** and **Request changes**.
3. **Run menu:** **Stop run** (confirm, `terminate`), **Retry** (`reclaim`), **Open in board**.
4. **Notifications** per decision 6, through Electron `Notification`. The body is the task title and state only, never the block reason.
5. **Candidate CR 0005** (stack): put the current tool name and a short argument preview in the `heartbeat` event payload, so "now: …" can come from the push feed instead of polling the log.

**Acceptance**
- [ ] 3.1 A comment sent while a worker runs appears in the timeline and the worker acknowledges it (seen in the console) within one step.
- [ ] 3.2 Reply and resume on a `needs_input` block moves the task to `ready`, and the dispatcher picks it up.
- [ ] 3.3 Stop asks first. After it, the run shows "Stopped by you", not "Crashed".
- [ ] 3.4 A background block raises one notification, and clicking it opens that task.
