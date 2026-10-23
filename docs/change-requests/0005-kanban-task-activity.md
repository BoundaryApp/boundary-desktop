# 0005 · Kanban task activity: what a worker is doing, an atomic stop, and filed task ids in history

**Serves:** [task activity spec](../kanban-activity-ux-study/spec.md) (Phases 1–3).
**Status:** Open

## Background

Boundary shows kanban work through the dashboard's kanban plugin (`plugins/kanban/dashboard/plugin_api.py`): the board, the `/events` WebSocket, per-task detail and the worker's log tail. Three gaps remain. Each has a working Boundary fallback, so none of them blocks anything. All three were checked against `hermes-agent v2026.9.14` in the stack's `hermes` container.

## R1 · The current tool in the heartbeat event (Wanted)

**Why:** the task page shows "now: …", the worker's current step. The only source today is the stdout log, so Boundary polls `GET /tasks/{id}/log` every 6 s per open task page (3 s with the console open) and takes the newest line. The pushed `heartbeat` event carries only an optional note (`heartbeat_worker`, `hermes_cli/kanban_db_dispatch.py:379`).

**Ask:** when the worker's activity stamp records a tool call, put the tool name and a short argument preview in the `heartbeat` event payload, for example `{ "tool": "terminal", "preview": "npm test" }` with the preview capped at about 80 characters and passed through the existing redaction. Keep the event's rate limit as it is.

**Acceptance:** while a worker runs a tool, the `/events` stream delivers a `heartbeat` event whose payload names the tool within one heartbeat interval of the call starting. A heartbeat with no tool in flight has no `tool` key.

**Boundary fallback:** `TaskPane.tsx` polls the log tail while the task runs and shows its last line. With R1, the strip reads the newest heartbeat instead, and the log is read only while the Console is open.

## R2 · Stop a run and hold the task, in one call (Wanted)

**Why:** "Stop run" must stop the task, not restart it. `POST /runs/{id}/terminate` is `reclaim_task` (`hermes_cli/kanban_db.py:2413`): it kills the worker and returns the task to its retry status, so the dispatcher starts it again. Boundary therefore sends two calls: terminate, then `PATCH /tasks/{id}` with `status: blocked`. A block sent that way is sticky (`_has_sticky_block`), so it holds. Between the two calls the task sits in `ready`, and a dispatcher tick in that gap can claim it and spawn a new worker. The same two-call pattern backs Boundary's runaway-run backstop (`stopOverlongRuns` in `hermesKanban.ts`).

**Ask:** an option on `POST /runs/{id}/terminate`, such as `{ "hold": true, "reason": "…" }`, that kills the worker and moves the task to a sticky `blocked` in the same transaction, recording the run's outcome as stopped by an operator (not `crashed` or `reclaimed`).

**Acceptance:** with `hold: true`, the task is `blocked` when the call returns, no dispatcher tick can claim it in between, and the run's outcome tells an operator stop from a crash.

**Boundary fallback:** `kanbanTaskAction` (`stop`) in `src/main/services/assistant/hermes/hermesKanban.ts` sends terminate, then the block. Boundary tells your stop from a crash by the reason it passes (`stopped from Boundary`, kept in the run's `error` as `manual_reclaim: …`). Both workarounds go once R2 lands.

## R3 · The filed task id in session history (Later)

**Why:** an agent files tasks with `kanban_create`, whose result is `{"ok": true, "task_id": …}` (`tools/kanban_tools.py`, `_handle_create`). Boundary renders those calls as live task cards in the conversation. `session.history` keeps a tool row's name and args but drops its result (`_history_to_messages`, `tui_gateway/session_history.py:181`), so after a reload the card has no task id.

**Ask:** for `kanban_create` rows, include the created `task_id` in the history projection (for example `"result": {"task_id": "t_…"}`), or include a short structured result for tools that declare one. Nothing else from the result is needed.

**Acceptance:** `session.history` for a session that filed a task returns that task's id on the tool row.

**Boundary fallback:** `matchFiledTasks` in `src/renderer/product/chat/kanbanActivity.ts` matches the card to the board task filed from the same session with the same title and assignee, created nearest the reply. Two same-titled tasks filed in one turn can swap cards.

## Notes

R1 and R2 are changes to Hermes's kanban code. R3 is a change to the TUI gateway. All three need either a patch carried by the stack or an upstream change.
