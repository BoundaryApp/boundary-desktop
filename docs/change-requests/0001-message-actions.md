# 0001 · Message actions: timestamps, edit, retry, branch, versions

| | |
| --- | --- |
| From | Boundary desktop |
| To | [Sovereign agent stack](https://github.com/kaxline/sovereign-agent-stack) maintainer |
| Serves | [docs/message-actions-ux-study/spec.md](../message-actions-ux-study/spec.md) · visuals in [index.html](../message-actions-ux-study/index.html) |
| Opened | 29 Sep 2026 |
| Status | Answered (R1 done · R2–R5 declined/deferred · R6 verified) |

## Context

Boundary is adding hover actions to chat messages. Your prompts get **Copy / Edit / Branch** and a **timestamp**. Assistant replies get **Copy / Retry / Branch** plus an overflow menu. Edit and Retry keep earlier **versions** (‹ 2 / 2 ›) rather than overwriting them.

Boundary talks to Hermes over the dashboard JSON-RPC WebSocket, using the contract vendored from hermes-agent (`gateway-contract.generated.ts`). That contract already has most of what we need:

- `TranscriptMessage.timestamp` and `TranscriptMessage.row_id` on `session.history` and `session.resume`.
- `prompt.submit` truncation for rewind, edit and regenerate: `truncate_before_row_id` (preferred), `truncate_before_message_id`, or `truncate_before_user_ordinal`, with `confirm_truncate`. It returns `survivor_row_id_map`.
- `session.branch` ("fork a live session into a new stored child"), and `parent_session_id` on `session.create` and on session list rows.

So Boundary can build the feature without new stack code. The items below are there so the parts other clients also need live in the stack, and so Boundary does not end up keeping its own copy of agent state.

---

## R1 · Pin a minimum Hermes version that has these methods

**Priority:** Blocking for spec Phase 2 (Edit / Retry).

**Why.** Boundary will call `prompt.submit` with truncate parameters and read `timestamp` / `row_id` from history. `.env.example` pins `HERMES_AGENT_IMAGE_TAG=v2026.9.14` and `HERMES_WEBUI_IMAGE_TAG=0.52.113`. The compose fallbacks in `docker-compose.yml` still default to `v2026.8.3` and `0.52.106`. An install without those `.env` lines gets the older images, and we cannot tell whether those have these methods.

**Ask.**

1. Confirm the pinned agent exposes all of the following over the dashboard WebSocket, for the default profile and the named agent profiles Boundary routes to with `profile`:
   - the truncate parameters on `prompt.submit`
   - `timestamp` and `row_id` on `session.history` and `session.resume` rows
   - `session.branch`
2. Align the `docker-compose.yml` fallback tags with `.env.example`.
3. State a minimum agent tag Boundary can rely on, for example in `docs/hermes.md`.

**Acceptance.** Against a fresh `make up`:

- `session.history` rows carry `timestamp` and `row_id`.
- `prompt.submit` with `truncate_before_row_id` + `confirm_truncate` replaces the tail and returns `survivor_row_id_map`.
- The documented minimum tag matches the compose default.

**Boundary fallback.** Boundary feature-detects. If the gateway rejects the truncate parameters, Boundary hides Edit and Retry and shows timestamps only where they come back.

**Stack reply (29 Sep 2026).** **Done.**

1. Confirmed on running `nousresearch/hermes-agent:v2026.9.14` over the dashboard WebSocket:
   - Default profile: `session.history` rows include `timestamp` and `row_id`. `prompt.submit` with `truncate_before_row_id` + `confirm_truncate` replaces the tail (seeded 4-row transcript → 3 rows with the edited user text). Result included `survivor_user_row_ids`; `survivor_row_id_map` was `null` on this probe (both fields are optional in the contract — prefer the map when present, otherwise rebind from `survivor_user_row_ids` / a history refresh).
   - Named profile `software-engineer` (`profile` param): history carries `timestamp`/`row_id`; `session.branch` returns a child with `parent` set.
   - `browser` profile: same truncate behaviour.
2. Compose fallbacks aligned with `.env.example`: agent `v2026.9.14`, WebUI `0.52.113` (`assistant` `docker-compose.yml`).
3. Minimum tag documented in `assistant` [`docs/hermes.md`](https://github.com/kaxline/sovereign-agent-stack/blob/main/docs/hermes.md#image-pins-minimum-agent-tag): **`v2026.9.14`** (WebUI companion `0.52.113`).

Keep feature-detecting: older gateways may still reject truncate.

---

## R2 · Branch at a chosen message, keeping full rows

**Priority:** Wanted for spec Phase 3 (Branch). Boundary has an interim.

**Why.** Branch opens a new chat that holds the conversation **up to a chosen message**. The user picks it, and it is often not the latest one. `SessionBranchParams` has `name` and `count`, but the contract does not say what `count` means. Boundary's interim is `session.create` with seeded `messages` plus `parent_session_id`. Seeding copies text only, so the branch loses tool rows, tool arguments and reasoning, and the agent in the branch has less context than the parent had.

**Ask.**

1. Document what `session.branch` `count` means.
2. If it cannot fork at an arbitrary earlier message, add a cut point, for example `before_row_id` (exclusive) or `through_row_id` (inclusive). Do this upstream or as a stack patch. The fork should:
   - keep full rows
   - set `parent_session_id`
   - accept `title`
3. Make sure `session.list` returns `parent_session_id` for branched rows, and that Hermes WebUI lists branches sensibly.

**Acceptance.**

- `session.branch({ session_id, before_row_id })` returns a new stored session. Its history equals the parent's rows before the cut, tool rows included.
- `parent_session_id` is set on the new session and appears in `session.list`.

**Boundary fallback.** Seeded `session.create` with `parent_session_id` (text-only history). Once this lands, remove the seeding path in `hermesGatewaySession.ts`.

**Stack reply (29 Sep 2026).** **Declined as a stack patch.**

1. On `v2026.9.14`, `SessionBranchParams.count` means: **keep only the first N rows of the source (raw) history** (contract comment in hermes-agent `tui_gateway/contracts/sessions.py`). That count is in backend row space, not merged-bubble space — unsafe for message-level forks from a client that folds tools into assistant bubbles.
2. No stack overlay for `before_row_id` / `through_row_id`. Upstream is working a durable cut (`up_to_row_id`) in [hermes-agent#98025](https://github.com/NousResearch/hermes-agent/pull/98025) (open as of this reply). When that ships in a released agent tag, this stack will bump the pin; until then keep the seeded `session.create` interim.
3. `parent_session_id` is already on list rows in the contract; live `session.branch` returned `parent` in our probe. WebUI branch listing is unchanged by this stack.

---

## R3 · Keep replaced turns as alternates, not deletions

**Priority:** Wanted. It decides whether versions survive a reload.

**Why.** Edit and Retry promise that nothing is silently lost. The ‹ 2 / 2 › picker lets you view and continue from an earlier version. `prompt.submit` truncation deletes the replaced tail. Boundary's chat runtime can keep versions in memory, but they vanish when the chat reloads or the user switches chats. Keeping them in Boundary on disk would mean Boundary owning transcript state, which it should not. Hermes WebUI would also never see them.

**Ask.** When `prompt.submit` truncates:

1. Keep the removed rows as an alternate: for example a hidden child session (`session.set_hidden`) linked to the parent and the cut row.
2. Expose alternates to clients: for example `session.alternates({ session_id, row_id })`, or an `alternates` count and ids on the history row where the branch point is.
3. Switching to an alternate should be possible without a model call. Only continuing from it should cost tokens.

**Acceptance.**

- After editing the same prompt twice, history reports three versions at that row. Each version's rows can be fetched.
- Hermes WebUI can show them, or at least is not broken by them.

**Boundary fallback.** Versions are held in memory by assistant-ui's local runtime for the life of the open chat, and labelled as such. Once this lands, Boundary loads versions through a history adapter backed by these methods.

**Stack reply (29 Sep 2026).** **Declined.** Durable alternates / version trees belong in hermes-agent (and WebUI), not in this compose stack's cont-init overlays. Keep the in-memory interim; reopen when upstream exposes an alternates API.

---

## R4 · Return the new user row id on the live turn

**Priority:** Wanted.

**Why.** To edit a prompt sent a moment ago, Boundary needs that row's `row_id`. Today it would re-fetch `session.history` after every completed turn just to learn it.

**Ask.** Include the new user message's `row_id` and `timestamp` in `PromptSubmitResult`, or in the `message.start` event. Do the same for the assistant row in `message.complete`.

**Acceptance.** Both ids are available without a history call.

**Boundary fallback.** Refresh the per-session row map from `session.history` after `message.complete`, and fall back to `truncate_before_user_ordinal`.

**Stack reply (29 Sep 2026).** **Declined.** `PromptSubmitResult` / `message.*` event shapes are upstream. Keep the history-refresh interim.

---

## R5 · Per-turn model or provider on retry

**Priority:** Later. Spec Phase 4, after inference Phase 4.

**Why.** The Retry menu offers "Retry with OpenRouter · sonnet-4" as a one-off. Today a provider change is a stack-level connection change and can restart Hermes (inference spec, ADR 0016), which is too heavy for one retry.

**Ask.** Add an optional `model` / `provider` override on `prompt.submit` that applies to that one turn only. It must still honour the project privacy pin (ADR 0017).

**Acceptance.** A retry with the override runs on the other provider. The next normal turn runs on the chat's resolved provider.

**Boundary fallback.** The menu shows only "Retry" (same provider). The other-provider row is hidden.

**Stack reply (29 Sep 2026).** **Declined (Later).** Agrees with the Later priority. This stack resolves models per Hermes profile / config, not per turn. A per-turn override would be an upstream `prompt.submit` change (and must still honour privacy pins).

---

## R6 · WebUI stays in step after truncate or branch

**Priority:** Wanted. Verification only.

**Why.** Boundary and Hermes WebUI read the same sessions, and WebUI caches agents (`HERMES_WEBUI_AGENT_CACHE_MAX`). After Boundary truncates or branches a session, WebUI must not keep showing the old transcript.

**Ask.** Check that a session edited in Boundary shows the new transcript in WebUI on next open. If the cache holds it, invalidate on `sessions.changed`, or document the limit.

**Acceptance.** Edit in Boundary, then open the same chat in WebUI: WebUI shows the edited transcript.

**Boundary fallback.** None needed. Boundary notes any limit in the spec.

**Stack reply (29 Sep 2026).** **Verified / no patch.**

- After truncate on the `browser` profile gateway, a fresh `session.history` for that session returned the truncated transcript (correct durable state).
- `HERMES_WEBUI_AGENT_CACHE_MAX=5` is an **agent instance** cache, not a transcript row cache. Session stream self-heal already reads the on-disk sidecar via this stack's `patch-webui-persisted-count.py`.
- Caveat for the spec: WebUI chat is the **`browser`** profile; dashboard/default and named-agent sessions live in other profile DBs. Boundary and WebUI only share a transcript when Boundary routes with `profile` matching the WebUI gateway (or you open the same stored session that WebUI indexes). No speculative cache-invalidation patch.

---

## Replies

Answers are inline under each item above. Assistant stack changes for R1: compose fallbacks + `docs/hermes.md` image-pins section.