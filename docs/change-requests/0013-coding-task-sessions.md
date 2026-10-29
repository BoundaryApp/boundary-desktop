# 0013 · Coding task sessions: the OpenCode session id up front, and progress while a task runs

**Serves:** [coding task progress plan](../coding-task-progress-plan.md).
**Status:** Open

## Background

When Hermes delegates coding, `opencode-mcp` runs the work in an OpenCode session and Hermes blocks on `coding_wait_for_task` for up to `TASK_DEFAULT_TIMEOUT_SEC` (600 s). Nothing reaches a client during that wait: the task's `progress` snapshot is returned only in the final result. A user watching a chat sees a tool call and no change for ten minutes at a time.

Boundary already reads OpenCode's API on the loopback port (`GET /session/status` and `GET /session` for the busy check, change request 0003 R3). It can follow a task's OpenCode session through `GET /global/event` and backfill it with `GET /session/{id}/message`, both confirmed in OpenCode 1.17.6. What it can't do reliably is find the session. `coding_continue_task` returns `session_id`, but `coding_start_task`'s result doesn't include it, because `_worker` creates the session on a background thread after the tool has returned. `coding_get_task_status` reports it, but Hermes calls that only when it chooses to.

Today Boundary would have to match the session by title. `_worker` titles it `hermes-delegate-<first 8 characters of task_id>`, and OpenCode's `GET /session?directory=&search=` filters titles with `LIKE`. That title is an implementation detail of `opencode-mcp`, not a contract.

## R1 · Return the OpenCode session id from `coding_start_task` (Wanted)

**Why:** a client that sees the tool result should be able to follow the task's OpenCode session without guessing from its title.

**Ask:** create the OpenCode session in `coding_start_task` before returning (the `POST /session` call `_worker` makes now), and add `session_id` to the result next to `task_id` and the resolved `directory`, as `coding_continue_task` already does. On a failed session create, return `ok: false` with the error instead of starting the worker.

**Acceptance:** `coding_start_task` returns `{ ok: true, task_id, session_id, directory, status }`. `session_id` matches the `id` of a session in `GET /session?directory=<directory>` and the `session_id` that `coding_get_task_status` later reports.

**Boundary fallback:** a task started by `coding_continue_task` uses the `session_id` in that result. For one started by `coding_start_task`, on `tool.start` for `coding_wait_for_task` Boundary takes `task_id` from the tool's args and searches `GET /session?directory=<directory>&search=hermes-delegate-<task_id[:8]>`, where `directory` comes from the `coding_start_task` result in the same turn. If the search finds no session or more than one, Boundary shows the plain tool row it shows today. Until R1 lands, please keep that title format.

## R2 · Report progress during `coding_wait_for_task` (Later)

**Why:** clients that don't read OpenCode directly (Hermes WebUI, the CLI, a board worker's log) still see nothing during the wait.

**Ask:** while `coding_wait_for_task` blocks, send MCP progress notifications (`ctx.report_progress`) every poll or every 15 s at most, with a short message: the current OpenCode tool and its title (for example `bash: npm test`), or `writing` while text streams. No file contents or command output.

**Acceptance:** an MCP client that sends a `progressToken` with `coding_wait_for_task` receives at least one progress notification a minute while the task runs, and none after the result.

**Boundary fallback:** Boundary follows the OpenCode session itself (R1 fallback above), so it doesn't need R2. R2 matters only once Hermes passes MCP progress through to its own tool events, which is an upstream Hermes change.

## Notes

R1 and R2 are changes to `compose/opencode-mcp/server.py` in the stack. Neither touches OpenCode. The stack pins OpenCode at 1.17.6 from v0.3.5 (before that, `compose/opencode/Dockerfile` pulled `latest`). Boundary reads OpenCode's event and message shapes, so a change to that pin should go in the stack's changelog.
