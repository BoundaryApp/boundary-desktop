# Shared services: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [Phase 4 click-through](phase4.html) |
| Stack requests | [0025 Twenty keys for one person](../change-requests/0025-twenty-member-keys.md), [0023 R3 asking before writes](../change-requests/0023-twenty-workspaces-access-sign-in.md) |
| Started | 8 Nov 2026 |
| Builds on | [ADR 0048](../adr/0048-sharing-a-service-with-a-circle.md), [ADR 0034](../adr/0034-shared-models.md), [add-ons spec](../addons-ux-study/spec.md), [circles plan](../circles-plan.md) (peer signals, Circle records) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Member keys and the service gateway | Built: unit tests only | — |
| 2 Offers, grants and the `service` channel | Built: unit tests and `test:circles` | 1 |
| 3 The consumer's listener and **Use in my agent** | Built: unit tests and `test:stack` | 2 |
| 4 Sharing and using from the add-on page and the Circle | Partly built: Twenty's page and provenance, unit tests. The Circle's **Shared** section and Trusted are not built | 3, a click-through first |
| 5 Revoking on removal, and sharing a hosted workspace | Not started | 4 |
| 6 Two-Mac check | Not started | 5 |

## Goal

A member who runs Twenty can let chosen people in a Circle look things up in it, or change it, from their own agents. Each person's changes carry their name, one person's access can be taken back without touching anyone else's, and nobody's key leaves the provider's Mac.

## Decisions

ADR 0048 holds the transport, trust and key decisions. These are the build's.

1. **Twenty is the only kind for now.** The gateway and the offer record carry a `kind` so another add-on can join through its manifest's `share` object (ADR 0048 §12), but nothing else is shareable until one declares it.
2. **Key names say who and where.** A member's key is named `<member name> · <Circle name>`, the text Twenty shows as a record's creator. Boundary keeps each key's id with the grant, so it revokes by id, not by name.
3. **Levels map to the stack's roles.** `read` uses the role labelled `Hermes read-only` and `write` the one labelled `Hermes read-write`, the roles `crm init` makes. A write grant mints both keys, so the member's unattended runs still use a read key.
4. **No queue.** MCP calls are short and Twenty serves them in parallel, so the gateway forwards each request as it arrives, up to four at a time per member. A fifth gets 429 with a sentence the member's agent shows.
5. **Bodies are capped at 1 MB.** Twenty's tool calls are small; a larger body is refused with 413 before anything is forwarded.
6. **Taking access away refuses first, revokes second.** Revoking a member, withdrawing an offer, narrowing it to `read` or lowering a grant updates the gateway before Boundary calls Twenty, so a slow or failed revoke never leaves access open. A revoke that fails is kept, by key id, and retried each time Circles start.

## Phases

**1 Member keys and the service gateway.** `twentyMemberKeys.ts` signs in as the owner through `/metadata`, finds the two roles by label, mints a key for a member and level, and revokes one by id. `serviceGateway.ts` answers a member's request: only `POST /mcp`, only from a current member with a grant at the level asked, with the member's key swapped in, the `Accept` header kept, and the reply streamed back. Counts per member per day. Unit tests against fake fetch.

**2 Offers, grants and the `service` channel.** The `services` Circle record, written and validated. Grants and keys on the provider's Mac, encrypted with `safeStorage`. A Protomux `service` channel beside `inference` and `signal`, carrying requests to the gateway. `test:circles` covers a request between two networks in one process.

**3 The consumer's listener and Use in my agent.** A loopback listener per used service, hardened as ADR 0027 §2 requires, on a kept port, with a token per level. Registration as a workspace in the Twenty store with a `host.docker.internal` URL, the restart bar, and the offline error. A `test:stack` case registers a workspace pointed at a local listener.

**4 Sharing and using from the add-on page and the Circle.** A click-through first. Then **Share with a Circle…** and the shared row on Twenty's page; **From your Circles** rows with **Use in my agent**; the Circle's **Shared** section; Private and Trusted from the provider's panel; provenance on tool calls.

**5 Revoking on removal, and sharing a hosted workspace.** Revoking when a member leaves or is removed, including on the next open after the provider was offline. Keys for a hosted workspace sent over a peer signal to one identity.

**6 Two-Mac check.** A checklist in `docs/testing/` covering look up, change, attribution, revoke, offline and remove.

## Non-goals

- Twenty's web app for members over the tunnel (ADR 0048, Consequences).
- Quotas. Counts only.
- Sharing Signal, Mail or Messages.

## Acceptance criteria

- [ ] A member granted `read` looks up records from their agent, and a change is refused.
- [ ] A member granted `write` creates a record, and Twenty shows their key's name as its creator.
- [ ] Revoking one member's grant stops their next call and leaves everyone else's working.
- [ ] A removed member's next call is refused, whether or not the provider's Mac was on when they were removed.
- [ ] With the provider's Mac off, a member's tool call says the provider is offline.
- [ ] No key, token or tool argument appears in the Circle's log, in a log file, or in the renderer.
