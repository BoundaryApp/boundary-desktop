# 0047. Confidential providers in pools, routed by expected cost

- Date: 2026-11-08
- Status: Proposed
- Parent: [0033](0033-inference-chains.md)
- Amends: [0033](0033-inference-chains.md) §2, §4, §5, §6 and §7 (see decisions 6, 7 and 8)
- Related: [0015](0015-inference-provider-slots.md), [0026](0026-model-key-lives-in-proxy-memory.md), [0034](0034-shared-models.md) §3, [0041](0041-electron-updater.md), [0043](0043-circles-live-in-the-chat.md)
- Visuals: [confidential inference UX study](../confidential-inference-ux-study/README.md); amended 2026-11-08 after it was approved (decisions 1, 3, 6, 7, 10 and 11)

## Context

Users without a local model use OpenRouter, where the serving provider sees every prompt in plaintext. A group of providers now serve open-weight models from trusted execution environments (TEEs), so that the operator can't read prompts. They differ in how much a client can check, which models they carry and what they charge. The same model can cost several times more at one than at another.

The facts below were read from each provider's own docs, terms and pricing pages on 2026-11-08, and Tinfoil's and Privatemode's rows updated from their public source and Tinfoil's keyless model list on 2026-11-14. None has been checked against a live account.

| Provider | Encrypted to the enclave | Client can verify | Images reproducible, measurements pinned | Example prices per 1M tokens (in / out) |
| --- | --- | --- | --- | --- |
| Prem | Yes, through its SDK or local proxy | SDK; the hardware check doesn't cover the key that prompts are encrypted to | No pinning by default | Qwen 3.8 27B $0.30 / $2.40; DeepSeek V4.1 Flash $0.35 / $1.40 |
| Tinfoil | Yes, TLS ends inside the router enclave, which attests each model enclave | Open-source verifier; Boundary pins chats to the attested TLS key | Yes, Sigstore; the V3 attestation Boundary checks is in beta | DeepSeek V4.1 Flash $0.60 / $1.45 |
| Privatemode | Yes, each body sealed to a secret exchanged with the attested deployment | Open-source client; Boundary runs its WebAssembly build | Reference values come from an unsigned manifest on Edgeless's CDN, the same file as each release's `manifest.json` on GitHub; Boundary's catalog pins it by SHA-256. BSI C5 and ISO 27001 | GLM-5.3-Flash €0.20 / €0.65 |
| NEAR AI Cloud | Yes, opt-in, including tool fields | No SDK; client implements it | Not found | Qwen 3.8 27B $0.04 / $1.35; DeepSeek V4.1 Flash $0.30 / $1.20 |
| Chutes | Yes, through its proxy | Optional | Partly; some components closed | Qwen 3.8 27B $0.039 / $1.25 |
| Phala | To its gateway's TEE, which decrypts and forwards | TypeScript verifier | Gateway source is open | Qwen 3.8 27B $0.20 / $2.50 |

None of these lets one account serve other people: Prem's terms (Art. 6.2(vi)) and Tinfoil's both bar resale and shared keys without a separate agreement. A single Boundary account billing users would also need a gateway that either sees plaintext or runs in a TEE of its own, which is what Phala built. If each user holds their own account at each provider, neither problem arises.

Several facts shape the design:

- Prompt caching changes the cost of an agent session more than list prices do, and a cache at one provider is lost on moving to another.
- The cheapest copies of a model are often fp4-quantized or have shorter contexts. A router that ranks on price alone moves traffic to them.
- Every provider sees request size, timing and model even when it can't read content. Spreading requests across providers means more companies see some of that.
- Each provider's encryption and attestation is its own integration: Prem's SDK, NEAR's X25519 + XChaCha20 scheme, Tinfoil's verifier.

## Decision

