# Circles screen: living spec

| | |
| --- | --- |
| Status | Proposed |
| Visuals | [prototype.dc.html](prototype.dc.html) (click-through source) |
| Started | 31 Oct 2026 |
| Builds on | [ADR 0032](../adr/0032-circles.md), [ADR 0034](../adr/0034-shared-models.md), [ADR 0036](../adr/0036-shared-model-app-default.md), [circles plan](../circles-plan.md), [settings spec](../settings-ux-study/spec.md) |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 List and detail | Not started | — |
| 2 People and the person panel | Not started | 1 |
| 3 Sharing | Not started | 2 |
| 4 Invites and joining | Not started | 1 |
| 5 Links from the rest of the app | Not started | 2, 3 |
| 6 Usage | Not started | Metering (circles plan phase 4) |

## Goal

A user can see who is in a Circle and what each person shares, and go from "Maya shares a model" to "Maya's model answers my chats" on one screen. A provider can tell at a glance whether members can use their models, and why not.

## What the current screen gets wrong

Everything sits in one scrolling page: identity, the global sharing panel, the create and join forms, then a card per Circle. Three kinds of thing are mixed there.

Sharing to a Circle takes two controls far apart: a tick in the panel at the top and a switch in that Circle's card. Trust belongs to a person, but it appears once per Circle, so one person in two Circles has two sets of switches that change together. A member who trusts someone in Circles has to go to Settings to use the model.

## Decisions

1. **List and detail.** The Circles destination has a 256px list and a detail pane, like the chat rail. The list holds **Sharing**, then the user's Circles, then a line with their name, connection state and **Profile**. Opening the destination restores the last selection.
2. **Each thing lives with its owner.** Models, pause and away mode belong to this Mac, so they're on **Sharing** and not in any Circle. An offer belongs to a person, so it's on that person's row. Trusted and Private belong to a person across Circles (ADR 0034 §3), so they're in the person panel.
3. **A Circle's page is its people.** Each row shows the person's presence, role, models and whether the user trusts them. There is no separate shared models list. A dot is green only when that person's model can be used now, amber when they're online and paused, and grey when offline.
4. **The person panel is one component.** A 320px panel on the right opens from a Circle's row and from a row in **Sharing**, so the list stays in view and the user can move between people. It holds the two switches, the person's models with **Use as default** and **Add as fallback**, and, for an admin viewing a Circle, **Make admin**, **Make member** and **Remove**. Setup's Model step (ADR 0036) and the Models destination's **Trust Maya** use the same content.
5. **Use comes after trust, in place.** The use buttons stay disabled until the provider is Trusted, as main already requires (ADR 0036 §3), and the line under them says so. Turning Trusted off for the model in use leaves it chosen but stale (ADR 0036 §5), and the panel says chats can't use it.
6. **Sharing has two sections.** **Shared from this Mac** holds status, **Pause sharing**, the server's models, a switch per Circle and **Away mode**. **From your Circles** lists every model offered to the user, one row per person and model, with its state. With no local model and nothing shared, the first section is gone.
7. **The You row stays a shortcut.** It has a **Share here** switch, the same state as the switch on **Sharing**. It appears only when the user can share.
8. **Sharing is not the Models destination.** The settings spec's Models destination is where the user orders what answers their chats. **Sharing** is what they offer and what's on offer. The Local entry there shows a status line that links here, and the controls stay in one place, because a switch in Settings caused a failed two-Mac test. When Models ships, the two use buttons become **Add to stack**, as "fallback" leaves the UI then.
9. **Words.** The UI says **Allow in private projects** for the Private setting, because "Private" reads oddly on a person. **Trusted** stays. The code and ADRs keep `private`.
10. **Start or join, once.** With no Circles the detail pane is a welcome screen: name, **Start a Circle**, **Join with an invite**. After that, both live behind **+** in the list.
11. **Invites are a sheet.** It creates a code with an optional **Who is it for?** label, says which admins must be online, and lists open invites by label. The label stays on this device and never enters the Autobase. Codes aren't stored after they're made, so the sheet says to copy the code now, and a lost code means revoking and making another.
12. **Joining has its own state.** A join shows a **Joining…** row and a waiting page, and it survives leaving the screen. **Cancel** stops it. Failures show on that page.
13. **Problems reach the user wherever they are.** A sharing problem sets a warning dot on the Circles icon, and **Sharing**'s status line in the list names it. A banner on **Sharing** carries the fix.
14. **Tabs wait for a second thing.** When Circle chats arrive (circles plan phase 5), Chat becomes the first tab of a Circle and this page becomes People. Until then there is no tab bar.
15. **Diagnostics moves to Profile.** So do the display name and renaming.

