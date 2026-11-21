# 0037 · Running the stack on a host a client reaches over SSH

**Serves:** [remote stack plan](../remote-stack-plan.md), [ADR 0062](../adr/0062-the-stack-runs-on-a-stack-host.md).
**Status:** R1–R5 released in stack v0.3.16 · R6 and R7 released in v0.3.17 (Boundary refuses an engine-down host as `engine_down`; `LIGHTRAG_LLM_*` stays on the file path while a tree older than the pin can be in use) · R1's Ubuntu run and R2's port check against a live stack pending · profiles, profile `.env` and `mcp_servers` wait on the client gateway

Released in v0.3.16 (its CHANGELOG, "Host scripts" and "Changes"): `scripts/install.sh`, `status.sh` and `backup.sh` without compose-file or project flags (R1, R2), `backup.sh` and `install.sh --skip-volume` (R5), `scripts/env.sh` and Twenty's add-on-level `local` setting (R3, a73d000), and the add-on lock's `STACK_CLIENT` holder shared by `env.sh` (R4). Boundary checked each script at the tag.

The stack replied against its main at 658a0e3. Boundary checked the reply against the stack's source at that commit and against its own code; each **Boundary response** below says what was checked. The stack's second reply describes its main after ad5383a, through the CR 0037 commits 7026363 to 46e96b3; Boundary checked it at stack main 1777365.

## Background

Boundary will be able to run the stack on another machine (a home server, a Linux VM, a Mac mini) and reach it over SSH: commands over the connection, files over SFTP, and the stack's published ports forwarded to the client. Today Boundary installs and upgrades the stack itself, and edits several stack-owned files directly: `.env` flags such as the built-in add-on switches, profile `.env` values (host bridge tokens, MCP env), and `mcp_servers` entries in profile `config.yaml` files. On a remote host Boundary doesn't install the stack, and editing the stack's files over SFTP ties every client to the stack's file layout.

> **Stack reply:** accurate about what Boundary writes today (project `.env`, profile `.env`,
> profile `config.yaml` through the Hermes config exec, `agents/registry.json`). Most of those
> writes already have a planned replacement: the client gateway's control-plane methods
> (`_stack/profiles.*`, `profiles.secrets.set`, `mcp.app_servers.set|remove|wake`, `model.set`,
> `agent.settings.set`), which run over the same WebSocket Boundary will forward to reach the
> gateway. Built-in add-on switches already have one: `addon.sh enable|disable --json`. See R3.
>
> Four things the remote host needs that the CR doesn't raise. Each needs a decision from
> Boundary or from both of us:
>
> - **Models.** The stack's defaults point at LM Studio on `host.docker.internal:1234`. On a
>   remote host that is the server, not the user's Mac. Pushing upstreams through the llm-proxy
>   admin API (`docs/contracts/models.md`) works over a forwarded port, but a model served on
>   the client needs a reverse forward (`ssh -R`) that Boundary owns.
> - **Terminal backend.** Boundary sets `HERMES_TERMINAL_BACKEND=ssh` with the worker key in
>   `compose/hermes/worker/ssh/`. Which machine the agent's shell reaches on a remote host is
>   undecided.
> - **Boundary's compose overlay.** Boundary runs with `docker-compose.boundary.yml`, its own
>   project name and remapped ports. R1 and R2 take `--compose-file` and `--project` so the
>   remote stack can run the same way; if Boundary would rather run the remote stack without its
>   overlay, say so and we drop those flags.
> - **Secrets.** Boundary reads the dashboard password, handoff secret, `API_SERVER_KEY` and
>   `LLM_PROXY_ADMIN_TOKEN` from `.env`. Over SFTP that is a read of the most sensitive file on
>   the host. R2 returns no secrets. Once Boundary is on the client gateway, the only credential
>   it needs is the gateway token (plus the llm-proxy admin token while it pushes upstreams), and
>   we'd add one narrow `credentials --json` read for those rather than have clients parse
>   `.env`.

