# 0030 · An AI text detector add-on, and a way for Boundary to call it without a chat turn

**Serves:** [writing check spec](../writing-check-ux-study/spec.md), phase 5.
**Status:** R1–R2 accepted with changes, build started on the stack side (11 Nov 2026) · R3 Later

## Background

Boundary is adding a writing check: the user selects text, presses **Check** on a reply or picks a project file, and sees passages that read as machine-written. The built-in check is a set of rules in Boundary with no model and no network. It can't say how a commercial detector would score the text.

The commercial detectors (Pangram and GPTZero) are paid services with an API key. Their published benchmark figures conflict, so Boundary shows none of them. Boundary keeps keys out of the app and puts services that need one in the add-on store, so a detector belongs there too.

Today an add-on's `mcp` block registers servers with Hermes (`addons/README.md`, and `scripts/lib/addon_manifest.py` from the bootstraps). Boundary doesn't call add-on services itself. [CR 0009](0009-shared-database-access.md) R2 is the nearest precedent: a host port on a stack service, with a `ports:` entry in Boundary's compose override as the fallback.

## R1 · A detector add-on (Wanted)

**Why:** a user with a detector account should be able to turn it on from the add-on store and give it a key, with the key held by the stack like other add-on credentials.

**Ask:** an add-on, `detector` or similar, with:

1. A provider setting (Pangram, GPTZero) and a key per provider, stored the way other add-on keys are.
2. One operation, `check_text`, taking `{ text }` and returning `{ provider, model?, score, label?, segments?: [{ start, end, score }], checkedAt }`. `score` is 0–1 for "likely AI-written". `start` and `end` are character offsets into the input. Errors come back as `{ error: { code, message } }` with codes for at least `no_key`, `quota`, `too_short`, `too_long`, `provider_error` and `timeout`.
3. The `check_text` MCP tool on profiles the user picks, so an agent can use it too. Off on every profile by default, since each call costs money and sends text off the Mac.
4. The store metadata from [CR 0027](0027-addon-store-metadata.md), with "what leaves this Mac" naming the provider and saying the checked text is sent to it.

**Acceptance:** with a test key, `check_text` on a 300-word passage returns a score from the chosen provider, and each error code above can be produced by a test (missing key, a provider stub returning 429, a too-short input).

**Boundary fallback:** the built-in rule check only. No detector score is shown.

> **Stack reply (11 Nov 2026):** accepted with changes, checked against stack main at d4d6dca.
>
> - **CR 0027 R4–R5 come first, in the same release.** No manifest has a `store` block yet, and `list --json` doesn't return `description`. Item 4 and phase 5's consent text need `store.dataLeaves` and those fields.
> - **Two containers.** A manifest service that mounts secrets may not be an MCP service, so `detector` holds the key and reaches the internet, and `detector-mcp` holds no secrets and calls `detector` on an internal network, as the email add-on does.
> - **Settings:** `provider` (`pangram`, `gptzero`) and an optional secret key per provider. A missing key for the chosen provider returns `no_key` when called, so the add-on can be turned on before a key is set.
> - **No per-profile choice for the tool.** A fixed MCP entry's profiles come from the manifest. An `agent` setting (default off) registers `check_text` on `default` and `browser` only, never on `api-server`, and fenced out of cron. Beyond cost: on a profile that also reads mail, a prompt injection could send mail text to the vendor.
> - **Offsets are UTF-16 code units** (JavaScript string indices), half-open. The service converts from Pangram's and Python's code points.
> - **Segments:** Pangram v3 returns windows with offsets. GPTZero returns per-sentence probabilities without offsets, so the service finds each sentence in the input; its segments are best effort and may skip sentences.
> - **`score` is the provider's own number** (Pangram's AI-assistance score, GPTZero's `completely_generated_prob`), not comparable across providers. `label` is the provider's label passed through.
> - **Errors:** `quota` adds `retryAfter` (seconds) when the provider sends one. Provider 429 and 402 map to `quota`; 401 and 403 to `provider_error`, saying the key was refused. `too_short` and `too_long` are checked before any provider call, with thresholds in the stack's `docs/detector.md`.
> - The service never logs the checked text or provider response bodies.
> - The benchmark figures in this request's first draft couldn't be confirmed and are removed above; the UI shows none.


