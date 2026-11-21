# 0067. Removing a project

- Date: 2026-11-17
- Status: Proposed
- Amends: [0024](0024-chats-belong-to-projects.md) (adds the removal its Consequences describe)
- Related: [0013](0013-project-sources-inspector.md), [0017](0017-project-inference-pin.md), [0028](0028-coding-folders.md), [0062](0062-the-stack-runs-on-a-stack-host.md)

## Context

Boundary has no way to remove a project. Its project store has a `removeStoredHermesProject` helper that only tests call, and the project menu offers **Change folder**, **Open in Finder**, **Check a file…**, **Turn off coding** and **Refresh index**.

Every project reaches the agent as a folder under `/opt/projects/<slug>`. A folder project is the user's own folder, bound there by Boundary's compose overlay (`docker-compose.projects.yml`), with an empty placeholder at `projects/<slug>` in the user content folder so the bind has a mount point. A Boundary-made project (`kind: 'empty'`) is the folder `projects/<slug>` in the user content folder itself.

The stack's project list comes from disk. Checked in the stack's `projects_library.py` and Hermes's `tui_gateway/methods_projects.py` and `hermes_cli/projects_db.py` (image `nousresearch/hermes-agent:v0.23.1` with the stack's overlay):

- `projects.list` lists each non-hidden child of `/opt/projects`. A database row only adds metadata to a folder that exists, and a row whose library folder is gone is left out.
- `projects.delete` deletes the database row and its folder rows. It never touches disk, so a project whose folder still exists comes back as a synthetic `fs:` entry on the next list.
- `projects.archive` sets `archived = 1` on a database row. It takes database ids only: a project never selected has only an `fs:` id, and archiving it fails with error 5062 (`no such project`). An archived project's files stay under `/opt/projects`, where the agent can read them.

Boundary's merge (`hermesProjectsMerge.ts`) keeps a stored folder project that the stack no longer lists, so the stack can't drop one; Boundary has to.

## Decision

1. **The project menu gets Remove project….** It opens a sheet that names the project and says what happens to its chats and its files. The sheet differs by kind (2 and 3).
2. **A folder project is removed and its folder is left alone.** The sheet says the folder stays where it is and that the agent loses access to it. Removing it:
   1. turns off coding when the project has it, in the same restart, and refuses while a coding task is running unless the user chooses to stop it (ADR 0028);
   2. removes the record from the store, clears it as the active project, and rewrites the overlay and recreates Hermes through the folder remount queue (`syncOverlayAndRecreate`), with the same prepare and rollback shape as **Change folder**. A failed recreate puts the record and the active project back;
   3. drops the project's extra source folders from `CONTEXT_EXTRA_ROOTS` (`collectContextExtraRoots` with `drop`). `sources.yaml` lives in the user's folder and is not changed, so adding the folder again brings its sources back;
   4. deletes the placeholder `projects/<slug>` in the user content folder through `StackFiles`, only when it is empty. Finder's own files (`.DS_Store`, `._*`, `.localized`) don't count. A placeholder with other files is left and logged, and the stack lists it, so it comes back as a Boundary-made project;
   5. calls `projects.delete` on the gateway when the record has a non-`fs:` `hermesProjectId`. A failure is logged and doesn't fail the removal, because the stack already leaves out a row whose folder is gone.
3. **A Boundary-made project is removed by moving its folder to the Trash.** Its files exist only in that folder, and the stack lists any folder there as a project, so removing it means deleting it. The sheet leads with what would be lost, the way the coding folder delete review does (ADR 0028 §11): file count and size, last change, and unpushed git commits. It asks for the typed project name under the same rule (`deleteNeedsTypedName`). The action is **Move to Trash**. After the move Boundary removes the record, clears it as the active project and calls `projects.delete` as in 2.5. No Hermes restart is needed: the folder sits inside the existing `projects` bind. The move comes first, in the main process (`shell.trashItem`, as the coding folder delete does). If it fails, nothing else changes and the sheet shows the error. When the folder is already gone, Boundary skips the move and the typed name and removes the record. A folder someone put in `projects/` by hand gets a record of this kind from the merge, so it gets this sheet.
4. **No project is active afterwards.** When the removed project was active, Boundary stores none as active and calls `projects.set_active` with a null id, which clears the gateway's pointer. The merge already keeps an explicit none (`resolveActiveProjectId`), so removing the last project leaves the picker on *No project*.
5. **A folder project needs the stack running.** Its removal fails like **Change folder** does when the recreate fails, and the rollback restores the record and the active project. A Boundary-made project's removal works with the stack stopped; the gateway steps are skipped and the next list drops the row.
6. **Removal waits for the project's replies.** While a reply in one of the project's chats is running (`projectTurnRunning`), the sheet's action is disabled and says so. A folder project's removal restarts Hermes like **Change folder** does, and is held by the remount queue the same way.
7. **Chats and channels stay.** They show under *No project* and keep their stored project id, as ADR 0024 already says. No chat is deleted. Channel filing already treats an unknown project id as none (`fileChannels`). Pending coding access requests for the project are dismissed.
8. **Remote stack hosts: Boundary-made projects only, no Trash.** A remote host has no folder projects (`hostFolders` capability), and its user content folder is on the other machine, where Boundary can't use the Trash. In this ADR the sheet opens there with its action disabled and a line saying removal on a remote host isn't available yet. Permanent deletion on a remote host is a separate decision.
9. **Local agent stack mode** (a developer checkout) follows 2 except for the overlay, which that mode never reads. The record, placeholder and gateway row are still removed.

## Consequences

- Removing a folder project restarts Hermes, so it interrupts replies running in other projects, as creating a project and **Change folder** already do.
- A Boundary-made project can't be hidden and kept. Its files go to the Trash, where the user can restore them from Finder. Moving the folder back into `projects/` brings the project back as a new project with the default model setting.
- A removed project's model pin (ADR 0017) and its coding grant are gone. Re-adding the folder starts with both at their defaults.
- Re-adding a folder or restoring a Boundary-made folder creates a new project id, so the old chats stay under *No project*. They can be moved with **Move to project…**; nothing re-links them.
- Boundary starts depending on `projects.delete` and on the stack listing projects from disk. The [stack contract](../stack-contract.md) gets both.
- The stack's `projects.archive` stays unused. An archive with **Restore** would need it to accept `fs:` ids, and would still leave the files readable by the agent.
