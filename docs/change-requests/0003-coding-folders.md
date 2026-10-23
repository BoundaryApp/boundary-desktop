# 0003 · Coding folders: app-managed coding roots, live allowlists and per-task sandboxing

| | |
| --- | --- |
| From | Boundary desktop |
| To | [Sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) maintainer |
| Serves | [docs/coding-folders-plan.md](../coding-folders-plan.md) (Phases 1, 5 and 6) · decision [ADR 0028](../adr/0028-coding-folders.md) |
| Opened | 7 Oct 2026 |
| Status | R1–R2 delivered on the stack's main (8 Oct 2026, ship in the tag after v0.3.1) · R3–R5 and R8 open · R6–R7 on hold |

## Context

Boundary is letting packaged-app users grant the coding agent access to host folders. These can be a project's own folder, any other folder they pick, or a new folder Boundary creates. Today the only route is `make coding-root-add`, which those users can't run.

Boundary now manages coding roots for its own stack (shipped 7 Oct 2026):

- It writes `CODING_EXTRA_ROOTS` (colon-prefixed) to the stack `.env` and the compose environment.
- It adds identity read-write binds for each root on `opencode` and `hermes-worker`, in its generated projects overlay.
- It recreates `opencode`, `opencode-mcp` and `hermes-worker`. It doesn't recreate `hermes` or `hermes-webui`, so chats don't drop.
- It verifies each root with `compose exec -T opencode test -d <path>`.
- It sets `CODING_ROOTS_APP_MANAGED=1`, `CONTEXT_ROOTS_APP_MANAGED=1` and `CODING_PATH_ALIASES` (one pair per host-folder project) in the stack `.env` and the compose environment, for R1 and R2.
- When a `coding_start_task` or `coding_continue_task` result carries `needs_access`, it shows its own card in the chat and grants or creates the folder. Then it sends one follow-up turn so Hermes retries.

None of this changes the stack's files. Developer stacks keep `make coding-root-add`.

**Where to start:** R1 and R2 are delivered (see their replies). R3–R5 and R8 have working fallbacks, so take them when convenient. R6 and R7 are on hold, as explained below.

What we read in the stack (7 Oct 2026):

- `opencode-mcp` reads `OPENCODE_WORKSPACE_HOST` and `CODING_EXTRA_ROOTS` once at start (`compose/opencode-mcp/server.py:32-33`) and checks paths by string prefix (`:59-66`).
- Outside those roots, it returns `needs_access` with a `make coding-root-add` hint (`:69-82`).
- Tasks live in memory only (`:40-41`). There's no way to list them; `/health` reports roots only (`:516-525`).
- The `delegate-coding` skill says to resolve host paths with `coding_list_roots` and never to invent `/opt/projects/...` paths (`SKILL.md:21-22`, `:67-68`). Nothing maps `/opt/projects/<slug>` to a host path.
- `HERMES_WRITE_SAFE_ROOT` on `hermes` appends `${CODING_EXTRA_ROOTS}` and is fixed when the container is created (`docker-compose.yml:815-817`).
- The opencode config sets `external_directory: allow` and `"*": allow` (`opencode/opencode.json`).

R1–R5 smooth the managed flow, and R8 removes the remaining restart for Hermes's own edits.

**R6 and R7 are on hold, so please don't start them yet.** They would allow *coding parent folders*: a parent such as `~/Code` is mounted once, so later grants under it need no restart. The ADR allows that only if the kernel enforces per-folder access inside the container, since instructions and allowlists checked by the agent's own side don't survive prompt injection.

Boundary is first running a spike between two ways to get there (ADR 0028 §14):
- a Landlock sandbox per task in the container, which needs R6 and R7;
- native OpenCode on the Mac behind Boundary's host bridge, which needs neither.

If the spike picks Landlock, Boundary will update this file and ask for R6 and R7. If it picks the native route, they are withdrawn.

---

## R1 · Say "the app will ask" instead of `make coding-root-add` when Boundary manages roots