> **Boundary response:** answers to the four questions.
>
> - **Overlay: drop it on a remote host, and drop `--compose-file` and `--project` from R1 and
>   R2.** Most of what makes Boundary's managed stack Boundary's comes from environment it passes
>   on every compose call, not from the overlay file: the ports, `COMPOSE_PROFILES`,
>   `HERMES_TERMINAL_BACKEND`, `CONTAINER_PREFIX`, `IMAGE_PREFIX`, `SQL_MCP_ENABLED`,
>   `GPTR_MCP_ENABLED`, `OPENCODE_MCP_ENABLED`, the coding roots and `WEB_SEARCH_URL`. On a
>   remote host, `install.sh`, the upgrade hooks, `addon.sh` and `status.sh` run on the host and
>   see only its `.env`, so a stack configured by per-call environment would drift from what
>   those commands recreate. A remote stack is configured the way Boundary already treats a
>   developer's own checkout: the stack's default project name and ports, with the host's `.env`
>   as the only source of its configuration. The overlay's remaining contents are binds of
>   folders on the client (unavailable on a remote host anyway), remapped ports for running
>   beside a developer stack, and healthcheck cadence. What Boundary still needs from it on a
>   remote host has to be settable in `.env`, through `env.sh` or a setup flag:
>   - `LLM_PROXY_AWAIT_PUSH=chat,lightrag` on `llm-proxy`, so no provider key is on disk and the
>     proxy answers 503 until Boundary pushes upstreams. Today the overlay sets it in the
>     service's `environment`.
>   - `TZ` for `caldav-mcp` only. The overlay passes the client's zone to that one service.
>   - `SQL_MCP_ENABLED`, `GPTR_MCP_ENABLED` and `OPENCODE_MCP_ENABLED` at `1`. Setup flags
>     (`--db`, `--research`, `--coding`) cover two of them; please confirm which of the three
>     `env.sh`'s allowlist or a setup flag covers.
> - **Terminal backend: the remote host's own `hermes-worker`.** `ssh` already means Hermes
>   reaches the `hermes-worker` container, not the client, so on a remote host the agent's shell
>   runs in that host's worker. `setup.sh` generates the worker key when it is missing, so
>   install covers it; Boundary's own `ssh-keygen` only serves its managed install.
>   `HERMES_TERMINAL_BACKEND=ssh` needs to be in the remote host's `.env`, which `env.sh`'s
>   allowlist covers. The workspace mounts the worker sees are folders on the client, which a
>   remote host doesn't have until a sync layer exists (the plan's `hostFolders` capability).
> - **Models: deferred to the plan's phase 6.** Boundary already pushes upstreams through the
>   llm-proxy admin API, and that works over a forwarded port. A model served on the client is
>   one of the callbacks phase 6 adds with reverse forwards. Until then a remote stack uses
>   upstreams it can reach itself (cloud providers, confidential pools, or a model server on the
>   remote host), and Boundary's inference settings say so when the host lacks callbacks.
> - **Secrets: yes to `credentials --json`, but covering all four values until Boundary is on
>   the gateway.** Boundary reads the dashboard password, handoff secret, `API_SERVER_KEY` and
>   `LLM_PROXY_ADMIN_TOKEN` today (`hermesEndpoints`, `hermesDashboardAuth`, `hermesBoardLinks`,
>   `llmProxyAdmin`), and the remote host may ship before the gateway move. A read that returns
>   only the gateway token would leave Boundary parsing `.env` over SFTP for the rest. When
>   Boundary has moved to the gateway, the read can narrow to the gateway token and the admin
>   token, as the client gateway plan already says for `.env` reads.

> **Stack reply (2):** the CR 0037 work landed at ad5383a, after the 658a0e3 Boundary checked.
>
> - **`--compose-file` and `--project`:** removed from `install.sh`, `status.sh` and `backup.sh` with no compatibility path, since none of it was released. The stack runs under its default project name with `.env` as its only config.
> - **`LLM_PROXY_AWAIT_PUSH`:** covered. `env.sh` allows every `LLM_*` key except `LLM_PROXY_ADMIN_TOKEN`. `env.sh` starts nothing, so recreate llm-proxy afterwards (`scripts/up.sh` does).
> - **Time zone for caldav-mcp only:** `TZ` also moves hermes, both bootstraps and web-browser, so caldav-mcp now reads `TZ=${CALDAV_TZ:-${TZ:-UTC}}` and `env.sh` allows `CALDAV_TZ`. Recreate caldav-mcp after setting it.
> - **`SQL_MCP_ENABLED`, `GPTR_MCP_ENABLED`, `OPENCODE_MCP_ENABLED`:** each is a built-in add-on's flag, so `env.sh` refuses them with `use_addon_sh`. Use `addon.sh enable sql|gptr|opencode`, or the setup flags `--db`, `--research` and `--coding`. `OPENCODE_MCP_ENABLED` already defaults to 1 on a fresh install.
> - **`credentials --json`:** `scripts/credentials.sh --json` prints one object with `HERMES_DASHBOARD_PASSWORD`, `HERMES_DASHBOARD_HANDOFF_SECRET`, `API_SERVER_KEY` (from `compose/hermes/api-server.env`) and `LLM_PROXY_ADMIN_TOKEN`. A missing or placeholder value is `null`, not an error. It narrows once Boundary is on the gateway.

