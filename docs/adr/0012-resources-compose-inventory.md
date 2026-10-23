# 0012. Host Compose inventory lives on Resources

- Date: 2026-09-25
- Status: Accepted
- Parent: [0011](0011-resources-destination.md)
- Related: [0002](0002-chat-as-product-home.md)

## Context

0011 shipped Resources as an observe-only rail destination: three stacked bars and four buckets. It deferred host Compose listing to a follow-on ADR and forbade start, stop, or inventory on that screen. Users need to see what is running on the engine without a second rail icon and without moving stack control off Services.

## Decision

Add an observe-only **Compose inventory** as a second region on Resources, under the 0011 bars. This amends 0011 decision 4 for listing only. Start / stop stay off Resources.

1. Show host Compose projects the engine already labeled (`com.docker.compose.project`, service, working dir). Fields: name, status, services, ports. Expandable service rows.
2. Honesty states: engine down, empty host. No start, stop, or restart controls. Services still opens endpoints and starts Boundary’s stack (`assistant-stack:ensure-running`).
3. Listing source is main `dockerService` container-label inventory (`listContainers({ all: true })`). Do not enable the unused home-directory walk.
4. Keep main `dockerService`.
5. GPU / VRAM stays out. No fifth legend item. No fifth rail icon.

Living spec: [`docs/resources-ux-study/04-compose-inventory.html`](../resources-ux-study/04-compose-inventory.html). 0011 bars remain [`01-stacked.html`](../resources-ux-study/01-stacked.html). Keep the kit.

## Consequences

- Resources is still one destination: share-of-machine first, then what Compose projects the engine knows.
- Product preload exposes a read-only inventory channel. Start / stop stay off that surface.
- GPU, harder disk / PID, and engine VM footnotes remain measurement work, not chrome changes.
