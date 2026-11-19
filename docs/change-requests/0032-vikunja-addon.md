# 0032 · Vikunja as an add-on: a manifest, setup through `addon.sh`, a signed-in link, and its data on remove

**Serves:** [add-ons spec](../addons-ux-study/spec.md) (the "Tasks" row of the add-on table).
**Status:** R1–R4 in stack 0.3.15 (c1bb98a; Boundary pins it) · R5 deferred

## Background

Vikunja is the stack's todo app. Its containers are in `docker-compose.yml` under the `todo` profile, its MCP server is registered by the Hermes bootstraps as `todos`, and setup is the sequence in the stack's `docs/todo.md`: `setup.sh --todo`, `make up`, `make todo-init`, `make hermes-reload`. It has no manifest under `addons/`, so `addon.sh list --json` doesn't report it and Boundary's add-on store can't offer it.

Boundary sets `COMPOSE_PROFILES` itself and doesn't run `make`, so a Boundary-managed stack never starts Vikunja. A user who has todos in a developer stack has nowhere to move them in Boundary.

Checked against stack main at a22506a (12 Nov 2026):

- `scripts/sync-profiles.sh:39` maps `VIKUNJA_MCP_ENABLED` to `todo` by hand, the row a manifest's `builtin` block replaces.
- `compose/hermes/bootstrap-api-profile.sh` registers `todos` itself (`VIKUNJA_MCP_KEY`, the token per profile, the pinned tools). `scripts/lib/addon_manifest.py:97` lists `vikunja` in `CORE_MCP_NAMES`, while the registered name is `todos`.
- `todo.sh prepare` (register the `vikunja` schema with `db.sh service-add`, mirror the password as `VIKUNJA_DATABASE_PASSWORD`, create the files directory) runs from `todo.sh ensure`, which only `make ensure-local` calls. `addon.sh enable` runs flags, one-shot services, `up` and then `hooks.init`, with nothing before `up` that would run `prepare`.
- `todo.sh init` needs the stack up, writes `VIKUNJA_USERNAME`, `VIKUNJA_PASSWORD` and both MCP tokens to `.env`, and asks nothing, so it fits `hooks.init` as it is.
- `todo.sh open` opens `http://localhost:${VIKUNJA_PORT}/login-local`, which `vikunja-proxy` serves and signs in with the stored password.
- The data is the `vikunja` schema in the shared Postgres plus `VIKUNJA_FILES_DIR` (default `./data/vikunja/files`). A manifest's `data` lists paths and volumes, not a schema.

## R1 · A manifest for Vikunja (Blocking)

**Why:** the add-on store lists what `addon.sh list --json` returns. Without a manifest, Boundary can't offer Vikunja at all.

**Ask:** `addons/vikunja/addon.json` with:

1. `builtin`: flag `VIKUNJA_MCP_ENABLED`, profile `todo`, replacing the hand-written row in `sync-profiles.sh`.
2. `services` for `vikunja` and `vikunja-proxy`, with the proxy's port.
3. The `mcp` block for `todos`: the read/write token on `default` and `browser`, the read-only token on `api-server`, the pinned tools the bootstrap pins today. The hard-coded registration in the bootstraps goes away, and `CORE_MCP_NAMES` stops reserving `vikunja` if nothing else needs it.
4. `hooks.init`: `scripts/todo.sh init`.
5. `data.paths`: `VIKUNJA_FILES_DIR`. `backup.secrets`: `VIKUNJA_SECRET` if a set value matters to existing sessions, and `VIKUNJA_PASSWORD` under `recommended`.
6. `permissions` (no egress) and the `store` fields from [CR 0027](0027-addon-store-metadata.md).
7. A title that doesn't say "Tasks". Boundary's **Tasks** screen is the Hermes kanban board, and `docs/todo.md` already calls this "todo lists".

**Acceptance:** `addon.sh list --json` includes `vikunja`; `addon.sh enable vikunja` on a fresh install starts Vikunja and its proxy, creates the account and tokens, and `todos` tools appear on `default` and `browser` (read/write) and `api-server` (read-only); the existing `test-vikunja-token-scope.sh` passes through the manifest path.

**Boundary fallback:** none. Vikunja stays unavailable in Boundary-managed stacks; developers keep the `make` route.

> **Stack reply (12 Nov 2026):** on stack main at c1bb98a, not in a tag; the next 0.3.x tag carries it. Fresh-install `enable` and a live `remove --delete-data` are still to be run before the tag. The manifest is `addons/vikunja/addon.json`, titled "Todo lists". Unchanged from the ask: flag `VIKUNJA_MCP_ENABLED`, profile `todo`, server `todos`, its URL and pins, the read/write token on `default` and `browser`, read-only on `api-server`. With Vikunja 2.8.0 the read/write token gets 28 tools and the read-only one 12. Differences:
>
> - **`mcp.auth`** is a new manifest field, `{header, scheme, env: {ro, rw}}`, naming the `.env` variable that holds each level's token. With `auth` set the stack writes no `tools.include`, so Vikunja's token scopes decide the tools. `mcp-plan` lines gain four fields.
> - **Permissions:** `uses: ["postgres"]`, egress `["postgres"]` and `exposesToAgent: true`, which the validator requires for anything in the shared Postgres. The SQL add-on's `agent_ro` and `agent_rw` roles can read the `vikunja` schema, including its user and token tables (hashes only).
> - **Backup:** `VIKUNJA_SECRET` is under `recommended`, not `secrets`; it only signs browser sessions. `VIKUNJA_PASSWORD` isn't listed, because `init` resets the password when a login fails.
> - **Profile key:** each profile's `.env` now holds the token as `TODOS_KEY`. `VIKUNJA_MCP_TOKEN` stays but is no longer read.
> - **Re-init:** on an install set up with `make todo-init`, the first `addon.sh enable vikunja` runs `init` again and replaces both tokens.