> **Boundary response (2):** accepted. Checked at stack main: `env.sh`'s `client_writable` takes `LLM_*` (except `LLM_PROXY_ADMIN_TOKEN`), image pins, `HERMES_TERMINAL_BACKEND`, `CODING_*`, `CONTEXT_*` and `CALDAV_TZ`, and `check_key` answers `use_addon_sh` for `COMPOSE_PROFILES` and every `*_ENABLED` key; `caldav-mcp` reads `TZ=${CALDAV_TZ:-${TZ:-UTC}}`; `credentials.sh` prints the four keys and maps an empty or `change-me` value to `null`; `install.sh` passes everything after `--` to `setup.sh --non-interactive`.
>
> On a remote host Boundary sets `LLM_PROXY_AWAIT_PUSH`, `CALDAV_TZ` and `HERMES_TERMINAL_BACKEND` through `env.sh` and then runs `up.sh`; turns on the SQL, research and coding MCPs with `--db`, `--research` and `--coding` after `--` on `install.sh`, or `addon.sh enable` later; and reads the four secrets through `credentials.sh --json`, never by parsing `.env` over SFTP.

## R1 · An install and upgrade command for a host Boundary doesn't manage

**Why:** on a remote host, the stack has to be installed, upgraded and backed up without Boundary's provisioning, which assumes the stack lives in Boundary's own app data.

**Ask:** one command, run on the host, that installs the stack at a given version into a given folder, or upgrades an existing install to that version. It is idempotent, backs up the data root before an upgrade, runs setup, starts the stack, and ends with a machine-readable result (`--json`). It runs on Linux with Docker or Podman, and on macOS with Docker Desktop. Ports are published on the host's loopback only, unless the user asks otherwise.

**Acceptance:** on a fresh Ubuntu 24.04 host with Docker, the command installs the pinned version and the stack passes `doctor.sh`; run again with a newer version, it upgrades in place and keeps chats and memory.

**Boundary fallback:** none. The remote host (plan phase 4) waits for this.

**Priority:** Blocking (phase 4)

> **Stack reply:** accepted, with changes to scope. Plan: `scripts/install.sh --version V --dir D
> [--compose-file F]… [--project P] --json`.
>
> Corrections to the ask:
>
> - **"Backs up the data root" would lose data.** Postgres (Vikunja, Twenty, the `db` add-on)
>   lives in the named volume `postgres_storage`, not under `data/`, as do `opencode_data`,
>   `search_gate_data` and `valkey_data`. There are also two roots: Hermes state in
>   `data/hermes` and user content under `ASSISTANT_DATA_ROOT`. The backup covers both roots and
>   dumps the stateful volumes (`pg_dump` for Postgres, a tar for the rest), and skips caches
>   such as `hermes_uv_cache`. It ships as its own command (`scripts/backup.sh`), which install
>   calls before an upgrade.
> - **Upgrades are not scriptable today.** Each release's "Upgrade steps" in `CHANGELOG.md` are
>   prose: v0.3.16 needs a Bitwarden broker rebuild, v0.3.15 needs `make hermes-reload` and a
>   CalDAV re-connect. Before install can upgrade unattended, those steps become per-version
>   upgrade hooks that install runs in order, and our release rules forbid prose-only steps. A
>   step that needs the user (re-entering a credential) is reported in the result as
>   `needs_user`, not hidden.
> - **Loopback ports are already the default.** Every published port in `docker-compose.yml`
>   binds `127.0.0.1`. Install adds no option to change that; a user who wants otherwise does it
>   in an override file.
> - **Podman is untested.** Nothing in the stack is run under Podman. R1 targets Docker Engine on
>   Linux and Docker Desktop on macOS. Podman stays unsupported until someone runs the suite on
>   it; tell us if a Boundary user needs it.
> - **Fetching the stack.** The command lives in the repo it installs, so a release now
>   publishes a tarball and a SHA-256 checksum as GitHub release assets, and install verifies
>   the checksum before unpacking. Boundary can either run a published `install.sh` fetched by
>   URL with a pinned checksum, or upload the tarball over SFTP and run `install.sh` from it.
>   We'd suggest the second: the client already knows the pin and the host needs no outbound
>   access to GitHub.
> - **macOS-only add-ons.** `mail`, `mail-drafts` and `messages` read host-built indexes of
>   Apple Mail and Messages. On Linux, install refuses to enable them and R2 reports them as
>   `unavailable`.
>
> The result is the same event-line shape `addon.sh` uses (phase lines, then `done` or
> `error`), with `done` carrying `{version, previous_version, backup, needs_user: [...]}`.
> Acceptance runs in our CI as an Ubuntu 24.04 job: install the previous tag, write a chat and
> a memory entry, upgrade to the new tag, check both survived and `doctor.sh` passes.

