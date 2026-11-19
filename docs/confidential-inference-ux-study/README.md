# Confidential inference UX study

A click-through for confidential providers and pools: adding a provider with your own key, the pool as a rung in the Chat stack, pool settings, what a chat shows when its provider changes, a private project that needs a higher trust level, spend, and the help page. The decisions are in [ADR 0047](../adr/0047-confidential-provider-pools.md).

| File | Role |
| --- | --- |
| [spec.md](spec.md) | Living spec: decisions, phases and acceptance criteria |
| [prototype.html](prototype.html) | Click-through, one tab per flow |

Open `prototype.html` in a browser. The controls along the top set which accounts exist (none, or Prem and NEAR AI), what's wrong now (a rate limit, an empty balance, a failed hardware check, or neither provider can serve), the state of Boundary's provider list (current, 9 days old, failed signature), and the theme. In the add-provider key field, type `bad`, `notools` or `fail` for the failure states.

Prices are from each provider's own pages, read on 8 November 2026. Trust levels and precision are placeholders for what Boundary's catalog would set, and balances and spend are made up.
