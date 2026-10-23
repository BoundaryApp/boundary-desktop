# Inference providers — living spec

The visual source is this kit. The decisions are in [`docs/adr/`](../adr/README.md); store is [`0015`](../adr/0015-inference-provider-slots.md); chat override and honest apply is [`0016`](../adr/0016-chat-inference-override.md); project pin is [`0017`](../adr/0017-project-inference-pin.md).

| | |
| --- | --- |
| Status | Accepted |
| Visuals | [index.html](index.html), [01-settings.html](01-settings.html), [02-chat-switch.html](02-chat-switch.html), [03-project-default.html](03-project-default.html) |
| Started | 27 Sep 2026 |

## Progress

Update the phase line and the AC list as work lands. Do not mark a phase done until its AC numbers are checked.

| Phase | Status | Notes |
| --- | --- | --- |
| 1 Settings store | Done | Two slots + app default. Onboarding still picks one; the other is added in Settings. GPU deploy is hidden, not deprecated. |
| 2 Chat chip | Done | Visible Hermes restart on connection change. Spike for same-connection model without restart not run; still restarts. |
| 3 Project pin | Done | Pin on `HermesProjectRecord`, patch IPC, resolve chat → project → app. Privacy row disabled only. |
| 4 Privacy, cost, restart reduction | Not started | |

## Goal

A user can keep a local runtime (Ollama or LM Studio) and OpenRouter at the same time, pick which one is the machine default, and later pin or override that choice per project and per chat. Local-only work never goes to the cloud without an explicit confirm.

## Non-goals

- Extra cloud providers beyond OpenRouter
- Per-agent models
- Hermes WebUI as the settings UI
- Editing endpoints in Settings
- GPU / VRAM rows
- Shipping B’s header segment or C’s inspector Model block as the chat switch

## Held constant

- Two stored connections, one app default
- Resolve, then send: chat override → project pin → app default
- No silent local → cloud fallback
- Switch cost is visible: a Hermes restart is a named composer phase, not an instant toggle
- Settings is a destination. Chat stays home (0002)
- J chrome stays (0014). Do not list files on the rail

## Locked decisions

1. **Onboarding stays one-provider-first.** First-run still picks Local *or* OpenRouter. The other connection is added later in Settings.
2. **Phase 2 ships the visible restart.** Do not block the first chat-switch release on proving Hermes honors a per-request `model` / provider without restart.
3. **Chat switch is the composer chip** (study B, variant A), after the project chip.
4. **Privacy lock is a hard block** when it ships (Phase 4): cloud is disabled for that project, including chat overrides.

Still open (Phase 4):

- Approximate cost on every cloud send, first cloud send only, or popover only
- Whether a later spike can drop restart for **same-connection** model changes
- Writing OpenRouter `extraHeaders` into Hermes

---

## Resolution

```
send
  → chat override?
       yes → privacy lock?
       no  → project pin?
                yes → privacy lock?
                no  → app default
  → privacy lock + target is cloud → refuse; stay local
  → provider reachable?
       yes → Hermes already on this connection? → send
             else named restart phase, then send
       local down → Retry local, or confirm OpenRouter
```

The first present value wins.

- Changing the app default does not rewrite existing chat overrides or project pins.
- Disconnecting a provider clears overrides that pointed at it and falls back to the remaining provider, or to “none configured.”
- Unreachable does not flip the app default to cloud.

---

## Data

Today one slot lives in `openai-onboarding` ([OpenAiOnboardingStore.ts](../../src/main/services/onboarding/OpenAiOnboardingStore.ts)). Saving local or OpenRouter overwrites the other.

| Layer | Store | Fields |
| --- | --- | --- |
| Connections | `openai-onboarding` (migrated) | `local?: Connection`, `openrouter?: Connection`, `appDefault: 'local' \| 'openrouter'` |
| Project pin | `hermes-projects` on `HermesProjectRecord` | `inference?: { mode: 'inherit' \| 'local' \| 'openrouter', modelId?: string, privacyLocalOnly?: boolean }` |
| Chat override | `hermes-agents` `SessionMeta` | `inference?: { provider: 'local' \| 'openrouter', modelId: string }` |

