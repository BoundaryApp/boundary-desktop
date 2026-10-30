# Change requests to the agent stack

Boundary is a thin desktop wrapper around the [sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) (checked out as `../assistant` for development): Hermes Agent, Hermes WebUI, and the compose files, patches and profiles that run them. **We do not edit files in that repository from here.** When Boundary needs behaviour that belongs in the stack, whether a gateway capability, a Hermes patch, a version pin, or a profile or compose change, we write a change request in this folder and hand it to the stack's developer.

A request belongs here, not in Boundary, when any of these is true:

- Another client (Hermes WebUI, the dashboard, n8n) would need the same behaviour.
- Boundary would otherwise have to store agent state (transcripts, lineage, versions) that the stack already owns.
- The fix is a Hermes patch, a gateway method, or a compose, profile or version change.

Boundary may ship an **interim fallback** while a request is open. Each request names that fallback and the Boundary code that goes away once it lands.

## Format

One file per request: `NNNN-short-name.md`. Each file contains:

- The Boundary spec it serves.
- Numbered items (R1, R2 …). Each item has Why, Ask, Acceptance, a Boundary fallback, and a priority (`Blocking`, `Wanted`, `Later`).

The stack developer updates **Status** in the table below and replies inline under each item.

## Requests

| # | Title | Serves | Status |
| --- | --- | --- | --- |
| [0001](0001-message-actions.md) | Message actions: timestamps, edit, retry, branch, versions | [message-actions spec](../message-actions-ux-study/spec.md) | Answered (R1 done · R2–R5 declined/deferred · R6 verified) |
| [0003](0003-coding-folders.md) | Coding folders: app-managed coding roots, live allowlists and per-task sandboxing | [coding-folders plan](../coding-folders-plan.md) | R1–R2 delivered · R3–R5, R8 open · R6–R7 on hold |
| [0002](0002-dm-context-budget.md) | DM context budget, the visible cut, and base-agent identity | [chat-types spec](../chat-types-ux-study/spec.md) | Open |
| [0004](0004-turn-liveness.md) | Turn liveness: a heartbeat while a turn runs, and a one-session status query | Chat turn state | R1–R2 delivered (unreleased) · Boundary wired, fallback kept |
| [0005](0005-kanban-task-activity.md) | Kanban task activity: the current tool in heartbeats, an atomic stop, filed task ids in history | [task activity spec](../kanban-activity-ux-study/spec.md) | Open |
| [0006](0006-calendar-connect.md) | Calendar connect: an arm64 bridge, event details in approvals, credential mirroring, a calendar allowlist | [calendar connect spec](../calendar-ux-study/spec.md) | R1–R3, R6 delivered in v0.3.3 · R4 declined · R5 waiting on upstream · R7 open |
| [0007](0007-profile-stub-bootstrap.md) | Profile bootstrap: create a gateway profile whose folder exists without config.yaml | First-run start-up | Open |
| [0008](0008-kanban-workspace-self-repair.md) | Kanban workspaces: refuse what can't start, and let agents repair a stuck task | [task activity spec](../kanban-activity-ux-study/spec.md) | R1–R3 delivered (v0.3.3) · R4 delivered (v0.3.3–v0.3.4; Boundary step not started) · R5 declined |
| [0009](0009-shared-database-access.md) | Shared database: read-write SQL for Boundary chats, a host port, a host-side integration role | Shared database (stack `db` profile) | Open |
| [0010](0010-room-context.md) | Room context: turn context on prompt.submit, platform hints, profile checks | Channels (ADR 0008–0010) | R1–R3 delivered in v0.3.3 · Boundary wired |
| [0011](0011-attributed-session-turns.md) | Attributed turns: speaker names on assistant rows, appending turns to a session | Channels (ADR 0008, 0010) | R1 wanted · R2 answered by hosted rooms, not adopted yet |
| [0012](0012-dashboard-sign-in.md) | Dashboard sign-in from Boundary, a task deep link, the board without the dashboard shell | [task activity spec](../kanban-activity-ux-study/spec.md) | R1–R3 delivered (v0.3.5) · Boundary wired (pinned v0.3.6) |
| [0013](0013-coding-task-sessions.md) | Coding task sessions: the OpenCode session id from `coding_start_task`, progress during `coding_wait_for_task` | [coding task progress plan](../coding-task-progress-plan.md) | Open |
| [0014](0014-proxy-fallback-upstream.md) | llm-proxy: a fallback upstream per route, the upstream that served, a session id for routing | [circles plan](../circles-plan.md) | R1–R2 done (v0.3.7) · R3 existing config, live checks pending |
| [0015](0015-untrusted-reply-approvals.md) | Approval for every side-effecting tool call in a reply that asks for it | [circles plan](../circles-plan.md) | Open |
| [0016](0016-bash-3-2-setup.md) | `setup.sh` fails on macOS's bash 3.2 when `HERMES_BUZZ_PROFILES` is empty | First-run setup and upgrades | R1–R2 done (v0.3.7) |
| [0017](0017-stack-releases.md) | Stack releases Boundary can install unattended | [updates plan](../updates-plan.md) | Open |
