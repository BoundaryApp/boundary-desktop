# Settings and models: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.dc.html](prototype.dc.html) (click-through source) |
| Started | 30 Oct 2026 |
| Builds on | [ADR 0033](../adr/0033-inference-chains.md), [ADR 0034](../adr/0034-shared-models.md), [explainer text spec](../explainer-text-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 Type scale and copy pass | Built; live check pending | — |
| 2 Sheets over the current screen | Not started | — |
| 3 Models destination | Not started | 2 |
| 4 Move panels to where they act | Not started | 2 |
| 5 A stack per request type | Not started | 3, stack change request, ADR |

## Goal

A user changes a setting from the place it has an effect and sees the effect without losing their place. Models are a destination of their own, shown as the ordered stack a request falls through.

## Decisions

1. **Models joins the rail, second after Chat.** Every chat, project and service depends on it. Shortcuts follow rail order: ⌘1 Chat, ⌘2 Models, ⌘3 Services, ⌘4 Resources, ⌘5 Circles. A warning dot on the icon means the Chat stack's first model isn't answering.
2. **The UI says "stack"; the code keeps "chain".** A *model stack* is the chain of ADR 0033. *Fallback* and *app default* leave the UI, because position in the stack says both.
3. **The stack draws the rules that already run.** Numbered entries sit on a spine, each with its status. The privacy cut is a dashed line, **Private projects stop here**, placed after the last private entry before the first non-private one, so it moves when the user reorders. The end cap says what happens when nothing answers. The footer names the context limit from ADR 0033 §8, because adding a small model shrinks every reply's context and nothing shows that today.
4. **Try a request is a dry run.** It walks the stack with main's chain planning and sends nothing to any model. Each entry reports why it answered or was skipped, in the words the chat's provenance line uses.
5. **One stack per request type, chosen by source.** Tabs: Chat, Coding, Research, Indexing. A type uses the Chat stack until the user gives it its own. As with chat, project and app levels, stacks aren't merged. Type is decided by which service made the request, never by inspecting each request, because switching models between a turn's tool calls breaks the turn (ADR 0033 §7). Per-entry rules ("only for images") in a single list were rejected: order and filters together are hard to predict, and a user would need the dry run to read their own configuration.
6. **Capability skips stay automatic.** Context size and image support are checks an entry passes or fails, like being online. They aren't routes.
7. **Settings panels become sheets.** Every panel renders in a sheet over the current screen, and the screen behind stays where it was. `openSettings()` opens the sheet instead of navigating. The `connectFromChat` special case goes away, since closing a sheet always returns to the chat.
8. **Saves are immediate with Undo.** No **Save model** button. The toast says when a change applies. It names a restart only when one happens (ADR 0033 §9).
9. **A fix sits on the row with the problem.** **Trust Maya** and **Sign in again** are buttons on the stack entry, with the consequence text beside the switch in the details panel.

## Where each setting goes

| Setting | Today | Proposed | Stays findable from |
| --- | --- | --- | --- |
| Connect and test Local, OpenRouter | General | Models: add a model, entry details | Settings search |
| App default, fallbacks | General | Models: stack order | — |
| Chat override | Composer chip | Composer chip, now listing the whole stack in order | Models › Exceptions |
| Project pin | Project inspector | Project inspector, same list | Models › Exceptions |
| Privacy lock | Disabled row in inspector | Working switch in the inspector | Models › Exceptions |
| Share my model | Inside the Local card | Local entry details and Circles | Settings search |
| Trusted, Private per person | Circles | Shared entry details and Circles | — |
| Calendars | Settings tab | Services card, sheet over chat from the setup offer | Settings search |
| Logins | Settings tab | Sheet from a chat's saved-login note; Settings row | Settings row |
| Always-allowed grants | Settings tab | Undo on the approval; Settings row | Settings row |
| Boundary's browser | Settings tab | Services card; Settings row | Settings row |
| Coding folders | Settings tab | Project inspector; Settings row | Settings row |
| Stop agents, replace tokens | Settings tab | Settings, always one click from the page | Settings row |
| Theme | General | Settings | — |

Settings keeps Appearance, a list of what agents can reach with a live summary on each row, and the emergency stop. Search also finds what moved and links to its new home. Experiments keep their `SettingsSection` slot on this page.

## Type and layout

Settings, Models and sheets use a reading scale. The chat rail and other dense chrome keep the current tokens.

| Role | Today | Proposed |
| --- | --- | --- |
| Body, row labels | 13px | 14px |
| Secondary text | 12px, `--text-faint` | 13px, `--text-muted` |
| Button text, height | 12px, about 28px | 13px, 34px |
| Section heading | 15px | 16px |
| Page heading | 22px | 24px |
| Row height | Content only | At least 58px |
| Content width | 720 and 920px mixed | 680px, one column |

Nothing in these screens goes below 12.5px. Add `--size-body: 14px` and `--size-small: 13px` to `tokens.css`, and record them in the design-system sheet.

## Copy audit

The suspicion holds. These strings shipped from the mocks or the spec, and each is verbatim in `ProductSettingsScreen.tsx` or `ProjectSourcesRail.tsx`.

| Shipped text | Problem | Replacement |
| --- | --- | --- |
| "Reconnect to keep the cloud card." | Names the mock's layout, from `01-settings.html` | "Sign in again" on the entry |
| "Local stays configured. The default does not change." | Acceptance criterion 5 restated | Status: Offline |
| "Cloud is the machine default. Local stays available as an override." | Mock option text | Removed; position says it |
| "Stays on this machine. Cloud is off unless a chat or project asks." | Mock text, and no longer true when a chain falls back to the cloud | Removed |
| "Connect with OAuth. Boundary stores one key." | Mock text about implementation | "Your prompts go to OpenRouter and the model's provider" |
| Account: "via OAuth" | Mock row with no information | Removed |
| "GPU providers will return to Settings later." | Roadmap note | Removed |
| "Off. Cloud overrides stay available on chats in this project. (Coming later)" | Placeholder for an unbuilt control | Removed; the working switch arrives with phase 3 |
| "Use project default" | Shown when the project has no default | "Use default"; "Back to Chat stack" once stacks ship |

**Rotate tokens** becomes **Replace tokens**. "Hermes" stays for now: it's the built-in agent's display name (`CalendarsPanel`, `PasswordsLoginsPanel`) as well as the engine, so a rename is a product naming decision that reaches past Settings.

## Open work outside the UI

Confirm each against source when its phase starts, as the stack contract requires.

- **Request type needs a signal.** LightRAG has its own `llm-proxy` route, so Indexing can be told apart. OpenCode and GPT Researcher look like they share the chat route, which needs checking, and they'd need their own route or header through a change request. The router has one chain per listener today.
- **ADR 0033 needs amending** for type stacks: the resolve order becomes chat → project → request type → Chat stack. Context sizing (§8) has to apply per stack, and Hermes sees only the Chat stack.
- **Two models from one source.** `ChainEditor` offers each slot's saved model only, though entries can carry a `modelId`. The add sheet needs the slot's model list, plus context lengths for models not yet selected.
- **Image support isn't known** for most models. Phase 5 needs a source, or the check stays out.
- **The privacy lock's enforcement needs checking end to end.** `privacyLocalOnly` is stored on the project and the inspector row is disabled.
- **Untrusted providers.** ADR 0034 §3 describes approvals per tool call; the code skips the entry until change request 0015 lands. The prototype follows the code.

## Phases

**1 Type scale and copy pass.** Tokens, Settings CSS, the copy audit above. Keeps the current structure, so it can ship alone. Reaches the "no settings row taller than two lines" criterion in the explainer text spec.

**2 Sheets.** A sheet host in the ready shell; each panel renders unchanged inside it. `openSettings()` keeps its signature. Tests: open from a chat, close, and confirm the thread and draft are unchanged.

**3 Models destination.** Rail entry, stack view on the existing chain IPC, details panel, dry run, inline trust and sign-in. Replaces the two cards, the default radio and `ChainEditor`'s list. The composer chip and project inspector take the same list.

**4 Move panels.** Calendars to Services, sharing to the Local entry and Circles, folders to the project inspector, the slimmed Settings page with search.

**5 A stack per request type.** Behind the change request and ADR amendment above.

## Acceptance criteria

- [ ] From a chat, a user can reorder the stack, trust a provider and connect a calendar, and return to the same scroll position and draft.
- [ ] The Models screen shows why each entry would be skipped, with no navigation.
- [ ] A dry run makes no model request.
- [ ] Moving a private entry moves the **Private projects stop here** line in the same render.
- [ ] No text in Settings, Models or sheets is below 12.5px.
- [x] Every string in the copy audit is gone.
- [ ] Every setting in the table is reachable from Settings search.
