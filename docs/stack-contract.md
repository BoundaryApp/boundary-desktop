# Stack contract

Everything Boundary takes from the agent stack, where Boundary uses it, and which check covers it
([ADR 0031](adr/0031-checks-on-the-stack-contract-and-drift.md)). A dependency missing from this
table has no check. Moving the stack pin means reading the stack's changelog against it.

`test:stack` cases live in four files:

- `hermesConfig.stack.test.ts` (keys, settings program) under `src/main/services/assistant/__tests__/`
- `stackHttp.stack.test.ts` (HTTP) in the same folder
- `hermesGateway.stack.test.ts` (catalog, live calls, the recovery notice) under `src/main/services/assistant/hermes/__tests__/`
- `addons.stack.test.ts` (the Twenty add-on's MCP server) in the same folder as `hermesConfig.stack.test.ts`

The catalog case checks each gateway method, param, event and server request against Hermes's
contract registry (`tui_gateway.contracts`) in the running image. Names the stack's overlays add
at runtime are not in that registry; each of those has a live case instead.

## Running the suite

```sh
bun run test:stack
```

It needs a running stack and the `docker` CLI. By default it targets the `assistant` checkout beside
this repository on the default ports; `BOUNDARY_ASSISTANT_ROOT`, `BOUNDARY_STACK_PORTS=offset-ports`,
`BOUNDARY_STACK_CONTAINER` and `BOUNDARY_STACK_DOCKER` point it elsewhere. Credentials come from the
stack's own files, read by Boundary's resolvers. Each file skips, and says why, when the stack isn't
reachable. The settings-program case writes only to a temporary folder under the Hermes container's
`/tmp` and removes it. The suite logs in to the dashboard four times; the dashboard allows ten
password logins a minute per address.

## Ports

Default ports; Boundary's own stack adds 10000, 20000 or 30000 in `offset-ports` mode, the first offset whose ports are all free (`assistantPortChoice.ts`).

| Port | Service | Used in | Check |
| --- | --- | --- | --- |
| 9119 | Dashboard (auth, `/api/ws`, kanban plugin) | `resolveHermesStackEndpoints` (hermesEndpoints.ts) | `test:stack` HTTP and gateway cases |
| 8643 | Hermes API (`/health`, `/v1`) | `resolveHermesStackEndpoints`, `waitUntilAssistantHealthy` (AssistantStackService.ts) | `test:stack` HTTP: `/health`, reconnect |
| 8787 | Hermes WebUI | `resolveHermesStackEndpoints`, hermesWebuiSessions.ts | none |
| 4096 | OpenCode | `waitUntilCodingAgentUp` (AssistantStackService.ts), codingAgentBusy.ts | none |
| 4001 | llm-proxy admin | `pushLlmProxyUpstream`, `readLlmProxyStatus` (llmProxyAdmin.ts) | none |

## HTTP endpoints

| Endpoint | Status and fields read | Used in | Check |
| --- | --- | --- | --- |
| `POST /auth/password-login` (dashboard) | 2xx, `Set-Cookie` | `loginToDashboard` (hermesDashboardAuth.ts) | `test:stack` HTTP |
| `POST /api/auth/ws-ticket` (dashboard) | 2xx, `ticket` | `mintDashboardWsTicket` (hermesDashboardAuth.ts) | `test:stack` HTTP |
| `GET /health` (API) | 2xx | `waitUntilAssistantHealthy` (AssistantStackService.ts) | `test:stack` HTTP |
| `POST /v1/mcp/servers/{name}/reconnect` (API) | 202 woken, 404 `mcp_server_not_found` | `wakeHermesBridgeServer` (hostBridge/hermesWake.ts) | `test:stack` HTTP; unit: hermesWake |
| `GET /api/plugins/kanban/boards` | `current` | `currentBoardSlug` (hermesKanban.ts) | `test:stack` HTTP |
| `GET /api/plugins/kanban/board` | 200 or 404 (no plugin), `columns[].tasks`, `now`, `latest_event_id` | `readBoard`, `tasksFromBoard` (hermesKanban.ts) | `test:stack` HTTP |
| `GET /api/plugins/kanban/workers/active` | `workers[]` | `overlongUncappedRuns` (hermesKanban.ts) | `test:stack` HTTP |
| `GET /api/plugins/kanban/tasks/{id}`, `.../log` | task detail, log | `getKanbanTask` (hermesKanban.ts) | none |
| `PATCH /api/plugins/kanban/tasks/{id}`, `POST .../runs/{id}/terminate` | 2xx | `kanbanTaskAction`, `stopOverlongRuns` (hermesKanban.ts) | none (writes) |
| WebSocket `/api/plugins/kanban/events` | event batches | `openEvents` (hermesKanban.ts) | none |
| `GET /auth/handoff?code=` (dashboard) | browser sign-in | `browserUrlFor` (hermesBoardLinks.ts) | none |
| `GET /api/sessions`, `GET /api/session` (WebUI) | session rows | hermesWebuiSessions.ts | none (returns chat content) |
| `GET/POST /admin/upstreams` (llm-proxy) | upstream status | `pushLlmProxyUpstream`, `readLlmProxyStatus` (llmProxyAdmin.ts) | none |
| llm-proxy's `chat` and `lightrag` routes, with Boundary's inference router as the upstream | forwards every request header but hop-by-hop ones (`X-Boundary-Session` reaches the router); the pushed key arrives as `Authorization: Bearer` | `applyLlmConnectionOnce` (AssistantStackService.ts), chainRouter.ts | unit: chainRouter, applyLlmViaProxy; no live case |
| `GET /session/status`, `GET /session` (OpenCode) | busy session ids, titles | codingAgentBusy.ts | none |

## Gateway (`/api/ws` on the dashboard)

Methods. "Catalog" is the `test:stack` registry check of the method and the param keys Boundary
sends; "live" is a call on the running gateway.

| Method | Used in | Check |
| --- | --- | --- |
| `gateway.capabilities` (`turn_heartbeat`, `turn_heartbeat_s`, `session_live_status`, `client_context`) | `getTurnLiveness` (hermesGatewaySession.ts), `refuseLocalStackOlderThanPin` (stackPinCheck.ts) | catalog, live |
| `client.capabilities` | vendored channel on `gateway.ready` (vendor/json-rpc-channel.ts) | catalog |
| `gateway.ping` | vendored heartbeat (vendor/json-rpc-channel.ts); answered by the socket reader, not the method table | live |
| `session.events.since` | vendored replay after a redial (vendor/json-rpc-gateway.ts) | catalog |
| `session.create` (`history_budget` from the stack's overlay) | `createSessionWithSeed` | catalog, live |
| `session.resume` (`history_budget`, `omit_messages`) | `resumeSession`, `withLiveSession` | catalog, live |
| `session.resume` answering "session not found" for an id Hermes never minted (it makes a row for a minted key with none); the row is otherwise written on the first `prompt.submit` | `startChatTurn` makes a new session for a DM or failed chat; `keepFailedSend` keeps what never got a row | unit: hermesFailedChats; no live case |
| `session.resume` finding a session by stored id, live or minted, and answering "session not found" for a runtime id | `startChatTurn` resumes by stored id, so a failed chat keeps its live session | live, unit: hermesFailedChats |
| `session.context_breakdown` (`categories`, `context_max`, `context_used`, `history_*`) | `getContextBreakdown` | catalog, live |
| `session.live_status` (stack overlay) | `getLiveStatus` | live |
| `session.list`, `session.history` | `listSessions`, `getSessionHistory` | catalog |
| `session.title`, `session.cwd.set`, `session.interrupt` | `setSessionTitle`, `setSessionCwd`, `cancelPrompt` | catalog |
| `prompt.submit` (`context` from the stack's overlay) | `submitPrompt` | catalog; `client_context` capability |
| `approval.pending` | `replayPendingApprovals` | catalog, live |
| `approval.respond`, `approval.received` | `respondPendingApproval`, `ackApprovalReceived` | catalog |
| `profiles.describe` | `describeProfile` | catalog, live |
| `profiles.create`, `profiles.configure` | `createProfile`, `configureProfile` | catalog |
| `tools.list` (`toolsets[].name`, `enabled`) | `applyToolsEnabled` | catalog, live |
| `tools.configure` | `applyToolsEnabled`, `enableProfileToolsets` | catalog |
| `projects.list`, `projects.for_cwd` | `listProjects`, `getDefaultCwd` | catalog, live |
| `projects.set_active` | `setActiveProject` | catalog |
| `complete.path` | `completePath` | catalog, live |
| `config.get` (`key: full`; `config.agent.max_turns`, then `config.max_turns`) | `getMaxTurns` | catalog |
| `vault.sources` | `listVaultSources` (hermesVault.ts) | catalog, live |
| `vault.list`, `vault.add`, `vault.remove`, `vault.unlock`, `vault.lock` | hermesVault.ts through `requestVault` | catalog |
| `mcp.servers.status` (`servers[]`) | calendarService.ts through `requestMcp` | catalog, live |
| `reload.mcp`, `mcp.servers.remove` | calendarService.ts through `requestMcp` | catalog |

Events and server requests, with the payload fields Boundary reads:

| Name | Used in | Check |
| --- | --- | --- |
| `gateway.ready` | `openSocket` (hermesGatewaySession.ts) | catalog, live |
| `sessions.changed`, `request.cancel` (`id`) | `HermesGatewaySession` constructor | catalog |
| `message.delta` (`text`), `session.usage` (`usage`) | `runJsonRpcTurn` (hermesChatSessions.ts) | catalog |
| `message.complete` (`status`, `error`, `failure_reason`) | `runJsonRpcTurn`, hermesReplyEndings.ts | catalog |
| `tool.start`, `tool.generating`, `tool.complete` | `runJsonRpcTurn`, hermesRunningTurns.ts | catalog |
| `turn.heartbeat` (stack overlay) | `runJsonRpcTurn` | `turn_heartbeat` capability |
| `status.update` kind `lifecycle` with `ladder_notice`'s text (`agent/turn_recovery_autorecover.py`: "retrying automatically in Ns (cycle c/t)") | `parseRecoveryNotice` (hermesRecoveryNotice.ts), `runJsonRpcTurn` | catalog, live: recovery notice |
| `reasoning.delta` | `runJsonRpcTurn` (ends a recovery wait) | catalog |
| server request `approval` (`mcp` from the stack's overlay) | `parkApprovalRequest` (hermesApprovals.ts) | catalog |
| server requests `secret`, `vault.unlock_prompt`, `vault.save_login`, `vault.code` | `parkCredentialRequest` (hermesCredentialRequests.ts) | catalog |

A difference the catalog case finds and Boundary hasn't fixed yet goes in its known-mismatch list,
so the fix shows up as a failure until the entry is removed. The list is empty.

## `config.yaml` keys

Boundary writes these into the default profile and its agents' profiles through the settings
program (`HERMES_CONFIG_APPLY_PROGRAM` in hermesConfigApply.ts), which calls Hermes's
`set_config_value` for scalars and writes mappings whole. The `test:stack` keys case collects them
from `desiredHermesConfig` (AssistantStackService.ts) and the calendar grant, so a new key is checked
without editing the test.

| Key | Written by | Check |
| --- | --- | --- |
| `model.provider`, `model.base_url`, `model.default`, `model.model`, `model.api_key` | `desiredHermesConfig` | `test:stack` keys, settings program |
| `agent.tool_use_enforcement`, `agent.execution_guidance` | `desiredHermesConfig` | `test:stack` keys, settings program |
| `agent.local_stream_stale_timeout`, `model.context_length`, `model.max_tokens` | `hermesProfileLimitSets` (hermesProfileLimits.ts); for a shared model as the app default, `model.context_length` is the offer's (ADR 0036) | `test:stack` keys, settings program |
| `platform_hints.boundary` (top level; Hermes refuses `agent.platform_hints.*`) | `BOUNDARY_PLATFORM_HINT_KEY` (hermesPlatformHint.ts) | `test:stack` keys, settings program |
| `mcp_servers.boundary.*` (`url`, `headers.*`, `timeout`, `connect_timeout`, `keepalive_interval`, `parked_retry_interval`) | `hostBridgeHermesConfigSets` (hostBridge/hermesProvision.ts) | `test:stack` keys, settings program |
| `browser.cdp_url` | `planHermesProfileWrites` from `hermesBrowserCdpUrl` | `test:stack` keys, settings program |
| `mcp_servers.opencode`, `mcp_servers.searxng`, `mcp_servers.todos` (whole entries) | `defaultMcpServerEntries` (hermesAgentMcpServers.ts) | `test:stack` keys, settings program |
| `mcp_servers.<calendar server>` (whole entry, through `hermes config set`) | `grant` (calendar/calendarService.ts) | `test:stack` keys |
| `providers.boundary-chain` (whole entry: `base_url`, `api_key`, `session_affinity_header`); Hermes sends that header on the route whose `base_url` matches `model.base_url`, and looks it up on each request, so writing this entry needs no restart (`build_api_kwargs`, `get_custom_provider_session_affinity_header`) | `desiredHermesConfig` with `routed` (ADR 0033), `hermesWritesNeedRestart` | `test:stack` keys, settings program, session header; no live case for the missing restart |

The settings-program case also runs a refused key and expects the program to report it as a result
line (`SystemExit` at that key) and exit 0, then reads the stored files back and expects Boundary's
own plan to find nothing left to write.

## Request shape

Token counts for shared models rely on Hermes sending `stream_options: {"include_usage": true}` on streamed chats (`_open_chat_stream` in `agent/chat_completion_helpers.py`), which it skips for native Gemini and for endpoints that refused it. Without it, `UsageTail` finds no `usage` and only requests are counted. No `test:stack` case covers this; the "Usage and limits" check in `docs/testing/circle-sharing.md` does.

## Compose progress

The start-up screen's milestones (`StartTimer`, startTimer.ts) read `compose --progress json` lines. A
missing event leaves the bar easing toward that milestone until a later one arrives, and a tool's
outline easing short of full until the stack is ready.

| Event | Used for | Check |
| --- | --- | --- |
| `Exited` on the `hermes-api-bootstrap` and `hermes-browser-bootstrap` containers | Bootstrap milestones. Compose v2.38.2 sends it from `waitDependencies` | manual: `start-up milestones` debug-log line |
| `Started` on any container, and on `boundary-hermes` | First-container and Hermes milestones | manual: `start-up milestones` debug-log line |
| `Started` and `Healthy` per container | Each tool's outline on the ring. `Healthy` arrives only where a dependent waits on `service_healthy` in the stack's compose file; the rest stop at `Started` | manual: `services` in the `start-up milestones` debug-log line |

## Compose profiles and switches

Boundary passes these in the compose environment of its own install, so they apply without
re-running `setup.sh`.

| Name | Stack behaviour relied on | Used in | Check |
| --- | --- | --- | --- |
| `automation` profile, services `n8n`, `n8n-import` and `gpt-researcher` | the profile holds `gpt-researcher`, `gptr-mcp`, `n8n-import` and `n8n`. `n8n` waits for `n8n-import` and a healthy `gpt-researcher`, and no other service depends on those three; since stack v0.3.9 `gptr-mcp` is also in `research` and runs GPT Researcher in-process, so Hermes's and OpenCode's GPT Researcher tools don't need the `gpt-researcher` service. Boundary starts n8n only when the user turns it on (Services → n8n). With n8n off, `up` names every service that `config --services` lists for Boundary's profiles except those three. Compose starts a named service without pulling or creating the rest of its profile, which `--scale n8n=0` doesn't do: it still pulls the image. Turning n8n off runs `rm -sf n8n-import n8n gpt-researcher` and keeps the `n8n_storage` volume | `N8N_COMPOSE_SERVICES` (assistantStackConstants.ts), `composeUpServices`, `setN8nRunning` and the start-up cards (AssistantStackService.ts) | unit: ensureAssistantStackProvision (n8n), setN8nRunning; no `test:stack` case |
| `rag` profile, services `lightrag-mcp`, `lightrag` and `neo4j`; `LIGHTRAG_MCP_ENABLED` | the profile holds only those three. `n8n`'s `depends_on` on `lightrag` and `neo4j` is `required: false`, and nothing else depends on them. With the flag at 1, `hermes-api-bootstrap` and `hermes-browser-bootstrap` register `mcp_servers.lightrag` (`http://lightrag-mcp:8000/mcp`, five read tools) on the api-server and browser profiles; at 0 they skip it but leave an entry already there, which Hermes then parks as unreachable; from 0.3.11 they also drop every entry on their profile that points at `LIGHTRAG_MCP_URL` (change request 0022 R1). `setup.sh` writes the Neo4j and LightRAG secrets with or without `--rag`. Boundary starts the profile only when the user turns LightRAG on (Services → LightRAG) and sets the flag to match, overriding the 1 that `setup.sh --rag` wrote for earlier Boundaries. Turning it on starts the three services and reruns both bootstraps before recreating `hermes`; turning it off runs `rm -sf` on them and keeps the `neo4j_data` volume and `data/rag_storage`. The first start with no setting removes containers left by earlier Boundaries | `LIGHTRAG_COMPOSE_SERVICES` (assistantStackConstants.ts), `lightragComposeProfiles` and `lightragComposeEnv` (addonComposeState.ts), `setLightragRunning`, `removeLightragLeftovers` and the start-up cards (AssistantStackService.ts) | unit: ensureAssistantStackProvision (LightRAG), setLightragRunning, addonComposeState; no `test:stack` case |
| `research` profile, `GPTR_MCP_ENABLED=1` | the profile starts `gptr-mcp`; with the flag, `hermes-api-bootstrap` and `hermes-browser-bootstrap` register `mcp_servers.gptr` (SSE, `http://gptr-mcp:8000/sse`, `tools.include` of five tools) on the default and browser profiles and never on api-server, and pin `deep_research`, `quick_search` and `write_report`. Stacks before the profile ignore both | `BOUNDARY_ASSISTANT_COMPOSE_PROFILES` (assistantStackConstants.ts), `buildBoundaryComposeContext` (AssistantStackService.ts) | `test:stack` live: GPT Researcher registration, when the stack's `.env` sets the flag; unit: recreateHermesForProjectMounts |
| `search-gate` profile, `WEB_SEARCH_URL=http://search-gate:8080` | the profile starts `search-gate`, built locally from `compose/search-gate` as `${IMAGE_PREFIX}-search-gate:local`, which waits for a healthy `searxng` and answers `GET /healthz` on port 8080. `WEB_SEARCH_URL` sets `SEARXNG_URL` on `mcp-searxng` and `SEARX_URL` on `gpt-researcher` and `gptr-mcp`; each of those waits on a healthy `search-gate` with `required: false`. The gate sends each query to one engine from `SEARCH_GATE_ENGINES` (default `bing:10,google cse:20,naver:20`), rests an engine after a CAPTCHA, 403, 429 or timeout, and answers a search still waiting after `SEARCH_GATE_MAX_WAIT` (15 s) with no results and a `search-gate` entry in `unresponsive_engines`. It caches results in the `search_gate_data` volume, which holds queries from chat. Since stack v0.3.8; with the URL set and no gate, searches fail | `BOUNDARY_ASSISTANT_COMPOSE_PROFILES` and `BOUNDARY_WEB_SEARCH_URL` (assistantStackConstants.ts), `buildBoundaryComposeContext` (AssistantStackService.ts), healthcheck cadence (docker-compose.boundary.yml) | `test:stack` live: search gate `/healthz`, when the stack's `.env` sets `SEARCH_GATE_ENABLED=1`; unit: recreateHermesForProjectMounts |
| `HERMES_WEB_SEARCH_MODE` (stack v0.3.11) | the `hermes` service gets `${HERMES_WEB_SEARCH_MODE:-private}`; the overlay `agent/web_search_mode.py` reads it on each call, lowercased and trimmed, and treats an unknown value as `private`. `private` is SearXNG and mcp-searxng's plain fetch only; `private-first`, `keyless-first` and `keyless` also or only use Hermes's keyless services (Exa, Parallel, Firecrawl, Keenable), which upstream's `web.keyless_fallback: false` turns off in every mode. Only `searxng_web_search` and `web_url_read` in Hermes follow it. Hermes loads `data/hermes/.env` and each profile's `.env` over the container's environment, so a line there wins. Boundary always passes its own value, so a line in the stack's `.env` doesn't decide; a change recreates `hermes` with `up -d --no-deps`. Settings offers the choice only when the pin is at least v0.3.11 | `WEB_SEARCH_MODE_MIN_STACK_VERSION` (webSearchMode.ts), `buildBoundaryComposeContext`, `getWebSearchModeState` and `setWebSearchModeRunning` (AssistantStackService.ts), `findWebSearchModeOverrides` (webSearchModeOverrides.ts) | `test:stack` live: the overlay's mode list and value parsing, skipped on a stack without it; unit: setWebSearchModeRunning, webSearchModeOverrides, WebSearchModeSection |

## Twenty add-on (stack 0.3.10)

Boundary's Add-ons section installs Twenty through these. Stacks before 0.3.10 have none of them, and Boundary lists no add-on for such a stack. Sources are the stack's `docker-compose.yml`, `scripts/crm.sh`, `scripts/lib/python.sh` and `compose/hermes/bootstrap-api-profile.sh`.

| Name | Stack behaviour relied on | Used in | Check |
| --- | --- | --- | --- |
| `crm` profile, `TWENTY_LOCAL_ENABLED=1`, `TWENTY_MCP_ENABLED=1` | the profile starts Twenty's four services; `TWENTY_MCP_ENABLED` makes both bootstrap services register `crm-<slug>` on the default profile, one per workspace file | the add-on installer's compose env and `--profile crm` (addonInstaller.ts) | `test:stack` live: `crm-main` registration, when the stack's `.env` sets `TWENTY_MCP_ENABLED=1` and `scripts/crm.sh` exists; unit: addonInstaller |
| `twenty-server`, `twenty-worker`, `twenty-db`, `twenty-redis`; `twenty-server` healthcheck (`/healthz`, 120 s start period, 12 retries) | the service names Boundary lists, stops and counts memory for; healthy means Twenty answers and migrations are done; any of them in `compose --profile crm ps` while Twenty isn't recorded as installed means leftover containers | addonCatalog.ts, addonInstaller.ts, addonFitCheck.ts | unit: addonFitCheck, addonInstaller; manual: install flow |
| `bash scripts/crm.sh init` | needs a running `twenty-server` and waits for it to report healthy (`require_running`); exits 0 on success and non-zero with a `[crm] ERROR:` line on stderr when it fails; writes `TWENTY_USERNAME` and `TWENTY_PASSWORD` to the stack's `.env` before it calls Twenty; needs host `python3` 3.9 or later and reports a missing or stub `python3` as `error: python3 ...` (`require_python3`, `scripts/lib/python.sh`) | addonInstaller.ts | unit: addonInstaller (fake runner); manual: install flow |
| `HERMES_BOOTSTRAP_FORCE=1` on `hermes-api-bootstrap` and `hermes-browser-bootstrap` | runs the full bootstrap even when inputs are unchanged, so a new `crm-*` entry is written | `reloadHermesForAddons` (AssistantStackService.ts) | unit: addonInstaller; manual: install flow |
| `compose/hermes/bootstrap-api-profile.sh` with `TWENTY_MCP_ENABLED` other than 1 | removes the profile's `crm-*` entries and their `TWENTY_<SLUG>_KEY` (`reconcile_twenty_workspaces`) | Turn off, and Undo install once Twenty was recorded as installed or its restart failed, each followed by the same reload | unit: addonInstaller; manual: Turn off flow |
| `TWENTY_DATA_DIR` (default `./data/twenty`, relative to the stack root) | `twenty-db` binds `db/` and `twenty-server` and `twenty-worker` bind `storage/` under it; `crm.sh ensure` creates both | the installer creates `<data root>/twenty/db` and `storage` before `up` in the managed stack, which skips `crm.sh ensure` (addonInstaller.ts) | unit: addonInstaller (temp folder); manual: install flow on Podman |
| `TWENTY_PORT` (default 3000) | Twenty publishes on `127.0.0.1:${TWENTY_PORT:-3000}` | the fit check's port probe (addonHostFacts.ts) | unit: addonHostFacts; Open Twenty still uses 3000 |

## Files under the stack's folder

| File | Read or written | Used in | Check |
| --- | --- | --- | --- |
| Gitignored files in the stack tree: `data`, `.env`, `compose/hermes/api-server.env`, `compose/hermes/browser.env`, `compose/hermes/worker/ssh`, `compose/caldav-mcp/accounts`, `compose/twenty/workspaces` (v0.3.10, one file per Twenty workspace with its API keys), `model-defaults/local.json` (v0.3.10, llm-proxy's per-model defaults), `opencode/opencode.local.json`, `searxng/settings.local.yml`, `models.local.yaml`, `docker-compose.override.yml` | moved from the old tree into the new one when the pin moves; everything else comes from the new archive. The list follows the stack's `.gitignore` | `PRESERVED_PROJECT_PATHS` (projectTreeSwap.ts) | unit: projectTreeSwap; manual: upgrade from a packaged build |
| `data/db` (Postgres cluster, `DB_DATA_DIR` default), with `data/hermes`, `data/n8n`, `data/rag_storage`, `data/neo4j` | copied with containers stopped | `backupStackDataBeforeUpgrade` (stackDataBackup.ts) | unit: stackDataBackup; manual: step 3 of the updates plan test path |
| `.env` (`HERMES_DASHBOARD_USER`, `HERMES_DASHBOARD_PASSWORD`, `HERMES_DASHBOARD_HANDOFF_SECRET`, `API_SERVER_KEY`) | read | `resolveDashboardCredentials`, `resolveDashboardHandoffSecret`, `resolveApiServerKey` (hermesEndpoints.ts) | `test:stack` HTTP (credentials) |
| `data/hermes/profiles/api-server/.env`, `compose/hermes/api-server.env` (`API_SERVER_KEY`) | read | `resolveApiServerKey` | `test:stack` HTTP (credentials) |
| `data/hermes/config.yaml`, `data/hermes/profiles/<name>/config.yaml` | read | `readHermesProfileConfig` (hermesConfigApply.ts), `hermesConfigExists`, `removeIncompleteHermesProfiles` (assistantPaths.ts) | unit: hermesConfigApply |
| `data/hermes/.env`, `data/hermes/profiles/<name>/.env` | read and written | `writeHostBridgeTokensToProfiles` (hostBridge/hermesProvision.ts), `editProfileEnv` (calendarService.ts); `findWebSearchModeOverrides` reads only whether `HERMES_WEB_SEARCH_MODE` is set | unit tests only |
| `scripts/setup.sh` and the scripts it runs, under macOS `/bin/bash` 3.2 | run | `runSovereignSetup` | the stack's `make bash32-test` (stub `docker`); manual: packaged install |
| `data/hermes/profiles/<name>/SOUL.md` | read | `resolveSoulFilePath` (agentSoul.ts) | none |
| `data/hermes/agents/registry.json` | read | `readRegistryAgents` (hermesAgents.ts) | none |
| `compose/hermes/worker/ssh/id_ed25519` | read | hermesWorkerKey.ts | none |
