# Circles and inference chains plan

Builds [ADR 0032](adr/0032-circles.md) (Circles), [0033](adr/0033-inference-chains.md) (inference chains and the router) and [0034](adr/0034-shared-models.md) (shared models).

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 0 Network process packaging spike | Built; the signed build and two-Mac test run with the first release candidate | |
| 1 Chain model and resolver | Done | |
| 2 Router and chain UI | In progress: fallbacks shipped for the app default, project pins and chat overrides; live proxy case not started | 1 |
| 3 Circles: identity, invites, roles, presence | Built; not yet tried in the app or between two Macs | 0 |
| 4 Shared models | In progress: sharing from Settings with away mode, offers, the provider's gateway, shared entries in the router, the ordered chain editor and the Private and Trusted settings work; untrusted providers don't serve until change request 0015; metering and quotas not started | 2, 3 |
| 5 Circle chats | Not started | 3 |

Phases 0 and 1 can run at the same time, and so can 2 and 3.

## Phase 0 · Network process packaging spike

**In.** An Electron `utilityProcess` that loads `hyperswarm`, `corestore` and `autobase`, owned by main over a MessagePort. A signed and notarized macOS build. Two Macs on different networks join one topic and replicate a Hypercore. Check how Autobase 7 shows writer entries while no indexer is online (0032 §7).

**Out.** Any UI. Identity.

**Done when.** The packaged app starts on a clean Mac with every native addon loaded, and the two-Mac test replicates.

**Checks.** [Circles network spike check](testing/circles-network-spike.md). Autobase's behaviour with no indexer online: [Autobase 7: writers' entries while no indexer is online](circles-autobase-confirmation.md).

## Phase 1 · Chain model and resolver

**In.** The chain type in `src/shared/types/inferenceChain.ts`. Pure functions in `src/main/services/inference/chain/`: resolve which chain applies (chat → project → app default), mark stale entries, cut at the privacy lock, and order the attempts the router makes (fallback triggers, session stickiness, context fit). Unit tests.

**Out.** Storage changes, IPC, UI, the router's HTTP side. Nothing calls the new code yet, so app behaviour doesn't change.

## Phase 2 · Router and chain UI

**In.**
- The router: loopback listener hardened as in 0027 §2, OpenAI-compatible `/v1/models` and `/v1/chat/completions`, the OpenRouter key in memory, `model` rewriting, the served-entry header, session stickiness by Hermes's affinity header.
- Pointing `llm-proxy`'s `chat` and `lightrag` routes at the router through `host.docker.internal`.
- Hermes settings: `model.context_length` from the chain, the stale-stream timeout for the slowest entry, a custom provider with `session_affinity_header`, and `fallback_providers` left empty.
- Storage: app default, project pin and chat override each hold a chain. Existing single slots migrate to one-entry chains.
- UI: a chain editor in Settings and on the project's Inference block, the chip's popover showing later entries, and the provenance line naming the entry that served.
- `docs/stack-contract.md` rows for `model.context_length`, `session_affinity_header` and the proxy's header forwarding, each with a `test:stack` case.

**Shipped so far.** The router, routing when the chain has more than one usable entry, Hermes sized for the chain, and a transcript mark when a fallback answers. The app default, a project pin and a chat override each hold fallbacks. With two providers a chain has at most one fallback, so each level has a switch: in Settings, in the project's Inference block, and in the chip's menu, where turning it on in a chat that inherits gives the chat its own override.

**Still to do.** A live case for a request through `llm-proxy` to the router.

**After the stack's next 0.3.x tag.** Pin it, then push OpenRouter as the proxy's fallback behind the router when the chain ends with OpenRouter and no privacy lock cuts it (change request 0014 R1). Once the stack confirms R3 on a live stack, the router keys sessions by the root session id Hermes already sends, which lets chats on different chains run at the same time and puts each fallback mark on the right chat.

**Out.** The `peer` entry type (phase 4).

## Phase 3 · Circles