> **Boundary response:** accepted, with the overlay flags dropped (see Background) and three
> corrections. Checked in the stack's `docker-compose.yml` at 658a0e3.
>
> - **Postgres is not in `postgres_storage`.** That volume belongs to the deprecated `postgres`
>   service, which no profile starts. The shared `postgres-db` (the `db` add-on, and Vikunja
>   through `VIKUNJA_DATABASE_HOST=postgres-db`) binds `${DB_DATA_DIR:-./data/db}`, and
>   `twenty-db` binds `${TWENTY_DATA_DIR:-./data/twenty}/db`. Both sit under `data/` by default.
>   The point behind the correction stands: a file copy of a running cluster is not a backup,
>   so each cluster needs `pg_dump` or a stopped copy.
> - **The backup needs the volumes the reply leaves out.** `n8n_storage` holds n8n's workflows
>   and credentials (n8n uses SQLite there), `neo4j_data` holds the LightRAG graph, and
>   `opencode_config` holds OpenCode's configuration. `bitwarden_signin` is a tmpfs for a socket
>   and has nothing to back up. Several data paths can also point outside both roots:
>   `ACTUAL_DATA_DIR`, `VIKUNJA_FILES_DIR`, `TWENTY_DATA_DIR`, `DB_DATA_DIR` and
>   `BITWARDEN_HOST_DATA_DIR`. We'd ask that `backup.sh` take the mounts from
>   `docker compose config` for the active profiles, back up every named volume and bind mount
>   it finds, and skip only an explicit list of caches and tmpfs volumes, so a volume added in a
>   later release is backed up without a change to the script. Acceptance could add an n8n
>   workflow and a `db` row to the chat and memory entries the CI job checks.
> - **Podman.** Boundary runs the stack under Podman on macOS for every managed install, so
>   "nothing in the stack is run under Podman" is true of the stack's CI only. Docker only is
>   fine for a remote host in this request; no Boundary user needs Podman there yet.
>
> We'll take the tarball route: Boundary uploads the release tarball over SFTP and runs
> `install.sh` from it, and checks the checksum against the one it pins.

> **Stack reply (2):** agreed with the Postgres correction. `postgres-db` and `twenty-db` store their data under `data/`, which `backup.sh` copies, and `backup.sh create` refuses to run while any service is up unless `--stop` is passed; the upgrade path in `install.sh` stops the stack first, so Postgres is always copied stopped.
>
> `backup.sh` now backs up every named volume in `docker compose --profile '*' config`, so a disabled add-on's volume is still backed up, minus a skip list: the caches (`hermes_uv_cache`, `actual_mcp_ro_cache`, `actual_mcp_rw_cache`), `neo4j_logs`, `bitwarden_signin`, and `email_index` and `search_gate_data`, which can be rebuilt and hold mail and search history. Bind mounts work the same way: every `${KEY:-default}` bind source in `docker-compose.yml` and `compose/`, plus any `*DATA_DIR` set in `.env`, that points outside the stack and both data roots becomes its own part (`VIKUNJA_FILES_DIR`, `MAIL_DRAFTS_DIR`, `DB_DATA_DIR`, `TWENTY_DATA_DIR`, `ACTUAL_DATA_DIR`, `BITWARDEN_HOST_DATA_DIR`, `SIGNAL_CLI_DATA_DIR`), so a mount added later needs no script change. Restore checks each part against the `.env` key that named it and puts these parts back only with `--with-dirs`. Newly included when they exist: `ollama_data` (downloaded models, possibly large), `valkey_data`, `postgres_storage` (the legacy n8n Postgres) and `web_browser_profile` (the browser's sign-ins). The `install-test` workflow now installs with `--db --automation` and checks that an n8n workflow and a `postgres-db` row survive an upgrade; it has never run.
>
> Podman: noted; Docker only for the remote host.

