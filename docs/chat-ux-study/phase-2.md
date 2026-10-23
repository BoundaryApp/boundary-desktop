# Project sources Phase 2

Phase 1 shipped the Accepted sources inspector: read/write `sources.yaml`, show mount honesty, list source directories with Open, refresh the agent `INDEX.md` catalog on the Mac.

Phase 2 remount is shipped: persist `CONTEXT_EXTRA_ROOTS`, identity `:ro` binds on the generated projects overlay, reuse `recreateHermesForProjectMounts()`. Cite [0013](../adr/0013-project-sources-inspector.md). Extra folders stay file context, not a second project.

## Shipped

1. Own extra mounts in-app — Boundary’s `docker-compose.projects.yml` (already `-f`’d). Extra paths stay host-absolute. Never mount `$HOME` or `/`. A coding-root path stays writable; do not silently remount it read-only. Do not add extras to `HERMES_WRITE_SAFE_ROOT`.
2. Replace CLI cards — after remount, Not visible → Read-only and Refresh index. Packaged-app users never leave the inspector for a Makefile.
3. Local-stack — extras go through Boundary’s projects overlay, not sibling `docker-compose.override.yml`. Explicit `-f` compose args skip that override.

## Still forbidden

- LightRAG ingest / `retrieval: lightrag|both` until the indexer accepts them.
- Merging `sources.yaml` into `projects.tree` or gateway `folders[]`.
- Extra folders in the left-rail picker or composer chip.
- Migrating host-folder projects into “empty library + one source.”
