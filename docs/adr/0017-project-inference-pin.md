# 0017. Project inference pin and resolve order

- Date: 2026-09-28
- Status: Accepted
- Parent: [0016](0016-chat-inference-override.md)
- Sources: [`docs/inference-ux-study/spec.md`](../inference-ux-study/spec.md), [`03-project-default.html`](../inference-ux-study/03-project-default.html)

## Context

Phase 2 resolves chat override over the app default. Users also need a durable per-project default so new chats in a folder inherit Local or OpenRouter without setting a chat override each time. There was no project patch IPC; create/select/change-folder must not be overloaded. Extra fields on `HermesProjectRecord` already survive gateway rematch when the merge spreads `...existing`.

## Decision

1. Persist `inference?: { mode: 'inherit' | 'local' | 'openrouter'; modelId?; privacyLocalOnly? }` on each `HermesProjectRecord` in `hermes-projects`. Create and merge new-rows default `{ mode: 'inherit' }`. Omitted create payload equals inherit.
2. Add `hermes-projects:patch` for inference only. Do not put inference in compose overlays or `sources.yaml`.
3. Resolve send as `chat override → project pin (active project, mode ≠ inherit) → app default`. Provenance includes `project-default`. Stale pins (disconnected slot) fall through like stale chat overrides. Disconnect clears matching project pins to inherit.
4. Project-tab Inference block (above Sources) is the edit surface. Quiet glyph pin only when `mode !== 'inherit'`. Privacy lock may render disabled; enforcement is Phase 4.

## Consequences

- Changing the app default does not rewrite project pins or chat overrides.
- Chip “Use project default” clears the chat override and surfaces the pin when one exists.
- `getLlmConnection()` remains the machine default for Settings/onboarding apply.
