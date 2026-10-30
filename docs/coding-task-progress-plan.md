# Coding task progress build plan

- Date: 2026-10-27
- Status: Proposed
- Change request: [0013](change-requests/0013-coding-task-sessions.md)
- Related: [ADR 0028](adr/0028-coding-folders.md) (coding folders), [task activity spec](kanban-activity-ux-study/spec.md)

## Goal

While Hermes waits on a coding task, the chat shows what OpenCode is doing: how long it has run, when it last did something, the step it is on, and its text as it writes. A user who has waited eight minutes can tell a working task from a stuck one without opening the OpenCode WebUI.

## What the user sees today

Hermes calls `coding_start_task`, then `coding_wait_for_task`, which blocks for up to 600 s per call and returns only when the task ends or the wait times out. The chat shows the tool card for `coding_wait_for_task` and nothing else. `opencode-mcp` keeps a 500-character `progress` snapshot, but Hermes sees it only in the final result.

## How it fits together

```
Hermes gateway (/api/ws)                       OpenCode (127.0.0.1:4096, basic auth)
  tool.complete coding_start_task  ──► task_id, directory
  tool.start coding_wait_for_task  ──► task_id
                                     │
                     find session    ├─► GET /session?directory=D&search=hermes-delegate-<id8>
                                     │     (or session_id from the result once 0013 R1 lands)
                     backfill        ├─► GET /session/{id}/message?directory=D&limit=20
                     follow          └─► GET /global/event   (one stream, filtered by sessionID)
                                             │
main: openCodeTaskWatch  ──► 'hermes-chat:coding-progress' ──► renderer: progress panel in the ToolCard
```

## OpenCode API (confirmed in 1.17.6)

Checked against the `/doc` OpenAPI spec served by the running 1.17.6 container and the `v1.17.6` source (`session/processor.ts`, `session/session.ts`, `event-v2-bridge.ts`, `server/routes/instance/httpapi/handlers/event.ts` and `global.ts`).