**Priority:** Wanted (spec Phase 5).

**Why.** Boundary turns a `needs_access` result into a card in the chat that grants access with one click. The skill's reply still tells the user to run `make coding-root-add DIR=…` and recreate containers. That shows above the card and contradicts it. Boundary sets the flag the stack chose (see the reply below).

**Ask.** When `BOUNDARY_MANAGED_CODING_ROOTS=1` is set on `hermes` and `opencode-mcp`, change two pieces of text:

- the `needs_access` hint becomes: "The app will ask the user to grant access to `<path>`. Stop and wait for the user; don't suggest commands."
- the `delegate-coding` skill's guidance on `needs_access` becomes: tell the user in one sentence what you need access to and why, then end the turn.

The variable is unset by default, so developer stacks keep today's text.

**Acceptance.** With the variable set, a delegated task outside the roots produces a Hermes reply that names the path, doesn't contain `make` or `docker compose`, and ends the turn. With it unset, the reply is unchanged.

**Boundary fallback.** Boundary shows the card above the reply. The reply's command text is wrong for app users but harmless.

**Delivered (8 Oct 2026, on the stack's main for the tag after v0.3.1).**
- **Variable names:** neutral rather than `BOUNDARY_*`, both read from `.env`.
  - `CODING_ROOTS_APP_MANAGED=1` on `opencode-mcp` turns the `needs_access` hint into "The app will ask the user to grant access to <path>. Stop and wait for the user; don't suggest commands."
  - `CONTEXT_ROOTS_APP_MANAGED=1` gives a missing context root the same wording in Hermes's system prompt.
- **No separate Hermes variable:** the skill is a static file, so the skill and the system prompt both say "follow the hint in the `needs_access` result". `delegate-coding` 1.3.0 names the folder and ends the turn.
- **A third copy removed:** the `make coding-root-add` text in `HERMES_ENVIRONMENT_HINT` is gone.
- **Payload unchanged:** `ok`, `needs_access`, `path` and `roots` are all still there.
- **Default hint fixed:** with the flag unset, the hint now names `hermes-worker` as the container to recreate.

*Boundary (8 Oct 2026):* sets both flags in the stack `.env` and the compose environment. The `BOUNDARY_MANAGED_CODING_ROOTS` overlay entry is removed. Takes effect once Boundary pins the next tag; the acceptance case runs then.

## R2 · Give Hermes the host path of a host-folder project

**Priority:** Wanted (spec Phase 1).

**Why.** Hermes sees a host-folder project at `/opt/projects/<slug>`. The skill rightly says not to pass `/opt/...` paths to `coding_start_task`. When the user grants the project's own folder, Boundary mounts it at its host path too. But Hermes has nothing that tells it which host path is *this* project's folder.

**Ask.** Expose the host path of a host-folder project in what Hermes sees for the active project. That could be a field on `projects.list` / `projects.set_active` that Boundary sends (`host_path`), surfaced in the project context the skill reads, or a line the skill can rely on. Tell us which. The skill should prefer it over guessing from `coding_list_roots`.

**Acceptance.** In a chat in a host-folder project whose folder is a coding root, "run the tests in this project" delegates with `directory` equal to the project's host path, without the user naming it.

**Boundary fallback.** Hermes matches the project folder name against `coding_list_roots`. This fails when two roots share a folder name.

**Delivered (8 Oct 2026, on the stack's main for the tag after v0.3.1), by a different mechanism.**
- **Why not the suggested options:** none of them would reach the model. The agent never sees `projects.list` / `projects.set_active` results, and Hermes's project database has no host-path field.
- **What they built:** `opencode-mcp` translates paths itself.
  - It reads `CODING_PATH_ALIASES=/opt/projects/foo=/Users/you/code/foo;/opt/projects/bar=/srv/bar`.
  - `coding_start_task` accepts either side of a pair, or any path under one, and translates it to the host path before checking the roots.
  - `coding_list_roots` returns the pairs as aliases. Hermes's system prompt lists them, and the skill prefers them over matching folder names.
- **What it doesn't do:**
  - An alias grants nothing: the host path must still be under a coding root.
  - Malformed entries are logged and ignored.
- **Recreating:** after any change, `opencode-mcp` and `hermes` must be recreated.
- **Their question:** do project chats start with the session working directory at `/opt/projects/<slug>`?

*Boundary (8 Oct 2026):*
- **The cwd question: yes.** Before every turn Boundary starts, it calls `session.cwd.set` with the chat's project folder (`applyConversationFolder`, ADR 0024 §2), or the gateway's default for chats without a project. This covers only turns Boundary starts: Hermes WebUI and Telegram chats keep their own folder. It's best effort, so a failed call leaves the previous folder.
- **Aliases:** Boundary writes one pair per host-folder project, whether or not coding is on, since an alias grants nothing.
- **Recreating:** the list changes only when a project is added, removed or moved, which already recreates Hermes. Boundary adds `opencode-mcp` to that recreate only when the list changed, so read-only source changes don't interrupt coding tasks.
- **Unsupported paths:** a host path containing `;` or `=` can't be expressed in the format and is left out.
- **Paths that come back:** if a `needs_access` result names an `/opt/projects/<slug>` path, Boundary maps it back to the host path. When the path is a project's own folder, the card turns on that project's coding switch.

## R3 · List in-flight tasks

**Priority:** Later.

**Why.** Recreating `opencode-mcp` loses every in-memory task. Before a grant, Boundary warns the user and offers to wait. It needs to know whether a task is running, including between OpenCode prompts.

**Ask.** Add `GET /tasks` on `opencode-mcp` returning `[{task_id, directory, status, started_at}]` for tasks that haven't finished.

**Acceptance.** While `coding_wait_for_task` is pending, `/tasks` lists that task with its directory. After it completes it isn't listed.

**Boundary fallback.** Boundary calls OpenCode's `GET /session/status` and checks its own running chat turns for a coding tool call.

## R4 · Report whether each root is visible inside the container

**Priority:** Later.

**Why.** Boundary must not show a folder as ready until the coding agent can open it. A path on an external volume can mount empty when the container engine doesn't share it.

**Ask.** Add `roots: [{path, exists}]` to `opencode-mcp`'s `/health`, checked inside `opencode`, or inside `opencode-mcp` if it mounts the same paths.

**Acceptance.** A root bound to an unshared path reports `exists: false`; a working root reports `true`.

**Boundary fallback.** `compose exec -T opencode test -d <path>` for each new root.

## R5 · Propose a host path when asked to start a new repo

**Priority:** Later.

**Why.** Boundary can create a new folder from the same `needs_access` card when the requested path doesn't exist. For "start a new Astro site", Hermes has no path to request.

**Ask.** When the user asks for a new repo, the skill proposes `<parent>/<kebab-name>`. The parent is the parent folder of an existing coding root, preferring the most common one. Hermes then calls `coding_start_task` with it, which returns `needs_access` for the missing path. When `CODING_ROOTS_APP_MANAGED=1`, the skill doesn't create the folder itself.

**Acceptance.** With roots `~/Code/a` and `~/Code/b`, "start a new site for the landing page" produces a `needs_access` for a path under `~/Code/`.

**Boundary fallback.** The user names a path, or uses Add… › New folder in the Project tab.

## R6 · Read the allowlist from a file on every request, scoped by project

**Priority:** On hold. Please don't start this until Boundary's Phase 6 spike chooses the Landlock route (ADR 0028 §14). If it chooses native OpenCode behind the host bridge, this item is withdrawn.

**Why.** Under a mounted parent, a new grant shouldn't need a restart. Today `opencode-mcp` reads roots once at start. Boundary also wants a chat's tasks limited to that chat's project grants, which a single environment variable can't express.

**Ask.**
- **File:** when `CODING_ROOTS_FILE` is set, read it on every `coding_start_task` and `coding_continue_task`, falling back to `CODING_EXTRA_ROOTS` when it's unset or unreadable. Boundary writes it atomically and mounts it read-only. Its shape:

  ```json
  { "version": 1, "projects": { "<project id>": ["/abs/a", "/abs/b"] }, "global": ["/abs/c"] }
  ```
- **Project scope:** accept an optional `project` argument on `coding_start_task`. When it's set, allowed roots are that project's list plus `global`. When it's absent, they're the union of all lists. The skill passes the active project's id once R2 gives Hermes one.
- **Reporting:** `coding_list_roots` and `/health` report the roots the call actually used.

**Acceptance.**
- Rewriting the file changes the next call's result with no restart.
- A task for project P can't start in a root listed only under project Q; it returns `needs_access`.
- With the file absent, behaviour is today's.

**Boundary fallback.** Every grant recreates `opencode-mcp`. Coding parents stay off.

## R7 · Run each task in a per-folder OpenCode server inside a Landlock sandbox

**Priority:** On hold. Please don't start this until Boundary's Phase 6 spike chooses the Landlock route (ADR 0028 §14). If it chooses native OpenCode behind the host bridge, this item is withdrawn.

**Why.** With a parent such as `~/Code` mounted on `opencode`, every process in that container can reach every repo under it. The allowlist (R6), `external_directory: deny` and the skill are all checked by the agent's own side, which a prompt injection controls. Landlock lets a process restrict its own file access, irreversibly and for everything it spawns, without extra container privileges. OpenCode runs its file tools inside the server process. So the sandbox has to wrap a server per folder, not a session inside one shared server.

**Ask.**
- **Sandboxed servers:** `opencode-mcp` starts an OpenCode server per task folder, or reuses one already running for that folder, inside a Landlock sandbox. The sandbox allows:
  - the task folder: read-write;
  - runtime paths: read-only. Boundary's spike S1 will list them (system libraries, the Bun/Node runtime, `/etc`, `/tmp`, tool caches);
  - the OpenCode data volume: read-write.

  Nothing else under any mount is allowed.
- **Lifecycle:** servers start on demand and stop after an idle timeout.
- **Image:** the opencode image ships the wrapper (`landrun` or equivalent).
- **Capability:** `/health` reports `sandbox: "landlock-v<ABI>"` when active, or `sandbox: null` when the kernel lacks Landlock. In that case tasks run as today.

**Acceptance.** From inside a task sandboxed to `~/Code/a`, each of these fails with a permission error:
- reading `~/Code/b/README.md` with the file tool;
- `cat ~/Code/b/README.md` and `cd .. && ls` from the shell;
- `python3 -c "open('/Users/…/Code/b/x')"` and `node -e` equivalents;
- following a symlink in `a` that points into `b`;
- reading through `/proc/self/root/…`.

`git status`, the project's test command and file edits inside `a` succeed. `/health` reports the ABI version.

**Boundary fallback.** None. Coding parent folders aren't offered, and every grant mounts its own folder with a restart.

## R8 · Read Hermes's write-safe roots from a file

**Priority:** Later.

**Why.** Boundary no longer recreates `hermes` on a grant, so chats don't drop. `HERMES_WRITE_SAFE_ROOT` is fixed when `hermes` starts, so Hermes's own `write_file` and `patch` can't touch a newly granted folder until it restarts. Boundary shows this as "Hermes can edit after its next restart". The coding agent works there immediately.

**Ask.** When `HERMES_WRITE_SAFE_ROOT_FILE` is set, have the write-safe check read extra roots from it on every write, in the same format as R6, using the union of `projects` and `global`. Keep the environment variable as the base.

**Acceptance.** After Boundary rewrites the file, Hermes can `write_file` into the new root with no restart, and a path in no root is still blocked.

**Boundary fallback.** Hermes picks up new roots at its next restart. That happens on app launch, on a stack restart, or after a read-only source change. The Folders row offers *Restart Hermes now*.
