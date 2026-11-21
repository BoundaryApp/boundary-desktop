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
| [0018](0018-workload-scheduling.md) | Workload scheduling: pausing coding tasks | [workload scheduling plan](../workload-scheduling-plan.md) | Open |
| [0019](0019-faster-stack-start.md) | Faster stack start on every launch | App launch time | R1 done, R2–R3 partly (v0.3.8) |
| [0020](0020-ui-installable-addons.md) | Add-ons Boundary can install from its UI: a manifest, resource limits, a scripted enable step, MCP registration without a restart, n8n as an add-on | [add-ons UX study](../addons-ux-study/README.md) | R1 manifests shipped for gptr, actual and bitwarden (v0.3.12); Twenty's on stack main for 0.3.13, n8n's in progress · `addon.sh` reply items 1–8 accepted, on stack main for 0.3.13 (unreleased) · R2, R5 (healthchecks), R8 shipped in 0.3.10 · R4 verified live on Hermes v0.22.7 · R11 shipped in 0.3.11 · R5 capabilities, R7 later · R9 declined · R10 manifest for n8n in progress |
| [0021](0021-worker-key-owner.md) | The SSH worker key is owned by uid 1000 whatever `HERMES_UID` is | Agent terminal and file tools | R1–R2 done (v0.3.11), Boundary pins it |
| [0022](0022-lightrag-off.md) | Turning LightRAG off leaves its MCP entry in Hermes; LightRAG as an add-on | LightRAG on Services | R1 done (v0.3.11), Boundary pins it · R2 built on a stack branch, not released (target 0.3.13) |
| [0023](0023-twenty-workspaces-access-sign-in.md) | Twenty: access changes, local workspaces while off, asking before writes, a sign-in link, finished onboarding | [add-ons spec](../addons-ux-study/spec.md) | Open |
| [0024](0024-browser-sign-up.md) | Browser sign-up: a login with a generated password, capturing a key from a page, a sign-up skill | Agent-driven account sign-up | R1–R3 built (unreleased, planned for 0.3.12) · R2 delivers to the viewer through `vault.take`, not `secret.deliver` |
| [0025](0025-twenty-member-keys.md) | Twenty: keys for one person, and adding a workspace that can't answer yet | [shared services spec](../shared-services-ux-study/spec.md) | Open |
| [0026](0026-actual-budgets-per-person.md) | Actual Budget: budgets per person, the credential that signs in, read-only runs, the MCP servers on the host, listing budgets, a local setup without the single budget | Actual Budget; [ADR 0048](../adr/0048-sharing-a-service-with-a-circle.md) | R1, R2, R4, R5 accepted, planned after `addon.sh` 0.3.13 · `budget.sh` becomes the Actual hooks for `addon.sh` · ended-session fix merged, unreleased · R3 asked to move to Wanted (round 8) · round 7 accepted, not built |
| [0027](0027-addon-store-metadata.md) | Add-on store fields in the manifest: a category, keywords, example questions, what leaves this Mac, and `list --json` returning them | [add-on store spec](../addon-store-ux-study/spec.md) | Open |
| [0028](0028-bitwarden-accounts-from-boundary.md) | Bitwarden accounts from Boundary: accounts as `addon.sh` instances, account state, unlock and sync as JSON | [add-ons spec](../addons-ux-study/spec.md), phase 8 | R1–R5 merged to stack main, unreleased · R6 withdrawn · not run against a real account |
| [0029](0029-hosted-twenty-tool-surface.md) | A hosted Twenty whose MCP lists every record tool, tool names over 64 characters, a guardrail stop only in `message.complete` | [shared services spec](../shared-services-ux-study/spec.md) | R1–R2 in stack 0.3.14 · R3 in 0.3.15 (guardrail stop streams as `message.delta`) · Boundary maps `no_catalog` |
| [0030](0030-text-detector-addon.md) | An AI text detector add-on, and calling it from Boundary without a chat turn | [writing check spec](../writing-check-ux-study/spec.md) | R1–R2 accepted with changes, building (needs CR 0027 R4–R5 in the same release) · R3 Later |
| [0031](0031-email-status.md) | Email add-on: `run email status` per account, named errors from `run email mailboxes` | [add-ons spec](../addons-ux-study/spec.md), phase 9 | Open |
| [0032](0032-vikunja-addon.md) | Vikunja as an add-on: a manifest, setup through `addon.sh`, a signed-in link, its data on remove | [add-ons spec](../addons-ux-study/spec.md) | R1–R4 in stack 0.3.15 (pinned) · R5 deferred |
| [0033](0033-gated-cron-sessions.md) | Cron fires skipped by a monitor or wake gate leave empty sessions; a person can type into a cron session | The chat list | Open |
| [0034](0034-bitwarden-broker-namespace-status.md) | `vault.sh status --json` reports a broker left in a recreated hermes's network namespace | [add-ons spec](../addons-ux-study/spec.md), phase 8 | Open |
| [0035](0035-bitwarden-enable-folders.md) | `addon.sh enable bitwarden` creates the broker's bind-mount folders | [add-ons spec](../addons-ux-study/spec.md), phase 8 | Open |
| [0036](0036-cron-fence-client-servers.md) | Cron fence: MCP servers a client adds between bootstrap runs | agents' scheduled jobs (calendars, host bridge) | Open |
| [0037](0037-remote-stack-host.md) | Running the stack on a host a client reaches over SSH | [remote stack plan](../remote-stack-plan.md) | R1–R5 released in v0.3.16 · R6 on stack main, unreleased · R7 asked · R1's Ubuntu run and R2's live port check pending · profiles, profile `.env` and `mcp_servers` wait on the client gateway |
| [0038](0038-bitwarden-broker-host-route.md) | The Bitwarden broker reaches Boundary's browser relay on the host; who else mounts its `secrets` folder | [ADR 0065](../adr/0065-relay-credential-client.md) | R1 and R2 released in v0.3.16 · not yet run against a live broker |
| [0039](0039-session-import.md) | Moving chat history between installs: a stack command to export and import sessions, profiles the target lacks, importing while the gateway runs | Chat history (Settings) | R1–R3 released in v0.3.16 (`scripts/sessions.sh`) · R4 not done · R5 (title clash fails a batch) and R6 (ids out) asked, Wanted · R7, R8 Later |
| [0040](0040-agent-own-soul.md) | An agent can find its own SOUL.md: say where the persona lives, a read-only copy in the worker | Agent identity in chat | R1 released in v0.3.16 · R2 not done · Boundary masks other checkouts |
| [0041](0041-bitwarden-sync-tmpfs-podman.md) | A `/run/bitwarden-sync` tmpfs that Podman accepts: no `uid=`/`gid=` on the broker's tmpfs | Bitwarden on bundled Podman | R1 in stack v0.3.17 (not tagged yet); R2 answered by CR 0042 R2 |
| [0042](0042-signin-seccomp-podman.md) | `bitwarden-signin` on Podman: a seccomp setup (also `web-browser`) and a socket volume Podman accepts | Bitwarden on bundled Podman | R2 accepted without `context=`, not built · R1 deferred to a stack Podman override |
| [0043](0043-twenty-secrets-on-enable.md) | `addon.sh enable twenty` generates `TWENTY_ENCRYPTION_KEY` and `TWENTY_DB_PASSWORD` when `.env` has none | Twenty on stacks set up before v0.3.10 | R1 on stack main, unreleased |
