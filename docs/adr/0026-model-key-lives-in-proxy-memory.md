# 0026. The model key lives in the proxy's memory, not on disk

- Date: 2026-10-06
- Status: Accepted (2026-10-06), amended 2026-10-06 (restart marker, held routes, Hermes settings)
- Parent: [0001](0001-record-architecture-decisions.md)
- Related: [credential-handling-plan.md](../credential-handling-plan.md) items 6–7, [0015](0015-inference-provider-slots.md)

## Context

From v0.2.0, every model call in the agent stack (Hermes, OpenCode, LightRAG, GPT Researcher) goes through `llm-proxy`. Clients send the placeholder key `local-llm` on the compose network. Only the proxy holds the real endpoint and key.

The proxy can get the key three ways:

- from `LLM_BINDING_API_KEY` in the stack `.env`, read when its container is created. The key is then in a plain file and in `docker inspect` output.
- from a file named by `LLM_BINDING_API_KEY_FILE`, such as a mount at `/run/secrets`. The key is still on disk, but in one file only you can read, and not in the container's environment.
- from `POST /admin/upstreams`, which updates its in-memory table. Nothing is written, and the proxy forgets the key when it restarts.

Boundary already keeps each key encrypted with the OS keychain (`safeStorage`, 0015). The stack keeps running after Boundary quits (`restart: unless-stopped`), and Boundary doesn't stop it on quit.

## Decision

1. **On a Boundary-managed stack, the key only reaches the proxy through the admin API.** The stack `.env` keeps `LLM_BINDING_API_KEY` and `LIGHTRAG_LLM_BINDING_API_KEY` blank. Boundary pushes the key on every launch and every model or slot change.
2. **Boundary pushes the key again when the proxy loses it.** While Boundary runs, it checks the proxy every 30 seconds.
   - From stack v0.3.0, the proxy reports a `boot_id` that changes on every start and a per-route `pushed` flag. Boundary pushes again when the `boot_id` differs from the one its last push reached, or a route isn't pushed. A keyless local upstream is never pushed twice to the same process.
   - On an older proxy, which reports neither, Boundary pushes when the chat or LightRAG route points at another endpoint, or has no key when ours has one.
3. **Keys left on disk by older versions are cleared.** On start, Boundary blanks the key lines in `.env`. If the stack is already running, it recreates `llm-proxy` once so the old key leaves the container's environment.
4. **Unpushed routes answer 503.** Boundary's overlay sets `LLM_PROXY_AWAIT_PUSH=chat,lightrag`. Until a push names them, those routes answer 503 with the reason, instead of reaching the provider without a key. Stack v0.3.0 added it; older proxies ignore it.
5. **Hermes settings follow the model, not the stack start.** Every model change sets these on each profile, as the stack's bootstrap and `model-use.sh` do:
   - `model.default` and `model.model`.
   - `agent.local_stream_stale_timeout`: 300 seconds for a local upstream, 180 for a cloud one, using the bootstrap's `upstream_is_local` rule. `HERMES_PROXY_STALE_TIMEOUT` in `.env` wins. The bootstrap only sizes it when the stack comes up, so without this a local↔cloud switch kept the old value until the next launch.
   - `agent.tool_use_enforcement` and `agent.execution_guidance` back to Hermes's default, `auto`. Earlier Boundary versions forced both on for every model to stop OpenRouter Llama faking tool calls. The stack's docs advise against it: it makes weaker or quantized models fake tool calls in text more often. OpenRouter Llama may do that again; the stack marks it not recommended.
6. **Local-stack mode keeps the key in `.env`.** Boundary doesn't drive a developer's own proxy, so that proxy still reads its key from `.env`.

## Consequences

- **Known gap: while Boundary is closed, a restarted proxy has no key.** A Docker Desktop restart, a reboot, or a proxy crash after you quit Boundary brings the proxy back with no key. Until Boundary opens and pushes it again, model calls through that route fail with the upstream's auth error. Things that can run without the app are affected: Hermes's messaging gateways (Telegram and so on), scheduled jobs, and the Hermes WebUI. Local endpoints that need no key are not affected.
  - **What a user sees:** a chat from a gateway or WebUI fails. With decision 4 (stack v0.3.0 and later) it is a 503 saying llm-proxy is waiting for its admin client to push the upstream. On an older proxy it was the provider's 401 or "missing API key", which looks like a bad key. Opening Boundary fixes it within a few seconds of the stack being ready.
  - **If this becomes a problem:** switch to the key-file route, which the stack has supported since v0.2.0 and reads again on every start. Boundary would write the key to a file only you can read in its stack home, mount it at `/run/secrets/llm_key`, and set `LLM_BINDING_API_KEY_FILE`. Then signal the proxy (`SIGHUP` or `POST /admin/reload`) after each change. The proxy already supports this. The cost is one file on disk with the key in it.
- `docker inspect boundary-llm-proxy` no longer shows the key. Decision 1 of the credential plan (accepting that exposure) no longer applies.
- When a push fails, Boundary recreates `llm-proxy` and retries for about 10 seconds. After that the 30-second check keeps trying, so a slow proxy start doesn't need a second model apply.
- Code: `llmProxyAdmin.ts` (admin client), `llmProxyKeyKeeper.ts` (checks and pushes again), `hermesStreamTimeout.ts` (stale-stream timeout), `LLM_PROXY_AWAIT_PUSH` in `resources/assistant/docker-compose.boundary.yml`, `clearLlmKeysFromProjectEnv` and `applyLlmConnectionToProjectFiles` in `applyLlmToProjectEnv.ts`, and `applyLlmConnectionToHermes` and `ensureAssistantStackRunning` in `AssistantStackService.ts`.
