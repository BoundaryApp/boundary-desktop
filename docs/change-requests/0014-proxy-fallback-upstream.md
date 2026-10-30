# 0014 · llm-proxy: a fallback upstream, the upstream that served, and a session id for routing

**Serves:** [circles plan](../circles-plan.md), [ADR 0033](../adr/0033-inference-chains.md).
**Status:** R1 and R2 done in v0.3.7, which Boundary pins · R3 needs no patch, two live checks pending

## Background

Boundary is adding inference chains: an ordered list of models, such as a model a friend shares, then the user's own local model, then OpenRouter. A host-side router in Boundary walks the chain, and `llm-proxy`'s `chat` and `lightrag` routes point at it. This works with today's proxy. The items below would make the same behaviour available to anyone running the stack, with or without Boundary, and close the gap Boundary's router opens when Boundary is closed.

What was checked in the stack's code:

- `compose/llm-proxy/proxy.py` keeps one `Route` (`url`, `api_key`) for each of `chat`, `lightrag` and `embed`. `Table.update` replaces fields from `POST /admin/upstreams`. There is no second upstream.
- `outbound_headers` copies every request header except hop-by-hop ones, so a header Hermes sends reaches the upstream.
- Hermes sends a session affinity header when a custom provider declares `session_affinity_header` (`agent/opencode_affinity.py`). Its value is `resolve_affinity_key(session_id)`. (Corrected by the stack reply below: for a chat that is the conversation's root session id.)

> **Stack reply (correction):** most of the checked claims hold. For R3, the affinity value is usually the conversation's root session id, not an opaque scope. `resolve_affinity_key` tries, in order, a declared scope (only kanban code sets one, `kanban:<task>`), the conversation's lineage root (set at turn entry), then the physical session id. Normalization only rewrites cron ids. So for a chat the value is the id of the session that started the conversation, which stays the same across compaction. Hermes also has a fallback chain of its own, `fallback_model`. The other clients weren't checked.
>
> **Boundary:** neither Boundary nor the stack sets `fallback_model` or `fallback_providers`, and Hermes leaves them out when disabled (`hermes_cli/config.py`, checked in the pinned image), so Boundary-managed profiles have no Hermes fallback, as ADR 0033 intends.

## R1 · A fallback upstream for each route (Wanted)

**Why:** a stack user with a local model and a cloud key wants calls to go to the cloud when the local server is down, for Hermes, LightRAG, OpenCode and GPT Researcher alike. Today each client would need its own fallback setting, and most have none. For Boundary, this is what lets OpenRouter keep working while Boundary is closed and its router is gone.

**Ask:** let each route carry an optional ordered `fallbacks` list of `{url, api_key, model?}`, settable by `POST /admin/upstreams` and by env or key file at start. The proxy tries the next upstream when one refuses the connection, times out before response headers, or answers 429 or 5xx before any body bytes. It never switches once body bytes have been sent. When an entry names `model`, the proxy rewrites the request body's `model` for that upstream.

**Acceptance:** with the primary stopped, a chat request through `llm-proxy` is served by the first fallback, with no client change. With the primary answering 200 and streaming, a later failure is not retried. `GET /admin/upstreams` lists the fallbacks with `api_key_set` and never the keys.

**Boundary fallback:** Boundary's router walks the chain itself and is the proxy's only upstream. While Boundary is closed, model calls fail with a connection error from the router's address.

> **Stack reply (done, with changes):** on the stack's main in `7fa8aa2`, not yet tagged. `chat` and `lightrag` each take an ordered `fallbacks` list of `{url, api_key, model?}`. Where it differs from the ask:
>
> - No fallbacks on `embed`: an embedding from another model lands in the same LightRAG index and breaks retrieval without an error. `fallbacks` on `embed` gets a 400.
> - No retry after a header timeout. `LLM_TIMEOUT` (600 s) covers prefill, so it runs out on a slow model as often as on a dead one, and Hermes gives up at 180 s anyway. The proxy moves on when an upstream refuses the connection, fails DNS, or can't be connected to within `LLM_CONNECT_TIMEOUT` (default 10 s), or answers 429, 500, 502, 503 or 504. The connect timeout applies only to an upstream with another after it, so a route with no fallbacks behaves as before. Nothing is retried once the response has started.
> - At start, from a file rather than env: `LLM_PROXY_FALLBACKS_FILE` names a JSON file `{"chat": [...], "lightrag": [...]}`, re-read on SIGHUP and `POST /admin/reload`. A JSON env var would put keys in `docker inspect`.
>
> Admin: `fallbacks` in a POST replaces the route's whole list, `[]` clears it, and leaving it out keeps it. A bad list gets a 400 and changes nothing. `GET` shows `url`, `model` and `api_key_set` per entry, never a key. A `lightrag` route with no URL of its own uses `chat`'s list. See the stack's `docs/extending.md#fallback-upstreams`.
>
> For Boundary's setup: pushed fallbacks live in memory and are gone after any proxy restart, and a route listed in `LLM_PROXY_AWAIT_PUSH` answers 503 after a restart until the next push, fallbacks or not; reloading the file doesn't release it. For OpenRouter to keep working while Boundary is closed, write the fallbacks file. Set `model` on the OpenRouter entry: without it the request goes out with the model name the router expects, and OpenRouter's 4xx isn't retried. When the router is down, the next upstream is tried at once, because the router's port on `host.docker.internal` refuses the connection.
>
> **Boundary:** not adopted yet; waits for the tag. The fallbacks file would hold the OpenRouter key on disk, which ADR 0026 rules out, and Boundary sets `LLM_PROXY_AWAIT_PUSH=chat,lightrag` (ADR 0026 §4), so a file alone wouldn't survive a proxy restart either. What fits ADR 0026: when the router is the route's upstream, push OpenRouter, with `model` set, as the route's one fallback. It lives in proxy memory, so OpenRouter answers while Boundary is closed until the proxy restarts, as before routing. Boundary won't keep OpenRouter across a proxy restart with Boundary closed: that would mean a key on disk and dropping await-push for `chat`, and ADR 0026 stands (decided 29 Oct 2026). Boundary won't use `LLM_PROXY_FALLBACKS_FILE`. Two constraints on that push: the proxy also falls back on the router's own 503 when a chain runs out, so the fallback may only be pushed when the active chain itself ends with OpenRouter and isn't cut by a privacy lock, or the router must answer an exhausted chain with a status the proxy doesn't retry. Otherwise a chain the user wrote without OpenRouter would reach it anyway. The proxy's missing header-timeout retry doesn't affect Boundary: its router keeps that rule for the entries it walks.

## R2 · Say which upstream served (Wanted)

**Why:** with fallbacks, a client or a user reading logs needs to know which upstream answered. Boundary shows it in the chat; a stack user would see it in the proxy log.

**Ask:** add a response header naming the route and upstream index that served, such as `X-LLM-Proxy-Upstream: chat;0`, and log the same in the proxy's metadata-only log line. When the upstream itself returns that header (Boundary's router does), pass its value through unchanged.

