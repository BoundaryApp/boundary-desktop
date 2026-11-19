# 0020 · Add-ons Boundary can install from its UI

**Serves:** [add-ons UX study](../addons-ux-study/README.md)
**Status:** R1 manifests shipped for gptr, actual and bitwarden (v0.3.12); Twenty's is on stack main for 0.3.13, n8n's shipped in 0.3.13 · `addon.sh` reply items 1–8 accepted; `--json`, `hooks.init`, `connect`/`disconnect`, reload without a recreate, `remove --delete-data` and fit-check figures are on stack main for 0.3.13 (unreleased) · R2, R5 (healthchecks), R8 shipped in 0.3.10 · R4 verified live on Hermes v0.22.7 · R11 shipped in 0.3.11 · R5 capabilities, R7 later · R9 declined · R10 shipped in 0.3.13 (n8n and LightRAG manifests); Boundary uses it

## Background

The stack is adding optional services, starting with Twenty CRM. Boundary wants a Services → Add-ons page where a user sees each optional service, learns whether this Mac can run it and what it costs, fills in the few values only they can choose, and installs it with one click and step-by-step progress.

Stack v0.3.9 gives each optional service one switch: a `*_ENABLED` flag in `.env`, which `scripts/sync-profiles.sh` turns into `COMPOSE_PROFILES`, and `make services` to list them. Boundary already uses that switch for `SQL_MCP_ENABLED` and `GPTR_MCP_ENABLED` by setting the flag in its compose env and recreating Hermes. What is missing is everything a UI needs around the switch: what a service costs before it starts, which values it needs, a first-time setup a program can run, progress it can show, and a defined way to remove it.

Boundary runs the stack in a Podman machine with 12 GiB of memory and a 100 GiB disk (`BOUNDARY_MACHINE_MEMORY_MIB`, `BOUNDARY_MACHINE_DISK_GIB`). Every add-on competes for that memory with Hermes, the coding agent and the add-ons already on.

Checked in the stack at `v0.3.9`: `scripts/sync-profiles.sh` (flag to profile table, `COMPOSE_PROFILES_MANAGED`), `docker-compose.yml` (image defaults, `deploy.resources` and `healthcheck` per service), and `docs/extending.md` (the llm-proxy `*_FILE` keys). Nothing below asks to change the existing flags or profiles.

> **Stack reply (correction):** the Twenty entry in R1 is a sketch, and several of its facts differ from what we're building. Use these:
>
> - **Two flags.** `TWENTY_LOCAL_ENABLED` starts a local instance (compose profile `crm`). `TWENTY_MCP_ENABLED` registers Hermes MCP servers for every Twenty workspace we know about, local or remote. A user with only a hosted Twenty sets the second flag alone.
> - **Image:** `twentycrm/twenty:v2.55.0`, overridable with `TWENTY_IMAGE`. The server migrates its database on start, so bumps are deliberate.
> - **Port:** `TWENTY_PORT`, default 3000, bound to `127.0.0.1`.
> - **Containers:** four. `twenty-server`, `twenty-worker`, and Twenty's own `twenty-db` (Postgres 16) and `twenty-redis`. It doesn't depend on the `db` profile (see R9).
> - **Size:** measured idle on a test stack, about 1.8 GiB in total (server 850 MiB, worker 870 MiB, Postgres 100 MiB, Redis 18 MiB). The image is 1.12 GB.
> - **Values:** the user chooses none at install. `setup.sh --crm` generates `TWENTY_ENCRYPTION_KEY` and `TWENTY_DB_PASSWORD`. First-time setup creates the owner account (default `owner@crm.localhost`, generated password), a workspace, two Hermes roles and two API keys. Losing the encryption key loses the secrets Twenty stores, so backups must keep it with `data/twenty`.
> - **Release:** 0.3.10. The stack stays on 0.3.x patch tags while it's experimental, so `since` values will look like `v0.3.10`, not `v0.4.0`.
>
> Checked against stack v0.3.9 (`docker compose --profile '*' config`), the Hermes Agent v0.22.5 image, and the stack's Twenty design, which isn't public yet. Nothing in these replies has been built.

## R1 · An add-on manifest (Blocking)

**Why:** every screen of the Add-ons page reads facts the stack owns: what a service is called, what it needs and what it gives Hermes. Without a manifest Boundary hard-codes a catalog for each stack pin and guesses at the numbers, the same problem 0017 R2 describes for release metadata.

**Ask:** one machine-readable entry per optional service, either `addons/<id>/addon.json` or a single `addons.json` at the root of the tree:

```json
{
  "id": "twenty",
  "name": "Twenty CRM",
  "summary": "Contacts, companies and deals your agents can look up and update.",
  "flag": "TWENTY_ENABLED",
  "profile": "crm",
  "since": "v0.4.0",
  "images": [
    { "service": "twenty-server", "ref": "twentycrm/twenty:v1.8.0@sha256:…", "platforms": ["linux/arm64", "linux/amd64"], "downloadBytes": 1200000000 }
  ],
  "memory": { "reserveMiB": 2048, "limitMiB": 2560 },
  "disk": { "dataPaths": ["data/twenty"], "oneWay": true, "estimate": "≈ 50 MB per 1,000 contacts" },
  "ports": [{ "key": "TWENTY_HOST_PORT", "default": 3020, "bind": "127.0.0.1" }],
  "dependsOn": ["db"],
  "config": [
    { "key": "TWENTY_WORKSPACE_NAME", "type": "string", "required": true, "label": "Workspace name" },
    { "key": "TWENTY_OWNER_EMAIL", "type": "email", "required": true, "label": "Owner sign-in email" },
    { "key": "TWENTY_APP_SECRET", "type": "secret", "generate": "random-32" }
  ],
  "tools": { "server": "twenty", "profiles": ["default", "browser"], "names": ["…"] },
  "restart": ["hermes"]
}
```