A `Connection` is the current persist payload: endpoint, encrypted key, model, provider, display name, auth scheme, capabilities, extra headers.

**Migration.** The existing single document becomes `local` or `openrouter` from `provider` / URL. That slot is `appDefault`. If `modelId` is missing, the slot is stored but not configured.

**Do not** put inference in `docker-compose.projects.yml` or `sources.yaml`. Extra fields on `HermesProjectRecord` survive gateway rematch; new-row construction in [hermesProjectsMerge.ts](../../src/main/services/assistant/hermes/hermesProjectsMerge.ts) must default `inference: { mode: 'inherit' }`.

There is no project patch IPC today. Add one. Do not overload create/select/change-folder.

---

## Hermes

[applyLlmConnectionToHermes](../../src/main/services/assistant/AssistantStackService.ts) rewrites three profiles and restarts Hermes. [hermesHttpChat.ts](../../src/main/services/assistant/hermes/hermesHttpChat.ts) already sends `model` but reads Hermes env, not the store.

Until a spike proves Hermes will honor a different `model` / provider on the HTTP body without a restart:

- A resolved-**connection** change (local ↔ OpenRouter) is a named composer phase (“Restarting assistant…”), then send.
- Same-connection model changes also restart in Phase 1–2. Phase 4 may drop that restart if the spike passes **and** provider / base URL match.

`getLlmConnection()` / apply read the **resolved** connection for the current send (Phase 2+), or the **app default** slot (Phase 1).

`extraHeaders` do not reach Hermes today. Leave that for Phase 4.

Clearing a slot does not unwind Hermes until the remaining default is applied, or the stack is reset.

---

## UX

**Settings** — [01-settings.html](01-settings.html), [ProductSettingsScreen.tsx](../../src/renderer/product/ProductSettingsScreen.tsx)

Two cards + app-default radio. Local: discover, loaded / not-loaded, health, Test, Disconnect. OpenRouter: OAuth / Reconnect, masked key, filterable picker with $/M and AA, Test, Disconnect.

**Chat** — [02-chat-switch.html](02-chat-switch.html) variant A, [WorkbenchThread.tsx](../../src/renderer/product/chat/WorkbenchThread.tsx) `.wb-cluster` after `ProjectPicker`

Chip shows the resolved provider and model. Second line is provenance: `from app default` (Phase 2), `from project default` (Phase 3), or `overridden for this chat`. Popover lists both configured providers plus “Use project default” (Phase 2: that reset clears the override back to app default). Switch writes a log line. Offline send: “Retry, or send via OpenRouter?”

**Project** — [03-project-default.html](03-project-default.html), [ProjectSourcesRail.tsx](../../src/renderer/product/chat/ProjectSourcesRail.tsx) above Sources

Inherit / Local+model / OpenRouter+model. Privacy lock ships in Phase 4 (row may exist earlier, disabled). Rail pin only when `mode !== 'inherit'`. Create-project Inference row defaults to inherit.

---

## Acceptance criteria

Check a box when the behavior is in `main` (or the phase branch is merge-ready and the phase is marked done). Numbers are stable — do not renumber; add `22a` if needed.

### Settings / store (Phase 1)

- [x] **1.** A user can connect Local and OpenRouter without losing the other.
- [x] **2.** After app restart, both connections and `appDefault` are still there.
- [x] **3.** Existing single-slot installs migrate; chat still works on the migrated default.
- [x] **4.** App default can be Local or OpenRouter only when that slot is configured.
- [x] **5.** Local offline: card is Unreachable; default does not change; Test / Retry work.
- [x] **6.** OpenRouter 401: card is Unauthorized; Reconnect restores the same model if it still exists.
- [x] **7.** Disconnect Local while it is the default → default becomes OpenRouter if configured, else none. Symmetric for OpenRouter.
- [x] **8.** Test message hits the **selected card’s** endpoint, not Hermes.

### Chat switch (Phase 2)

- [x] **9.** Composer chip shows the resolved provider and model, plus provenance.
- [x] **10.** Choosing the other provider sets a chat override, writes a log marker, and the next send uses that connection.
- [x] **11.** “Use project default” (Phase 2: app default) clears the override.
- [x] **12.** If the resolved connection is not what Hermes is on, the composer shows the restart phase and does not send until healthy (or surfaces apply failure).
- [x] **13.** Local unreachable on send: inline Retry / Send via OpenRouter. OpenRouter is used only after confirm. Confirm writes an override.