> **Boundary response (2):** accepted. Checked: `backup.sh` reads volume names from `docker compose --profile '*' config --volumes` and drops `SKIP_VOLUMES`, finds bind sources in the compose files and `*DATA_DIR` keys in `.env`, makes the backup folder mode 700, and skips out-of-stack parts on restore without `--with-dirs`; `install-test` passes `-- --db --automation` and checks for `volume-n8n_storage.tar.gz`.
>
> Two things the wider scope changes for Boundary. A backup now holds `web_browser_profile`, so it carries the browser's sign-ins, and Boundary leaves backups on the host rather than copying them to the client. And `ollama_data` can make an upgrade's backup many gigabytes on a host that serves its own models. Leaving out a volume that can be downloaded again is asked for as R5.

## R2 · A status command a client can read

**Why:** on connect, Boundary checks that the remote stack's version is one it supports, and needs the published ports to forward.

**Ask:** `scripts/status.sh --json` (or a subcommand of an existing script) returning the stack version, the Hermes image it pins, each service's state, and each published port with the service it belongs to. Read-only, and it doesn't need the stack to be running.

**Acceptance:** with the stack stopped, the command reports the version and every service as stopped; with it running, each published port matches `docker compose ps`.

**Boundary fallback:** none for the remote host. A local install keeps reading versions and ports as it does today.

**Priority:** Blocking (phase 4)

> **Stack reply:** accepted as asked. `scripts/status.sh --json [--compose-file F]…
> [--project P]` returns:
>
> ```json
> {
>   "version": "v0.3.17",
>   "images": {"hermes_agent": "…", "hermes_webui": "…"},
>   "services": [
>     {"name": "hermes", "state": "running", "ports": [{"host": 8642, "container": 8642}]}
>   ],
>   "addons": [{"id": "mail", "state": "unavailable", "reason": "macos_only"}]
> }
> ```
>
> The version comes from a stamp file that install writes, falling back to `git describe` in a
> checkout. Ports come from `docker compose config` when the stack is stopped and from `docker
> compose ps` when it's running. It needs the Docker daemon but not the stack. It reads no
> secrets and writes nothing.

> **Boundary response:** accepted, without `--compose-file` and `--project` (see Background).
> Boundary forwards each port in `services[].ports` and takes its endpoints from them, so ports
> an add-on publishes from `.env` (`DETECTOR_PORT`, `TWENTY_PORT`) need to appear there too.

> **Stack reply (2):** `services[].ports` already includes ports published from `.env`. They come from `docker ps` for a running service and from `docker compose config` (with `.env` interpolated) otherwise, so `DETECTOR_PORT` and `TWENTY_PORT` show up whenever their add-on's profile is active. Checked in code, not yet run against a live stack with those add-ons on.

> **Boundary response (2):** accepted. Checked: `status.sh` builds stopped services' ports from `docker compose config --format json`. Phase 4's live check runs `status.sh --json` with Twenty's local instance and the detector on and confirms both ports are listed.

## R3 · Commands for the config clients change

**Why:** Boundary edits stack-owned files directly. Each edit depends on a file format and layout the stack can change, and the cron fence (CR 0036) already shows that edits made between bootstrap runs need the stack's help to take effect.

**Ask:** commands, with `--json` results, that:

- set and unset an allow-listed `.env` flag (the built-in add-on switches, `COMPOSE_PROFILES`, image pins);
- set and unset values in a profile's `.env`;
- add, update and remove an entry in a profile's `mcp_servers`, applying whatever the cron fence needs;
- create and remove a profile.

Each change is atomic, so a client that stops halfway leaves the file as it was.

**Acceptance:** each command, run twice with the same arguments, leaves the same file; a stopped run leaves the previous file; `addons.stack.test.ts` and `hermesConfig.stack.test.ts` pass with Boundary using the commands instead of writing files.

**Boundary fallback:** Boundary keeps editing the files, locally or over SFTP, until the pin includes these commands.

**Priority:** Wanted

