# Backend notes: what Hermes exposes about kanban work

Checked against `nousresearch/hermes-agent v2026.9.14` as installed in the stack's `hermes` container (`/opt/hermes`), on 14 Oct 2026. Source only: no board database or session was read. No stack overlay touches kanban; `patch-gateway-liveness.py` (CR 0004) covers gateway sessions only.

## Why Boundary sees nothing today

| What Boundary watches | Why a kanban run never shows up there |
| --- | --- |
| `hermesRunningTurns.ts` (the working dot, the Chat icon dot) | It holds only turns Boundary submitted itself. The dispatcher starts workers, not Boundary. |
| Gateway turn events: `tool.start`, `status.update`, `turn.heartbeat`, `session.live_status` | These cover sessions held by the gateway (`_sessions`). A worker is a separate `hermes chat` subprocess, so `session.live_status` answers `idle` for it. |
| `session.list` (the chat lists) | `_LISTING_DENY_SOURCES = {"kanban", "tool"}` (`tui_gateway/methods_session.py:127`) hides worker sessions. The project tree drops them too. |

The only kanban-aware field in the gateway contract is `ProfileWorkerSession` on `profiles.list` (the profile's newest `kanban`/`tool` session and its `last_active`). It can say "this profile ran a worker recently". It cannot say which task, or whether the run is still alive.

## How a task runs

- **Dispatcher:** runs inside the default gateway (`gateway/kanban_watchers*.py`). Each tick it reclaims stale runs, promotes ready tasks, claims one (opening a `task_runs` row) and spawns a worker.
- **Worker:** a detached subprocess, `hermes -p <assignee> --cli … chat -q "work kanban task <id>"` (`hermes_cli/kanban_db_dispatch.py:2097`, `:2181`). Stdout goes to `kanban/logs/`. The env sets `HERMES_SESSION_SOURCE=kanban` (`:2245`), `HERMES_KANBAN_TASK` and `HERMES_KANBAN_RUN_ID`.
- **Session:** each run is an ordinary session in the assignee profile's `state.db`, source `kanban`. Its id is stamped on the run (`metadata.worker_session_id`) only when the run **completes**.
- **Heartbeat:** every activity stamp in the worker updates `tasks.last_heartbeat_at` and `task_runs.last_heartbeat_at`, extends the claim, and appends a rate-limited `heartbeat` event. The `kanban_heartbeat` tool can attach a note.
- **Steering:** comments added to a running task are injected into the worker's turn (`inject_new_comments_from_env`). So a comment box is a real "talk to the running task" control.
- **Blocking:**
  - `kanban_block(reason, kind)` takes `kind` ∈ `dependency | needs_input | capability | transient`.
  - `dependency` moves the task back to `todo`. The other kinds move it to `blocked`.
  - A task that blocks the same way too often goes to `triage`.
  - `kanban_request_review` moves it to `review`.
- **Result:** `kanban_complete(summary, result, …)` writes `task_runs.summary` and `tasks.result`, and emits `completed`.

Statuses: `triage, todo, scheduled, ready, running, blocked, review, done, archived`.
Run outcomes: `running, done, blocked, crashed, timed_out, failed, released`.

## The read surface Boundary should use: the dashboard kanban plugin

It is mounted at `/api/plugins/kanban/` on the dashboard (`127.0.0.1:9119`). Boundary already logs in to the dashboard and mints WebSocket tickets (`hermesDashboardAuth.ts`). The routes below are checked in `plugins/kanban/dashboard/plugin_api.py`.

| Route | Line | Gives |
| --- | --- | --- |
| `GET /board?board=` | 321 | Columns of tasks. Each task carries its age, a `latest_summary` preview, link and comment counts, progress and diagnostics. Also `latest_event_id`, the cursor for `/events`. |
| `GET /tasks/{id}` | 341 | `task, comments, events, attachments, links, child_results, runs` |
| `GET /workers/active` | 867 | Each live run: `run_id, task_id, task_title, task_assignee, profile, started_at, last_heartbeat_at, claim_expires, max_runtime_seconds` |
| `GET /runs/{id}/inspect` | 890 | Process stats (CPU, memory) for a run |
| `GET /tasks/{id}/log?tail=` | 1194 | Tail of the worker's stdout |
| `POST /tasks/{id}/comments` | 749 | Add a comment. A running worker picks it up. |
| `POST /runs/{id}/terminate` | 932 | Stop a run |
| `POST /tasks/{id}/reclaim` | 955 | Release a stuck claim so the task runs again |
| `PATCH /tasks/{id}` | 642 | Change status, assignee and other fields (used for unblock) |
| `WS /events?since=&board=` | 1693 | Pushes `{events:[{id, task_id, run_id, kind, payload, created_at}], cursor}`. The server polls `task_events` every 300 ms. Auth uses `?ticket=`. |

**Event kinds** include `created, claimed, spawned, heartbeat, status, completed, blocked, unblocked, dependency_wait, crashed, timed_out, gave_up, reclaimed, stale, commented, assigned, review_requested, changes_requested, archived, linked`.

## Gaps

1. **No token- or tool-level stream for a worker.** What Boundary can show is:
   - heartbeat freshness (is it alive),
   - the event timeline (what stage it is at),
   - the stdout tail (what it is doing, in the CLI's own words).

   The tail has to be polled. A small stack change could add the current tool name to the `heartbeat` event payload; that is candidate CR 0005 (see spec, Phase 3).
2. **No live task → session link.** The worker session id appears only after completion. A "View transcript" link can only exist on finished runs, and it opens a session the lists deliberately hide.
3. **Event payloads and the stdout tail carry worker-authored text** (block reasons, summaries, tool output). Boundary may show them to the owner, but must keep them out of its debug logs and telemetry.