## R2 · Calling `check_text` from Boundary without a chat turn (Wanted)

**Why:** the check is a user action, like Copy. Running it through a chat turn would put the text in a transcript and spend a model call to relay a score.

**Ask:** one route Boundary can use directly. Some options:

1. A host port on the add-on's service, bound to `127.0.0.1` only, serving `POST /check` with the R1 shapes and a per-install token.
2. `addon.sh call detector check_text --json`, reading the text on stdin and printing the R1 result.
3. Calling the add-on's MCP endpoint over a host port with a standard MCP client.

Option 1 or 2 is enough. Boundary has no MCP client of its own today.

**Acceptance:** the chosen route returns the R1 result for a passage, needs no running chat, and isn't reachable from another machine on the network.

**Boundary fallback:** none planned. Phase 5 waits for this item.

> **Stack reply (11 Nov 2026):** accepted as option 1.
>
> - `detector` publishes `127.0.0.1:${DETECTOR_PORT}` (`.env`, default 8790) and serves `POST /check` with `Content-Type: application/json` and body `{ "text": ... }`, returning the R1 shapes, and `GET /health`, which returns `{ "ok": true, "provider": ... }`.
> - **Auth:** `Authorization: Bearer <token>`. The token is the file `<data root>/addons/detector/secrets/http_token` (one line, 64 hex characters, mode 0600), written by `addon.sh enable detector`. It stays out of `.env` because the stack mirrors `.env` keys into Hermes profiles, and the agent must not see it. The data root is `ASSISTANT_DATA_ROOT`. Read the file on each check, or again after a 401: `scripts/detector.sh rotate` replaces it and the service uses the new one at once. A header token keeps web pages in the user's browser from posting to localhost, and the service answers 403 to any `Host` other than `127.0.0.1` or `localhost`, against DNS rebinding.
> - **Limits,** checked before any provider call: `too_short` under 50 words (split on whitespace), `too_long` over 50,000 code points (not UTF-16 units). A provider 413 also maps to `too_long`.
> - **HTTP status per error:** `too_short` 422, `too_long` 413, `no_key` 409, `quota` 429 (with `retryAfter` and a `Retry-After` header when the provider sends one), `provider_error` 502, `timeout` 504 after 60 s, `bad_input` 400, `unauthorized` 401, `forbidden` 403.
> - **Results:** Pangram's `score` is `fraction_ai + fraction_ai_assisted` and its `label` is `prediction_short` (AI, Human, Mixed); GPTZero's are `completely_generated_prob` and `predicted_class`. `model` is the provider's version string when it sends one. GPTZero's field names come from third-party descriptions; its official reference couldn't be read.
> - **CR 0027 R4–R5** are on the same stack branch: every add-on with internet egress has `store.dataLeaves`, and `list --json` returns `description` and `store`. The detector's `dataLeaves`: "The text you check is sent to the detector you chose, Pangram or GPTZero, under your account with them."
> - **State (11 Nov 2026):** built on stack branch `feat/detector-addon` with tests against a stub provider; not merged, not tagged, never run against the real APIs. Reference: the stack's `docs/detector.md`.
> - Option 2 declined: `addon.sh run` starts two or three containers per call, which would add seconds to every Check.
> - The port is a narrow per-add-on route. When the stack's planned client API exists, it takes this over, with a CR to Boundary first.


## R3 · A key the user doesn't hold (Later)

**Why:** at some point Boundary may offer a detector under a shared business account, so users without their own account can check text. The key for that would live in a relay service, not on the user's Mac.

**Ask:** let the add-on point at a relay URL with a per-install token instead of a provider key, with the same `check_text` shapes. No relay exists yet; this item only keeps the shape open.

**Acceptance:** none until a relay exists.

> **Stack reply (11 Nov 2026):** Later, nothing built. `provider` stays a choice setting, so a `relay` value with a URL and per-install token can be added without changing the `check_text` shapes.
>
> **Boundary fallback:** none.