> **Stack reply:** mostly covered by existing or planned interfaces. Using them instead of new
> file commands keeps clients off the stack's file layout and off Hermes' layout too, which
> matters if the agent behind the stack ever changes.
>
> - **Built-in add-on switches and `COMPOSE_PROFILES`:** use `addon.sh enable|disable <id>
>   --json`, which exists today. It writes the flags, syncs `COMPOSE_PROFILES`, starts or stops
>   the services, and rolls back on failure. Boundary's own flag writes "in local mode" should
>   move to it now, locally as well as remotely.
> - **Profile create and remove, profile `.env` values, `mcp_servers` entries:** the client
>   gateway's control plane (`_stack/profiles.create|delete`, `profiles.secrets.set`,
>   `mcp.app_servers.set|remove`). Those methods apply whatever the cron fence and the
>   bootstraps need, so Boundary stops running bootstrap containers after changes. They are
>   phase 3 of the gateway plan and arrive with the gateway CR.
> - **Everything else in the project `.env`** (image pins, `LLM_*`,
>   `HERMES_TERMINAL_BACKEND`, `CODING_*` and `CONTEXT_*` roots): new `scripts/env.sh set|unset
>   KEY [VALUE] --json`, limited to an allowlist. Keys outside it answer `bad_input`.
>
> One correction to "each change is atomic": today's `.env` writes are not. `upsert_env`
> (`scripts/lib/env.sh`) writes a temp file in `$TMPDIR` and moves it over `.env`, which is a
> copy rather than a rename wherever `/tmp` is a separate filesystem, as on many Linux hosts.
> That is fixed for every `.env` writer, not only the new command.

> **Boundary response:** accepted. Checked: `upsert_env` at 658a0e3 writes through `mktemp`
> and `mv` as described, and its append branch writes to `.env` in place, so the fix needs to
> cover that branch too.
>
> - **Add-on switches.** Boundary already enables and disables Actual, Bitwarden, email,
>   Vikunja, n8n and LightRAG through `addon.sh`. The one direct flag write left is Twenty's, in
>   the installer that runs Twenty through compose, when Boundary uses a developer's own
>   checkout. `addons/twenty` is in the pinned v0.3.15, so Boundary will move Twenty to
>   `addon.sh enable|disable twenty --json` and delete its own flag writer.
> - **Profiles, profile `.env` values and `mcp_servers`.** Accepted through the gateway. Boundary
>   gets these by moving to the gateway as a whole (its CR's control-plane item), so on a remote
>   host Boundary keeps writing these files over SFTP, and running the bootstraps after them,
>   until it has moved. The remote stack plan tracks the two halves of this item separately.
> - **`env.sh` allowlist.** Please add the keys the Background response lists
>   (`LLM_PROXY_AWAIT_PUSH` or an equivalent, the `caldav-mcp` zone, and whichever
>   `*_MCP_ENABLED` flags no setup flag covers).

> **Stack reply (2):** the append branch is fixed. ad5383a fixed only the shared `upsert_env` in `scripts/lib/env.sh`; `setup.sh` (which `install.sh` runs), `data-dir.sh`, `corpus.sh`, `coding-root.sh`, `context-root.sh`, `bootstrap-buzz.sh` and `sync-signal-profile.sh` kept copies that appended in place. They all use the shared one now, which writes a temp file next to the target and renames it for a new and a changed key, and a test fails if a script defines its own copy again.
>
> Twenty's local instance: `local` was only an instance setting, and instance `configure` never writes flags. Also `disable twenty` zeroed `TWENTY_LOCAL_ENABLED` and the next `enable twenty` didn't turn it back on. Twenty now has an add-on-level `local` bool setting that owns `TWENTY_LOCAL_ENABLED`, as Actual's does for `ACTUAL_LOCAL_ENABLED`. To turn off only the local instance, send `configure twenty` with `{"local": false}`, then `enable twenty`: that stops twenty-server, twenty-worker, twenty-db and twenty-redis, resyncs `COMPOSE_PROFILES` and keeps hosted workspaces registered. `configure` alone writes the flag but doesn't resync profiles or stop anything. Boundary's install sequence, `configure twenty` with `{"local": true}` then `enable twenty`, works as written. Tested with a stub engine only. The same stored-setting fix went into `setup.sh --budget`, as `--crm` got.

> **Boundary response (2):** accepted. Checked: `scripts/lib/env.sh` holds the only `upsert_env` outside the tests' stand-ins, and `addons/twenty`'s manifest has a `local` bool setting with `flag: TWENTY_LOCAL_ENABLED`, which `addon.sh` writes as it does for Actual. Once the pin includes a73d000, Twenty moves to `addon.sh`: Get runs `configure twenty` with `{"local": true}` and then `enable twenty`; removing the local instance while hosted workspaces stay runs `configure twenty` with `{"local": false}` and then `enable twenty`; Turn off runs `disable twenty`. Boundary's own `.env` writes for Twenty stay only as the fallback for older pins.

> **Boundary, after the v0.3.16 pin:** done. Get, Start, Turn off, Undo and removal run the sequence above; Turn off with no hosted workspace stored runs `configure twenty` with `{"local": false}` and then `disable twenty`. Writing or removing a Circle's hosted workspace still sets `TWENTY_MCP_ENABLED` itself.
>
> `env.sh` is in use for `HERMES_TERMINAL_BACKEND`, the image pins, the coding variables, `CONTEXT_EXTRA_ROOTS` and a managed install's `LLM_*` keys, with `STACK_CLIENT=boundary`. Checked at v0.3.16: the allowlist, the `done` and `error` lines, and `busy` with a live holder, against the real script in a temp copy. `LIGHTRAG_LLM_*` is outside the allowlist; see R6.

## R4 · Config writes safe with more than one client

**Why:** two devices using one remote stack can change its config at the same time.

**Ask:** R3's commands take a lock on the file they change, and report which client holds it when they can't get it within a timeout. A client passes its name.

**Acceptance:** two R3 commands on the same file at once both apply, one after the other.

**Boundary fallback:** Boundary allows one client per remote stack.

**Priority:** Later

> **Stack reply:** partly built. `addon.sh` already serializes its writes on
> `data/addons/.lock`, but the lock records a PID, not a client, and nothing else takes it.
> Plan: the lock takes `--client NAME`, reports the holder's name and start time when it can't
> be taken within `--lock-timeout`, and `env.sh` takes the same lock. The client gateway
> serializes its own control-plane writes in-process. Boundary's one-client-per-stack fallback
> is fine until then.

> **Boundary response:** accepted. Checked: the lock at 658a0e3 is a symlink whose target is the
> holder's PID, with a takeover guard for a dead holder. Boundary will pass its device name as
> `--client`.

> **Stack reply (2):** the lock names its holder from the `STACK_CLIENT` environment variable (letters, digits, `.`, `_`, `-`, up to 64 characters), not a `--client` flag: `STACK_CLIENT=<device> scripts/addon.sh ...`. A flag could be added as an alias if Boundary wants one.

> **Boundary response (2):** the variable is fine; no flag needed. Checked: `stack_lock_client` in `scripts/lib/stack-lock.sh` drops other characters and cuts to 64, and `env.sh` and `addon.sh` share the lock. Over SSH Boundary prefixes each `addon.sh` and `env.sh` call with `STACK_CLIENT=` and the device name.

## R5 · Leave a named volume out of a backup

**Why:** since R1's second reply, a backup holds every named volume, `ollama_data` included. On a host that serves its own models (the only way a remote stack runs a local model before the plan's phase 6), that volume can hold tens of gigabytes the user can pull again. `install.sh` backs up before every upgrade, so each upgrade needs that much free space and time, and a host short of space fails the upgrade at the backup step.

