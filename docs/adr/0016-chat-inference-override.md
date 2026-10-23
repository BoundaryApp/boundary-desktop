# 0016. Chat inference override and honest apply

- Date: 2026-09-28
- Status: Accepted
- Parent: [0015](0015-inference-provider-slots.md)
- Sources: [`docs/inference-ux-study/spec.md`](../inference-ux-study/spec.md), [`02-chat-switch.html`](../inference-ux-study/02-chat-switch.html)

## Context

Phase 1 stores Local and OpenRouter together and names one app default. `getLlmConnection()` and Hermes apply read only that default. Chat had no way to switch provider for a single conversation, no record of what Hermes is actually on, and no honest restart when the resolved connection changed. Silent HTTP fallback could send a local-intended turn to whatever Hermes last used.

## Decision

1. Persist a per-chat override on `hermes-agents` `SessionMeta.inference`: `{ provider: 'local' | 'openrouter', modelId }`. Switch markers live in `sessionInferenceMarks` so they survive reload without entering Hermes history.
2. Resolve send as `chat override ?? app default`. `getLlmConnection()` stays the machine default for Settings and onboarding. Project pin is a later phase.
3. Record `lastAppliedLlm` (`slot + endpointUrl + modelId`) on the assistant-stack store after a successful apply. If the resolved fingerprint differs, the next send is a named composer phase (`restarting`) then apply, then send.
4. Local unreachable on send is a hard stop: Retry local, or confirm OpenRouter. Confirm writes an override. No silent cloud fallback.
5. The composer chip (study B, variant A) is the switch. Provenance is a second line. Header and inspector placements stay foils.

## Consequences

- Changing the app default does not rewrite existing chat overrides. Disconnecting a provider clears overrides that pointed at it.
- Same-connection model changes still restart in this phase. A later spike may drop that restart if Hermes honors `model` on the HTTP body and provider / base URL match.
- Privacy lock and cloud cost remain later work.
- Project pin landed in [0017](0017-project-inference-pin.md): resolve is now chat → project → app default.
