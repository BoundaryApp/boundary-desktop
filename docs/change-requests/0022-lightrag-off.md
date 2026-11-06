# 0022 · Turning LightRAG off leaves its MCP entry in Hermes

**Serves:** LightRAG as an optional service (Services → LightRAG), off by default.
**Status:** R1 built (unreleased, ships in 0.3.11) · R2 planned with 0020 R1

## Background

Boundary starts the `rag` profile (`lightrag`, `lightrag-mcp`, `neo4j`) only while the user has LightRAG on, and passes `LIGHTRAG_MCP_ENABLED` to match. With the flag at 1, `compose/hermes/bootstrap-api-profile.sh` registers `mcp_servers.lightrag` (`http://lightrag-mcp:8000/mcp`) on the profile it bootstraps, which is api-server for `hermes-api-bootstrap` and browser for `hermes-browser-bootstrap`. At 0 it logs `Skipping LightRAG MCP registration` and leaves the profile's `mcp_servers` as it is.

Installs from earlier Boundaries ran `setup.sh --rag`, so both profiles already hold the entry. After LightRAG is turned off, Hermes keeps trying a server that no longer exists. It parks the server as unreachable and starts without it (`set_stack_mcp_parked_retry`), so nothing breaks, but each retry fails and the entry stays in the config.

The mail, SQL, Vikunja and GPT Researcher registrations already handle this: when their flag is off, they call `drop_mcp_entries_for_url` with their URL. Checked against v0.3.10, the tag Boundary pins.

> **Stack reply:** accurate. One correction to the acceptance step: `HERMES_BOOTSTRAP_FORCE=1`
> isn't needed. `LIGHTRAG_MCP_ENABLED` is part of the bootstrap's input hash, so changing it and
> starting both bootstrap services reruns the full bootstrap. Setting it does no harm.

## R1 · Drop the LightRAG entry when the flag is off (Wanted)

**Why:** turning LightRAG off should leave Hermes's config as if it had never been on.

**Ask:** in the `LIGHTRAG_MCP_ENABLED` case's `*)` branch, call `drop_mcp_entries_for_url "$PROFILE" "" "$LIGHTRAG_MCP_URL"`, as `register_mail_mcp_servers` does.

**Acceptance:** with `mcp_servers.lightrag` in `data/hermes/profiles/api-server/config.yaml` and in the browser profile's, running both bootstrap services with `LIGHTRAG_MCP_ENABLED=0` and `HERMES_BOOTSTRAP_FORCE=1` removes the entry from both files and keeps every other server.

**Boundary fallback:** none built. The entry stays parked until the pinned tag carries R1. Turning LightRAG on again re-registers it.

> **Stack reply (built, ships in 0.3.11):** done as asked. With the flag off, both bootstraps
> remove every MCP entry pointing at `LIGHTRAG_MCP_URL` on their profile, whatever its key. That
> covers `lightrag` and the unfiltered `lightrag-mcp` copy a profile cloned from default. Other
> servers stay. Checked by running the bootstrap's functions in the v0.22.7 image against
> api-server and browser configs that held both entries plus two other servers: both LightRAG
> entries went, and the other two stayed. `scripts/test-lightrag-mcp-registration.sh` covers both
> branches in CI.
>
> The default profile isn't touched. The bootstrap never registers LightRAG there, and it leaves
> the default profile's MCP servers to the user. If a user added `lightrag-mcp` to default by
> hand, it stays parked until they remove it.
>
> The tool pins in `tools.tool_search.always_include` stay, as they do for mail and GPT
> Researcher. With no server to match, they have no effect.

## R2 · LightRAG in the add-on manifest (Wanted)

**Why:** Boundary's LightRAG switch is a stand-in like n8n's (0020 R10). An add-on entry would let LightRAG move to the add-ons catalog, with its memory reservation in the fit check.

**Ask:** an entry for the `rag` profile in the add-on manifest from 0020 R1: services, `LIGHTRAG_MCP_ENABLED` as the flag, reservations for `lightrag` and `neo4j`, and the reload that registers the MCP server.

**Acceptance:** Boundary's add-ons catalog lists LightRAG from the manifest.

**Boundary fallback:** the Services switch, which starts the profile and reruns both bootstraps.

> **Stack reply (planned with 0020 R1):** accepted. LightRAG gets `addons/lightrag/addon.json`
> with the first batch of manifests. The manifest and `scripts/addon.sh` aren't built yet. Three
> details:
>
> - **Memory figures come from compose**, as for every add-on (0020 R1). `lightrag` and `neo4j`
>   have no `deploy.resources` yet. They get them when we measure them under load (0020 R2).
>   `addon.sh list --json` will report them.
> - **Neo4j is a shared stack service.** The `neo4j` profile, n8n and `scripts/corpus.sh` use it
>   too, so the manifest lists it under `uses` rather than as one of LightRAG's services. Count
>   its memory in the fit check only when no other active profile already runs it.
> - **No reload is needed to register.** As with Twenty (0020 R4), a new entry connects within
>   about a second. `addon.sh disable lightrag` drops the entries, stops `lightrag` and
>   `lightrag-mcp`, and runs the reload. Until then, turning the flag and the profile off leaves
>   the running containers in place, since Compose ignores services of an inactive profile.
>   Your Services switch should keep removing them.
>
> **Also changing in the manifest plan:** mail, mail drafts and Messages become add-ons like the
> rest. They'll be in the catalog, installed and disabled through `addon.sh`. Three manifest
> features cover what's different about them:
>
> - `host` covers the macOS reader app and its Full Disk Access grant. Install waits until the
>   grant's check passes.
> - `permissions.reads` covers the personal data, allowed only for built-in and official-feed
>   add-ons.
> - Install-time checks keep them off `api-server` and out of cron, and keep reading and sending
>   in separate add-ons.
>
> Your add-ons page should expect an install step that waits on the user for a macOS grant.