## Where each flow goes

| Flow | Today | Proposed |
| --- | --- | --- |
| First visit | Name form, then two forms | Welcome screen |
| Create or join again | Forms always on the page | **+** in the list |
| Invite | Inline code; open invites by id | Sheet with labels |
| Join | Busy button in a form | **Joining…** row and waiting page |
| Change role, remove | Buttons on every row | Person panel |
| Leave | Button on the card | **Leave** in the Circle's header |
| Share a model | Tick at the top, switch in the card | **Sharing**; **Share here** as a shortcut |
| Pause, away mode | Panel at the top | **Sharing** |
| Use a shared model | Trust in Circles, pick in Settings | Person panel |
| Setup with no model | Offer rows and a separate picker | Join, then person panel content |
| Local server stops | Panel warning on this screen | Icon dot, list status, banner |
| A chat stops on a shared model | Message with the reason | Message links to the person panel |
| Provider checks usage | Not built | Table on **Sharing** |

## Non-goals

- Sharing different models with different Circles. `CircleSharing` holds one model list.
- New Autobase operations. Nothing here changes `apply`.
- Renaming a Circle, and avatars. Both need a Circle or member field that doesn't exist.
- Invite links, which ADR 0032 allows. Codes stay until links are designed.
- The composer chip's list. The settings spec owns it.

## Risks and open questions

- **One model, two Circles.** A chain entry names a Circle as well as a provider, so one row can stand for two possible entries. **Use** saves the first Circle offering it where the provider is online, or the first offering it otherwise. Leaving that Circle makes the entry stale even if another Circle still offers the model. The router could look for the offer in any shared Circle, which needs a check against ADR 0033 §10.
- **Cancel needs a network change.** `joinCircle` runs until it finishes, and the network process has no way to stop it. Phase 4 adds one and decides what happens to a half-joined Circle.
- **Offers stay published as available** when the provider's server is down. Members see a model that fails until they try it. Fixing that is a network change outside this spec.
- **Window width.** Icon rail, list and panel leave about 640px at a 1280px window. The panel should cover the detail pane below that width. The minimum window size needs checking.

## Build order

**1 List and detail.** The shell, the welcome screen, **+**, Profile. Existing cards move into the detail pane unchanged, and the sharing panel moves to **Sharing**. No new IPC.

**2 People and the person panel.** New rows replace `MemberRow` and `OfferRow`. Setup moves to the shared panel content. Add the use buttons through `chooseSharedModel` and the chain's fallback path.

**3 Sharing.** The two sections, **Share here**, the deduplicated list of offers. Rewrite `docs/testing/circle-sharing.md`.

**4 Invites and joining.** The sheet, labels in main's Circles store, join state outside the form, cancel.

**5 Links from the rest of the app.** A navigation request that names a person or **Sharing**, used by the chain editor, the chat's stop message and the Local card. The icon dot.

**6 Usage.** Who is running or queued, requests and tokens today, and daily limits (ADR 0034 §5). Members see only their own totals.

## Acceptance criteria

- [ ] **1.** A user with two Circles can switch between them from the list, and leaving the destination and coming back restores the selection.
- [ ] **2.** Someone in two Circles appears with one set of switches, and a change shows in both Circles at once.
- [ ] **3.** A member can trust a provider and make their model the default without leaving the Circles destination.
- [ ] **4.** Use buttons stay disabled until the provider is Trusted, and main refuses the choice if the renderer is wrong.
- [ ] **5.** A paused provider's dot is amber on the Circle page and in **Sharing**, and a provider who is offline is grey.
- [ ] **6.** A user with no local model and nothing shared sees no **Shared from this Mac** and no **Share here**.
- [ ] **7.** Turning off a Circle's switch on **Sharing** turns off **Share here** in that Circle, and the reverse.
- [ ] **8.** With the local server stopped, the Circles icon shows a dot from any screen, and the banner offers **Open Settings**.
- [ ] **9.** An invite's label never appears in the Circle's log or on another device.
- [ ] **10.** A join in progress survives navigating away, shows its failure on return, and can be cancelled.
- [ ] **11.** The chat's stop message for a shared model opens that person's panel.
- [ ] **12.** Only admins see role and remove actions, and the remove dialog keeps the wording ADR 0032 requires.
- [ ] **13.** Usage counts appear only on the provider's and that member's own Macs.
