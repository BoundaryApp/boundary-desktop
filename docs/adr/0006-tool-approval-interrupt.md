# 0006. Tool-approval interrupt

- Date: 2026-09-21
- Status: Accepted
- Parent: [0002](0002-chat-as-product-home.md)
- Related: [0003](0003-workbench-chrome.md), [0004](0004-instrument-composer.md)

## Context

Workbench (0003) and the Instrument composer (0004) cover layout, project scanning, and honest turn telemetry. They do not cover the moment the assistant is parked on a dangerous command or agent-written script. Hermes already owns that gate (`once` / `session` / `always` / `deny` over dashboard JSON-RPC). Bind-mounted host folders keep those guards on. The study kit had no visual for the interrupt, so the in-app card was a four-button row with no hierarchy.

## Decision

Prototype an approval interrupt on Workbench, not a modal and not a fourth rail:

1. Tool cards stay progress. The consent card sits on the composer.
2. Primary **Run** is `once`. **Reject** is `deny`. Session and Always live in **More**. Always allow requires a confirm.
3. Offer only the choices the gateway sent. Composer stays on screen but does not send until the card is answered. Stop still cancels.
4. If JSON-RPC is down, show the deny as a tool result. Do not invent a card.

Living spec phase: [`docs/chat-ux-study/01-workbench.html`](../chat-ux-study/01-workbench.html) (Approve in the title bar). Source variants: [`05-approval.html`](../chat-ux-study/05-approval.html). Do not restyle from Hermes Desktop or WebUI chrome.

## Consequences

- Policy stays in the agent. Boundary maintains a renderer and a responder.
- Sibling interrupts (sudo, secret, clarify) should reuse this slot later.
- Accepted 2026-09-28 as shipped in `ApprovalInterrupt.tsx`: the consent card is part of the 0004 composer, not a separate surface.
