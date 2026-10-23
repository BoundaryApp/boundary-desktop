# 0013. Project sources are a right-rail inspector

- Date: 2026-09-25
- Status: Accepted
- Parent: [0003](0003-workbench-chrome.md)
- Related: [0002](0002-chat-as-product-home.md), [0014](0014-tabbed-inspector.md)

## Context

A Workbench project is one writable hub: a library child of `/opt/projects/<slug>`, or a host folder bind-mounted at that path (0002, 0003). Users also need a second tree — notes vaults, research dumps — without promoting it to a library project or a picker row. The sibling assistant stack already treats extra dirs as `sources.yaml` rows plus a generated `INDEX.md`. H and I in the chat UX kit sketched the inspector. Mixing any two of hub, registry, catalog, mount visibility, and LightRAG is the failure this feature exists to prevent.

## Decision

Extra host folders are **file context for the active project** — a directory plus a retrieval policy — not a second project, not a chat, and not LightRAG.

1. The right rail is the inspector. It lists source directories (hub + extras) with Open. The left-rail picker and composer chip stay hub-only.
2. Source of truth for extra folders is `sources.yaml` in the hub. Missing file means hub only. Extra paths are absolute host paths. `retrieval` is `files`. `lightrag` and `both` stay reserved and disabled.
3. Do not list individual files on the rail. `INDEX.md` remains an agent catalog generated on the Mac. Open a source directory in the native file manager (`shell.openPath`) when the user wants to see what’s in it.
4. Add folder is not Change folder / New project. Refuse `$HOME`, `/`, the hub, and other library projects. A path already under a coding root is allowed with a writable warning.
5. Phase 1 reads and writes hub files and tells the truth about mounts. It does not inject INDEX into the system prompt. Phase 2 remounts extra context roots in-app via the projects overlay and `recreateHermesForProjectMounts()`.
6. Living spec: [`docs/chat-ux-study/08-sources.html`](../chat-ux-study/08-sources.html). Source for the add flow: [`09-add-source.html`](../chat-ux-study/09-add-source.html). Keep the kit. Remount follow-on notes live in [`phase-2.md`](../chat-ux-study/phase-2.md).

## Consequences

- Product chrome lists source directories with Open on the Workbench right rail when a project is active. The file tree and Index preview stay out of the UI.
- Extra folders never appear in `projects.list`, the picker, or the composer chip.
- An unmounted extra stays “Not visible”. Do not write a success state after a failed remount.
- Extra context roots persist on `CONTEXT_EXTRA_ROOTS` and identity `:ro` binds in `docker-compose.projects.yml`. They are not added to `HERMES_WRITE_SAFE_ROOT`. Packaged users remount from the inspector, not a Makefile.