### Project pin (Phase 3)

- [x] **15.** Inherit / Local / OpenRouter persist on the project and survive gateway rematch.
- [x] **16.** New chats in that project resolve through the pin before the app default.
- [x] **17.** Create-project Inference defaults to inherit; skipping it equals inherit.
- [x] **18.** Rail pin shows only when `mode !== 'inherit'`.

### Privacy / honesty (Phase 2 + 4)

- [ ] **14.** Privacy-locked project: OpenRouter is disabled in the popover; confirm-to-cloud is not offered. (Phase 4)
- [ ] **19.** Privacy lock forces Local, disables cloud in that project, and ignores a cloud app default. (Phase 4)
- [x] **20.** No request is sent to OpenRouter unless the resolved provider is OpenRouter **or** the user confirmed the offline prompt. (Phase 2)
- [x] **21.** Chat stays home; Settings stays a destination; rail / tabs stay 0014.
- [x] **22.** Existing single-provider onboarding still reaches a configured default. (Phase 1)

---

## Phases

Each phase is shippable. Do not start the next until the earlier store and apply path are stable. One git branch per phase. Verify (fetch, ancestor check, `merge-tree` dry-run, `git diff --check`, targeted tests). Do not merge to the base branch unless asked.

```
P1 Settings store → P2 Chat chip → P3 Project pin → P4 Privacy / cost / spike
```

### Phase 1 — Two connections + Settings

**In.** Migrate `openai-onboarding` to `{ local, openrouter, appDefault }`. New IPC: save / update / clear per slot, list models per slot, test per slot, set app default. `getLlmConnection()` / `applyLlmConnectionToHermes` read the app-default slot. Settings becomes the two-card + radio UI. Onboarding writes into the matching slot instead of clobbering.

**Out.** Chat chip, project fields, privacy lock, cost, per-request model.

**AC.** 1–8, 21–22.

**Build order.** Types + migration + tests → IPC → Settings UI → onboarding slot write → apply-default wiring → manual check of the six Settings states.

**Known cost.** Changing the default model in Settings still restarts Hermes. Say so in the saved-model copy.

### Phase 2 — Chat chip + honest apply

**In.** Resolve `chat override ?? app default`. Persist override on `SessionMeta`. Chip + popover after `ProjectPicker`. Log marker. Offline confirm. Before send: if resolved connection ≠ last applied connection, apply + restart phase.

**Spike (time-boxed, does not gate the phase).** Send a different `model` on `startHermesHttpChatStream` while Hermes stays on the other default. Record the result in the log below. If it works **and** the provider / base URL match, Phase 4 may skip restart for same-connection model changes. Provider changes still restart.

**Out.** Project pin (provenance says “from app default”). Privacy lock. Cost.

**AC.** 9–13, 20. Treat “project default” in copy as “app default” until Phase 3.

### Phase 3 — Project pin

**In.** Fields on `HermesProjectRecord` + patch IPC. Merge constructor default. Inference block above Sources. Resolver becomes chat → project → app. Create-project inherit row. Quiet rail pin on explicit pins.

**Out.** Privacy lock may render as a disabled row; do not enforce. Cost.

**AC.** 15–18. Chip provenance starts using “from project default.”

### Phase 4 — Privacy, cost, restart reduction

**In.** `privacyLocalOnly` enforcement (14, 19). Approximate cloud cost from `ListedModel.pricing`. If the Phase 2 spike passed, drop restart for same-connection model changes. Optional: OpenRouter `extraHeaders` into Hermes.

**Out.** Header / inspector placement variants. New providers.

---

## How to update this file

When a phase starts, set its **Progress** row to In progress and name the real branch.

When a phase is merge-ready (not necessarily merged), check its AC boxes, set Status to Done, and add a **Log** line: date, commit or PR, what shipped, what slipped.

If a rule changes, edit the spec in place and add a Log line. Do not fork a second spec. If the change should outlive the program, write or update an ADR and point at it from the header.