**In.** Identity and device keys, kept with `safeStorage`. Create a Circle, invite with `blind-pairing`, accept, remove, change role. Live presence. A Circles destination listing Circles and members.

**Out.** Shared models, Circle chats, a second device on one identity.

**Checks.** `bun run test:circles` runs three people on a HyperDHT testnet on 127.0.0.1 through create, invite, join, refused invites, member limits, promotion, removal and leaving, and a Circle with three admins through confirmation with all but one offline ([Autobase 7: writers' entries while no indexer is online](circles-autobase-confirmation.md)). The two-Mac check comes with the first release candidate.

## Phase 4 · Shared models

**In.**
- Provider side: publishing an offer, the gateway's narrow API and queue, availability and away mode with a power-save blocker, metering, and quotas.
- Consumer side: the `peer` entry type in the router, tunnelled over Protomux. An ordered chain editor, which replaces the fallback switches once a chain can hold more than two entries. Private and trusted settings for each provider. Approval for every side-effecting tool call in turns served by an untrusted provider. Remaining quota in offers.

## Phase 5 · Circle chats

**In.** Chat channels stored in the Circle's Autobase, unconfirmed marks until an admin indexes, and an explicit share action from a Hermes chat.

## Acceptance criteria

### Chains (0033)

- [x] **1.** Resolve takes the first level that has a chain (chat, then project, then app default) and does not merge levels.
- [x] **2.** A disconnected slot, a left Circle or a withdrawn offer marks its entry stale, and attempts skip it.
- [x] **3.** In a privacy-locked project the chain stops at the first entry that is not private. A chain with no private entry refuses the send.
- [x] **4.** A shared model counts as private only when its provider is marked private.
- [x] **5.** A session that a later entry served starts its next request at that entry. A new turn starts from the top.
- [x] **6.** An entry whose context is smaller than the request is skipped.
- [x] **7.** Unreachable, 429, 5xx and a header timeout move to the next entry. A reply that has started streaming never moves.
- [ ] **8.** The chat's provenance line names the entry that served, with the person and Circle for a shared model. (The provider and model are named; the person and Circle wait for phase 4.)
- [x] **9.** A one-entry chain keeps the Retry-or-OpenRouter stop of 0016 §4.
- [x] **10.** Changing a chain does not restart Hermes unless the model name or context length Hermes sees changes.

### Circles (0032)

- [x] **11.** An invite completes only while an admin is online, and an expired or revoked invite is refused.
- [ ] **12.** A removed member's device gets no new data, and the remove dialog says history they hold stays with them. (The dialog says so, and peers stop replicating with the removed device. A removed member who shares another Circle with a peer, or who makes a new device key, can still fetch the Circle's blocks: see ADR 0032 §6.)
- [ ] **13.** Entries written while no admin is online show as unconfirmed until one is.

### Shared models (0034)

- [ ] **14.** The gateway refuses any path other than `GET /v1/models` and `POST /v1/chat/completions`, and any model not in the offer.
- [ ] **15.** A turn served by an untrusted provider asks for approval on every side-effecting tool call.
- [ ] **16.** Over quota, the gateway answers 429 before any reply bytes, and the consumer's router falls back.
- [ ] **17.** Usage counts never appear in the Circle's log.

## Change requests to the stack

These are things that would help anyone running the stack, not only Boundary. Each one lists the Boundary fallback that ships until it lands.

- [0015](change-requests/0015-untrusted-reply-approvals.md): Hermes asks before every side-effecting tool call in a reply that carries a header, which Boundary's router would add to replies from untrusted providers. Until then, an untrusted provider's models don't serve; the chain editor and Circles screen say so.
- [0014](change-requests/0014-proxy-fallback-upstream.md): a fallback upstream for each `llm-proxy` route (R1) and a header naming the upstream that served (R2), both done for the next 0.3.x tag. R3 needs no patch: Hermes already sends the conversation's root session id through the providers entry Boundary writes; two live checks are pending on the stack's side.
