# 0002. Chat is the product home after ready

- Date: 2026-09-20
- Status: Accepted
- Parent: [0001](0001-record-architecture-decisions.md)
- Children: [0003](0003-workbench-chrome.md), [0004](0004-instrument-composer.md), [0005](0005-folder-first-create-flow.md), [0006](0006-tool-approval-interrupt.md), [0007](0007-multi-agent-dms-and-roster.md), [0008](0008-multi-agent-channels-and-wake.md), [0011](0011-resources-destination.md), [0013](0013-project-sources-inspector.md), [0015](0015-inference-provider-slots.md)

## Context

After setup, Boundary currently lands on `AssistantServicesScreen` (browser cards). The Hermes Chat UX study treats chat as the product, with Hermes as the first backend and a later OpenAI-compatible backend using the same chrome.

## Decision

Once LLM + stack are ready, chat is the default view. App chrome (Chat, Services, Resources, Settings) sits outside the Projects rail. Setup stays the existing full-screen gate. A Project is a user-chosen host folder bind-mounted into the assistant — not an upload, embed, or copy into Application Support. Chrome does not say Hermes.

## Consequences

- Services are a destination, not home (P1).
- Settings stays a top-level destination; it is never a project row or a thread.
- The reserved Devices slot is Resources — an observe-only rail destination (0011), not a Settings row.
- Visual language of SetupLayout (full-bleed, large type) stays a cut from chat.