## R2 · `prepare` before `up` on the `addon.sh enable` path (Blocking)

**Why:** `enable` starts the services before any hook runs, and Vikunja needs its schema registered and its env file written first. `make ensure-local` does that today; Boundary never runs it.

**Ask:** a step `addon.sh enable` runs before `up`, either a manifest hook (for example `hooks.prepare`, run before services start) or `addon.sh enable` calling `todo.sh ensure` the way `make ensure-local` does. A hook is the better shape if other add-ons need a schema in the shared Postgres.

**Acceptance:** on an install where `compose/postgres/services/vikunja.env` doesn't exist, `addon.sh enable vikunja` succeeds without `make` and Vikunja reaches healthy.

**Boundary fallback:** none.

> **Stack reply (12 Nov 2026):** built as a manifest hook, `hooks.prepare` (script only). `enable` runs it on every enable as step `prepare`, before step `flags`; a failed prepare leaves the add-on as it was. Vikunja's is `todo.sh prepare`, which is idempotent. `todo.sh prepare` and `init` take `--json`, and `init` ends with `{"phase":"done","account":"<username>","mcp":["todos"]}`, so `enable --json` reports `account`.

## R3 · A signed-in link Boundary can open (Wanted)

**Why:** Vikunja's web app is how a person sees and edits their lists. Boundary opens Twenty and Actual from their add-on pages and should do the same here, without holding the password.

**Ask:** a way for Boundary to get the URL `todo.sh open` opens, without opening a browser on the stack's side. Either `todo.sh open --print` (one line, the URL) or a field in `addon.sh list --json` that names the proxy port and the `/login-local` path.

**Acceptance:** Boundary can open the web app signed in, using only the URL it was given.

**Boundary fallback:** Boundary opens `http://localhost:<VIKUNJA_PORT>/login-local`, with the port from the stack's `.env` (default 3456), only while the add-on is on.

> **Stack reply (12 Nov 2026):** built as a manifest field instead of `todo.sh open --print`. The manifest's `web: {service, path}` becomes a `web` key on every object in `addon.sh list --json`: null, or `{service, path, url}`. `url` is `http://localhost:<host port><path>` with the port compose publishes, so a `VIKUNJA_PORT` override is picked up; Vikunja's is `http://localhost:3456/login-local`, which signs the browser in. `url` is null when compose config fails, the port isn't published, or the service's gate flag is off. Open it only while `enabled` is true. Twenty (gated on `TWENTY_LOCAL_ENABLED`), Actual and n8n got `web` too, at `/`.

## R4 · Removing the data (Wanted)

**Why:** `addon.sh remove --delete-data` deletes the paths and volumes in `data`. Vikunja's tasks live in a schema in the shared Postgres, so the delete would keep every task while reporting the data gone.

**Ask:** a way for `remove --delete-data` to drop the `vikunja` schema and its role, such as a manifest field for a shared-database schema or a `todo.sh` command that `remove` calls.

**Acceptance:** after `remove --delete-data vikunja`, the schema and role are gone from the shared Postgres, the files directory is gone, and a later `enable` starts with an empty account.

**Boundary fallback:** the remove sheet says the lists stay in the shared database. Boundary offers no delete-data choice for this add-on until this lands.

> **Stack reply (12 Nov 2026):** built as a manifest field, `data.schemas` (Vikunja: `["vikunja"]`). It requires `uses: postgres`, and no two add-ons may declare the same schema.
>
> - `remove --delete-data` and `disable --purge` run `scripts/db.sh service-remove <schema> --yes`: drop the schema with CASCADE and everything role `svc_<schema>` owns, then the role, then delete `compose/postgres/services/<schema>.env`.
> - If `postgres-db` isn't running, `remove` starts it and stops it again afterwards, and only stops it if it started it.
> - New `delete` steps on the event stream: target `postgres-db` for the start and the stop, and target `vikunja` for the drop. A failed drop is `command_failed` at step `delete`, target `vikunja`.
> - `plan-remove` JSON gains `schemas`.
> - The next `enable` after a remove starts with an empty account, reusing `VIKUNJA_USERNAME` and `VIKUNJA_PASSWORD` from `.env` and minting new tokens.

## R5 · Moving lists between installs (Later)

**Why:** people with lists in a developer stack want them in a Boundary-managed one. Vikunja has a per-user export and an importer that reads it, but both go through its web UI, and the two installs can pin different Vikunja versions (2.7.0 in one installed Boundary on this Mac, 2.8.0 on stack main).

**Ask:** `todo.sh export <file>` and `todo.sh import <file>` around Vikunja's own export and import, with a check that the importing Vikunja is the same version or newer.

**Acceptance:** lists, tasks, labels and attachments exported from one install appear in another after import, and an import into an older Vikunja is refused with a message naming both versions.

**Boundary fallback:** none. People use Vikunja's export and import in its web UI.

> **Stack reply (12 Nov 2026):** deferred. When someone needs it, a `pg_dump` of the `vikunja` schema plus the files directory may be simpler than Vikunja's per-user export and import, since Vikunja migrates its own schema on start. It would still need the version check above.