**Acceptance:** CI fails when a flag in `sync-profiles.sh` has no manifest entry, when an entry names a profile, service or env key that `docker compose config` doesn't know, or when an image in the manifest differs from the compose default.

**Boundary fallback:** a catalog compiled into Boundary for the add-ons of the pinned stack, with figures measured by hand.

> **Stack reply (planned, after Twenty):** yes, as `addons/<id>/addon.json`. Two changes to the shape:
>
> - **The manifest becomes the flag list.** `sync-profiles.sh` will read its flag-to-profile table from the manifests instead of keeping its own copy, so a flag with no entry can't exist.
> - **Facts compose already holds stay in compose.** Images, memory figures, ports and healthchecks live in `docker-compose.yml`, and the manifest won't repeat them. The manifest holds what compose can't express: name, summary, the flag or flags, config fields, data paths, disk notes, MCP server names per Hermes profile and removal steps. `scripts/addon.sh list --json` prints the two merged, one object per add-on, with per-service images and memory figures. Read that instead of the files. It runs `docker compose config`, which doesn't need the engine running.
>
> CI checks that every profile, service and env key a manifest names exists in `docker compose config`, and that every optional profile has a manifest.
>
> Twenty's entry will carry both of its flags. Tell us if your page needs one switch per add-on. We'd then add an `install` field naming the flag set your **Install** button turns on.

> **Boundary reply:** yes, please add `install`. The Add-ons page has one **Install** button per add-on, and for Twenty it should turn on both `TWENTY_LOCAL_ENABLED` and `TWENTY_MCP_ENABLED`. We'd offer a hosted Twenty as a separate flow, "Connect a Twenty workspace", which turns on `TWENTY_MCP_ENABLED` alone. For that flow, what does the user supply, and where does it go? If the manifest can list those fields, we'd build the form from it. We'll read `addon.sh list --json` rather than the files.

> **Stack reply (`install` and `connect`):** we'll add both.
>
> - **`install`** lists the flags the **Install** button turns on. For Twenty: `["TWENTY_LOCAL_ENABLED", "TWENTY_MCP_ENABLED"]`.
> - **`connect`** describes the hosted flow: the flags it turns on (`["TWENTY_MCP_ENABLED"]`) and the fields to ask for, in the same shape as `config`. For Twenty:
>
>   | Key | Type | Required | Meaning |
>   |---|---|---|---|
>   | `TWENTY_SLUG` | `slug` | yes | Short name for the workspace. Hermes sees it as MCP server `crm-<slug>` |
>   | `TWENTY_URL` | `url` | yes | The instance's base URL, such as `https://crm.example.com`. Not the workspace subdomain: the API key selects the workspace |
>   | `TWENTY_KEY_RW` | `secret` | one of the two | API key for a role that can write |
>   | `TWENTY_KEY_RO` | `secret` | one of the two | API key for a read-only role |
>   | `TWENTY_WORKSPACE_URL` | `url` | no | Where **Open** sends the user |
>   | `TWENTY_ACCESS` | `enum` `read`, `write` | no, default `write` | See the roles answer below |
>
> `scripts/addon.sh connect twenty --json`, with those values in the environment, checks the key with an MCP `initialize` against `${TWENTY_URL}/mcp` before writing anything. It then writes `compose/twenty/workspaces/<slug>.env` (gitignored), regenerates the Hermes MCP entries, and reloads as in R4. `addon.sh disconnect twenty <slug> --json` deletes that file and the entries. It leaves the remote workspace alone. The user creates the keys in Twenty's settings, and the manifest's `connect.help` will say where.

## R2 · Memory reservations and limits on every optional service (Blocking)

**Why:** the fit check compares an add-on's memory with what is free in the 12 GiB machine. In `v0.3.9` only `hermes` (3G) and `hermes-webui` (512M) set a memory limit; no optional service sets one. Without limits the figures are guesses, and one busy add-on can push Hermes out of memory.

**Ask:** `deploy.resources.reservations.memory` and `deploy.resources.limits.memory` on every service in an optional profile, with the same figures in R1's manifest.

**Acceptance:** `docker compose config` for each profile shows both values on every service outside `core`.

**Boundary fallback:** Boundary measures `docker stats` after an add-on starts and shows the reading next time, so the first install is checked against an estimate only.

> **Stack reply (planned for 0.3.10):** accepted. Every long-running service in an optional profile gets `deploy.resources.reservations.memory` and `deploy.resources.limits.memory`, set from measurements under load rather than idle. Twenty's four containers get theirs in the Twenty change. The other profiles follow in the same release if measuring them fits, or the next one. One-shot jobs (`n8n-import`, `ollama-pull`, `db-provision`) get limits only. `addon.sh list --json` reports the figures.
>
> Also missing from core: `hermes-worker`, `llm-proxy`, `searxng` and `mcp-searxng` have no limit either. They're outside this request, but your fit check should not treat Hermes's 3 GiB as all of core.

> **Boundary reply:** thanks. Until the core services have limits, the fit check will measure them with `docker stats` and won't read Hermes's 3 GiB as all of core.

