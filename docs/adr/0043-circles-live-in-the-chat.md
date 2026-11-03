# 0043. Circles live in the chat, models live in Inference

- Date: 2026-11-02
- Status: Proposed
- Parent: [0042](0042-circle-chats.md)
- Amends: [0014](0014-tabbed-inspector.md) (a Circle tab), [0042](0042-circle-chats.md) §10 (what the Circles screen keeps)
- Related: [0032](0032-circles.md), [0033](0033-inference-chains.md), [0034](0034-shared-models.md), [0036](0036-shared-model-app-default.md), [Circles screen spec](../circles-ux-study/spec.md), [settings spec](../settings-ux-study/spec.md), [Circle chats spec](../circle-chats-ux-study/spec.md)

## Context

ADR 0042 §10 makes each Circle a place in the Workbench chat: a switcher at the top of the chat rail chooses **This Mac** or one Circle, and the rail then shows only that Circle's channels and people. The Circles destination in the icon rail still lists the same Circles with their people, invites, **Leave** and the person panel, so there are two ways into one Circle.

The Circles destination also holds two kinds of thing that don't belong together. People, roles, invites and channels are about who is in a Circle. **Sharing**, trust and the use buttons are about which models answer this Mac's chats: what this Mac offers, what other people offer, whom the user trusts with private projects, and usage. Those have nothing to do with a Circle's chat or membership. Trust already belongs to a person across Circles, not to one Circle (Circles screen spec decision 2).

The settings spec plans a **Models** destination for the model stack (ADR 0033): order, details, dry run and exceptions. It isn't built. It also warns that sharing controls must stay in one place, because a switch in Settings caused a failed two-Mac test.

The chat already has the pattern for a place's settings. In This Mac, the inspector on the right has a Project tab (0013, 0014). A Circle can have the same.

Phases 1 to 6 of the Circles screen spec are built. Their parts (the person panel, the invites sheet, the join state, the Sharing sections) are components; what changes is where they're mounted.

## Decision

1. **The Circles destination leaves the icon rail.** Circles are reached only through the chat's place switcher.
2. **Inference is the home of everything about models.** The settings spec's Models destination is named **Inference** and sits second in the icon rail, after Chat. It holds the model stack as the settings spec describes, plus what the Circles screen held about models:
   - **Shared from this Mac**: status, **Pause sharing**, a switch per Circle, away mode and usage.
   - **From your Circles**: every model offered in any of the user's Circles, one row per person and model, with the Circles it's offered in, its state, and the person's **Trusted** and **Allow in private projects** switches and use actions.

   Nothing in a Circle, its tab or its person panel changes a model setting.
3. **A Circle tab in the inspector.** In a Circle place, the inspector shows one tab, **Circle**. It has the Circle's name, people and online count, **Invite someone** for admins, the channels (with **Add a channel**, rename and remove for admins), the people list with presence and role, open invites for admins, and **Leave** at the foot.
4. **One header button opens the panel.** A Circle channel's header has a single button on the right that opens and closes the inspector. Channel management moves from a header menu into the Circle tab, so there is no second panel or menu button. The header's only other control is **Call** ([0044](0044-circle-calls.md) §3).
5. **A person in a Circle is about membership.** Selecting a person, from the Circle tab, the rail's People section or a who-line in the chat, replaces the tab's content with their panel and a **Back** row: presence, role, the models they share as plain text with **Open in Inference**, and, for admins, **Make admin**, **Make member** and **Remove**. Trust and use stay in Inference.
6. **Links about a model open Inference.** The chat's stop message for a shared model, the chain's stale entry and **Open in Inference** open Inference at that person's row. They never switch the chat's place.
7. **Starting and joining are sheets from the switcher.** The switcher's menu has **Start a Circle…** and **Join with an invite…**. Start asks for a name, creates the Circle and switches to it. Join takes a code, closes, and adds a **Joining…** row to the switcher's menu. Selecting that row shows the waiting page from the Circles screen spec's decision 12 in the chat area, with **Cancel** and any failure. When an admin admits the device, the Circle replaces the row, and someone still on the waiting page moves into it.
8. **With no Circles, the switcher explains them.** Its menu shows **This Mac**, a line saying what a Circle is, and the two sheets.
9. **Sharing problems show on Inference.** The warning dot that was on the Circles icon moves to the Inference icon, and Inference carries the banner with the fix.
10. **Profile moves to Settings.** The Circles list's footer (the user's name, connection state and **Profile**, with diagnostics and renaming) becomes a **Circles profile** row in Settings. When Circles can't connect, the switcher's menu says so in a line with a link to that row.

## Consequences

- Shipped UI is rearranged. `CirclesScreen`, its list and its mounted tests are replaced by the Circle tab, the switcher's menu, the sheets and Inference. The invites sheet and join state are kept and mounted in new places. The person panel splits: its membership part stays with the Circle, its trust and use part moves to Inference's rows, and Setup's model step uses the Inference part.
- The Circles destination can't be retired until both Circle chats' places (0042 §10, Circle chats spec phase 3) and Inference (settings spec phase 3) ship. Until then the Circles screen stays as it is.
- The Circles screen spec's decision 8, which kept Sharing apart from Models, is reversed: the controls stay in one place, and that place is Inference.
- Shortcuts follow the rail: ⌘1 Chat, ⌘2 Inference, ⌘3 Services, ⌘4 Resources.
- The inspector must be open to manage a Circle. **Invite someone** from the rail and selecting a person open it if it's closed.
- At a 1280px window, the icon rail, chat rail and inspector leave about 650px for the thread, as the Circles screen with its panel did. Below that width the inspector covers the thread, as it does in This Mac.