- **`GET /global/event`** is a server-sent event stream for every directory. Each event is `{ directory, project, workspace, payload: { id, type, properties } }`. It sends `server.connected` first and `server.heartbeat` every 10 s. It doesn't replay: a subscriber gets only events published after it connects. `GET /event?directory=D` is the same stream filtered to one directory, without the wrapper.
- **Session events published on every prompt.** `session.updatePart` publishes `message.part.updated` `{ sessionID, part, time }`. `session.updatePartDelta` publishes `message.part.delta` `{ sessionID, messageID, partID, field, delta }` for streamed text. `session.status` carries `{ sessionID, status: { type: 'idle' | 'busy' | 'retry', … } }`, and `session.idle` and `session.error` follow. The `session.next.*` events also exist, but some are published only behind OpenCode's experimental event flag. Boundary uses the stable events above.
- **Parts.** A `ToolPart` has `tool`, `callID` and `state`, where `state.status` is `pending`, `running` (`input`, optional `title`, `time.start`), `completed` (`title`, `output`) or `error` (`error`). A `TextPart` has `text`. Other part types (`step-start`, `step-finish`, `reasoning`, `patch` and so on) are counted as activity but not shown.
- **Waiting on the user.** `permission.asked` and `question.asked` exist. The stack's OpenCode config allows every permission and denies `question` for headless use, so a delegated session shouldn't stop on them. Boundary still shows them as "waiting for permission" in case a local config differs.
- **Lookup and backfill.** `GET /session` lists the sessions of the project for `directory` (default: the server's working folder), and `search` is a `LIKE` on the title. `GET /session/{id}/message` takes `directory`, `limit` and `before`.

## Phases

Each phase lands as its own commits and passes `bun run test` and the type check before the next starts. Each phase ends with a short checklist for in-app testing.

### Phase 1: follow a task's session (main process only)

1. **Confirm the Hermes side.** Before writing code, confirm in the pinned Hermes image which field of `tool.complete` carries an MCP tool's JSON result (`result` or `result_text`), and the exact tool names Hermes gives the `opencode` MCP server's tools. `isCodingAgentTool` (codingAgentBusy.ts) already matches the names by suffix.
2. **Session finder.** `coding/openCodeSessions.ts` resolves a task to `{ sessionId, directory }`. It takes the `session_id` from a `coding_continue_task` or (after 0013 R1) `coding_start_task` result, or otherwise does the title search. More than one match, or none, means no panel. It reuses the credential and port resolution in codingAgentBusy.ts.
3. **One event stream.** `coding/openCodeEvents.ts` opens `GET /global/event` while at least one task is followed, and closes it when none is. It drops events for other sessions before parsing their parts. It redials with backoff. A heartbeat missed for 30 s counts as a dropped stream. After each (re)connect it backfills from `GET /session/{id}/message` so nothing between connect and the first event is lost.
4. **Watch state.** `coding/openCodeTaskWatch.ts` keeps per task: started, last activity, the current tool (`tool` plus `state.title` or a short form of `input`), status (`busy`, `retry` with its message, `waiting`, `idle`, `error`), and the last 4 KB of streamed text. It sends `hermes-chat:coding-progress` to the turn's window at most every 500 ms. It stops on `session.idle`, on the turn ending, or when `coding_wait_for_task` completes.
5. **Wire it to turns.** In hermesChatSessions.ts, the `tool.start` and `tool.complete` handlers for coding tools start and stop the watch.

Tests use fake OpenCode responses and a fake SSE body under fixtures, with made-up sessions and text, and fake timers for heartbeats and throttling.

### Phase 2: the progress panel in the chat

1. While a coding tool runs, `ToolCard` (ToolCards.tsx) shows a panel under it:
   - **First line:** `OpenCode · Working · 6m · last activity 4s ago · now: bash npm test`.
   - **Waiting:** "waiting for permission" or "retrying: <message>" in place of the current step.
   - **Text:** a collapsed **Output** disclosure with the streamed text, which follows the end while open.
   - **Link:** an **Open in OpenCode** link to the session in the OpenCode WebUI.
2. "Last activity" turns amber after 3 minutes without an event, the same threshold as the task activity strip.
3. When the tool completes, the panel collapses to one line: duration and the last step.
4. The panel shows only for turns this window started. A chat reopened mid-task has no `tool.start` to start from, and gets the panel in Phase 3.

### Phase 3: reopened chats and board tasks

1. **Reopened chats.** When a chat opens with a running turn whose last tool is a coding tool (`runningTurnToolNames`), find the busy `hermes-delegate-` sessions in `GET /session/status` and follow one if exactly one matches the turn's directory.
2. **Board tasks.** A board worker's turns run in the worker container, so Boundary sees no `tool.start` for them. Once change request 0005 R1 reports the current tool in heartbeats, the task page shows the same panel for a task whose current tool is a coding tool, found the same way.

## Privacy and logging

The panel shows the user their own OpenCode session, the same content the OpenCode WebUI shows them. The debug log gets metadata only: task id, session id, tool name and status. No text, tool input or output. Fixtures are synthetic.

## Stack contract

When Phase 1 lands, add these rows to [stack-contract.md](stack-contract.md):

- **HTTP:** `GET /global/event` (OpenCode), the events and part fields listed above, used in openCodeEvents.ts.
- **HTTP:** `GET /session` with `directory` and `search`, and `GET /session/{id}/message` (OpenCode), used in openCodeSessions.ts.
- **Tools:** `coding_start_task`, `coding_continue_task` and `coding_wait_for_task` args and results (`task_id`, `directory`, `session_id`), and the `hermes-delegate-<task_id[:8]>` session title until 0013 R1 lands.

A `test:stack` case can check the read-only parts: `/global/event` sends `server.connected` and the `/doc` spec still has the event and part shapes above. Following a real task needs a model call and writes a session into OpenCode, so it stays a manual flow: start a coding task in a chat and watch the panel.

## Dependencies

- **OpenCode pin.** The stack pins OpenCode at 1.17.6 from v0.3.5, and Boundary pins v0.3.7, so a rebuild no longer moves the API. A local stack can still run a newer OpenCode, so treat any shape that doesn't parse as "no panel".
- **Change request 0013 R1** replaces the title search. Phase 1 doesn't wait for it.

## Open questions

- `codingAgentBusy` calls `GET /session/status` and `GET /session` without `directory`. In 1.17.6 both answer for one OpenCode instance, and the instance comes from `directory` (default: the server's working folder): session status is per-instance state, and the session list is filtered to the instance's project. So the busy check may miss an OpenCode session running in another coding folder. It still catches a chat turn waiting on a coding tool. Confirm this while building Phase 1. If it holds, the busy check should ask per coding folder, or follow `session.status` on `/global/event`. Phase 3's lookup for reopened chats needs `directory` for the same reason.
