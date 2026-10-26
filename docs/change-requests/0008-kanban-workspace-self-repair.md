# 0008 · Kanban workspaces: refuse what can't start, and let agents repair a stuck task

**Serves:** [task activity spec](../kanban-activity-ux-study/spec.md) (Phase 3, the Gave up card).
**Status:** R1–R3 delivered (v0.3.3) · R4 delivered (comment in v0.3.3, wake in v0.3.4; Boundary's background resume not started) · R5 declined

## Background

Task `t_5727c92a` was filed on 2026-10-14 by an orchestrator worker with `kanban_create(workspace_kind="worktree")` and no `workspace_path` or project. Board `default` has no `default_workdir`. Every time the task is unblocked, the dispatcher claims it, `_resolve_worktree_workspace` (`hermes_cli/kanban_db_workspace.py:715`) raises

> workspace: task t_5727c92a has workspace_kind=worktree but no workspace_path, and board 'default' has no default_workdir set.

and after `DEFAULT_FAILURE_LIMIT = 2` (`hermes_cli/kanban_db_dispatch.py:37`) the task is blocked with `gave_up`. That has now happened three times (2026-10-14, 10-17 and 10-20), the last from Boundary's Retry button.

Setting a board default workdir wouldn't fix it in this stack. The `hermes` container sees git repos only under `/opt/projects`, which is mounted read-only, and `git worktree add` has to write to the repo. `PATCH /tasks/{id}` can't change a workspace either, so the only repair is to file a copy and archive the original.

Nothing reliably tells an agent that a task it filed gave up. The task has two `kanban_notify_subs` rows, both `platform=tui`, `delivery_mode=notify`, with `last_event_id` stuck at 1 and 7, so no live session received the `gave_up`. The chat agent Boundary talks to couldn't repair the task if it were told: `hermes-api-server` is built with `_core_without(..., kanban=False)` (`toolsets.py:197`), so it has no `kanban_*` tools. An orchestrator worker has `kanban_show` and `kanban_create`, but no agent tool can archive a task or change its workspace.

The goal of this request is that an agent finds out about this failure when it happens and fixes it without the owner stepping in. All references are to `Hermes Agent v0.22.2 (2026.9.24)`, upstream `d923a5eb`, in the stack's `hermes` container.

The stack's replies are quoted under each item. The work is stack overlays on Hermes Agent, delivered in v0.3.3 (Hermes v0.22.2) and v0.3.4 (Hermes v0.22.5). `HERMES_KANBAN_GUARDS=0` turns off R1, R3 and the creator comment. The contracts are in the stack's `docs/extending.md` under "Kanban workspaces".

## R1 · Refuse a workspace the board can't build when the task is filed (Blocking)

**Why:** the error only shows up at spawn time, minutes after the agent that filed the task has moved on. If `kanban_create` refused the task, that agent would read the error in its tool result and could file it again in `scratch` during the same turn.

**Ask:** in `create_task` (`hermes_cli/kanban_db.py:1184`), or in `_handle_create` (`tools/kanban_tools.py:1094`) and `POST /tasks`, run the same checks `_resolve_worktree_workspace` runs once the project has been resolved. Refuse `worktree` with no `workspace_path`, no project and no board `default_workdir`. Refuse a path that isn't absolute, isn't in a git repo, or that the container can't write to. Do the same for `dir` with no path or a missing one. The error should name what to pass instead, for example "pass workspace_kind='scratch', or a project".

**Acceptance:** on a board with no `default_workdir`, `kanban_create(workspace_kind="worktree")` with no path or project returns a tool error and files no task. `POST /tasks` returns 400 with the same message. Tasks whose workspace resolves today are filed as before.

**Boundary fallback:** none for filing. Boundary only sees the task after it gives up (R4).


> **Stack reply (delivered, v0.3.3):** `create_task` checks the workspace once the project is resolved, so `kanban_create` returns a tool error (`kanban_create: <reason>`) and `POST /tasks` returns 400 (`{"detail": "<reason>"}`). No task is filed. It refuses:
>
> - `worktree` with no path, no project and no board `default_workdir`;
> - a path that isn't absolute or isn't in a git repo;
> - a repo, target or git dir this container can't write to;
> - `dir` with no path, or under a directory it can't write to.
>
> A `dir` path that doesn't exist yet but can be created is still accepted, because the dispatcher creates it. Every message ends with the fix:
>
> ```text
> workspace_kind='worktree' needs a workspace_path or a project, and board 'default' has no default_workdir. Pass workspace_kind='scratch', or a project or path in a git repo this container can write to.
> ```
>
> With the SSH terminal backend, `/opt/projects` is read-only in `hermes` and the coding roots aren't mounted there. So every `worktree` task on those repos is now refused when filed, and so is every task linked to a project there. File them as `scratch`: the worker's terminal runs on `hermes-worker`, where the repos are writable.

**Boundary:** the Orchestrator's role now files work on a coding repo as `scratch` and names the repo's path in the body.

## R2 · Change a task's workspace while it isn't running (Wanted)

**Why:** repairing a task by copying it loses its id, its run history, its attachments and the session it was filed from. An agent or the owner should be able to fix the workspace in place.

**Ask:** accept `workspace_kind`, `workspace_path` and `project_id` on `PATCH /tasks/{id}` when the task isn't `running`, check them the way R1 does, and record an `edited` event. Expose the same change to orchestrator agents, as a new `kanban_update` tool or as fields on an existing one. Add a `kanban_archive` tool too, so an agent that does have to copy a task can clear away the original.

**Acceptance:** `PATCH /tasks/t_x {"workspace_kind": "scratch"}` on a blocked task succeeds, and the next unblock starts a worker in a scratch workspace. The same call on a running task returns 409. An orchestrator can make both changes with its tools.

**Boundary fallback:** the Gave up card's **Run in a scratch workspace** (`refileInScratch` in `src/main/services/assistant/hermes/hermesKanban.ts`). It files a copy with the same fields, parents and comments, moves the children to the copy, then archives the original. With R2, that becomes a single `PATCH` followed by an unblock.


> **Stack reply (delivered, v0.3.3):** `PATCH /tasks/{id}` takes `workspace_kind`, `workspace_path`, `clear_workspace_path` and `project_id`.
>
> - **Fields:** in a PATCH, a null field means "not sent". Use `clear_workspace_path: true` to clear the path, and `project_id: ""` to unlink the project.
> - **Defaults:** changing the kind drops the stored path unless you send one. Changing to `scratch` also drops the project link unless you send `project_id`.
> - **Checks:** the new workspace is checked as in R1.
> - **Errors:** 409 while the task runs. 400 for a workspace that can't be built, an unknown project, or both path fields sent. 404 for an unknown task.
> - **Order:** the workspace step runs before the rest of the PATCH, so a refused change applies none of it.
> - **History:** an `edited` event carries `fields`, `from` and `to`.
>
> A blocked task stays blocked, but one PATCH can also unblock it:
>
> ```json
> {"workspace_kind": "scratch", "status": "ready"}
> ```
>
> **Tools:** `kanban_update` (the same change) and `kanban_archive` (refuses a running task) are orchestrator-only, like `kanban_unblock`. A profile with the `kanban` toolset sees them, including your `orchestrator`. Workers started by the dispatcher don't.
>
> **Boundary:** `refileInScratch` can become that single PATCH.

**Boundary:** done. **Run in a scratch workspace** sends that PATCH, so the task keeps its id, runs, comments, attachments and links. The re-file fallback is gone. The Orchestrator's role tells it to repair a task the same way with `kanban_update`.

## R3 · Give up on the first spawn failure the dispatcher can't recover from (Wanted)

**Why:** a missing workspace, an unknown assignee profile or a bad model override fails the same way every time. Retrying spends the failure budget and the dispatcher's time, and every unblock starts the cycle again.

**Ask:** when `resolve_workspace` raises `ValueError`, or the spawn fails for another reason that can't change between ticks, block the task straight away with `gave_up`, and add a field to the payload marking it as a configuration failure, for example `"retryable": false`.

**Acceptance:** a task whose workspace can't be resolved goes from `ready` to `blocked` + `gave_up` after one claim, and its payload includes `"retryable": false`. A spawn failure that can be retried, such as a worker exiting early, keeps the current limit.

**Boundary fallback:** stack v0.3.3 already gives up at the first claim and sends `retryable: false`, which the Gave up card reads. This item stays open for the stack developer to confirm that v0.3.3 covers every workspace error, including the missing-`default_workdir` case above. `workspaceFailure` in `src/renderer/product/chat/TaskControls.tsx` still matches the `workspace:` prefix to decide whether to offer a scratch workspace, since some failures that can't be retried, such as a revoked credential, aren't fixed by changing the workspace. A machine-readable failure kind in the payload (for example `"cause": "workspace"`) would replace that text match.


> **Stack reply (delivered, v0.3.3):** a workspace error that can't heal blocks the task on its first claim, with `gave_up` and `"retryable": false` in the payload. That covers no path, a path that isn't absolute or isn't in a git repo, and a repo or directory the container can't write to. The block is sticky: only an unblock releases it, and the dispatcher won't re-promote it. Other `git worktree add` failures, such as a held `index.lock`, keep the normal limit and have no `retryable` key. The give-up for a revoked credential or missing model (`terminal_provider`) also carries `"retryable": false`. Treat a missing key as retryable.
>
> Two of the three examples in Why don't fail at spawn in v0.22.2. An unknown assignee profile isn't a failure at all: the task stays `ready` and gets one `skipped_nonspawnable` event. A bad model override is refused when the task is filed.
>
> **Boundary:** the payload key is `trigger_outcome` (here `"spawn_failed"`), not `trigger`. The `workspace: ` prefix on `error` comes from the dispatcher, not from the resolver. `workspaceFailure` can read `retryable` instead of matching text.

**Boundary:** Boundary already read `trigger_outcome`. `retryable: false` alone can't drive the scratch offer, because a revoked credential sends it too (`trigger_outcome: crashed`). `workspaceFailure` now offers a scratch workspace for `trigger_outcome: spawn_failed` with `retryable: false`, and no longer matches the `workspace:` prefix. A `cause` field would still be clearer if the stack adds more spawn failures that can't be retried.

## R4 · Tell the agent that filed a task when the task gives up (Wanted)

**Why:** self-repair needs an agent to find out. The `gave_up` for `t_5727c92a` reached only two `tui` notify subscriptions, neither of them live, and a dispatcher-spawned orchestrator has no subscription at all. R1 handles most workspace mistakes, but crashes and timeouts still need a reader.

**Ask:** when a task gives up, send the error to whoever filed it: comment on the creator task (`creator_task_id`) if there is one, and wake the filing session (`session_id`) the way a `blocked` event already wakes subscribers in `gateway/kanban_watchers_notifier.py`. The wake turn should carry the error and the task id, so the agent can fix the task without reading the board first.

**Acceptance:** when a task filed from a session gives up, that session gets one turn that names the task and its error. A task filed by a worker gets a comment on the creator task saying it gave up.

**Boundary fallback:** Boundary notifies the owner (`hermesKanbanNotify.ts`) and shows the Gave up card. The owner, not an agent, makes the repair.


> **Stack reply (delivered: creator comment in v0.3.3, wake fix in v0.3.4):** some of the diagnosis needs correcting first.
>
> - **What exists:** the notifier already wakes sessions on `gave_up`, and a child task inherits its creator's subscriptions.
> - **Why it missed:** Boundary's chats are dashboard-gateway sessions, so `kanban_create` subscribes them as `platform=tui`. Their only reader is the gateway's per-session poller. It claims a session's events and runs them as one turn once the session is idle, but only while the session is open with its agent built. That means after `session.create` or a `session.resume` without `lazy`. While a session is closed, its events wait, and the next resume delivers each one once.
> - **The bug:** Hermes never re-keyed these subscriptions when context compression gave a session a new key. So a session that had been compressed never received events for tasks it filed earlier, even after a resume. That fits the cursors stuck at 1 and 7, though we haven't looked at that data.
>
> Changes:
>
> - **v0.3.3:** when a task filed by another task's worker gives up, the creator task gets a comment from `kanban-dispatcher` naming the task and its error.
> - **v0.3.4:** the poller claims subscriptions whose old key resolves, through the compression history, to the session's current key.
> - **v0.3.4:** the `gave_up` text, which is also the wake turn, says whether a retry can help, carries up to 500 characters of the error and names the repair:
>
> ```text
> ✖ @default Kanban t_5727c92a gave up: it can't start until its workspace or configuration changes
> Error: workspace: task t_5727c92a has workspace_kind=worktree but no workspace_path, ...
> To repair it: kanban_update(task_id='t_5727c92a', workspace_kind='scratch'), then kanban_unblock(task_id='t_5727c92a').
> ```
>
> The stack never opens a session on its own. Doing that would run turns on the owner's model with no client attached.
>
> **Boundary:** to have the agent repair a task without the owner, resume the filing session in the background when `/events` shows a `gave_up`. Use the task's `session_id` with its `profile`, and a default resume, not `lazy`. The poller then runs the turn. That turn may also carry other events queued for the same session.
>
> A worker started by the dispatcher still gets no wake. It sees the creator comment through `kanban_show` the next time it runs.

## R5 · Kanban tools for the API server's agent, or a decision not to give them (Later)

**Why:** the owner talks to the agent through Boundary, which uses the API server. That agent can't see a task's state or repair it even when asked to, because `hermes-api-server` drops every `kanban_*` tool. Boundary already renders `kanban_create` calls in chat (CR 0005 R3), so some sessions do file tasks.

**Ask:** either add `kanban_show`, `kanban_list`, `kanban_create`, `kanban_unblock` and the R2 tools to `hermes-api-server`, or to a profile Boundary can choose for this work, or tell us why the API server leaves them out so Boundary can send these requests to the orchestrator instead.

**Acceptance:** an agent reached through the API server can inspect a gave-up task and re-file or fix it on request. Or this file records the reason it can't.

**Boundary fallback:** none. Today the owner makes the repair from the Gave up card.


> **Stack reply (declined):** Boundary's chats go through the dashboard gateway on the default profile or an agent's own profile. The API server is only the HTTP fallback for the built-in Assistant, so adding kanban tools to `hermes-api-server` wouldn't reach those chats. Upstream doesn't record why `hermes-api-server` leaves them out.
>
> The kanban tools come from the profile's toolset. The `orchestrator` profile already has them (Boundary turns on `kanban` in its `platform_toolsets.cli`), and with R2 that includes `kanban_update` and `kanban_archive`. Send repair requests to the Orchestrator, or turn on `kanban` for any other agent's profile the same way.

**Boundary:** agreed. The Why above is wrong: Boundary's chats use the gateway, not the API server.

## Notes

R1, R2 and R3 change Hermes's kanban code. R4 touches the kanban notifier in the gateway. R5 is a toolset or profile change. R1 alone would have stopped this failure. R2 and R4 are what let an agent repair failures that R1 can't catch.

> **Stack:** moving the pin to v0.3.3 brings R1, R2, R3 and the creator comment. v0.3.4 adds the wake fix and the new give-up text. `docker compose up -d` recreates `hermes` for the new overlay mounts. Our tests are `scripts/test-kanban-guards.py`, `test-kanban-edit.py` and `test-kanban-wake.py`.
