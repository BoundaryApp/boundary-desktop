# 0034. Sharing a local model with a Circle

- Date: 2026-10-29
- Status: Accepted
- Parent: [0032](0032-circles.md)
- Related: [0006](0006-tool-approval-interrupt.md) (approval interrupt), [0033](0033-inference-chains.md), [circles plan](../circles-plan.md)

## Context

A member running LM Studio or Ollama can let the rest of their Circle use it. Other members then put that shared model in their inference chains ([0033](0033-inference-chains.md)).

Two risks come with this. First, the provider's machine sees every prompt it serves. Second, its replies drive the consumer's agent. Hermes acts on the tool calls in a reply, and its tools include a terminal and, through the host bridge, the user's browser. A provider with a modified model server could have a consumer's agent run commands. With OpenRouter the user trusts a company; with a shared model they trust a person and the security of that person's machine.

Local model servers often serve one request at a time, and the provider knows their own hardware's limits.

## Decision

1. **An offer is published to the Circle.** The offer lists the shared models with each one's context length and whether it supports tool calls, plus an availability flag and an away mode. Offers live in the Circle's Autobase ([0032](0032-circles.md) §3). Whether the provider is reachable now comes from live swarm connections, not the offer.
2. **The provider's gateway forwards a narrow API.** A Protomux `inference` channel accepts requests only from current members' device keys. It forwards `GET /v1/models` and `POST /v1/chat/completions` to the local server and nothing else, so pull, delete and load endpoints are never reachable. It only serves models listed in the offer, queues requests in order, and streams replies back.
3. **Private and trusted are two separate settings, set by the consumer for each provider.**
   - **Private** means "I accept that this person can read my prompts." It lets a provider's models serve privacy-locked projects ([0033](0033-inference-chains.md) §4). It is off by default, so a shared model counts as cloud.
   - **Trusted** means "I accept that this person's model can run my agent's tools." Without it, every tool call with side effects in a turn served by that provider goes through the approval interrupt ([0006](0006-tool-approval-interrupt.md)), whatever the session's approval mode.

   Both settings attach to the provider's identity, not the Circle, so one person sharing in two Circles has one pair of settings. Neither can be verified, and the UI states each one as the claim it is.
4. **Away mode.** A provider can mark their models available while they are away. Boundary then holds a power-save blocker so the Mac doesn't sleep. Away mode only works while Boundary is open, and the setting says so.
5. **Metering is on and quotas are optional.**
   - The provider's Boundary counts requests and tokens for each member identity, using the `usage` field in each response. The consumer's Boundary counts its own usage.
   - Counts stay on those two machines and never go to the Circle's log, so members can't see each other's usage.
   - A provider sees every member's totals; a member sees only their own.
   - Quotas are off by default. A provider can set requests per day, tokens per day and concurrent requests, for everyone or per member. Quotas count per identity across all Circles.
   - Over quota, the gateway answers 429 before any reply starts, which the router treats as a reason to fall back ([0033](0033-inference-chains.md) §6). An offer includes each member's remaining quota so the router can skip a model that's used up.
6. **No prompt content leaves the request path.** The gateway logs metadata only: member identity, model, token counts, status and timings.

## Consequences

- Sharing a model is the user's decision to run a service for their Circle. Settings shows the queue, usage by member, and a stop button.
- An untrusted provider's turns ask for more approvals. That cost is intended.
- A provider who leaves a Circle, or whose offer is withdrawn, becomes a stale chain entry for consumers ([0033](0033-inference-chains.md) §10).
- Embeddings are not shared in this decision. LightRAG keeps using the consumer's own embedding route.
