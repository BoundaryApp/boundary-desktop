# Stack contract

Everything Boundary takes from the agent stack, where Boundary uses it, and which check covers it
([ADR 0031](adr/0031-checks-on-the-stack-contract-and-drift.md)). A dependency missing from this
table has no check. Moving the stack pin means reading the stack's changelog against it.

`test:stack` cases live in three files:

- `hermesConfig.stack.test.ts` (keys, settings program) under `src/main/services/assistant/__tests__/`
- `stackHttp.stack.test.ts` (HTTP) in the same folder
- `hermesGateway.stack.test.ts` (catalog, live calls) under `src/main/services/assistant/hermes/__tests__/`

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

Default ports; Boundary's own stack adds 10000 in `offset-ports` mode (`portsForIsolationMode`).

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
| `agent.local_stream_stale_timeout`, `model.context_length`, `model.max_tokens` | `hermesProfileLimitSets` (hermesProfileLimits.ts) | `test:stack` keys, settings program |
| `platform_hints.boundary` (top level; Hermes refuses `agent.platform_hints.*`) | `BOUNDARY_PLATFORM_HINT_KEY` (hermesPlatformHint.ts) | `test:stack` keys, settings program |
| `mcp_servers.boundary.*` (`url`, `headers.*`, `timeout`, `connect_timeout`, `keepalive_interval`, `parked_retry_interval`) | `hostBridgeHermesConfigSets` (hostBridge/hermesProvision.ts) | `test:stack` keys, settings program |
| `browser.cdp_url` | `planHermesProfileWrites` from `hermesBrowserCdpUrl` | `test:stack` keys, settings program |
| `mcp_servers.opencode`, `mcp_servers.searxng`, `mcp_servers.todos` (whole entries) | `defaultMcpServerEntries` (hermesAgentMcpServers.ts) | `test:stack` keys, settings program |
| `mcp_servers.<calendar server>` (whole entry, through `hermes config set`) | `grant` (calendar/calendarService.ts) | `test:stack` keys |
| `providers.boundary-chain` (whole entry: `base_url`, `api_key`, `session_affinity_header`); Hermes sends that header on the route whose `base_url` matches `model.base_url` | `desiredHermesConfig` with `routed` (ADR 0033) | `test:stack` keys, settings program, session header |

The settings-program case also runs a refused key and expects the program to report it as a result
line (`SystemExit` at that key) and exit 0, then reads the stored files back and expects Boundary's
own plan to find nothing left to write.

## Files under the stack's folder

| File | Read or written | Used in | Check |
| --- | --- | --- | --- |
| `.env` (`HERMES_DASHBOARD_USER`, `HERMES_DASHBOARD_PASSWORD`, `HERMES_DASHBOARD_HANDOFF_SECRET`, `API_SERVER_KEY`) | read | `resolveDashboardCredentials`, `resolveDashboardHandoffSecret`, `resolveApiServerKey` (hermesEndpoints.ts) | `test:stack` HTTP (credentials) |
| `data/hermes/profiles/api-server/.env`, `compose/hermes/api-server.env` (`API_SERVER_KEY`) | read | `resolveApiServerKey` | `test:stack` HTTP (credentials) |
| `data/hermes/config.yaml`, `data/hermes/profiles/<name>/config.yaml` | read | `readHermesProfileConfig` (hermesConfigApply.ts), `hermesConfigExists`, `removeIncompleteHermesProfiles` (assistantPaths.ts) | unit: hermesConfigApply |
| `data/hermes/.env`, `data/hermes/profiles/<name>/.env` | read and written | `writeHostBridgeTokensToProfiles` (hostBridge/hermesProvision.ts), `editProfileEnv` (calendarService.ts) | unit tests only |
| `data/hermes/profiles/<name>/SOUL.md` | read | `resolveSoulFilePath` (agentSoul.ts) | none |
| `data/hermes/agents/registry.json` | read | `readRegistryAgents` (hermesAgents.ts) | none |
| `compose/hermes/worker/ssh/id_ed25519` | read | hermesWorkerKey.ts | none |