> **Stack reply (Twenty's figures):** measured under load on v2.55.0, Twenty's four containers have memory limits of 1152 MiB (`twenty-server`), 1152 MiB (`twenty-worker`), 256 MiB (`twenty-db`) and 128 MiB (`twenty-redis`), 2688 MiB in all. Redis runs with `--maxmemory 96mb` and `noeviction`, under its limit. All four have healthchecks; the worker's checks that its queue process is running. `addon.sh list --json` will report these with the reservations, so count them from there rather than copying them.

## R3 · A non-interactive enable and disable step (Blocking)

**Why:** turning a flag on starts containers, but many services need a first-time setup before agents can use them: Twenty needs its database, a workspace, an owner account and an API key for its MCP bridge. That setup belongs to the stack, since any other client would need it too, and Boundary needs progress from it to fill the install screen.

**Ask:** `scripts/addon.sh enable <id> --json` and `scripts/addon.sh disable <id> --json`. `enable` takes config values from the environment or a file, writes the flag, runs `sync-profiles.sh`, pulls, starts the profile, runs the add-on's first-time setup once, and registers its MCP server. With `--json` it prints one JSON object per line:

```json
{"phase": "pull", "service": "twenty-server", "bytes": 512000000, "total": 1200000000}
{"phase": "setup", "step": "migrations", "status": "running"}
{"phase": "done", "restart": ["hermes"]}
{"phase": "error", "step": "migrations", "message": "…", "logTail": ["…"]}
```

Running `enable` again on an enabled add-on does nothing and exits 0. A failed `enable` leaves the flag off and says what it left behind.

**Acceptance:** with a fresh stack, `enable twenty --json` ends with `done`, and a second run ends with `done` without repeating setup. With setup made to fail, the last line is `error` and `make services` shows the add-on off.

**Boundary fallback:** Boundary sets the flag in its compose env, runs `compose up` for the profile and reports progress from the pull and container states only. Add-ons that need a first-time setup are not offered until this lands.

> **Stack reply (planned, after R1):** accepted as specified: `scripts/addon.sh enable|disable <id> --json`, values from the environment or `--env-file`, JSON lines on stdout. Two details:
>
> - **Pull progress** comes from `docker compose pull --progress json`. Byte counts are present when compose reports them, and some lines will have a status only.
> - **First-time setup** is a per-add-on hook. Twenty's is the `make crm-init` work in its design, so `enable twenty` and `make crm-init` run the same code. Each step reports `running`, then `done` or `error`, and setup records that it finished so a second `enable` skips it.
>
> `enable` ends with the R4 reload, so `done` will carry `"restart": []` when that works and `["hermes"]` when it didn't.

> **Boundary reply:** this works for us. Two additions. First-time setup generates the owner account, so we'd like the owner email and password, or the path to a file holding them, in the `done` line; Boundary will put them in Passwords & Logins. And on an `error` line, the last few log lines, so the install screen can show them without reading container logs. Since losing `TWENTY_ENCRYPTION_KEY` loses data, could the manifest also list the secrets that must be backed up with the data paths?

> **Stack reply (owner account, log tail):** both, with one change.
>
> - **Owner account:** the `done` line of the first `enable twenty` carries `"account": {"url": "http://localhost:3000", "username": "owner@crm.localhost", "passwordEnv": "TWENTY_PASSWORD"}`. The password isn't printed, because these lines end up in install logs. Read it from the stack's `.env` under that key. If you set `TWENTY_PASSWORD_FILE` before `enable`, setup writes the generated password there instead, and the line has `"passwordFile"` in place of `"passwordEnv"`. Setup signs in with that password on later runs, so if the user changes it in Twenty, write the new one back or the next `enable` reports an `error` on the sign-in step.
> - **Log tail:** every `error` line has `logTail`, the last 20 lines from the failing step's output, or from the failing container's logs when the step was waiting on one. Lines are passed through as written. They can hold record data, so treat them like any log.
>
> **Backups:** the manifest gets a `backup` object.
>
> - `paths`: for Twenty, `data/twenty`.
> - `secrets`: env keys without which the backup can't be restored. For Twenty, `TWENTY_ENCRYPTION_KEY` (without it Twenty can't read the secrets it stores) and `TWENTY_DB_PASSWORD` (the restored database expects it).
> - `recommended`: keys and files that can be recreated but are worth keeping. For Twenty, `TWENTY_PASSWORD` and the local workspace file, whose API keys can otherwise be re-minted with `make crm-init --rotate`.
> - `stopFirst: true`. `data/twenty` holds a live Postgres data folder, and a copy taken while it runs may not restore. Stop the profile, copy, start it again. A dump-based hook that doesn't need a stop is a later addition, and the field will change to say so.
>
> `make db-backup` doesn't cover Twenty's database, and the stack docs will say so.

## R4 · Register an MCP server on a running Hermes (Wanted)

**Why:** every install ends with a restart of the assistant so that Hermes sees the new tools. The restart interrupts chats and kanban runs, and Boundary has to ask the user to time it around running work. `POST /v1/mcp/servers/{name}/reconnect` answers 404 `mcp_server_not_found` for a server Hermes doesn't already know (Boundary's `test:stack` HTTP case), so it can't add one.

**Ask:** a way to add and remove an MCP server on running Hermes profiles after the config changes, such as a gateway method or an API route that re-reads `mcp_servers`. If Hermes already has one, say so here.

**Acceptance:** after `enable` writes the new server, one call makes its tools appear in the next turn of an open session on the default profile, without recreating the container.

**Boundary fallback:** Boundary recreates Hermes at the end of an install, after asking, and waits for running work if the user prefers.

> **Stack reply (Hermes has this, live check pending):** you don't need a new method. The 404 you saw comes from the stack's own overlay. `POST /v1/mcp/servers/{name}/reconnect` only wakes a server Hermes parked after failed reconnects, so it never adds one. Hermes v0.22.5 has two paths that do add servers:
>
> - **`reload.mcp`**, a session control method on the gateway. It takes `session_id` and `confirm: true` (optional `profile`, `rev`), needs the `session:control` capability, and syncs that profile's live MCP servers with `config.yaml`: connects new or enabled ones, tears down removed or disabled ones. The calling session gets the new tool set as soon as it's idle, and other sessions of the profile get it when they next attach. It answers `mcp_servers_unavailable` when a configured server didn't connect and nothing else changed. Without `confirm` it returns `confirm_required`, because a reload invalidates the prompt cache of every chat on that profile.
> - **A housekeeping pass** that does the same sync on every gateway tick, about once a minute, for each served profile. With no call at all, new servers connect within about a minute, and open sessions see them when they're next idle.
>
> What we haven't tested is the stack's half. The stack writes MCP entries into each profile's `config.yaml` by running the bootstrap containers. Today `make hermes-reload` follows that by recreating Hermes. We'll check that a bootstrap run against a running Hermes, followed by `reload.mcp`, makes a new server's tools appear in an open default-profile session without the recreate. Then `addon.sh enable` will do exactly that. Until the check passes, keep your recreate fallback.

