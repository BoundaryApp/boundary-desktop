# 0036. A shared model as the app default

- Date: 2026-10-30
- Status: Accepted
- Parent: [0034](0034-shared-models.md)
- Amends: [0033](0033-inference-chains.md) §5
- Amended by: [0039](0039-shared-models-that-cant-serve.md) §2 (§5: a wiped Circle's model doesn't stay chosen)
- Related: [0016](0016-chat-inference-override.md), [0032](0032-circles.md), [circles plan](../circles-plan.md)

## Context

A shared model could only be a fallback, after a slot. A member with no OpenRouter and no local server had no first entry, so the chain never ran and chats couldn't send. Setup's Model step blocked them too, and it comes before the Circles screen.

A one-entry chain goes straight to its provider ([0033](0033-inference-chains.md) §5). A shared model has no address to go straight to: it is reachable only through the router, over the Circles network.

## Decision

1. **The app default is a slot or a shared model, never both.** The shared model is stored as its own field beside `appDefault`, which is null while it is set. Choosing a slot clears it. Connecting a provider leaves it alone; the new provider can be added as a fallback ([0033](0033-inference-chains.md) §2). Project pins and chat overrides stay slots for now.
2. **A chain that starts with a shared model always routes.** This amends 0033 §5, including for one entry, and for a chain where only a later entry is usable. Hermes gets the shared model's id, and `model.context_length` from the offer as 0033 §8 describes. An offer with no context length leaves whatever the profile holds; Hermes isn't sized for it.
3. **It can be picked only while it can serve.** The provider must be Trusted, offering the model and not paused; a user's own offer isn't a choice. Main checks this again when the choice is saved. Setup shows the Trusted and Private switches beside the choice.
4. **With nothing else to answer, the send stops and says why.** This is the hard stop of [0016](0016-chat-inference-override.md) §4 without its Retry-or-OpenRouter prompt, which assumes a local model. The message names the model and the reason: offline, paused or withdrawn, no longer offered, untrusted, the Circle left, or Circles not connected. Fallbacks work as in 0033: a later usable entry answers without a stop.
5. **A chosen model that can't serve stays chosen.** It is stale as in 0033 §10: Settings shows it with the reason, and it serves again when the reason clears. Start-up and setup finish without applying it, so a provider who stopped sharing can't hold the app on the start-up screen. The next send plans again. A Circle removed by the wipe of [0038](0038-changing-circle-operations.md) §8 is the exception ([0039](0039-shared-models-that-cant-serve.md) §2).
6. **The last entry has no header timeout, and a lone entry no size check.** Both exist to choose the next entry. A member's server can queue or load a model before its first byte, so the last entry waits until Hermes stops waiting. The size check is an estimate, so with one entry the server decides.
7. **The privacy lock still applies.** A shared model serves a private project only when its provider is marked Private ([0033](0033-inference-chains.md) §4).
8. **Local-stack mode doesn't serve it.** That mode never routes, so a send there refuses and says so. The consumer in a two-Mac test has to be a managed install.

## Consequences

- With Boundary closed nothing answers, as with any routed chain. If the provider's Mac is off, a member with no other provider can't chat.
- The first entry's provider sees every prompt and its replies drive the agent, as 0034 describes, now for all of the member's chats. Setup says so before anything is picked.
- LightRAG and other stack services follow the chain. Embeddings are not shared ([0034](0034-shared-models.md)), so a member with no provider has no embedding route.
- An untrusted provider can't be in a chain until change request [0015](../change-requests/0015-untrusted-reply-approvals.md) lets Hermes ask before each tool call.
