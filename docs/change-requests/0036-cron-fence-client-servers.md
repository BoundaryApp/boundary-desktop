# 0036 · Cron fence and MCP servers a client adds between bootstrap runs

**Serves:** agents' scheduled jobs on Boundary's installs (calendars, the host bridge).
**Status:** Open

## Background

From v0.3.15 (b54ee11) the bootstraps' cron fence (`fence_mail_from_cron` in `compose/hermes/bootstrap-api-profile.sh`) pins `platform_toolsets.cron` on every profile, including when no mail, messages or fenced add-on is registered, and runs on every profile under `data/hermes/profiles/`. The list it writes is Hermes's cron toolsets without `browser`, plus each enabled MCP server it isn't fencing (`others = sorted(enabled - mail)`), read from `config.yaml` at that run. docs/cron-fence.md says a job whose list names at least one MCP server gets only the servers named.

Boundary writes MCP entries into profiles while the stack runs: `calendar-<slug>` and `calendar-mac` when the user grants an agent a calendar, and the `boundary` host bridge on each new agent profile. An entry added after the last full bootstrap run isn't on that profile's pinned list, so a cron job without its own `enabled_toolsets` doesn't get it. The next start reruns the bootstrap, because the edited `config.yaml` changes the state hash, and the list then includes it.

Hermes's source in the image v0.3.15 pins (`nousresearch/hermes-agent:v0.23.1`) confirms it. `_resolve_cron_enabled_toolsets` (`cron/scheduler.py`) gives a job without `enabled_toolsets` the result of `_get_platform_tools(cfg, "cron")` (`hermes_cli/tools_config.py`), whose `_merge_mcp_servers` treats the MCP server names on the list as an allowlist once any of them is a configured server; only a list naming none gets every enabled server. The scheduler reads `config.yaml` on every run, without a cache, so a rewritten `platform_toolsets.cron` applies from the next run with no restart. A job's own `enabled_toolsets` goes through `_merge_mcp_into_per_job_toolsets` instead: a list naming any configured server gets only those, and a list naming none gets every enabled server, including ones added after the bootstrap run.

## R1 · Say how a client keeps its servers in cron

**Why:** the fence is right to pin a list, but a client that adds a server has no documented way to keep it available to cron jobs, short of restarting the stack.

**Ask:** one of these, whichever fits the fence's design:

- a command a client can run after editing `mcp_servers`, such as `scripts/cron-fence.sh [--profile NAME]`, that reruns only `fence_mail_from_cron` on the running install, or
- a note in docs/extending.md and contracts/agent.md (scheduler) that servers a client adds reach cron jobs after the next bootstrap run, and that a job wanting one sooner names it in its own `enabled_toolsets` (which then limits that job to the servers it names).

Since Hermes rereads `config.yaml` on each run, the command needs no restart or recreate of `hermes`.

**Acceptance:** with a pinned list on the default profile, a client adds `mcp_servers.example` and follows the documented step; a cron job without `enabled_toolsets` on that profile then gets `example`'s tools.

**Boundary fallback:** none. Boundary creates no cron jobs; a job a person schedules in chat gets a newly granted calendar after the next stack start.