**Acceptance:** a response through a fallback carries the header with its index. A response from an upstream that sets the header keeps the upstream's value.

**Boundary fallback:** Boundary's router sets its own header and the proxy forwards it today, so Boundary does not need R2 until R1 is in use.

> **Stack reply (done):** every proxied response carries `X-LLM-Proxy-Upstream: <route>;<index>` (0 = primary). When the upstream sends that header, its value is forwarded unchanged. The request log line ends with `<status> upstream=<route>;<index>`, and each attempt the proxy moved past gets its own line with the upstream's host and the reason. No bodies or headers are logged.
>
> **Boundary:** nothing to change while the router is the only upstream. Once the proxy has an OpenRouter fallback, a turn the proxy sent there never reaches the router, so Boundary's fallback mark can't name it; Hermes gets `X-LLM-Proxy-Upstream`, Boundary doesn't. The proxy log line is the evidence until then.

## R3 · An opt-in session id header to the model endpoint (Later)

**Why:** a proxy or router that chooses an upstream per conversation, or attributes cost per conversation, needs to know which session a request belongs to. Hermes's affinity header carries a normalized cache scope, which a client cannot map back to its session.

**Ask:** a Hermes setting (patched in the stack if upstream doesn't take it) that sends the Hermes session id in a named header on every model request, off by default.

**Acceptance:** with the setting on, every chat completion request for a session carries that session's id in the named header, through `llm-proxy`.

**Boundary fallback:** Boundary pushes the chain resolved for the chat being sent to its router before each send, as it applies a single connection today. Two chats on different chains at the same time share whichever chain was pushed last.

> **Stack reply (use existing config, to be confirmed):** no patch planned. Add a `providers` entry whose `base_url` is `http://llm-proxy:4000/v1` with `session_affinity_header` set to any header name. Hermes matches the entry by URL and sends the conversation's root session id on main-turn and auxiliary calls, and the proxy forwards it. A router choosing an upstream per conversation wants the root id rather than the physical id, because compaction rotates the physical id. Kanban runs send `kanban:<task>` and cron runs `cron_<job>`. Still to confirm on a live stack: that a profile set up with only `model.base_url` picks up the entry, and that the header arrives on dashboard-gateway turns. The result will be posted here.
>
> **Boundary:** this is what Boundary already writes (`providers.boundary-chain`, header `X-Boundary-Session`), and the `test:stack` session-header case checks that Hermes's lookup finds the header from `model.base_url`. It doesn't check that the header arrives on a turn. Since the value is the root session id, the router can tell chats apart by it, which would end both gaps above: concurrent chats on different chains, and a fallback mark landing on the wrong chat. That waits for the stack's two live checks.

## Notes

R1 and R2 change `compose/llm-proxy/proxy.py` only. R3 is a Hermes change and may belong upstream.

> **Stack reply:** R1 and R2 ship in the next 0.3.x tag; Boundary gets them when it pins that tag. With no fallbacks configured, routing, timeouts and errors are as before. The only visible changes are the `fallbacks` field in `GET /admin/upstreams`, the new response header and longer log lines.
