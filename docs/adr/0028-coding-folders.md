# 0028. Coding folders: the coding agent works in folders the user grants

- Date: 2026-10-07
- Status: Proposed, amended 2026-10-07 (deleting folders after review; coding parent folders behind per-task sandboxing; grants no longer restart Hermes; grants share the host bridge's model; restart-free route is a spike between Landlock and native OpenCode), amended 2026-10-08 (stack R1/R2: app-managed flags and project aliases)
- Change requests: [0003](../change-requests/0003-coding-folders.md)
- Parent: [0013](0013-project-sources-inspector.md)
- Related: [0027](0027-host-bridge.md) (grants, approvals, audit), [0005](0005-folder-first-create-flow.md), [0006](0006-tool-approval-interrupt.md), [0024](0024-chats-belong-to-projects.md), [credential-handling-plan.md](../credential-handling-plan.md)
- Mock: [`docs/chat-ux-study/12-coding-folders.html`](../chat-ux-study/12-coding-folders.html)
- Build plan: [`docs/coding-folders-plan.md`](../coding-folders-plan.md)

## Context

Hermes hands coding work to OpenCode through `opencode-mcp`. In Boundary's stack, OpenCode can only see one host folder, `<stack home>/workspace`, mounted at its own path (`resources/assistant/docker-compose.boundary.yml`). Nothing in the app adds another.

- **Host-folder projects aren't reachable.** The projects overlay binds a host-folder project into `hermes`, `hermes-worker` and `hermes-webui` at `/opt/projects/<slug>`, but not into `opencode`. When Hermes delegates work in the project, the coding agent can't find the files.
- **The stack already has the mechanism.** `opencode-mcp` allows a task directory only if it equals or sits under `OPENCODE_WORKSPACE_HOST` or an entry in `CODING_EXTRA_ROOTS` (colon-separated, read once at process start). Outside those it returns `{needs_access: true, path, hint}`, and the `delegate-coding` skill tells the user to run `make coding-root-add` and recreate containers. Packaged users can't act on that.
- **Coding roots are host-absolute everywhere.** `coding-root.sh` binds each root read-write at its own path on the terminal service (`hermes-worker` with the ssh backend) and `opencode`. `HERMES_WRITE_SAFE_ROOT` on `hermes` appends `${CODING_EXTRA_ROOTS}`, which is why the variable carries a leading colon. Nothing translates `/opt/projects/<slug>` to a host path, and the skill says not to invent `/opt/...` aliases.
- **The grant is larger than Hermes's own edits.** OpenCode runs headless with every permission allowed. Hermes asks before risky tool calls (0006); the coding agent never does.
- **One coding agent serves every project.** Mounts and `CODING_EXTRA_ROOTS` are per container, not per project.
- **A restart loses work in flight.** `opencode-mcp` keeps tasks in memory only. Recreating it, or `opencode` mid-task, fails or orphans the running task. OpenCode's own sessions survive in the `opencode_data` volume, and `GET /session/status` reports which ones are busy.
- **Mounts are fixed when a container is created.** Every new grant costs a restart. Granting a parent folder once (such as `~/Code`) would make later folders under it free, but the coding agent could then reach every repo under the parent. Instructions, `opencode-mcp`'s allowlist and OpenCode's `external_directory` permission are all checked by the agent's own side. Prompt injection, the threat in the credential plan, gets past them. Inside a container only the kernel can enforce a narrower view.
- **The container engine shares only part of the disk.** Boundary's Podman machine, like Docker Desktop's default, shares the home folder. A path on an external volume mounts empty or fails.

## Decision

1. **Every project folder has one of two access levels.** *Read-only* is today's context root (0013). *Coding* means the coding agent can edit files and run commands there, and Hermes can edit it too from its next restart (§4). The UI says "the coding agent", never OpenCode. The Project tab's Sources list becomes **Folders**, and each row shows its level as a pill and a "who can do what" line.
2. **Grants are made per project and are reachable from every project.** The user grants coding access from a project (its Folders list, its own folder, or a chat in it). The consent step and Settings both state that chats in other projects can reach the folder too. We don't pretend to isolate projects the containers don't isolate.
3. **Boundary owns the grant list.** A coding grant is a record in Boundary's store: host path, the project that added it, where it came from (`add`, `project-folder`, `chat`, `new-folder`), and whether Boundary created the folder. `sources.yaml` keeps listing extra folders so `INDEX.md` covers them, but it doesn't carry access levels, because it is the stack's format. The project's own folder is granted by a flag on the project record.

   Coding grants use the host bridge's grant shape (0027 §7): capability `coding`, resource = the folder's host path, `createdAt`, and `expiresAt` (always null for coding). The coding-specific fields sit beside these. Until the bridge's store merges, coding grants live in their own store with that shape, so joining the two is a move, not a migration of meaning. The in-chat card (§9) uses the bridge's approval card once it lands, and grants appear in the same audit log.
4. **Grants become identity mounts and `CODING_EXTRA_ROOTS`.** On every change Boundary:
   - writes the grant paths to `CODING_EXTRA_ROOTS` (colon-prefixed) in the stack `.env` and in the compose environment it passes, with `CODING_ROOTS_APP_MANAGED=1`, `CONTEXT_ROOTS_APP_MANAGED=1` and `CODING_PATH_ALIASES` (one `/opt/projects/<slug>=<host path>` pair per host-folder project; change request 0003 R1, R2);
   - adds a read-write bind `P:P` for each grant on `opencode` and on the terminal service, in the generated projects overlay;
   - recreates `opencode`, `opencode-mcp` and the terminal service (`hermes-worker`, since Boundary runs the ssh backend). It doesn't recreate `hermes` or `hermes-webui`, so chats keep streaming through a grant.

   `HERMES_WRITE_SAFE_ROOT` is fixed when `hermes` starts. Hermes's own edits in a newly granted folder therefore start at its next restart, while the coding agent can work there at once. That restart comes with app launch, a stack restart, a read-only source change, or *Restart Hermes now* on the folder's row. Change request R8 would remove the lag.

   A granted project folder keeps its `/opt/projects/<slug>` bind and also gets the identity bind, so Hermes and the coding agent agree on its host path. A grant already covered by another grant adds no mount.
5. **Refuse folders that are too broad or Boundary's own.** Never grant `/`, the home folder, any ancestor of the home folder (such as `/Users`), system folders (`/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/dev`, `/cores`, `/Applications`), the user's `~/Library`, Boundary's user data and stack home, or any folder that contains one of these. The stack's own check only blocks `/` and the exact home path, so Boundary enforces the rest before writing anything.
6. **Hide secrets at mount time.** For each granted folder, Boundary shadows top-level `.env` and `.env.*` files (not `.env.example`, `.env.sample` or `.env.template`) with an empty read-only file on `opencode` and the terminal service, as the stack's override example recommends. Boundary rescans on every remount. A `.env` created after the grant isn't hidden until the next remount, and the consent step says secrets in `.env` files are hidden, not all secrets.
7. **Say when a restart will stop work, and don't claim success early.**
   - Before recreating, Boundary checks for a busy OpenCode session (`GET /session/status`) and for a running chat turn whose last tool is a coding tool. If either is busy, it offers *Add when it finishes* (the default) or *Stop task and add*.
   - A grant shows Connecting until Boundary has run `test -d <path>` inside `opencode` and it passed. A failed check leaves the row *Not visible*, with the container engine's file-sharing limits as the stated cause.
8. **Boundary only ever creates new, empty folders.** *New folder…* takes a name and an existing parent, refuses a name that's already taken, and offers *Use existing folder* instead. *Start a git repo* is on by default and makes an empty first commit with the host's `git`. Without host `git`, the option is off and says why.
9. **Hermes asks, the user grants, then the chat resumes.** When a `coding_start_task` result carries `needs_access`, Boundary replaces the skill's `make` hint with a coding-access card in the thread (the 0006 interrupt family). If the path doesn't exist on the host, the card offers to create it (decision 8). After the grant succeeds, Boundary sends a short visible follow-up turn ("Coding access to `<path>` is ready.") so Hermes retries. Hermes never grants access itself.
10. **Removing access downgrades by default.** Removing a grant keeps the folder as read-only reference in its project unless the user picks *Remove from project*. Neither option touches files on disk.
11. **Boundary deletes a folder only after the user reviews and accepts it.**
    - **Where:** *Delete the folder from this Mac…* is the last option when removing a grant, in Settings and in a Folders row's menu. It is never the default.
    - **Scope:** it applies only to granted coding folders, and never to a project's own folder.
    - **Review step:** the user always sees one first. It shows:
      - the path, file count and size;
      - when the folder last changed;
      - whether Boundary created it;
      - its git state: commits on no remote and files with uncommitted changes.
    - **Confirming:** if the folder has unpushed commits or uncommitted changes, or Boundary didn't create it, the user types the folder name to enable the button. A folder Boundary created that is clean and fully pushed needs one click.
    - **Running tasks:** while a coding task runs in the folder, deleting is disabled until the task stops.
    - **How it deletes:**
      - Boundary removes the grant and recreates the containers so nothing holds the mount.
      - It then moves the folder to the Trash with `shell.trashItem`.
      - It never deletes permanently and never empties the Trash, so every deletion can be undone in Finder.
      - A failure at any step stops before the folder moves.
    - **Hermes can't trigger this.** Agents have no path to Boundary's delete action. Inside a granted folder the coding agent can still delete files with its own tools, which is part of what the consent step describes.
12. **Defaults never grant silently.**
    - A new project made from a git repo starts with coding on, and the switch states the consequence.
    - Other new projects start with coding off.
    - Existing projects stay off after upgrading.
    - Changing a project's folder turns coding off; the new folder needs its own grant.
13. **Local-stack mode isn't managed.** When Boundary drives a developer's own stack checkout, Folders shows each folder's real visibility and gives the `make coding-root-add DIR=…` command instead of granting. That stack's compose files and override belong to the developer.
14. **Restart-free grants: a spike decides between two kernel-enforced routes.** Per-folder mounts with a coding-agent restart (§4) stay the baseline and the fallback. Two routes can remove the restart while keeping enforcement outside the agent's control:
    - **Landlock in the container (below):** a coding parent mounted once, with a per-task Landlock sandbox in `opencode-mcp`. It keeps the virtual-machine boundary, and it needs change requests R6 and R7.
    - **Native OpenCode behind the host bridge:** Boundary starts an OpenCode server per grant on the Mac under a `sandbox-exec` profile, and Hermes reaches it through the bridge (0027). There are no mounts and no restarts, and file-pattern denies hide `.env` and `~/.ssh` in any repo. It also gives native toolchains (Xcode, the user's Node). The costs are weaker isolation (an escape lands on the Mac, not in a VM), a deprecated sandbox API, and Boundary owning the OpenCode binary and its processes.

    The spike runs the same escape tests, toolchain checks and timing on both. Its results go into the build plan, and this ADR is amended with the choice. Until then, neither route ships.

    **If Landlock is chosen, coding parent folders are allowed only behind per-task sandboxing.** A *coding parent* is a folder such as `~/Code` that is mounted once, so folders under it can be granted, or created by Boundary, with no restart. Mounting the parent never grants it. The user still grants each folder under it, and the agent may only touch what was granted. Boundary enforces this in layers, and only the first one is a guarantee.
    - **Enforcement (kernel):**
      - `opencode-mcp` runs each task in an OpenCode server started for that task's folder, inside a Landlock sandbox.
      - The sandbox allows the granted folder (read-write), system and tool paths (read-only), and OpenCode's data volume. Nothing else under the parent is allowed.
      - The allowed set is the grants of the chat's project, so parent mode also removes the cross-project reach in §2.
      - Landlock can't be lifted once applied and covers everything the task spawns: file tools, shell and child processes. It needs no extra container privileges.
      - Servers start on demand and stop when idle.
    - **Guidance (no guarantee):**
      - The `delegate-coding` skill and project context say to work only in granted folders.
      - `opencode-mcp` re-reads its allowlist from a file Boundary writes, on every request, so the `needs_access` card keeps working without a restart.
      - Boundary's OpenCode config (`BOUNDARY_OPENCODE_CONFIG_FILE`) sets `external_directory` to `deny`.

      These keep a well-behaved agent on track and give clean errors.
    - **Detection (main process):** Boundary watches the parent for writes outside the grants and offers a git revert. It can't see reads, which is why detection is never the protection.
    - **Hermes's command container never gets the parent.** It keeps one mount per grant, so Hermes's own edits in a newly granted folder wait for its next restart. The coding agent can work there at once.
    - **`.env` hiding stays mount-time.** Landlock can only allow folders, not deny files inside them. Repos created under the parent after the last restart have no shadows until the next one, and the consent step says so.
    - **Gate:**
      - Boundary offers coding parents only when the stack advertises per-task sandboxing (change requests R6 and R7).
      - The kernel must report a Landlock ABI that covers file access; Boundary checks this in the opencode container at start.
      - If either check fails, parent grants are hidden and existing ones fall back to per-folder mounts with restarts.
      - Without the sandbox, the UI would have to say the agent can reach everything under the parent. We don't ship that.

## Consequences

- **Deleting is recoverable by design.** The Trash is the undo, and the review step is the explicit prompt. A user who empties the Trash afterwards loses the folder, and unpushed commits with it, which is why the review leads with them.
- Delegated coding works in host-folder projects and in any folder the user grants. The `make coding-root-add` reply no longer reaches packaged users.
- **Every grant restarts the coding agent,** about 10 seconds. Chats keep working. A coding task in flight is lost, which is why §7 checks first. Hermes's own edits in the new folder wait for its next restart, and the folder's row says so.
- **The grant list is visible in two places:** the project's Folders list (that project's grants) and Settings › Coding agent (every grant, machine-wide).
- **`.env` shadowing is a mitigation, not a boundary.** The coding agent can still read secrets in other files, and in `.env` files created after the last remount.
- **The skill's wording follows the app.** From the stack tag after v0.3.1, `CODING_ROOTS_APP_MANAGED` makes the `needs_access` hint say "the app will ask", and `delegate-coding` names the folder and ends the turn. Until Boundary pins that tag, the skill's `make` hint still appears in Hermes's reply above the card.
- **Restart-free grants wait for the spike.** Until it chooses a route, and that route's dependencies land (R6 and R7 for Landlock, a shipped OpenCode binary and sandbox profile for native), every grant costs a coding-agent restart. With them, a parent costs one restart and later grants are free. Each active folder then costs one OpenCode process.
- **External volumes need a user step.** The Podman machine must share the volume, or the repo must move under the home folder. Boundary explains this; it doesn't reconfigure the machine.
- Code that changes:
  - `hermesProjectsOverlay.ts` (coding binds and shadows), `AssistantStackService.ts` (compose env and the wider recreate set), `hermesContextRoots.ts` (coding roots from the grant store).
  - `hermesProjectSources.ts` and `projectSourcesModel.ts` (access levels, refusals), a new `codingGrants` store and service.
  - `ProjectSourcesRail.tsx` and `AddSourceSheet.tsx`, a new Settings › Coding agent screen, and the chat runtime's tool-result handling.