> **Boundary reply:** `reload.mcp` takes a `session_id`, so which session will `addon.sh enable` reload with, and can it reload a profile with no open session? A reload clears the prompt cache of every chat on the profile, so the install screen will say so before it runs. We'll keep the Hermes recreate until your live check passes; please tell us which release it lands in.

> **Stack reply (no session needed):** `addon.sh` will call `reload.mcp` once per Hermes profile with no `session_id`. Reading the v0.22.5 source, a call without a session still runs the resync and refreshes the profile's cached agents. It just doesn't commit a new tool set to a particular open session. Each open session picks up the new tools when it's next idle. It works the same for a profile with no open sessions. If the live check shows the call needs a session, `addon.sh` will skip it and rely on the background pass, which connects the server within about a minute.
>
> Your warning on the install screen is right either way. New tools are added after the existing ones, but the tool list comes before the conversation in every request, so each chat on the profile re-sends its history uncached on its first turn after the change. The background pass has the same effect, just later.
>
> **Release:** the live check runs during the Twenty build, since Twenty is the first add-on registered this way. The result goes in the 0.3.10 notes. `addon.sh` itself comes after 0.3.10, in a later 0.3.x patch. Its release notes will say when Boundary can drop the recreate.

> **Stack reply (verified live on Hermes v0.22.7):** a new MCP server reaches open sessions without recreating Hermes, and without `reload.mcp`. The test, on a real stack with the Twenty branch:
>
> 1. Opened a default-profile session before Twenty existed, and ran one turn.
> 2. Ran the stack's bootstrap against the running Hermes, without recreating it.
> 3. `mcp.servers.status` showed `crm-main` connected 1.1 s after the bootstrap exited, before any reload call. Hermes picks up the config change right away, so the "about once a minute" in our earlier reply is only the fallback.
> 4. The open session's next turn called `mcp__crm_main__get_tool_catalog`, which succeeded in 0.2 s.
>
> So you can drop the Hermes recreate once you pin a release with the bootstrap that registers Twenty, 0.3.10. Until `addon.sh` exists, run `docker compose run --rm hermes-api-bootstrap` (and `hermes-browser-bootstrap` for the browser profile) after changing add-on flags, then wait for the server in `mcp.servers.status`.
>
> One correction to how to read `reload.mcp`. The call with `confirm: true` and no session returned `4001 mcp_servers_unavailable` with "did not connect: boundary". Your own MCP server, `boundary`, was down at the time, and `crm-main` had already connected. The error names any configured server that is down, even when the one you added connected and nothing else changed. So don't treat 4001 as a failed install. Check the add-on's own server in `mcp.servers.status`. `addon.sh` will do the same, and will only call `reload.mcp` when the server hasn't appeared in time.
>
> Your install screen's prompt-cache warning still applies, because the tool list changes either way.
>
> The live run also turned up a bug, fixed for 0.3.10. Hermes names MCP tools `mcp__<server>__<tool>` with `-` turned into `_`. The bootstrap was pinning `mcp__crm-main__*`, which matched nothing, so the CRM tools stayed behind tool search. CalDAV's `caldav-<slug>` pins had the same bug on earlier releases. After 0.3.10 they're pinned as intended.

## R5 · Installed add-ons in `gateway.capabilities` (Wanted)

**Why:** the Add-ons page shows each add-on as on, starting or failing. Most optional services already have a `healthcheck`; `n8n` has none. Boundary would otherwise map container names back to add-ons itself.

**Ask:** a `healthcheck` on every long-running service in an optional profile, and an `addons` list in `gateway.capabilities` with each enabled add-on's id, version and whether its MCP server connected. This extends 0017 R3.

**Acceptance:** with Twenty enabled, `gateway.capabilities` returns `{"addons": [{"id": "twenty", "version": "v1.8.0", "tools": "connected"}]}`.

**Boundary fallback:** Boundary reads container health through the engine and matches services to add-ons from R1's manifest, or from its own catalog.

> **Stack reply (healthchecks planned for 0.3.10; capabilities held):** `n8n` gets a healthcheck, and so does `valkey` (the `searxng-prod` profile), which also has none. All four Twenty containers ship with one.
>
> We'd rather not add `addons` to `gateway.capabilities` yet. Every gateway overlay is code we re-test on each Hermes bump, and the answer can be assembled from what already exists: the manifest maps services to add-ons and the version comes from its image, container health comes from the engine, and the `reload.mcp` call at the end of an install names any configured server that didn't connect (`unavailable`). What that misses is a server that drops later. If your page needs that, tell us and we'll reconsider.

> **Boundary reply:** agreed, hold the `addons` capability. Boundary will show the `reload.mcp` result at install and container health after that. We'll come back if users hit servers that drop later.

## R6 · Defined removal (Wanted)

**Why:** the Add-ons page offers two actions: **Turn off**, which keeps the data, and **Remove and delete data**. Today a flag set to 0 stops the profile, and what happens to its data, its database in the shared Postgres and its MCP registration isn't written down.

**Ask:** `disable` stops the profile and removes the MCP registration, and keeps the data. `remove <id> --delete-data` also drops the add-on's database and data paths from R1. Both print what they removed.

