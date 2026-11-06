# 0020 · Add-ons Boundary can install from its UI

**Serves:** [add-ons UX study](../addons-ux-study/README.md)
**Status:** R1, R3, R6 planned with Boundary's additions · R2, R5 (healthchecks), R8 planned for 0.3.10 · R4 live check in the Twenty build · R5 capabilities, R7 later · R9 declined · R10 asked · R11 open

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

## R10 · n8n as an add-on (Wanted)

**Why:** Boundary now starts n8n only when the user turns it on, from a switch on its Services card, and the Add-ons page should list it beside Twenty. `AUTOMATION_ENABLED` is the switch the stack gives it, but the `automation` profile also holds `gpt-researcher` and `gptr-mcp`. At v0.3.8, `gptr-mcp` is in no other profile, and OpenCode's config uses it. Boundary keeps the profile on and names every other service for `up`, because Compose pulls images for every service in an active profile, even one scaled to 0.

**Ask:** an `addons/n8n/addon.json` entry for n8n with `install`, data paths (`n8n_storage`), and its backup and removal steps. Either move n8n and `n8n-import` into a profile of their own or have the manifest list the services an add-on adds, so a client can start or remove n8n without naming the rest of `automation`.

**Acceptance:** `addon.sh enable n8n --json` and `disable n8n --json` start and stop n8n and `n8n-import` only, and `gpt-researcher` and `gptr-mcp` keep running.

**Boundary fallback:** n8n's switch is on its Services card. Boundary runs `up -d n8n-import n8n` to turn it on and `rm -sf n8n-import n8n` to turn it off, and keeps the volume.

## R11 · First-time setup that needs nothing on the host (Blocking)

**Why:** `scripts/crm.sh init` and `scripts/todo.sh init` call `require_python3` and run Python on the host, and the Makefile wraps them. A Mac without the Command Line Tools has neither a working `python3` (`/usr/bin/python3` is a stub that opens an install dialog) nor `make`. Boundary's users mostly don't have them, so an install from the UI would stop at first-time setup.

**Ask:** `addon.sh enable` runs each add-on's first-time setup inside a container, such as a one-shot service in the add-on's profile or `docker compose run` on an image the stack already pulls, so the only host requirements are bash and the container engine. Until `addon.sh` exists, the same for `crm.sh init`.

**Acceptance:** with `python3` and `make` removed from `PATH`, `scripts/crm.sh init` (and later `addon.sh enable twenty --json`) completes on a fresh `crm` profile.

**Boundary fallback:** none for release builds; Boundary develops against `crm.sh init` on a Mac that has Python, and rc.16 and labs.6 wait for this item along with 0.3.10.

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
