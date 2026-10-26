# 0009 · Shared database: read-write SQL for Boundary chats, a host port, a host-side integration role

**Serves:** the shared database Boundary turns on by default (stack `db` profile, `docs/database.md` in the stack).
**Status:** Open

## Background

Boundary runs the `db` profile and `setup.sh --db` on every install, and passes `SQL_MCP_ENABLED=1` in the compose environment. Boundary's chats go through the `api-server` profile (`:8643`). `register_sql_mcp_servers` in `compose/hermes/bootstrap-api-profile.sh` always registers `sql-mcp-ro` on `api-server` and drops any entry there that points at `SQL_MCP_RW_URL`. Checked against `v0.3.4`.

## R1 · Opt-in read-write SQL on api-server (Wanted)

**Why:** a request like "make me a reading list and add Dune" fails with a permission error in a Boundary chat and works in WebUI. `api-server` is read-only because the stack treats it as the unattended profile for n8n and cron, but a Boundary chat has a person typing each turn. Boundary can't change this from its overlay: pointing `SQL_MCP_RO_URL` at the rw sidecar is undone by the drop step.

**Ask:** an `.env` key `SQL_MCP_API_SERVER_ACCESS`, default `ro`. With `rw`, `register_sql_mcp_servers` gives `api-server` `SQL_MCP_RW_URL` and the agent_rw display name, and skips the drop step. With `ro`, behaviour is as today, so switching back cleans up. Whatever tells the `api-server` agent it is read-only (the `database` skill, any system prompt line) follows the key, so the model doesn't refuse writes the grants allow. `make doctor` reports which sidecar `api-server` uses. The CHANGELOG and `docs/database.md` note that n8n and cron jobs on `api-server` can then write to schema `agent`, still within `agent_rw`'s grants.

**Acceptance:** with `SQL_MCP_API_SERVER_ACCESS=rw` and both bootstraps re-run, an `api-server` session can `CREATE TABLE agent.reading_list` and insert a row, and still gets `permission denied` writing to any other schema. With the key unset, the same session gets `permission denied` on the create.

**Boundary fallback:** none in code. Boundary chats can read the database but not write to it; writes happen from WebUI. Once R1 is in the pinned tag, Boundary sets `SQL_MCP_API_SERVER_ACCESS=rw` in the compose environment next to `SQL_MCP_ENABLED` in `AssistantStackService.ts`.

## R2 · A host port for postgres-db (Later)

**Why:** Boundary wants a read-only view of what the agent has stored, built on `agent_ro` and `public.data_catalog`. `postgres-db` has no host port.

**Ask:** a `DB_HOST_PORT` variable. Empty (the default) publishes nothing; a value publishes `127.0.0.1:${DB_HOST_PORT}:5432`.

**Acceptance:** with `DB_HOST_PORT=15432`, `psql postgresql://agent_ro:…@127.0.0.1:15432/assistant -c 'select count(*) from data_catalog'` succeeds from the host, and nothing listens on another interface.

**Boundary fallback:** a `ports:` entry on `postgres-db` in `resources/assistant/docker-compose.boundary.yml`, added when the view is built. It goes once R2 is in the pinned tag.

## R3 · An integration role for a client on the host (Later)

**Why:** Boundary may keep its own schema (projects, coding folders, the Resources inventory; never chat content) so the agent can query them. Boundary runs on the host, not as a compose service, and `db-service-add` writes a `DATABASE_URL` whose host is `postgres-db`.

**Ask:** a way to register a `svc_<slug>` role whose connection details are usable from the host, for example `db-service-add --host-url` writing the URL against `127.0.0.1:${DB_HOST_PORT}`. Depends on R2.

**Acceptance:** after registering `boundary`, a client on the host connects with the written URL, creates a table in schema `boundary`, and the table is readable as `agent_ro`.

**Boundary fallback:** none; the feature waits for R3.
