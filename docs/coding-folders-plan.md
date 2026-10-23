# Coding folders build plan

- Date: 2026-10-07
- Status: Proposed
- Decision: [ADR 0028](adr/0028-coding-folders.md)
- Mock: [`chat-ux-study/12-coding-folders.html`](chat-ux-study/12-coding-folders.html)
- Revised: 2026-10-07 (Phase 6, coding parent folders behind per-task sandboxing; grants share the host bridge's shape; Phase 6 becomes a two-route spike)

## Goal

A packaged-app user can let the coding agent work in their project's folder, in any other folder they choose, or in a new folder Boundary creates. They can do this from the Project tab, from Settings, or when Hermes asks in a chat. They never see a `make` command, and Boundary never shows a folder as ready before the coding agent can open it.

## How it fits together

```
grant store (Boundary)                 projects overlay (generated)
  hostPath, projectId, origin   ──►    opencode:      P:P rw, .env shadows
  createdByBoundary                    hermes-worker: P:P rw, .env shadows
project.codingEnabled (hub)            (existing /opt/projects binds unchanged)
        │
        └──► CODING_EXTRA_ROOTS=:P1:P2   in stack .env + compose env
                 ├─ opencode-mcp: allows tasks under P1, P2
                 └─ hermes: HERMES_WRITE_SAFE_ROOT gains P1, P2

recreate: opencode, opencode-mcp, hermes, hermes-webui, hermes-worker
verify:   compose exec opencode test -d P   →  Coding  |  Not visible
```

## Phases

Each phase lands as its own commits and passes `bun run test` and the type check before the next starts. Per project practice, I don't launch the app to verify. Each phase ends with a short checklist for in-app testing.

### Phase 1: grants and mounts (main process only, no UI)

The plumbing, behind IPC, so the rest is UI.

1. **Grant store.** Add `codingGrantStore.ts` beside `hermesProjectStore.ts`.
   - Each record uses the host bridge's grant shape (ADR 0027 §7, `HostBridgeGrant` in the `host-bridge-skeleton` branch): `{ capability: 'coding', resource: <host path>, createdAt, expiresAt: null }`.
   - Coding fields sit beside it: `{ projectId, origin: 'add' | 'project-folder' | 'chat' | 'new-folder', createdByBoundary }`.
   - It is its own `electron-store` (`coding-grants`) until the bridge store is on `main`. Then the records move into the bridge's `grants`, and `hasHostBridgeGrant('coding', path)` answers the same question. Don't import unmerged bridge code.
   - Add `codingEnabled?: boolean` to `HermesProjectRecord`. A missing value reads as `false`, which covers upgrades (ADR §12).
2. **Refusals.** Add `refuseCodingGrantReason()` to `projectSourcesModel.ts`. It refuses:
   - `/`, the home folder and any ancestor of home;
   - the system folders listed in ADR §5;
   - Boundary's `userData` and stack home, and any folder that contains one;
   - a path that isn't an existing directory.

   Keep the existing `refuseAddFolderReason` for read-only sources.
3. **Roots from grants.** Make `readCodingRoots()` in `hermesContextRoots.ts` read the grant store and granted hubs, not just `.env`, so `visibilityForSource()` reports `writable` for granted folders. Drop covered paths with the existing `pathCoveredByRoots`.
4. **Overlay.** Extend `buildHermesProjectsOverlayYaml()`:
   - an `opencode` service block;
   - identity read-write binds for each grant on `opencode` and on the terminal service (`hermes-worker` under ssh, `hermes` under local);
   - an identity bind for each granted hub, in addition to its `/opt/projects/<slug>` bind;
   - empty read-only shadows over top-level `.env` and `.env.*` files, excluding `.example`, `.sample` and `.template`. Shadows point at one empty file in the stack home.
5. **Environment.**
   - Write `CODING_EXTRA_ROOTS` with a leading colon to the stack `.env` via `upsertEnvLine`.
   - Pass the same value in `buildBoundaryComposeContext()`'s env, so the variable is set even if `.env` lags.
   - `opencode-mcp` reads it at start, and `HERMES_WRITE_SAFE_ROOT` appends it.
6. **Recreate set.** Add `recreateForCodingMounts()` next to `recreateHermesForProjectMounts()` in `AssistantStackService.ts`:
   - it recreates `opencode`, `opencode-mcp` and `hermes-worker` only, not `hermes` or `hermes-webui` (decided 2026-10-07, ADR §4);
   - it records which grants Hermes hasn't picked up yet. Any later recreate of `hermes` clears the record (`recreateHermesForProjectMounts`, stack start);
   - `restartHermesForGrants()` backs the row's *Restart Hermes now* action;
   - it emits progress events the UI can map to the checklist (saved → restarting → checking).
7. **Verify.** After `waitUntilAssistantHealthy`, run `compose exec -T opencode test -d <path>` for each new grant. A failure leaves the grant stored with a `notVisible` result, and the error names the likely cause when the path is outside the home folder.
8. **Busy check.** Add `codingAgentBusy()`:
   - it calls `GET http://127.0.0.1:<opencode port>/session/status` with basic auth from the stack `.env` (`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`);
   - it returns the busy sessions' titles from `GET /session` when known.

   *As built:* Boundary's running turns don't record which tool is in flight, so Phase 1 relies on OpenCode's session status alone. A delegated task is a busy OpenCode session for its whole run. The gap is the moment between `opencode-mcp` accepting a task and OpenCode starting it, which R3 closes.
9. **Service API.** Add `codingGrants.ts` with:
   - `grantCoding({ projectId, hostPath, origin, waitIfBusy })`
   - `grantProjectFolder(projectId)`
   - `revokeCoding({ hostPath, keepAsReference })`
   - `listCodingGrants()`
   - `createCodingFolder({ parent, name, initGit })`, which is Phase 3's backend but cheap to add here.

   Each one serializes through one remount queue, so two grants in a row cause one restart, not two.
10. **IPC.** Add `coding-folders:*` channels in `hermesChatIpc.ts`, plus the matching `hermesChatIPCService` methods and types in `shared/types/hermesChat.ts`.
11. **Local-stack mode.** All grant calls return `{ managed: false, command: 'make coding-root-add DIR=…' }` (ADR §13).

**Tests (vitest):**
- the overlay YAML for each backend, with quoting for paths with spaces and with shadows;
- every refusal case, including `/Users` and a folder containing userData;
- `CODING_EXTRA_ROOTS` serialization (leading colon, covered paths dropped);
- the queue coalescing two grants;
- the busy check parsing a `/session/status` reply;
- local-stack mode returning the command.

**In-app checklist:** grant `~/Code/<repo>` by calling IPC from devtools. Then ask Hermes to change a file there, and check that `docker inspect boundary-opencode` shows the bind.

### Phase 2: Project tab (mock flows 1 and 2)

1. Rename the inspector's Sources section to **Folders** in `ProjectSourcesRail.tsx`.
   - Pills become *Coding*, *Read-only*, *Hub*, *Connecting*, *Queued* and *Not visible*.
   - Each row gets a "who can do what" line, and a legend sits under the list.
2. Add a `coding` flag on `HermesSourceRow` and on the hub row, set from the grant store rather than inferred from `writable`. A folder that's writable because it sits under someone else's grant keeps today's warn treatment.
3. Turn `AddSourceSheet.tsx` into the three-step sheet:
   - **Pick:** a native dialog, now with `createDirectory`; the inline refusals from Phase 1 appear here.
   - **Access:** *Code in it* or *Use as reference*, with git detected by a `.git` check.
   - **Confirm:** what the agent can do, where the folder is reachable, `.env` hiding and the restart.
4. Add the *Allow coding…* popover on the hub row.
5. Add the Connecting checklist banner, driven by Phase 1 progress events.
6. Add the busy branch, with *Add when it finishes* as the default and *Stop task and add*. Waiting polls `codingAgentBusy()` every 5 seconds, and the row shows *Queued*.
7. Add the Not visible banner, with the container-engine copy and Retry / Remove.
8. Add a toast with Undo, which calls `revokeCoding({ keepAsReference: false })`.
9. In the New project sheet (folder-first, 0005), add the *Let the coding agent work here* switch. It defaults on when the folder has `.git`.
10. Rows for grants Hermes hasn't picked up read "Coding agent can edit · Hermes can edit after its next restart", with *Restart Hermes now*. The Connecting copy says chats keep working.

**Tests:** component tests for each pill state, the three-step sheet's navigation, the hub popover, and the busy branch's default.

*As built (2026-10-07):*
- **Shared state:** a small renderer store (`codingFoldersStore.ts`) holds grants, Connecting and Queued folders, the checklist step and the last error. The add sheet and the Project tab both read it. Row wording is a pure helper (`codingFolderView.ts`).
- **Grant before listing:** *Code in it* grants the folder first, then adds its `sources.yaml` row. Since the folder is already a coding root, adding the row causes no read-only remount.
- **Removing:** removing a coding folder revokes its grant before dropping the row.
- **New project:** creating a project used to have no confirm step (picking a folder created the project). It now opens `NewProjectSheet` with the coding switch. Turning coding on there waits for a running task rather than stopping it.
- **Changing a project's folder** turns coding off and drops the old folder's mount (ADR §12).
- **Phase 3 item 4 moved here:** `createDirectory` is on the project and source pickers, and on the new add-folder picker.

**In-app checklist:**
- add a repo for coding;
- add a notes folder as reference;
- allow coding on a host-folder project;
- grant while a delegated task runs;
- grant a folder on an external volume and confirm Not visible.

### Phase 3: new folders (mock flow 1, New folder and Name taken)

1. Add *New folder…* to the pick step. It opens a form with:
   - name and parent, where the parent defaults to the parent of the most recent grant, else `~/Code` if it exists, else home;
   - a live path preview;
   - *Start a git repo*;
   - an access toggle.
2. The backend `createCodingFolder()`:
   - `mkdir`, with no `-p` past the chosen parent;
   - `git init` and `git commit --allow-empty -m "Start"` via host `git`;
   - then `grantCoding({ origin: 'new-folder', createdByBoundary: true })`.

   With no host `git` (`git --version` fails), the checkbox is off with the reason.
3. For a name that's taken, show the existing folder's summary: whether it's a git repo, and its file count from a shallow listing. Offer *Use existing folder*, which goes to the access step.
4. Add `createDirectory` to the other two folder dialogs (`index.ts:1053`, `hermesProjects.ts:172`).

**Tests:**
- folder creation in a temp directory, with and without git;
- refusing an existing name;
- refusing a parent that fails `refuseCodingGrantReason`.

*As built (2026-10-07):*
- **Where it lives:** *New folder…* sits beside *Choose folder…* on the pick step and opens `NewFolderForm`, inside the add sheet. Name, location, git and access share one screen, as ADR 0028 §8 and the mock describe.
- **Live check:** `checkNewCodingFolder` validates as the user types (debounced). It refuses bad names, missing or refused parents, and taken names. For a taken name it reports whether it's a git repo and how many top-level items it holds.
- **Default location:** the parent of the most recent grant that still passes the rules, else `~/Code` if it exists, else home.
- **Use as reference:** creates the folder with no grant (`grant: false`), then adds it as a read-only source. This works on a developer stack too.
- **No Undo on the toast:** the folder Boundary just made would stay on disk, and Undo would suggest otherwise.

### Phase 4: Settings › Coding agent and deleting (mock flows 4 and 5)

1. Add a new Settings section listing every grant. It shows the folder, which project added it and how, its status (verified with the Phase 1 check on open, cached for a minute), and whether Hermes can edit.
2. Removing a grant opens a sheet: *Keep as read-only reference* (the default) or *Remove from project*. While it runs, the row strikes through.
3. Include the three "never shared" notes from the mock.
4. **Delete the folder from this Mac…** (ADR §11): the remove sheet's last option, also in a Folders row's menu, and never offered for a project's own folder.
   - Backend: `inspectFolderForDelete(hostPath)` returns file count, size (and how much is `node_modules`), last change, `createdByBoundary`, and git state (`git status --porcelain` and `git rev-list --branches --not --remotes --count`).
   - Backend: `deleteCodingFolder({ hostPath, confirmName })`. It refuses unless the folder is a current grant and passes `refuseCodingGrantReason`. It refuses while a coding task runs there. It revokes the grant, recreates the containers, re-checks, then calls `shell.trashItem`. It stops at the first failure.
   - Review sheet: the typed-name check is required when there are unpushed commits or uncommitted changes, or Boundary didn't create the folder. Otherwise one click confirms.
   - A done toast with *Show in Trash*.

**Tests:**
- list rendering from a fixture store, and the remove sheet's default;
- the delete inspector against temp repos: clean and pushed, unpushed commits, dirty, not a repo;
- the typed-name rule for each case;
- `deleteCodingFolder` refusing a project folder, a non-grant, a refused path and a busy folder;
- `trashItem` only being called after the grant is revoked and the restart succeeds.

*As built (2026-10-07):*
- **Settings:** a new **Coding agent** tab sits beside General and Passwords & Logins. It's verified on open, the check is cached for a minute in main, and *Check again* forces it.
- **Remove sheet:** *Keep as read-only reference* is the default (and is disabled when no project lists the folder), then *Remove from <project>*, then *Delete the folder from this Mac…*. Removing never touches files.
- **Project tab:** a coding row also gets *Delete…*, which opens the same review.
- **One click to delete** needs all of these: Boundary created the folder, it's a git repo, there are no uncommitted changes, and nothing is unpushed. A repo whose only commit is Boundary's empty "Start" commit counts as nothing unpushed. Everything else needs the typed name. A folder that isn't a repo always does.
- **No "Stop task" button:** while a task runs, the review offers *Check again* and says to stop the task in its chat. Boundary has no way to stop a delegated task.
- **Cleanup:** after the Trash, the folder's row is dropped from every project that listed it.

### Phase 5: grant from chat (mock flow 3)

1. In `hermesChatSessions.ts`'s `tool.complete` handler:
   - detect a coding tool by name suffix `coding_start_task` / `coding_continue_task`;
   - parse `result_text` as JSON, falling back to a `"needs_access": true` regex when it's truncated;
   - emit a `coding-access-request` event with `path` and the chat's project.
2. Render `CodingAccessInterrupt.tsx` in the 0006 interrupt family.
   - If the path exists, it offers *Add to <project> for coding* / *Not now*.
   - If not, it offers to create the folder, with the path editable and git on.
   - The card collapses into a status line on either choice.
3. On success, send a visible follow-up turn: "Coding access to `<path>` is ready." Record "Not now" in the status line and don't show the card again for that path in the same turn.
4. If the chat isn't in a project, the grant's project is null. It still appears in Settings, labelled "from a chat".
5. Gateways and the Hermes WebUI don't get the card. They keep the skill's hint, which change request R1 rewrites.

**Tests:** parsing real and truncated `needs_access` payloads, the card's existing vs new-folder variants, and the follow-up turn being sent once.

*As built (2026-10-07):*
- **Detection:** `codingAccessRequests.ts` matches the tool name by a `coding_(start|continue)_task` suffix and reads `needs_access` from the result JSON. When the result is truncated it falls back to field matching, then to the call's `directory` argument. It skips folders already covered by a grant, other tools, relative paths, and developer stacks.
- **Refusals:** a missing folder is judged by the parent it would be created in, so `~/new-repo` is allowed while `~` itself is refused. A refused folder gets an explanation and Dismiss only.
- **Placement:** the card sits in the composer slot, after Hermes's and the host bridge's approvals, using the 0006 styles, not inline in the transcript as the mock drew it. A path is shown once per turn, and not again that turn once answered.
- **On grant:** the folder is added to the chat's project Folders list, and the thread sends one visible follow-up turn through its own composer: "Coding access to `<path>` is ready."
- **Not now:** it closes the card and sends nothing. Hermes's own reply has already ended the turn.
- **Until Boundary pins the stack tag after v0.3.1:** Hermes's reply still includes the skill's `make coding-root-add` hint above the card. R1 is delivered upstream as `CODING_ROOTS_APP_MANAGED`, which Boundary already sets.

### Phase 6: restart-free grants (spike first, ADR §14)

Starts only after Phase 4, and after the host bridge skeleton is on `main`. Two spikes run on the same tests, and their results decide which route, if either, ships.

**Spike S2: native OpenCode behind the bridge.** In a branch, with nothing shipped. It must answer:
- **Sandbox:** Does `opencode serve` run under a `sandbox-exec` profile with deny-by-default file access? The profile allows one repo read-write; system and toolchain paths (Homebrew, Xcode, the user's Node/Python) read-only; and network to llm-proxy's loopback port, plus registries for installs.
- **Escape attempts:** the same list as S1 below, plus reading `~/.ssh/id_*`, `security find-generic-password`, a `.env` in a repo cloned after the server started, and AppleScript or `osascript`. Each must fail.
- **Toolchains:** `npm test`, `git commit`, `swift build`, and an Xcode build in a sample repo.
- **Wiring:** Can Hermes reach it with `opencode-mcp` pointed at a bridge relay, or should the bridge serve the `coding_*` tools itself and check grants in main? Measure start time and memory per server.

**Then choose.** Weigh S1 and S2 on enforcement (escape results), isolation (a VM versus the Mac), toolchain coverage, cost, and what each needs from the agent stack. Amend ADR 0028 §14, and keep only the chosen route's steps below. The steps after S1 are written for the Landlock route.

1. **Spike S1, in a branch, nothing shipped.** It must answer:
   - **Kernel:** Is Landlock available in the opencode container on Boundary's Podman machine and on Docker Desktop? Which ABI version, and does it cover file access?
   - **Sandbox:** Do OpenCode's server, file tools, shell and `git` work inside a Landlock sandbox? Use `landrun` or a small wrapper, allowing one repo read-write plus `/usr`, `/lib`, `/etc`, `/tmp`, the Bun/Node runtime and the OpenCode data volume read-only. Which extra paths does it need (cache folders, `~/.npm`, `~/.cache`)?
   - **Escape attempts:** From inside the sandbox, try `cat` on a sibling repo, `cd ..`, a symlink pointing out, a hard link, `python -c open(...)`, `node -e`, and `/proc/self/root/...`. Each must fail.
   - **Cost:** What do memory and start time look like for one OpenCode server per folder, with three active?
   - **Timing:** Can `opencode-mcp` start a sandboxed server per task fast enough? The target is under 3 seconds before the first prompt.

   Write the results into this plan. If any answer fails, Phase 6 stops and ADR §14 stays gated off.
2. **Parent grant type.** Add `{ kind: 'parent', hostPath }` to the grant store, with the same refusals as other grants. Also refuse a parent that contains a project's own folder Boundary didn't grant, and any parent above `~/<one level>`.
3. **Mounts.** Bind the parent read-write on `opencode` only. `hermes-worker` keeps one mount per grant (ADR §14).
4. **Allowlist file.** Write `coding-roots.json` (granted folders per project) into a stack-home folder mounted read-only into `opencode-mcp`, and rewrite it on every grant. This is R6's input. A grant under a mounted parent then needs no restart, only a file write and a Phase 1 verify.
5. **OpenCode config.** Set `permission.external_directory` to `deny` in the config Boundary writes (`ensureOpenCodeConfigFile` in `assistantPaths.ts`). This applies in every mode, not just with parents.
6. **Gate check.** On stack start, read the stack's sandbox capability (R7) and run `compose exec -T opencode` with a Landlock ABI probe. Cache the result. When it fails, hide parent options and fall back to per-folder mounts.
7. **Write watcher.** Watch each parent with `fs.watch` (recursive, which uses FSEvents on macOS). Ignore granted folders, `.git` internals and `node_modules`. Debounce changes outside the grants into one Folders banner: what changed, *Revert with git* where possible, and *Show in Finder*.
8. **UI.**
   - Add *Let the coding agent use folders under ~/Code without restarting* as an option on the confirm step. It appears once a user has granted a second folder in the same parent.
   - The consent copy names the kernel sandbox, the `.env` limit and the one restart.
   - Settings › Coding agent lists parents separately, with the folders granted under each.
   - New folders under a parent skip the Connecting restart, and the checklist shows "Checking it can open the folder" only.

**Tests:**
- grant-store refusals for parents;
- `coding-roots.json` contents per project;
- the overlay giving the parent to `opencode` only;
- the gate falling back when the probe fails;
- the watcher ignoring granted paths and debouncing;
- the confirm step only offering a parent after the second grant in it.

**In-app checklist:**
- grant `~/Code` as a parent, then grant `~/Code/a` and confirm there's no restart;
- ask Hermes to have the coding agent read `~/Code/b/README.md` and confirm it's refused;
- edit a file in `~/Code/b` from a Terminal inside the container and confirm the banner appears.

## Change requests to the agent stack

Written up in [change request 0003](change-requests/0003-coding-folders.md), opened 2026-10-07. Boundary ships the fallback in each case.

| # | Ask | Why | Fallback | Priority |
| --- | --- | --- | --- | --- |
| R1 | "The app will ask" instead of `make coding-root-add` when Boundary manages roots | The `make` command shows above Boundary's card and confuses users | The card sits below the reply; the text is wrong but harmless | **Delivered** as `CODING_ROOTS_APP_MANAGED` / `CONTEXT_ROOTS_APP_MANAGED` (tag after v0.3.1) |
| R2 | Hermes can delegate into a host-folder project's own folder | The skill says not to use `/opt/projects` paths, so Hermes must find the hub's host path | Hermes matches the project folder name against `coding_list_roots` | **Delivered** as `CODING_PATH_ALIASES` in `opencode-mcp` (tag after v0.3.1) |
| R3 | `opencode-mcp` lists in-flight tasks (`GET /tasks`) | A precise busy check, including tasks between OpenCode prompts | OpenCode `GET /session/status` plus Boundary's running turns | Later |
| R4 | `opencode-mcp /health` reports whether each root exists inside the container | Verify without `compose exec` | `compose exec -T opencode test -d` | Later |
| R5 | The skill proposes a host path under an existing parent root when asked to start a new repo | Makes the new-folder card appear for "start a new site" requests | The user names a path, or uses Add… › New folder | Later |
| R6 | `opencode-mcp` reads its allowlist from a file (`CODING_ROOTS_FILE`, JSON of granted folders per project) on every request, falling back to `CODING_EXTRA_ROOTS`. `coding_start_task` takes the chat's project so the check uses that project's grants | Grants under a mounted parent need no restart, and per-project scoping becomes possible | Every grant recreates `opencode-mcp` (Phase 1 behaviour) | On hold until the Phase 6 spike picks Landlock |
| R7 | `opencode-mcp` runs each task in an OpenCode server started for the task's folder inside a Landlock sandbox. It allows the granted folder read-write and the runtime paths from spike S1 read-only, starts servers on demand, stops them when idle, and reports `sandbox: "landlock-v<N>"` on `/health`. The opencode image ships the wrapper | Kernel-enforced per-folder access while the container mounts a parent | None. Coding parents stay off | On hold until the Phase 6 spike picks Landlock |
| R8 | Hermes's write-safe check reads extra roots from a file (`HERMES_WRITE_SAFE_ROOT_FILE`) on every write | Grants don't restart `hermes`, so its own edits in a new folder wait for its next restart | *Restart Hermes now* on the row; picked up on the next natural restart | Later |

### Stack R1 and R2 adoption (2026-10-08)

The agent stack delivered R1 and R2 on its main, for the tag after v0.3.1 (see change request 0003).
- **Variables:** `CODING_ROOTS_APP_MANAGED=1`, `CONTEXT_ROOTS_APP_MANAGED=1` and `CODING_PATH_ALIASES` are written by `codingStackEnv()` / `persistCodingStackEnv()` in `codingMounts.ts`. They go into the stack `.env` (alias values single-quoted when they contain spaces) and the compose environment.
- **Aliases:** one pair per host-folder project. Paths containing `;`, `=`, a quote or a line break are left out.
- **Restarts:** `recreateHermesForProjectMounts()` adds `opencode-mcp` only when the alias list differs from the one it last started with (`appliedAliases` in the grant store). Coding-agent recreates and full stack starts record the list.
- **In-chat card:** `/opt/projects/<slug>` paths map back to host paths. A project's own folder turns on that project's coding switch rather than adding a grant.
- **Removed:** the `BOUNDARY_MANAGED_CODING_ROOTS` overlay entries.
- **Next:** bump `SOVEREIGN_AGENT_STACK_VERSION` once the tag ships, then run R1's and R2's acceptance cases in the app and report the replies back to the stack.

## Open questions

1. **Should Hermes's own edits follow the grant?** The ADR says yes, because `HERMES_WRITE_SAFE_ROOT` appends `CODING_EXTRA_ROOTS` automatically. Keeping Hermes read-only there would need a stack change.
2. **What should `.env` shadowing do to tests that need env values?** Shadowing breaks a project whose tests read `.env`. The current answer is a per-folder "Show .env to the coding agent" override in the folder's menu, recorded on the grant. This is not in the mock yet.
3. **Should the grant list be backed up with projects?** Today `hermesProjectStore` is the only per-user record. If projects are ever exported, grants should travel with them.

## Done when

- Phases 1–4 are shipped and the in-app checklists pass on a packaged build.
- Phase 5 is shipped, with R1 answered or its fallback accepted.
- ADR 0028 moves to Accepted, and the mock's caption notes match what shipped.
- Phase 6 is shipped, or spikes S1 and S2 are recorded here with the reason it stopped.
