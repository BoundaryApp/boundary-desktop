# Add-ons: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.html](prototype.html) (click-through) |
| Stack requests | [0020 Add-ons Boundary can install from its UI](../change-requests/0020-ui-installable-addons.md) |
| Started | 5 Nov 2026 |
| Builds on | [updates plan](../updates-plan.md), [resources UX study](../resources-ux-study/README.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Prototype matches the stack's replies | Done | — |
| 2 Add-ons page and fit check | Built; live check pending | — |
| 3 Install and remove Twenty | Built; live check pending | 2; stack 0.3.10 and 0020 R11 before release |
| 4 Twenty access, approvals and sign-in | Not started | 3 |
| 5 Install through `addon.sh`, then Tasks and the rest | Not started | 3, stack patch after 0.3.10 (0020 R1, R3, R4, R6) |
| 6 Add-on backups and updates | Not started | 5, updates plan phase 5, 0020 R7 |

## Goal

A user sees the optional services their stack offers, learns before installing whether this Mac can run one and what it costs, and installs or removes it from Boundary with progress for each step. Nothing asks them to run a `make` target or edit `.env`.

## Decisions

1. **Add-ons live under Services.** They are services the assistant runs, beside the existing service cards. Settings keeps what an add-on's agents may do only where it already has a home (Passwords & Logins for the owner account).
2. **The catalog comes from the stack.** Boundary reads `addon.sh list --json` once the stack ships it (0020 R1). Until then Boundary compiles a catalog for the pinned stack in the same shape, so phase 4 swaps the source without touching the page.
3. **Only services Boundary doesn't already start are add-ons.** Boundary always runs `core`, `automation`, `coding`, `db` and `research`, so those aren't listed. LightRAG and Neo4j (`rag`) are off until the user turns them on from LightRAG's Services card. n8n, part of `automation`, is off the same way from its own card; it becomes an add-on when the stack ships R10 of change request 0020. Mail and Messages are left out: they read the user's real mail and messages and need a consent flow of their own, which this spec doesn't cover. Twenty is the first add-on built end to end and joins the catalog with stack 0.3.10. Tasks, Local models and Signal follow once `addon.sh` exists.
4. **The fit check is drawn against the container engine.** Add-ons compete for the Podman machine's memory (12 GiB by default), not the Mac's. The check uses each add-on's reservation from compose (0020 R2), and `docker stats` for running services that have no limit yet, including core's `hermes-worker`, `llm-proxy`, `searxng` and `mcp-searxng`. When an add-on doesn't fit, the page offers to grow the engine and says that this restarts the stack.
5. **One Install button per add-on.** It turns on the manifest's `install` flag set. Twenty's turns on both `TWENTY_LOCAL_ENABLED` and `TWENTY_MCP_ENABLED`. Connecting a hosted Twenty is a separate action on the same page, which turns on `TWENTY_MCP_ENABLED` alone and asks for the manifest's `connect` fields.
6. **The user chooses only what the stack can't.** Secrets and accounts are generated at install. The one choice offered before install is what agents may do, where an add-on supports it.
7. **What agents may do has three settings.** **Look things up** maps to the add-on's read-only key, **Make changes after asking you** to the write key plus Boundary's approval prompt, and **Make changes on their own** to the write key alone. For Twenty, `TWENTY_ACCESS=read|write` picks the key. The read-only key is described as the stack's docs describe it: if Twenty's read-only role can still write junction records, the page says what it can still write instead of calling it read-only.
8. **Approval reads the inner tool.** Twenty routes every record change through `execute_tool`, so "after asking" prompts on `execute_tool` calls whose inner tool name is a write (`create_*`, `update_*`, `delete_*`) and lets `find_many_*` through. Prompting on `execute_tool` itself would ask before every lookup.
9. **Install is a list of steps with one progress bar.** Steps come from the stack's JSON lines once `addon.sh` exists (pull with bytes where compose reports them, setup steps as `running` then `done` or `error`). A failure shows the step's `logTail` and offers **Try again** and **Undo install**. The user can leave the screen; the Services icon shows a dot until it finishes.
10. **The restart step is the last step and waits for the user.** Until the stack's `reload.mcp` path ships, installs end by recreating Hermes, with **Restart when the task finishes** offered while agent work runs. After it ships, the step becomes a reload that needs no restart, and the page still says that each chat on the profile re-sends its history uncached on its next turn.
11. **Generated sign-ins go to Passwords & Logins.** Twenty's owner account (`owner@crm.localhost` and a generated password) is read from the `done` line's `account` object and stored there. If the user changes the password in Twenty, Boundary writes the new one back to the stack, because the next `enable` signs in with it.
12. **Turn off keeps data; removal is separate.** **Turn off** runs `disable`. **Remove and delete data** runs `remove --delete-data`, only after Turn off, and asks the user to type a confirmation.
13. **Add-ons stay pinned.** An add-on updates with the stack until the signed channel file can carry its own tested pin (0020 R7). Updates that migrate data ask first and back up the add-on, using the manifest's `backup` object; Twenty's needs its profile stopped for the copy.

## The first catalog

Facts from stack v0.3.8 (`docker-compose.yml`, `.env.example`, `docs/todo.md`), and for Twenty from the stack's Twenty work (`docs/crm.md`, `scripts/crm.sh`) and its 0020 replies.

| Add-on | Profile and flags | What the user gets | First-time setup today |
| --- | --- | --- | --- |
| Tasks | `todo`; `VIKUNJA_MCP_ENABLED` | Vikunja on `127.0.0.1:3456`, Hermes tools under `todos` (11 read-only, 26 read-write) | `setup.sh --todo`, then `make todo-init` for the account and two tokens |
| Local models | `ollama` | Ollama for local models | Model pull (`ollama-pull`) |
| Signal | `signal`; `HERMES_SIGNAL_ENABLED` | Messaging the agent from Signal | Linking a phone |
| Twenty CRM (stack 0.3.10) | `crm`; `TWENTY_LOCAL_ENABLED`, `TWENTY_MCP_ENABLED` | Twenty on `127.0.0.1:3000`, four containers reserving about 2.1 GiB (limit about 2.5 GiB) | `setup.sh --crm`, then `crm.sh init` for the owner account, workspace `main`, two roles and two keys |

## Open work outside the UI

Confirm each against source when its phase starts, as the stack contract requires.

- **First-time setup without host tools.** `crm.sh init` and `todo.sh init` need `python3` 3.9 or later on the host, and the Makefile wraps them; a Mac without the Command Line Tools has neither. 0020 R11 asks the stack to run setup in a container. Boundary develops against `crm.sh init` meanwhile, and release builds wait for R11.
- **Release gating.** Builds pinned to a stack without the `crm` profile must show no Twenty entry. The catalog shows an add-on only when the installed stack tree has what it needs.
- **Approval on inner tool names.** Find where Boundary's approval prompt decides which calls to stop (ADR 0006) and whether it can read `execute_tool`'s arguments before Hermes runs the call.
- **Writing a changed password back.** Phase 5 needs a way to update `TWENTY_PASSWORD` (or the file named by `passwordFile`) when the user edits the Twenty login in Passwords & Logins.
- **Contract table.** Each phase that reads something new from the stack adds it to `docs/stack-contract.md` with its check.

## Phases

**1 Prototype matches the stack's replies.** Twenty's four containers, port, size and generated values; no **Set up** form; the access choice; the hosted connect flow; the owner account handed to Passwords & Logins; a catalog of services Boundary doesn't already run.

**2 Add-ons page and fit check.** The page under Services with the compiled catalog, the engine memory bar, and the detail page with the fit check and what it runs. Installs nothing. The fit check is a pure function with unit tests for room to spare, tight and won't fit.

**3 Install and remove Twenty.** `TWENTY_LOCAL_ENABLED` and `TWENTY_MCP_ENABLED` in Boundary's compose env, `setup.sh --crm`, the `crm` profile started, `crm.sh init`, Hermes recreated at the restart step, **Turn off** and **Remove and delete data**. Developed against the stack's Twenty work through `BOUNDARY_ASSISTANT_ROOT`. A mounted test runs the install screen against a fake stack that fails at setup and checks **Undo install**. A `test:stack` case covers a `crm-main` server on the default profile.

**4 Twenty access, approvals and sign-in.** The access choice through `TWENTY_ACCESS`, approval on `execute_tool`'s inner tool, the owner account in Passwords & Logins, and **Connect a hosted workspace** through `crm.sh add`.

**5 Install through `addon.sh`, then Tasks and the rest.** The catalog from `addon.sh list --json`, steps from `enable --json`, removal through `disable` and `remove`, and the reload in place of the recreate once the stack's release notes say so. Boundary's compiled catalog and its Twenty glue go away, and Tasks, Local models and Signal join.

**6 Add-on backups and updates.** Backups from the manifest's `backup` object, with Twenty stopped for the copy, and add-on updates from the signed channel file.

## Acceptance criteria

- [x] The Add-ons page lists no service Boundary already starts.
- [ ] The fit check says whether an add-on fits before anything downloads, and offers the engine resize when it doesn't.
- [ ] A user installs Twenty without typing anything, and its tools answer in the next chat.
- [ ] A failed install leaves the stack as it was after **Undo install**.
- [ ] **Turn off** then install again keeps the add-on's data.
- [ ] No install step prints or stores a generated password outside Passwords & Logins and the stack's own files.
- [ ] With **Make changes after asking you**, a Twenty lookup runs without a prompt and a record change waits for approval.
