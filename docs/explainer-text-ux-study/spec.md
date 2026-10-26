# Explainer text: living spec

| | |
| --- | --- |
| Status | Accepted; phases 1–3 built |
| Visuals | [index.html](index.html) |
| Started | 25 Oct 2026 |

## Progress

| Phase | Status | Depends on |
| --- | --- | --- |
| 1 `InfoTip` primitive | Built; live check pending | — |
| 2 Settings tabs | Built; live check pending | 1 |
| 3 Chat, sheets and list panes | Built; live check pending | 1 |
| 4 Copy rules in the design-system sheet | Not started | — |

## Goal

A returning user sees labels, values and actions, not paragraphs. Explanations stay one click or hover away, and text that changes a decision (permissions, deletes, what leaves this Mac) stays in view at the moment of the decision.

## Inventory

An audit of the renderer counted about 130 always-visible explainer passages, about 2,350 words. By kind:

| Kind | Passages | Words | Treatment |
| --- | --- | --- | --- |
| Restates the label or heading | 11 | ~110 | Cut |
| Reference a returning user doesn't need each visit | 48 | ~1,050 | `InfoTip` or a disclosure |
| Needed for the decision in front of the user | 35 | ~700 | Keep inline; tighten |
| Empty-state guidance | 21 | ~260 | One sentence plus the action |
| Status or provenance that only matters when unusual | 16 | ~230 | Show only when unusual |

The heaviest areas are Settings › Calendars (~215 words, mostly provider how-tos in the connect sheet), the add-folder sheets (~200, mostly decision text), Settings › Boundary's browser (~145), Settings › Inference (~140, including a cloud notice repeated after connecting), the thread centre (~110, including a 37-word host-tools banner) and the agent and channel sheets (~105 each).

## Rules

1. **One line under a heading, at most.** A section or settings row may carry one muted line of up to about twelve words. Anything longer moves into an `InfoTip` beside the label.
2. **Explain at the decision, not on every visit.** Consequence text (permissions, deletes, data leaving the Mac, restarts) stays inline in the sheet, interrupt or confirm where the user acts. Once acted on, it is not repeated on the settled screen.
3. **Show provenance only when it is unusual.** The default state carries no label; overrides, warnings and stale data do. The composer's model chip already follows this.
4. **How-tos go behind a disclosure.** Step-by-step help (where to find an app password, what CalDAV URL to use) sits under a **How do I get this?** disclosure, closed by default.
5. **Empty states get one sentence and the action.** The sentence says what will appear here; the button creates it.
6. **Don't explain standard controls.** "One per line" under a list textarea becomes the placeholder; "Enter to send" lives in the send button's tooltip.

## Decisions (confirm before Phase 1)

1. **The info icon opens on hover and on click.** Hover (after 400 ms) shows the text; click or Enter pins it open until Esc or a click outside. Hover-only would hide the text from keyboard users and make links inside it unreachable. *Recommended.*
2. **Build on Radix Popover.** The renderer already uses Radix primitives (label, progress, select, slot). Popover adds collision handling and focus management that the startup screen's hand-built `WhyPopover` lacks. *Recommended over* extracting `WhyPopover`, which would need its own positioning.
3. **Tooltips stay for labels only.** Native `title` attributes keep doing what they do now (full values of truncated text, icon-button names, disabled reasons). Explanations move to `InfoTip`, which is reachable by keyboard and screen reader.

---

## Phase 1 · `InfoTip` primitive

**Where:** new `src/renderer/components/ui/info-tip.tsx`, `workbench.css`.

1. A 14px circled-i button in `--text-faint`, lifting to `--text` on hover and focus, placed after a label with a 4px gap. `aria-label` is "About {label}".
2. Popover: `--surface-2`, `--shadow-popover`, max 280px wide, `--size-xs` text, at most about 60 words, optional single link at the end.
3. Hover intent 400 ms, click or Enter to pin, Esc or outside click to close, focus returns to the icon.

**Acceptance**

- [x] Opens on hover, click and keyboard; closes on Esc and outside click.
- [ ] Screen readers announce the label and read the content when opened.
- [ ] Never clipped by the window edge.

## Phase 2 · Settings tabs

**Where:** `ProductSettingsScreen.tsx`, `AgentBrowserPanel.tsx`, `CalendarsPanel.tsx`, `PasswordsLoginsPanel.tsx`, `ComputerAccessPanel.tsx`, `CodingFoldersPanel.tsx`.

1. Each tab's lead paragraph becomes one line or an `InfoTip` on the tab heading.
2. Row hints longer than one line move into an `InfoTip` on the row label.
3. Calendars' provider how-tos move under **How do I get this?**
4. Inference: the cloud notice shows while connecting and not afterwards.
5. Textarea "One per line" hints become placeholders.

**Acceptance**

- [ ] No settings row is taller than two lines of text at 1000px wide.
- [x] Every removed sentence is either cut as redundant or reachable from an `InfoTip` or disclosure on the same screen.

## Phase 3 · Chat, sheets and list panes

**Where:** `WorkbenchThread.tsx`, `ChatRail.tsx`, `AllChatsPane.tsx`, `ProjectPane.tsx`, `MentionsPane.tsx`, `RightInspector.tsx`, `ChannelSheets.tsx`, `AgentSheets.tsx`.

1. Cut list-pane subtitles that restate the title ("Every conversation, across every project").
2. The host-tools banner becomes one line with an `InfoTip`.
3. Repeated per-row hints in the Room tab's member list ("Member · reads later") show once in the section header.
4. Sheet ledes keep the consequence sentence and move background into an `InfoTip`.

**Acceptance**

- [ ] Empty states are one sentence and an action.
- [x] Consequence text in sheets and interrupts is unchanged in meaning.

## Phase 4 · Copy rules in the design-system sheet

Add the six rules above and the `InfoTip` anatomy to `docs/design-system/index.html`, so new screens start within the budget.
