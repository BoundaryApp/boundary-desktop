# 0039. Shared models that can't serve

- Date: 2026-11-01
- Status: Accepted
- Parent: [0034](0034-shared-models.md)
- Amends: [0034](0034-shared-models.md) §3, [0036](0036-shared-model-app-default.md) §5
- Related: [0033](0033-inference-chains.md) §10, [0038](0038-changing-circle-operations.md) §8, [change request 0015](../change-requests/0015-untrusted-reply-approvals.md)

## Context

0034 §3 had an untrusted provider's turns run with an approval on every side-effecting tool call. Hermes can't do that until change request 0015 ships, so `resolveChain.ts` has always skipped an untrusted provider's model, at every position.

The wipe of 0038 §8 removed Circles but left defaults and fallbacks naming them. Under 0036 §5 such an entry stays chosen until its reason clears, and for a wiped Circle that never happens. An install updated from rc.12 kept a default that refused every send.

## Decision

1. **An untrusted provider's models are skipped.** This amends 0034 §3, which described approvals instead. They count as stale at every position in a chain, so without **Trusted** the provider serves no turn. Change request 0015 reopens this.
2. **A wipe clears what named the wiped Circles, once.** This amends 0036 §5 for those Circles only. The app default, its fallbacks, and project and chat fallbacks lose those entries. When that was the app default, the first fallback that may serve takes over, then a connected provider, which is the same order as filling an empty default. With neither, nothing is chosen: Settings says so and a send stops and says where to choose. A migration does this before anything reads the choices, so it needs no Circles running. A Circle left in the ordinary way keeps its model selected, as 0036 §5 says.
3. **A row that can't serve leads to the fix, and can't be picked.** In the app default list, clicking it opens the provider's panel when trust is the problem and **Sharing** otherwise. A model from a Circle the user left has no such page, so its row says to choose another model. **Add a fallback** still accepts a model that can't serve yet, marked as such: the router skips it, and it can only serve after the user acts.

## Consequences

- On an install that wiped in rc.13, the store can't tell a wiped Circle from one left afterwards, so the migration clears both. That window is the time between rc.13 and rc.14.
- A connected provider can become the default though the user never put it in the chain. It is the same provider an empty default takes, and the privacy lock still applies. 0033 §2 stays true for shared models: the only one that can take over is a fallback the user added.
- Raising `CIRCLES_DATA_VERSION` needs a new migration of this kind, because the data version alone doesn't clear references.