**Acceptance:** after `disable twenty` and `enable twenty`, the earlier contacts are still there. After `remove twenty --delete-data`, the `twenty` database and `data/twenty` are gone and nothing else changed.

**Boundary fallback:** Boundary offers **Turn off** only.

> **Stack reply (planned, with R3):** accepted. `disable` stops the add-on's profile, removes its MCP entries from every Hermes profile, runs the R4 reload, and keeps data and generated secrets. `remove <id> --delete-data` also deletes the data paths in its manifest. Both print what they removed as JSON lines.
>
> For Twenty, `--delete-data` removes `data/twenty` (Twenty's own Postgres and its attachments), the local workspace's file under `compose/twenty/workspaces/`, and the local instance's `TWENTY_*` values in `.env`. Files for remote workspaces stay. Nothing in the shared `db` server belongs to it, so nothing else changes. `remove` refuses while the add-on is on, so run `disable` first.

> **Boundary reply:** agreed. Boundary will run `disable` before `remove --delete-data`, and the page already keeps the two actions apart.

## R7 · An add-on's pin can move without a stack release (Later)

**Why:** the updates plan moves the stack pin into a signed channel file. Add-ons that run database migrations can't follow floating tags, because a migration changes the data one way, but waiting for a whole stack release to ship an add-on fix is slow. Each add-on's pin can move on its own if the stack says which versions it has tested.

**Ask:** an image override per add-on (`TWENTY_IMAGE`, as `GPTR_IMAGE` and others already have), a range of stack versions each add-on version works with in R1's manifest, a `migrates` field per version, and a CI smoke test per add-on: start, health, one MCP tool call.

**Acceptance:** the channel file can set `TWENTY_IMAGE` to a newer digest that CI tested against the installed stack, and Boundary can tell from the manifest whether it must back up first.

**Boundary fallback:** add-ons update only with the stack.

> **Stack reply (later):** `TWENTY_IMAGE` ships with Twenty, so an override per add-on exists from the start. Stack-version ranges, a `migrates` field and per-add-on CI smoke tests wait until the signed channel from 0017 exists, since that's the only thing that would move an add-on pin on its own.

> **Boundary reply:** agreed; this waits for the 0017 channel file.

## R8 · Secrets from files (Wanted)

**Why:** generated secrets and API keys for add-ons would otherwise sit in `.env` and in `docker inspect`. llm-proxy already reads its keys from `*_FILE` paths.

**Ask:** each add-on config key of type `secret` in R1 accepts a `<KEY>_FILE` path in place of the value.

**Acceptance:** with `TWENTY_APP_SECRET_FILE` set and `TWENTY_APP_SECRET` unset, Twenty starts and the secret is absent from `docker inspect`.

**Boundary fallback:** Boundary writes secrets into the stack's `.env`, as it does today for other generated values.

> **Stack reply (planned for 0.3.10):** accepted for Twenty. `TWENTY_ENCRYPTION_KEY_FILE` and `TWENTY_DB_PASSWORD_FILE` work in place of the values. Postgres reads its password file natively. For the server and worker, the entrypoint reads the files and builds the connection URL inside the container, so neither secret appears in `docker inspect`. The Twenty API keys written for Hermes stay in each profile's `.env`, where every MCP key lives today. Later add-ons with `secret` fields in their manifest follow the same rule.

> **Boundary reply:** agreed. The Hermes API keys can stay in each profile's `.env`.

## R9 · Shared database and cache for add-ons (Later)

**Why:** Twenty's own compose setup brings a Postgres and a Redis. Running a second Postgres for each add-on roughly doubles its memory in a 12 GiB machine.

**Ask:** add-ons that need Postgres use the `db` profile's server with their own database and role, and add-ons that need a cache share one Valkey.

**Acceptance:** with Twenty and Tasks enabled, `docker compose ps` shows one Postgres server.

**Boundary fallback:** none; the manifest figures include each add-on's own database.

> **Stack reply (declined for Twenty):** Twenty keeps its own Postgres and Redis.
>
> - Twenty pins Postgres 16, and the shared `db` server runs 18.
> - Twenty creates a schema per workspace at runtime. The shared server gives each service one schema with fixed grants, which can't express that.
> - Twenty's Redis must run with `--maxmemory-policy noeviction`, because it holds job queues. The existing Valkey is a SearXNG rate-limit cache, and eviction policy is set per server, so they can't share one.
>
> The extra cost is about 120 MiB idle. Later add-ons that can live in one schema of the shared server will use it, and their manifests will say so.

> **Boundary reply:** accepted for Twenty. The fit check will count Twenty's own Postgres and Redis.

## R10 · n8n as an add-on (Shipped in 0.3.13)

**Why:** Boundary now starts n8n only when the user turns it on, from a switch on its Services card, and the Add-ons page should list it beside Twenty. `AUTOMATION_ENABLED` is the switch the stack gives it, but the `automation` profile also holds `gpt-researcher` and `gptr-mcp`. At v0.3.8, `gptr-mcp` is in no other profile, and OpenCode's config uses it. Boundary keeps the profile on and names every other service for `up`, because Compose pulls images for every service in an active profile, even one scaled to 0.

**Ask:** an `addons/n8n/addon.json` entry for n8n with `install`, data paths (`n8n_storage`), and its backup and removal steps. Either move n8n and `n8n-import` into a profile of their own or have the manifest list the services an add-on adds, so a client can start or remove n8n without naming the rest of `automation`.

**Acceptance:** `addon.sh enable n8n --json` and `disable n8n --json` start and stop n8n and `n8n-import` only, and `gpt-researcher` and `gptr-mcp` keep running.

**Boundary fallback:** n8n's switch is on its Services card. Boundary runs `up -d n8n-import n8n` to turn it on and `rm -sf n8n-import n8n` to turn it off, and keeps the volume.

> **Stack reply (works with v0.3.9's flags; manifest entry planned):** the premise is from v0.3.8. Since v0.3.9, `gptr-mcp` is also in the `research` profile, switched by `GPTR_MCP_ENABLED`. It runs GPT Researcher in-process and doesn't call the `gpt-researcher` service. So with `GPTR_MCP_ENABLED=1`, which OpenCode needs anyway, `AUTOMATION_ENABLED` turns n8n on and off and `gptr-mcp` keeps running either way. Once you pin v0.3.9 you can stop naming services for `up`.
>
> What `automation` adds on top of `research` is `n8n`, `n8n-import` and `gpt-researcher`. `gpt-researcher` belongs to n8n: n8n waits for it to be healthy at start, and the only caller of its HTTP API is n8n's research workflow. So n8n's add-on is those three services, and the acceptance becomes: `disable n8n` stops `n8n`, `n8n-import` and `gpt-researcher`, and `gptr-mcp` keeps running.
>
> We won't move n8n into its own profile. Taking `gptr-mcp` out of `automation` would stop it on installs that turned on automation for research and never set `GPTR_MCP_ENABLED`. Leaving it in `automation` costs nothing when `research` is on too.
>
> One thing the flag doesn't do: setting `AUTOMATION_ENABLED=0` and running `up` leaves running n8n containers in place, because Compose ignores services of an inactive profile rather than removing them. `addon.sh disable n8n` stops and removes the three services. Until then, your `rm -sf` is the right step. Add `gpt-researcher` to it.
>
> The manifest entry (`addons/n8n/addon.json`) comes with R1:
>
> - `install: ["AUTOMATION_ENABLED"]`.
> - The `services` it adds, which R1 now lists for every add-on: those three.
> - Data in named volumes, not paths: `n8n_storage` (workflows, credentials, its SQLite database) and `gptr_outputs` (research reports). R1's `dataPaths` becomes `data` with `paths` and `volumes`.
> - `backup.secrets: ["N8N_ENCRYPTION_KEY"]`. n8n encrypts stored credentials with it, so a restore without it loses them. `N8N_USER_MANAGEMENT_JWT_SECRET` goes under `recommended`, because a new one only signs users out.
> - `remove --delete-data` deletes both volumes.

## R11 · First-time setup that needs nothing on the host (Blocking)

**Why:** `scripts/crm.sh init` and `scripts/todo.sh init` call `require_python3` and run Python on the host, and the Makefile wraps them. A Mac without the Command Line Tools has neither a working `python3` (`/usr/bin/python3` is a stub that opens an install dialog) nor `make`. Boundary's users mostly don't have them, so an install from the UI would stop at first-time setup.

**Ask:** `addon.sh enable` runs each add-on's first-time setup inside a container, such as a one-shot service in the add-on's profile or `docker compose run` on an image the stack already pulls, so the only host requirements are bash and the container engine. Until `addon.sh` exists, the same for `crm.sh init`.

**Acceptance:** with `python3` and `make` removed from `PATH`, `scripts/crm.sh init` (and later `addon.sh enable twenty --json`) completes on a fresh `crm` profile.

**Boundary fallback:** none for release builds; Boundary develops against `crm.sh init` on a Mac that has Python, and rc.16 and labs.6 wait for this item along with 0.3.10.

> **Stack reply (accepted for 0.3.11, widened):** accepted, but `crm.sh init` isn't what stops these Macs today. `scripts/setup.sh` has required a working host `python3` in its preflight since v0.2.0, and runs Python itself. Boundary's `runSovereignSetup.ts` checks for this and asks the user to install the Command Line Tools before setup runs. A Mac without them never gets far enough to install an add-on, so Twenty in 0.3.10 doesn't add a new blocker. Removing Python from `crm.sh` alone wouldn't let those users through either.
>
> So we'll take R11 as "the whole first run needs only bash, the container engine and what macOS ships", and do it in 0.3.11. On Boundary's path that means:
>
> - the two Python heredocs in `setup.sh`, and `sync-terminal-backend.sh`, which `setup.sh` runs
> - `todo.sh init`
> - `crm.sh init`
> - `generate-n8n-credentials.js`, which `sync-n8n-credentials.sh` runs with host Node when `automation` is on. Since 0.3.10, `setup.sh` without `automation` no longer needs Node, so your `node` stub matters only for n8n
>
> Each moves into a container from an image the stack already pulls: Python from the pinned Hermes image (the stack already does this for its YAML edits), and the n8n credentials step from the n8n image. `crm.sh init` also stops calling back into the host's Docker CLI, and reaches Twenty over the `crm` network instead of `127.0.0.1`. Scripts that only run with Buzz on stay on host Python for now. Tools macOS ships in `/bin` and `/usr/bin` stay allowed, including `grep`, `sed`, `awk`, `openssl`, `ssh-keygen` and `curl`. The stack's scripts use these throughout, and `crm-add`'s key check (which `addon.sh connect` will run) and the `doctor` probes call `curl` on the host.
>
> `make` isn't involved: your installer runs `bash scripts/crm.sh init` directly, and `crm.sh` only prints `make` commands as next-step hints.
>
> **Acceptance:** with `python3`, `node` and `make` off PATH, `setup.sh --non-interactive` with Boundary's flags, then `crm.sh init` and `todo.sh init`, all complete on a fresh stack. CI builds that PATH from the base system's `/bin` and `/usr/bin` plus `docker`, with `python3`, `node` and `make` removed. After that, Boundary can drop its Command Line Tools check and the `node` stub.
>
> **On your release question:** 0.3.10 ships Twenty without R11, and 0.3.11 follows with it. Folding R11 into 0.3.10 would hold Twenty back without unblocking anyone, because base setup would still need Python. If your next release needs Macs without the Command Line Tools, it waits for 0.3.11 either way.

## `addon.sh` as merged

> **Boundary reply (the merged `addon.sh`):** we read `scripts/addon.sh` and "Add-ons: scripts/addon.sh" in `docs/extending.md` on stack `main` at 5b33ffd, unreleased. `list --json`, the settings schema and `configure` with secrets on stdin work for us, and Boundary will build its settings forms from `schema`. Several things the earlier replies agreed are missing, though, and Boundary can't move installs onto `addon.sh` until they're in. In order of how much they block:
>
> 1. **Progress and errors (R3).** `enable` and `disable` print nothing on success and one `error:` line on failure. Boundary's install screen is built on the JSON lines agreed in R3: pull bytes per service, each setup step as `running` then `done` or `error`, `logTail` on an error, and a final `done`. Without them a 1 GB pull shows no progress and a failure shows one line. Please add `--json` to `enable` and `disable` as agreed. Keeping `error:` on stderr is fine.
> 2. **First-time setup (R3).** `enable` starts services and reloads Hermes but runs no setup, so Twenty's `crm.sh init` and Actual's `budget.sh init` still need a separate call. R3 agreed a per-add-on setup hook that `enable` runs once and records. If manifest `commands` with `run` is meant to replace it, please name the command each add-on needs, say whether `enable` runs it, and report it in the same JSON lines.
> 3. **`connect` and `disconnect` (R1, and change requests 0023 and 0026).** `configure --instance` stores an instance's values but doesn't check them, and doesn't register or reload anything until `enable`. The agreed `connect` checked the credential before writing, wrote the entry and reloaded. Change request 0026 now plans `budget.sh connect` / `disconnect` with JSON lines and named errors (`login_refused`, `no_access`, `token_expired`, `timeout` and others). We'd like one `addon.sh connect <short-id> --instance <slug> --json` and `disconnect` in that shape for every add-on with instances, so Twenty workspaces and Actual budgets use one path. Until then Boundary uses `crm.sh` and `budget.sh` directly.
> 4. **Reload without a recreate or `make` (R4, R11).** `enable` and `disable` end with `make hermes-reload`, which runs both bootstraps and then force-recreates `hermes`. The R4 live result showed the bootstrap alone connects a new server in about a second, and a recreate interrupts running chats and kanban runs, which is what R4 set out to avoid. `make` also isn't on a Mac without the Command Line Tools, which R11 removed from the first run. Please run the bootstraps directly and recreate `hermes` only when something needs it. If the Bitwarden broker's `follow-hermes` step is what needs the recreate, say so and limit it to that add-on.
> 5. **Removal (R6).** `disable --purge` deletes `data/addons/<short-id>/` and the named volumes the manifest lists. The data of a bind-mounted add-on stays, such as `data/twenty` and `ACTUAL_DATA_DIR`, and the manifest has no field for data paths. R6 agreed `remove <id> --delete-data` covering the manifest's data paths and printing what it removed. Please either extend `--purge` to bind-mounted data paths from the manifest, or add `remove` as agreed, with JSON lines either way.
> 6. **Figures for the fit check (R1, R2).** `list --json` has no memory reservation, memory limit, image or download size. The R1 reply said `list --json` would merge these from compose, and the fit check needs them before install. Please add them per service.
> 7. **Who owns the flags.** `addon.sh` writes flags to `.env` and runs `docker compose` itself. Boundary's managed stack passes add-on flags in compose's environment and its own `--profile` list, which override `.env`. When Boundary moves an add-on onto `addon.sh`, it will stop passing that add-on's flags and treat `.env` as the source. Please confirm that `addon.sh`'s compose calls take `COMPOSE_PROJECT_NAME`, `COMPOSE_PROFILES` and the rest of the caller's environment unchanged, so the profiles Boundary runs stay on.
> 8. **Twenty and n8n.** Neither has a manifest yet, and Twenty is the only add-on Boundary installs today. Please tell us when their manifests are planned. Twenty stays on `crm.sh` in Boundary until then.
>
> **What Boundary does meanwhile:** Twenty stays on `crm.sh` and Boundary's own installer. Actual Budget waits for `budget.sh connect` from change request 0026. Each add-on moves onto `addon.sh` once items 1 to 5 are in a release, starting with Actual. Please say in the changelog which 0.3.x patch has them.

> **Stack reply (the merged `addon.sh`):** you're right on every point. We checked each one against `main` at 7a3b847, and the merged `addon.sh` is the first slice, not the R3/R6 contract. Answers in your order:
>
> 1. **Progress and errors.** Accepted as R3 specified. `enable` and `disable` get `--json` and print R3's lines on stdout: `pull` lines from `docker compose pull --progress json`, `setup` steps as `running` then `done` or `error`, `logTail` with the last 20 lines on every `error`, and a final `done` that carries `restart`. Every `--json` run ends with exactly one `done` or `error` line. A hook's `done` `message` passes through to that final `done` line. `error:` stays on stderr.
> 2. **First-time setup.** Accepted. Manifests get a `hooks.init` command that `enable` runs once after the services are healthy, with `--json`. `enable` records that it finished in `data/addons/<id>/state.json`, `enable --reinit` runs it again, and `enable` and reports each step in the same JSON lines. For Actual it runs `budget.sh init`, which needs `actual-server` up and does nothing on a second run, and for Twenty `crm.sh init`'s work once Twenty has a manifest. `run` stays for commands a user triggers later.
> 3. **`connect` and `disconnect`.** Accepted. `addon.sh connect <short-id> --instance <slug> --json` checks the credential before writing anything, writes the entry, registers the server and reloads. `disconnect` undoes it. Both use R3's JSON lines. An error line adds `error` with a named code: change request 0026's codes (`login_refused`, `no_access`, `token_expired`, `timeout` and the rest), plus `addon.sh`'s own failures: `bad_input`, `missing_settings`, `command_failed`, `compose_failed` and `busy` (another run is in progress). An add-on error that isn't declared arrives as `command_failed`, with its name in `message`. Secrets arrive as one JSON object on stdin and never in argv. `budget.sh connect` is the first one built, and `addon.sh` wraps it unchanged. Each add-on declares its extra error names in its manifest under `instances.errors`, for example Actual's `encryption_password`.
> 4. **Reload.** Accepted. `enable` and `disable` will run the two bootstraps directly. They won't recreate `hermes` and won't call `make`. The `done` line lists, under `mcp`, every MCP server name to wait for, including names an init hook reports. Check them in `mcp.servers.status` over your gateway connection, as the R4 live check did, since Boundary already holds that connection. The recreate came from `make hermes-reload` itself. `vault.sh follow-hermes` only moves the Bitwarden broker after a recreate. No add-on recreates `hermes`, Bitwarden included. Bitwarden's login plugin is now installed on every Hermes start. After the bootstraps, `addon.sh` runs `vault.sh reload-plugins`, which asks the running gateway to reload plugins on each profile whose login backends changed. Bitwarden's tools reach new sessions only, and open sessions keep the tools they started with. The first start after upgrading to 0.3.13 recreates `hermes` once, because its environment changed. _[On main for 0.3.13. Not yet checked with a full turn on a real stack after turning Bitwarden on or off.]_
> 5. **Removal.** We'll add `remove <id> --delete-data` as R6 agreed, with JSON lines naming each path and volume it deletes. Manifests get `data.paths` (bind mounts such as `data/twenty` and `ACTUAL_DATA_DIR`) beside `data.volumes` (for Actual, `actual_mcp_rw_cache` and `actual_mcp_ro_cache`, which hold full budget copies), as the R10 reply described. A data path is deleted only when it resolves inside the stack's data root (`./data` or `ASSISTANT_DATA_ROOT`). A path outside it, such as an `ACTUAL_DATA_DIR` you pointed elsewhere, is kept and reported as `"kept"`. `disable --purge` stays as an alias that runs `disable` then `remove --delete-data`.
> 6. **Fit-check figures.** Accepted. `list --json` will report `memory.reservation`, `memory.limit`, `image` and `downloadSize` per service, merged from `docker compose config` and the image manifest. `downloadSize` is absent when the registry doesn't report one.
> 7. **Who owns the flags.** `addon.sh` writes flags to `.env` and runs `sync-profiles.sh`, which writes `COMPOSE_PROFILES` to `.env`. Its compose calls inherit your environment, and the project name comes from `COMPOSE_PROJECT_NAME` in the environment first. An exported `COMPOSE_PROFILES` overrides the `.env` value, so the profiles you run stay on, and `enable` names its services explicitly so they start either way. `scripts/test-addon-cli.sh` checks this. With both variables exported, it runs `enable`, `connect`, `disconnect`, `disable --purge` and `list` against a stub `docker`. It confirms that every docker call, the bootstraps included, sees the caller's values, and that `remove` deletes volumes under the caller's project name.
> 8. **Twenty and n8n.** n8n's manifest ships in 0.3.13 with items 1 to 6, with `data.volumes` (`n8n_storage`, `gptr_outputs`) and `backup.secrets` (`N8N_ENCRYPTION_KEY`) as the R10 reply described. It needs no first-time setup, because `n8n-import` generates its credentials before n8n starts. `gptr-mcp` stays in the `automation` profile, and `disable n8n` leaves it running. Twenty gets its manifest in the same patch. Its workspaces become generic instances, so `connect` and `disconnect` work for Twenty workspaces as they do for Actual budgets. A one-time `crm.sh migrate` converts existing workspace files.
>
> **Release:** items 1 to 6 ship together in 0.3.13, and its CHANGELOG entry will say that Boundary can move Actual onto `addon.sh`. Until then, keep Twenty on `crm.sh` and Actual waiting for `budget.sh connect`, as you planned.

## Question · Hermes roles and agent access

> **Boundary question:** the install page asks what agents may do: look things up, make changes after asking, or make changes on their own. First-time setup creates two Hermes roles. Are they read-only and read-write, and can we choose which role's API key each Hermes profile gets? That would back the first two choices directly; "after asking" would add Boundary's approval prompt on top of the read-write key.

> **Stack reply (roles and access):** setup creates two Twenty roles, both assignable to API keys:
>
> - **Hermes read-only:** read all records, nothing else.
> - **Hermes read-write:** read, update and soft delete. It can't permanently delete records or change workspace settings. We'll confirm during the build that this role can create records, and correct this if not.
>
> One gap you should know before offering "look things up". In our test on v2.55, the read-only key couldn't create people or notes, but it could create a note target, the record that links a note to a person or company. Junction and system objects seem to sit outside a role's record permissions. We'll try to close that during the build. If we can't, the docs will call the key read-mostly and list what it can still write, and the manifest's `access.read` description will say the same.
>
> **Choosing the key:** yes. `TWENTY_ACCESS=read|write` in each workspace file, default `write`, picks the key the `default` and `browser` profiles get. `api-server` always gets the read-only key, or no Twenty server when there isn't one. With `read` and no read-only key, no profile gets a server for that workspace, and `doctor` reports it. The manifest lists `TWENTY_ACCESS` as an install field, so your three choices map to `read`, `write`, and `write` plus your approval prompt.
>
> **For "after asking":** Twenty's MCP server exposes seven fixed tools, and every record change goes through `execute_tool`, so the tool name alone doesn't separate reads from writes. Your approval prompt has to look at `execute_tool`'s arguments: the inner tool name (`find_many_*` reads; `create_*`, `update_*` and `delete_*` write). Prompting on `execute_tool` itself would ask for every lookup too.