**Ask:**

- `backup.sh create --skip-volume NAME`, repeatable, where `NAME` is a volume as `volume-NAME` names it. It leaves that volume out, as `SKIP_VOLUMES` does, and `--plan` reflects it.
- A name that isn't a named volume in `docker compose --profile '*' config` answers `bad_input`, so a typo doesn't pass silently.
- `manifest.json` and the `done` line list the volumes left out at the caller's request (`"skipped":["ollama_data"]`), so a person looking at a backup can tell a volume was left out rather than missing.
- `restore` leaves a skipped volume as it is, as it already does for any volume the backup has no part for.
- `install.sh --skip-volume NAME`, repeatable, passes it to the backup an upgrade runs. A fresh install ignores it.

Any named volume can be skipped; the stack doesn't judge which ones are safe to leave out. Boundary offers it only for `ollama_data`, as a choice the user makes before an upgrade.

**Acceptance:** with a file in `ollama_data`, `backup.sh create --skip-volume ollama_data --json` writes no `volume-ollama_data` part and lists the volume under `skipped` in the manifest and the `done` line; `restore` from that backup leaves the file in place; `--skip-volume nosuch` exits 2 with `bad_input`; an upgrade through `install.sh --skip-volume ollama_data` produces a backup without the part.

**Boundary fallback:** upgrades back up every volume. If the backup fails for lack of space, `install.sh` starts the old release again and Boundary shows its error.

**Priority:** Later

> **Boundary response:** the stack answered with a commit rather than a reply here: ccfd097, listed under v0.3.16 in its changelog, which is not tagged yet. Accepted. Checked at stack main 494b533: `backup.sh` takes `--skip-volume` repeatedly, refuses a name missing from `docker compose --profile '*' config --volumes` (and a bare `--skip-volume`) with `bad_input` before writing anything, prints a `skip` phase line under `--plan`, and lists the names under `skipped` in `manifest.json` and the `done` line; `install.sh` passes the names to the upgrade's backup, ignores them on a fresh install, and when the backup refuses them starts the previous release again and fails with `bad_input`. `test-backup-sh.sh` and `test-install-sh.sh` cover each point of the acceptance against a fake engine; none has run on a live stack. `ollama_data` is declared at the top level of `docker-compose.yml`, so offering it never fails on a host without Ollama. A remote host needs a pin that includes ccfd097.

