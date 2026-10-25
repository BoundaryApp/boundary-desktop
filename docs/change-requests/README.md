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