1. **Users bring their own account at each provider.** A **Confidential providers** card sits under **Model sources** on the Inference screen, where models live ([0043](0043-circles-live-in-the-chat.md)). The user adds an API key per provider, and tops up and is billed at that provider. Boundary never holds a provider account, never bills for inference and never shares a key between users. Keys are stored with `safeStorage` and pushed to the host-side router's memory only, never to the stack's `.env` or `llm-proxy` ([0026](0026-model-key-lives-in-proxy-memory.md)). Where a provider needs a client-held encryption key (Prem's KEK), Boundary generates it per install and stores it the same way.

2. **One adapter per provider, in the router.** An adapter does five things for its provider:
   - encrypts requests and decrypts responses;
   - verifies attestation at the start of each session and caches the result for that session; a failed check makes the provider ineligible, and the router never falls back to an unverified call to the same provider;
   - lists models from the provider's own models endpoint;
   - maps the provider's errors to the router's fallback reasons: rate limit, empty balance, bad key, unreachable;
   - reads the account balance where the provider's API offers it.

   Adapters run in the main process. Boundary doesn't spawn a provider's own local proxy, because each would be another process to supervise and some take their keys on the command line, where `ps` shows them.

3. **A catalog of canonical models.** A canonical model (`qwen3.8-27b`) maps to each provider's id for it and records, per provider, the weight quantization class (bf16, fp8, fp4, unknown), context length, tool support and input types. Two providers serve the same canonical model when their context length and input types match and each meets the user's lowest precision: bf16, fp8 (the default) or fp4. Several providers, Prem and NEAR AI among them, don't report precision through their APIs, so a provider that doesn't state it counts by default, and a switch in pool settings excludes such providers. Tool support is recorded per provider but decides eligibility per request (decision 7).

4. **Prices come from two layers.**
   - **Live:** at startup and once a day, the router reads each provider's models endpoint with the user's key, where that endpoint reports prices.
   - **Catalog:** Boundary publishes a signed catalog next to the update feed ([0041](0041-electron-updater.md)), built by a scheduled job. It holds the model mappings, prices for providers with no price API, promotions with their expiry dates, and each provider's trust level (decision 6). The app pins the key that verifies it, which is separate from the code-signing key, so a tampered catalog can't steer traffic.

   A live price overrides the catalog. A price older than seven days is marked stale on the card and still used.

5. **Rank by expected cost per turn.** Expected cost = uncached input × input price + cached input × cache price + output × output price. The token counts come from the session's own `usage` history, or from a default agent-turn profile before it has any. A provider's cache price and hit rate count toward its rank, so a provider with a higher list price can rank first for long sessions.

6. **Trust levels decide eligibility, and the user sets the floor.** This amends [0033](0033-inference-chains.md) §4 for confidential providers.
   Levels describe what Boundary's adapter checks on the user's Mac, not what the provider offers:
   - **A, checked hardware and code:** encrypted to the enclave; the adapter checks the hardware and checks the measured build against reproducible, published reference values.
   - **B, checked hardware:** encrypted to the enclave; the adapter checks the hardware, but not which build runs in it.
   - **C, provider gateway:** anything else, including a gateway that decrypts before forwarding, and a provider whose hardware check the adapter can't enforce on every session.

   Facts that bear on trust but aren't about what the client checks go in the catalog's reason for the level, shown wherever the level is: closed-source components, anonymous operators, missing or present audits. Chutes is level B only once its adapter enforces the hardware check that Chutes leaves optional; until then it is C.

   The catalog assigns levels and the app shows the reason for each. The user sets a minimum level for chats, B by default, and one for privacy-locked projects, A by default. A project can allow a lower level for itself; that choice is stored on the project and shown in its inspector with what it means. A provider below the floor is never used, however cheap.

7. **A pool is a chain entry.** `confidential:<canonical model>` can stand anywhere in a chain ([0033](0033-inference-chains.md) §1). At the start of each session it resolves to the eligible providers, filtered in this order: key present with balance and no active rate limit; trust level at or above the floor; capabilities the request needs (tools, enough context, input types; tool support comes from a test tool call when the provider is added, and a provider that fails it still serves requests without tools); healthy (recent errors and time to first byte within limits, with a circuit breaker after repeated failures); attestation verified. The rest are sorted by expected cost. Latency, then the user's own order, breaks ties.

   This amends [0033](0033-inference-chains.md) §2. **A pool draws only on providers the user has added a key for and approved.** A new model at an approved provider joins the pool automatically. A new provider never does, whether it appears in the catalog or not.

8. **Routing.** This amends [0033](0033-inference-chains.md) §5–7.
   - A pool entry always routes through the host-side router, even in a one-entry chain, because `llm-proxy` can't encrypt.
   - Fallback still happens before the first response byte only. A rate limit, an empty balance or a failed attestation moves to the next provider in the pool, alongside the 0033 §6 triggers.
   - The choice is made when a session starts. The session stays on that provider until it fails, so its cache isn't thrown away, and a new session ranks again.
   - The chat's provenance line names the provider that served the turn ([0033](0033-inference-chains.md) §3).

9. **Prefer one provider.** The card has a **Prefer one provider** switch, off by default. When on, the router keeps every session on the user's top-ranked provider and moves only when that provider fails, or when another is cheaper by more than a threshold the user sets. It trades cost for fewer companies seeing metadata.

10. **The tradeoffs are stated in the app and the docs.** The Inference screen and the user docs say, in plain words and next to the controls they affect:
    - what each trust level means, and that level B means the provider's code in the enclave can't yet be checked;
    - that every provider in a pool sees the size, timing and model of the requests it serves, though not their content, and that **Prefer one provider** limits how many providers that is;
    - that the cheapest provider changes over time, and so does which one serves a chat;
    - that each provider bills separately, so the user has a balance to keep topped up at each;
    - that Boundary's catalog sets trust levels and model matches, and how to see why.

11. **A spend log with metadata only.** Each turn records time, provider, canonical model, token counts and computed cost. No content. The card shows estimated spend by provider over the last 30 days, and each provider's balance where the adapter can read it. Boundary doesn't claim the estimate matches the provider's invoice.

## Rollout

1. The adapter interface, with Prem and NEAR AI as the first adapters. NEAR is the cheapest with documented encryption and the one that encrypts tool fields.
2. The catalog, the price feed and the spend log.
3. Pool entries, ranking and **Prefer one provider**.
4. Tinfoil and Privatemode adapters. Tinfoil is level B and moves to A when Tinfoil drops the beta label from V3 attestation. Privatemode is level A: the catalog lists the SHA-256 of each manifest it accepts (`manifestSha256`), and the adapter refuses any other before Privatemode's client runs.

## Open questions

- **Tool calling over the encrypted route.** Untested at Prem and Chutes. Hermes needs tools, so a provider without them can't serve agent turns.
- **Context length.** Prem lists none. A provider that reports no context length can't be matched to a canonical model or used to size Hermes ([0033](0033-inference-chains.md) §8).
- **Status codes** for empty balances at each provider.
- **Who maintains the catalog** and how often its scheduled job runs. Privatemode's availability depends on it: each Privatemode release needs its manifest's SHA-256 added, after checking the manifest against the release (privatemode-public's `scripts/generate-manifest.sh` regenerates it from the repository).
- **Licences and package size** of each provider's SDK in the packaged app.
- **What the fake adapter assumes.** Boundary's fake adapter assumes the following until each provider's adapter is checked against a live account. Phase 6 wrote the Prem and NEAR AI adapters, and phase 7 the Tinfoil and Privatemode adapters, from each provider's docs and public source and a keyless check of the public endpoints. Each assumption below stays open until the live test passes for that provider.
  - `tools-pass-through`: a tool call in the request comes back as `tool_calls` over the encrypted route. NEAR's docs list the tool fields it encrypts in both directions, and the adapter encrypts them. Prem's and Privatemode's adapters seal the request body whole, and Tinfoil's sends it whole over the pinned connection; whether each enclave honours `tools` is untested.
  - `context-reported`: the provider's models endpoint reports each model's context length. NEAR's `/v1/models` does. Prem's model list has `price_config` and `input_modalities` but no context length, so this is expected to fail for Prem, and a Prem model needs its context length from the catalog.
  - `cached-tokens-reported`: each reply reports cached input tokens in `usage.prompt_tokens_details.cached_tokens`. NEAR's model list has a cache-read price and Prem's has a cached rate, but neither source shows the reply field. Neither is confirmed, and neither is known to send usage on a stream without `stream_options`. Tinfoil's model list has a cached input price. Privatemode's prompt cache is scoped by a `cache_salt` the adapter derives from the API key, and whether Privatemode accepts it is untested.
  - `errors-classifiable`: rate limits, an empty balance, a bad key and a failed hardware check can each be told apart from the response. NEAR's docs give 401, 402 and 429 with an `error.type`. Prem's give 401, 429 and 400 with `INSUFFICIENT_FUNDS`. Neither provider has a free authenticated endpoint, so the key check is a one-token chat at NEAR and a model list call at Prem; whether a bad key gets 401 there is untested. A bad key on a Prem chat may surface as a failed attestation instead. Tinfoil's key check is a one-token chat; a 429 with `insufficient_quota` is read as no balance. Privatemode's key check is its attestation call, which takes the key, and its client reports errors only as text, so the adapter matches the 1.64.0 client's fixed wording for 401 and 402.
  - `balance-readable`: the account balance can be read through the API with the same key, or the provider says it cannot. Neither documents a balance endpoint that takes an API key, so both adapters report no balance and the card shows "not reported". An empty balance is learnt from the 402 or `INSUFFICIENT_FUNDS` reply.
  - `attestation-per-session`: the provider's hardware evidence can be fetched and checked at the start of each session without sending a prompt. Both providers' attestation endpoints answer without a key, and the adapters verify there before any chat. What the evidence reports for a live model is untested: NEAR's `model_name` and Intel TDX status, and Prem's `workload_id` for the requested model. Tinfoil's router document answers without a key and was verified offline from a recorded copy; whether the TLS key it names is the one `inference.tinfoil.sh` presents is untested. Privatemode's attestation needs the key, so it is checked only by the live test.
- **Prem's key binding.** Prem's attestation evidence commits to the client's nonce and a manifest of two fields (`podvm_version` and `workload_id`). The key that prompts are encrypted to comes from a separate endpoint, and nothing in the evidence ties that key to the hardware. Whoever controls what that endpoint serves can read prompts without any check failing. Prem is level C until its evidence commits to the key and Prem's verifier exposes it. NEAR AI differs: the model's signing key is in the quote's report data, so the key that prompts are encrypted to is the one the hardware check covers. That binding was read in NEAR's verifier source (`nearai-cloud-verifier`) and confirmed against live public evidence for a NEAR model.
- **Prem's reply nonce.** Prem's protocol as documented decrypts a non-streamed reply, and stream frames sent as bare hex, with the request's shared secret and nonce, so one key and nonce would encrypt both the prompt and the reply. XChaCha20-Poly1305 requires a nonce never to repeat under a key. The adapter uses a reply's own nonce when it names one, and the live test reports whether Prem reuses the request's. If it does, Prem's level reason and this ADR need to say so.
- **Privatemode's manifest rotation.** Privatemode's client checks the deployment against a manifest Boundary fetches from Edgeless's CDN. The manifest isn't signed, so the catalog pins it: Privatemode is level A only with a `manifestSha256` list, and a manifest whose SHA-256 isn't on it fails the check as `manifest-unpinned`. The manifest has changed with each recent Privatemode release (v1.62.0 to v1.64.0, three to ten days apart). An older hash on the list helps only while Privatemode still serves that manifest. From each release until the catalog lists the new hash, Privatemode fails closed and pools move to other providers. Until a published catalog exists, the list ships with the app, so that gap lasts until the next Boundary build. A build older than the pin check would show a published catalog's level A without enforcing it; no build reads a published catalog yet, and the publisher must not offer Privatemode at level A to builds older than the check.
- **Tinfoil's V3 attestation is in beta.** The verifier Boundary bundles checks the router against Sigstore-logged releases with no release pin. Tinfoil is level B while Tinfoil calls V3 beta.
- **NEAR's replies aren't authenticated to the model key.** A reply is encrypted to the client's public key, which travels in a request header, and nothing in it is signed by the model's key. NEAR's gateway could therefore forge a reply that decrypts correctly. Prompts stay confidential to the attested model; checking that a reply came from it is later work.

## Consequences

- Users get cloud inference where neither Boundary, a gateway operator nor a reseller can read prompts, at the lowest price their accounts allow, without Boundary becoming a reseller or running a server in the prompt path.
- Boundary runs one more service, the catalog, whose correctness affects both price and privacy. A wrong trust level or model match is a privacy or quality bug, not only a price bug.
- Every adapter is code to maintain against a provider's changing API and attestation scheme. Adding a provider costs an adapter, a catalog entry and a review of its terms.
- Users manage several prepaid balances. The more providers they add, the lower their cost and the more companies see metadata.
- While Boundary is closed, pool entries fail, as every routed chain does ([0033](0033-inference-chains.md) consequences). The `llm-proxy` fallback can't cover them, because the proxy can't encrypt.
- Code that would change: the slot types in `src/shared/types/onboarding.ts`, the Inference screen's Model sources and Chat stack, the chat chip, the project inspector, the host-side router, and a new catalog fetcher beside the updater.