## R6 · LightRAG's model keys in `env.sh`

**Why:** Boundary writes LightRAG's model next to the chat model whenever the user picks one: `LIGHTRAG_LLM_BINDING`, `LIGHTRAG_LLM_MODEL`, `LIGHTRAG_LLM_BINDING_HOST` and a blank `LIGHTRAG_LLM_BINDING_API_KEY` (`docker-compose.yml` at v0.3.16 reads all four). `env.sh` at v0.3.16 accepts `LLM_*` but not these, so on a remote host they are the one project `.env` write left on SFTP outside the config lock.

**Ask:** add `LIGHTRAG_LLM_*` to `env.sh`'s `client_writable`, or name the interface Boundary should use instead (`model-use.sh --lightrag` writes `LIGHTRAG_LLM_MODEL` only).

**Acceptance:** `env.sh set LIGHTRAG_LLM_MODEL m --json` prints `done`; `env.sh set LIGHTRAG_LLM_BINDING_API_KEY '' --json` prints `done`.

**Boundary fallback:** Boundary writes these four keys to `.env` through `StackFiles`, over SFTP on a remote host.

**Priority:** Wanted

> **Stack reply (20 Nov 2026):** accepted as asked and on stack main at 1c29f98, not in a tag. `client_writable` in `scripts/env.sh` accepts `LIGHTRAG_LLM_*` and, beyond the ask, `EMBEDDING_*` (`EMBEDDING_BINDING`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `EMBEDDING_BINDING_HOST`, `EMBEDDING_BINDING_API_KEY`, `EMBEDDING_CLIENT_HOST`), the embedding choices `setup.sh` writes beside `LLM_*`. Both patterns include the `*_API_KEY` and `*_API_KEY_FILE` names; `LLM_PROXY_ADMIN_TOKEN` stays refused. `scripts/test-env-sh.sh` runs both acceptance commands and sets `EMBEDDING_MODEL`. `env.sh` starts nothing, so `lightrag` is recreated after a change as for the other keys. The `StackFiles` fallback can go once Boundary pins the tag carrying 1c29f98.
>
> **Boundary response:** accepted. Checked `client_writable` at stack main 31184fc. On a pin carrying 1c29f98, `applyLlmToProjectEnv.ts` sends the four keys through `env.sh` and `projectEnv.ts`'s copy of the allowlist adds `LIGHTRAG_LLM_*`; the developer's own `.env`, which holds the real key, stays on the file path.

## R7 · `status.sh` with the engine down

**Why:** `status.sh`'s header says it works with the stack stopped and reports `"engine": false` when the engine is down. At v0.3.16 it does read `docker compose config` and sets `--engine-down` when `docker info` fails, but then pipes everything into `stack_python scripts/lib/stack_status.py`, which runs `docker run … nousresearch/hermes-agent:<tag> python3`. With the engine down, or before the Hermes image is pulled, that fails and `status.sh` prints no JSON. Boundary connects to a remote stack by reading `status.sh --json`, so a host whose engine is stopped is reported as `status.sh` failing, not as a stack whose engine is down. `STACK_PYTHON=host` avoids the container, but the header documents it for tests and development, and a host may have no `python3` 3.9 or later.

**Ask:** `status.sh --json` prints its JSON with the engine down or the Hermes image missing: `version`, `project`, `engine: false` and each enabled service with `state: "unknown"` and the ports from the compose config. For example, it could run `stack_status.py` on the host's `python3` when the image can't run, or build the engine-down output without Python.

**Acceptance:** with `docker info` failing (a stub `docker` that fails `info`, `run` and `ps` and answers `compose config`), `status.sh --json` exits 0 with `"engine":false`; the same with the engine up and the Hermes image absent.

**Boundary fallback:** the install path doesn't use `status.sh`: `readInstalledStack` reads `.stack-version` over SFTP, so installing and upgrading work with the engine down. Connecting to a host whose engine is down fails with `script_failed` and `status.sh`'s last stderr line, and the user starts the engine on the host.

**Priority:** Wanted (plan phase 5, connecting to a stopped host)
