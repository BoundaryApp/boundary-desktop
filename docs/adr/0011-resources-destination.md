# 0011. Resources is an icon-rail destination

- Date: 2026-09-25
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md)
- Children: [0012](0012-resources-compose-inventory.md)

## Context

After setup, chat is home (0002). App chrome today is Chat, Services, and Settings. 0002 reserved a later Devices slot on that same layer — never a project row, never a thread. Users still need a place to see how much of this machine is Boundary, the assistant stack, the local LLM, and everything else.

## Decision

Scope the reserved chrome slot as **Resources**, a fourth icon-rail destination after Services. Settings stays pinned at the bottom. Resources is observe-only:

1. Hero is three 100% stacked bars — CPU, memory, disk — sharing one four-segment legend: Boundary app, assistant stack, local LLM, rest of computer (estimated).
2. A missing live bucket collapses to 0 + “not detected” / “not running.” Disk files may remain when a process is down.
3. GPU / VRAM is out of this cut. Disk is capacity, not I/O. Engine VM overhead is a measurement caveat, not a fifth legend item.
4. No Compose start or stop on this screen. Services still opens and starts Boundary’s stack. Host Compose listing is [0012](0012-resources-compose-inventory.md).

Living spec: [`docs/resources-ux-study/01-stacked.html`](../resources-ux-study/01-stacked.html). Sources: [`02-quiet-meters.html`](../resources-ux-study/02-quiet-meters.html), [`03-share-cards.html`](../resources-ux-study/03-share-cards.html). Keep the kit. Inventory living spec is [`04-compose-inventory.html`](../resources-ux-study/04-compose-inventory.html) (0012). GPU and harder disk/PID work remain in [`phase-2.md`](../resources-ux-study/phase-2.md).

## Consequences

- Product chrome adds a Resources rail destination. Chat stays home.
- 0002’s reserved Devices slot is this destination, not a Settings section and not a second screen.
- Capability totals, compose project labels, and local-LLM HTTP discovery are the identity hooks for live attribution.
- Host Compose inventory is 0012. Remaining Phase 2 measurement work is documented in `phase-2.md`.
