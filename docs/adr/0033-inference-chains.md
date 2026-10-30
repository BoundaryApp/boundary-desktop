# 0033. Inference chains and a host-side router

- Date: 2026-10-29
- Status: Accepted
- Parent: [0017](0017-project-inference-pin.md)
- Amends: [0016](0016-chat-inference-override.md) §4
- Related: [0026](0026-model-key-lives-in-proxy-memory.md), [0027](0027-host-bridge.md), [0034](0034-shared-models.md), [0035](0035-turn-admission-and-model-gate.md) (proposed: gates model calls in this router), [circles plan](../circles-plan.md)

## Context

The app default, a project pin and a chat override each name one slot ([0015](0015-inference-provider-slots.md)–[0017](0017-project-inference-pin.md)). When that slot is down, the send stops and the user picks Retry or OpenRouter ([0016](0016-chat-inference-override.md) §4). Users want to put a preferred model first, such as a model a Circle member shares ([0034](0034-shared-models.md)) or their own local model, and fall back to OpenRouter on their own say-so, without stopping to confirm each time.

What the stack offers today, checked in its source:

- `llm-proxy` (`compose/llm-proxy/proxy.py`) has one upstream for each of its `chat`, `lightrag` and `embed` routes. It has no fallback. Boundary sets the upstreams through `POST /admin/upstreams` ([0026](0026-model-key-lives-in-proxy-memory.md)).
- Hermes has a fallback chain, `fallback_providers`, whose entries carry their own base URL and `key_env` (`hermes_cli/fallback_config.py`). After a fallback, `_served_runtime` in `gateway/platforms/api_server_runs.py` reports the provider and model that served the turn. Every entry would still need its own route through `llm-proxy`, which has one chat route.
- Hermes takes an explicit `model.context_length` before any `/models` probe (`get_model_context_length`, step 0 in `agent/model_metadata.py`).

## Decision

1. **A chain is an ordered list of entries.** Each entry names a slot (`local`, `openrouter`, `infrastructure`, or a shared model, `peer`) and an optional model. The app default, a project pin and a chat override can each hold a chain. A chain with one entry behaves as a slot does today. The resolve order stays chat → project → app default ([0017](0017-project-inference-pin.md) §3). The first level that is set supplies the whole chain; levels are not merged.
2. **The user writes the chain.** Boundary never adds an entry. A chain may hold any model the user can use, from any Circle. "Any model I have access to" is a list the user picks from, not a set Boundary fills in, because a new offer joining a chain on its own would widen who sees the user's prompts.
3. **Fallback is visible, not silent.** This amends [0016](0016-chat-inference-override.md) §4: a chain with more than one entry is the user's standing consent to fall back. When a later entry serves a turn, the chat's provenance line names it: the person and Circle for a shared model, the provider otherwise. A one-entry chain keeps the hard stop of 0016 §4.
4. **The privacy lock cuts the chain.** In a privacy-locked project, a chain stops at the first entry that is not private. Local is private. OpenRouter and infrastructure are not. A shared model is not private unless the user has marked its provider private ([0034](0034-shared-models.md) §3). A chain with no private entry refuses the send.
5. **A host-side router serves the chain.** Boundary runs an OpenAI-compatible router on loopback, hardened as the host bridge's listeners are ([0027](0027-host-bridge.md) §2). While the chain has more than one usable entry, `llm-proxy`'s `chat` and `lightrag` routes point at it through `host.docker.internal`; a one-entry chain keeps today's direct upstream. The router holds the OpenRouter key in memory, walks the chain, tunnels shared-model requests over the network process ([0032](0032-circles.md) §1), and rewrites `model` for each entry. It reports the entry that served in a response header, which feeds the provenance line.
6. **Fallback happens before the first response byte only.** The router moves to the next entry when one is unreachable, refuses the connection, answers 429 or 5xx, or sends no headers before its timeout. It never switches once a reply has started streaming.
7. **A session stays on the entry that served it.** Switching models between the tool-call steps of one turn produces broken turns. The router keeps each session on the entry that served its last request until that entry fails, then moves down the chain and stays there. A new turn tries the chain from the top again. The router tells sessions apart by the header Hermes sends when a custom provider declares `session_affinity_header` (`agent/opencode_affinity.py`); `llm-proxy` forwards it, because it drops only hop-by-hop headers. For a chat, its value is the conversation's root session id, which stays the same across compaction (change request [0014](../change-requests/0014-proxy-fallback-upstream.md), stack reply to R3).
8. **Hermes is sized for the weakest entry.** Boundary sets `model.context_length` to the smallest context of any entry in the chain, and sizes the stale-stream timeout ([0026](0026-model-key-lives-in-proxy-memory.md) §5) for the slowest. The router skips an entry whose context is smaller than the request. Hermes keeps the first entry's model name, so its per-model handling still applies, and the router answers `/v1/models` with that one model and the chain's context.
9. **Changing a chain does not restart Hermes.** The proxy's upstream stays the router. A change to the chain is pushed to the router. Hermes restarts only when the model name or context length it sees changes.
10. **Stale entries are skipped.** An entry whose slot was disconnected, whose Circle the user left, or whose offer was withdrawn is skipped, as a stale pin is today ([0017](0017-project-inference-pin.md) §3). It stays in the chain so the user can see it is stale.

## Consequences

- While Boundary is closed, the router is gone and every model call from the stack fails, OpenRouter included. Today an OpenRouter route keeps working until the proxy restarts ([0026](0026-model-key-lives-in-proxy-memory.md) consequences). The stack's answer to change request [0014](../change-requests/0014-proxy-fallback-upstream.md) R1, in its next 0.3.x tag, lets Boundary push OpenRouter as the route's fallback behind the router, which restores that: OpenRouter answers with Boundary closed until the proxy restarts. It only fits a chain that ends with OpenRouter and isn't cut by a privacy lock, because the proxy also falls back on the router's own 503. Across a proxy restart with Boundary closed, model calls fail until Boundary starts: the stack's fallbacks file would keep OpenRouter answering, but it holds the key on disk, and 0026 stands.
- LightRAG, OpenCode and GPT Researcher follow the chain too, because they reach models through `llm-proxy`.
- Hermes's own `fallback_providers` and `fallback_model` stay unset on Boundary-managed profiles. Two fallback layers would make it unclear which entry served a turn.
- A chain's first entry stays the default the user sees in Settings and on the chip. Later entries show in the chip's popover.
- The router is the first Boundary service in the inference path. Its failures show as the router's 502 or 503 with a reason, through `llm-proxy`.
