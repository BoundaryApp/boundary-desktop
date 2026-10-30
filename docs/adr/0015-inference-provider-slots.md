# 0015. Two stored inference connections, Settings is the destination

- Date: 2026-09-27
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Sources: [`docs/inference-ux-study/spec.md`](../inference-ux-study/spec.md), [`01-settings.html`](../inference-ux-study/01-settings.html)

## Context

Boundary stored one LLM connection in `openai-onboarding.json`. Saving Local or OpenRouter overwrote the other. Users need a local runtime and OpenRouter at the same time, with one machine default. GPU deploy (Baseten, Cerebrium, and later peers) remains a way to generate inference endpoints; it is not deprecated.

## Decision

1. Persist an extensible slot map in the same store: `local`, `openrouter`, and `infrastructure`. `appDefault` names which slot `getLlmConnection()` / Hermes apply read.
2. Settings is the destination for both visible cards and the app-default radio. Chat stays home (0002). Do not list files on the rail (0014).
3. First-run onboarding still picks one provider (Local or OpenRouter). The other slot is added later in Settings. GPU deploy stays in the store and handlers but is hidden from Settings and first-run home until a later phase surfaces it as a first-class card.
4. Existing single-slot documents migrate from `provider` / URL. Unmapped GPU or remote custom rows become `infrastructure` so chat still works.
5. Saving a non-default slot does not restart Hermes. Changing the app default, or the default slot’s model, does.

## Consequences

- Local and OpenRouter can coexist. Disconnecting the default falls back to the other configured visible slot, then infrastructure, then none.
- Disconnecting OpenRouter keeps its encrypted key and model outside the slots, so nothing sends with them. Settings can put them back without a sign-in or remove them; a new sign-in replaces them. Disconnecting never reopens setup once setup has finished: with no provider left, Settings says so and chats refuse to send.
- Health (local unreachable, OpenRouter 401) is probed, not persisted as a default flip.
- Later work can promote `infrastructure` (or named GPU slots) into Settings cards without another graveyard migrate.
- Chat override and project pin land in later phases; they resolve through this app default. Chat override shipped in [0016](0016-chat-inference-override.md).
