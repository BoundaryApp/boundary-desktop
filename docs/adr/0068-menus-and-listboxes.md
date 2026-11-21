# 0068. Menus and listboxes

- Date: 2026-11-18
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md), [0060](0060-css-cascade-layers.md), [0061](0061-one-button.md), [0063](0063-one-text-field-and-select.md), [0064](0064-one-checkbox-radio-and-switch.md), [0066](0066-choice-cards-chips-and-segments.md)

## Context

ADR 0066 left menus, the reaction pill and the move-project destination list outside the primitives. In `src/renderer` outside tests and `components/ui`, every menu and pick-from-a-list popup was written by hand with literal `role="menu"`, `menuitem`, `listbox` and the like. Two other files only name `[role="menu"]` in a `querySelector` string to decide who owns Escape; they aren't menus. The sites fall into four families by where focus lives, which decides the primitive more than the role each uses:

| Family | Focus is | Sites | Files |
| --- | --- | --- | --- |
| A. Action menus from a trigger | in the menu | `role="menu"` and `menuitem`, 10 menus | PasswordsLoginsPanel (row ⋯), ApprovalInterrupt, MessageActions, ProjectSourcesRail, TaskControls, ThreadHead, ServiceTile, CirclesDock, AgentButton (opens on right-click), DmThreadTools (Jump to date: a `listbox` whose options are all `aria-selected={false}`, though each is an action) |
| B. Menus with a current choice | in the menu | 3 menus | CircleRowMenu (Notifications is a hand-built submenu of `menuitemradio`), WritingVoiceChips (the current voice marked with `aria-current` on a `menuitem`), Reactions (a picker of `menuitemcheckbox`) |
| C. Popups driven from a text field | stays in the field | 4 popups | MentionMenu and CommandMenu (`listbox`; the composer moves the index), BusySendMenu (`role="menu"`, though the composer keeps focus and arrows move the active row), PasswordsLoginsPanel's Known sites (`listbox` under the site field) |
| D. Single-select lists | in the list or its search field | 2 lists | ProjectPicker (a popover `listbox` with a search field), MoveProjectSheet (a `radiogroup` of menu rows inside a sheet) |

What was wrong, by family:

- No menu but Reactions had arrow keys. Families A and B announce `role="menu"`, which tells VoiceOver that arrows move between items and Tab leaves; on every other menu arrows did nothing and Tab walked the items. No menu had typeahead. CircleRowMenu's submenu opened on ArrowRight, but its items weren't reachable by arrows either.
- Family C announced nothing. None of the four fields had `role="combobox"`, `aria-expanded`, `aria-controls` or `aria-activedescendant`, so the highlighted row was visual only. BusySendMenu said `role="menu"` while focus never entered it, so screen readers heard neither the menu nor the choice Enter would take.
- Two lists announced the wrong thing. Jump to date is a list of actions announced as unselected options. MoveProjectSheet is a radio group whose rows had no arrow keys (each was a Tab stop), drawn as ProjectPicker's rows.
- There were three ways to dismiss. Seven menus used Radix `Popover`, whose content closes on an outside pointer-down and on Escape and returns focus. AgentButton, CirclesDock and ProjectSourcesRail's second popover used `useDismiss`. Reactions and WritingVoiceChips hand-rolled a `mousedown` listener, and WritingVoiceChips had no Escape.
- There were eleven looks. Menu surfaces and rows came from 17 class families in four stylesheets (`.wb-menu`, `.wb-insp-menu`, `.wb-approve-menu`, `.wb-busy-menu*`, `.wb-proj-menu*`, `.wb-vault-menu`, `.wb-kept-voice-menu`, `.wb-title-menu*`, `.wb-task-runmenu`, `.wb-mentions`, `.wb-vault-suggest`, `.wb-sel-pop` and `.wb-dm-days` in `workbench.css`; `.wb-react-pop`, `.wb-react-pick`, `.wb-circles-menu` and `.wb-circles-row-menu` in `circleChat.css`; `.wb-agent-button-menu` in `agentButton.css`).

## Decision

1. There are two primitives, split by where focus lives. `Menu` is for families A and B: focus moves into the popup, and its items are actions or checkable choices. `Listbox` is for families C and D: one list of options with one active option, and focus either stays in a field that drives the list (family C, ProjectPicker's search) or sits on the list itself (MoveProjectSheet). A family C popup isn't a menu, because focus never leaves the field; that is the ARIA combobox pattern.
2. `Menu` wraps Radix DropdownMenu (`@radix-ui/react-dropdown-menu` 2.2.1, now a direct dependency). It gives roving focus with arrows that wrap and skip disabled items, Home and End, typeahead, `menuitemcheckbox` and `menuitemradio` with `aria-checked`, submenus on ArrowRight and ArrowLeft, focus return to the trigger, and the same outside pointer-down and Escape dismissal `PopoverContent` has. The menu is non-modal and renders in place with no portal, as `PopoverContent` does, so the rest of the window stays reachable, the desktop agent's child window keeps its own `ownerDocument`, and descendant selectors keep working. Building on `Popover` with a roving-focus hook, as ADR 0066 did for chips, was rejected because submenus, typeahead and checkable items would each be new code. Radix's lower `react-menu` layer, which takes any anchor, was rejected for now because it is less documented and only AgentButton needs an anchor other than its trigger.
3. `Menu`'s parts are in `components/ui/menu.tsx`, and each renders `data-slot="menu-…"`.
   - `Menu` takes `open` and `onOpenChange`; open state stays with the caller, as with `Popover`.
   - `MenuTrigger` wraps its one child (always `asChild`) and gives it `aria-haspopup` and `aria-expanded`.
   - `MenuContent` takes Radix's content props, with `sideOffset` 6, `collisionPadding` 8 and `loop` on by default. Radix names the menu after its trigger with `aria-labelledby`; when `MenuContent` is given an `aria-label`, it drops that `aria-labelledby` so the label wins. An item that moved focus on purpose (Quote focuses the composer, Move opens a sheet) keeps it when the menu closes; otherwise focus returns to the trigger.
   - `MenuItem` takes `onSelect`, `disabled`, `title`, `variant` (`default` or `danger`), and `icon`, `hint` (right-aligned text such as a shortcut or count) and `description` (a second line). `MenuCheckboxItem` takes `checked` and `onCheckedChange`. `MenuRadioGroup` takes `value` and `onValueChange`, and `MenuRadioItem` takes `value`. Checkable items draw a fixed check column.
   - `MenuLabel` is a heading focus skips ("This chat writes in"). `MenuNote` is text under an item that focus skips, such as why the item above is disabled. `MenuSeparator` draws a rule. `MenuSub`, `MenuSubTrigger` (with a trailing chevron) and `MenuSubContent` make a submenu.
4. `Listbox`'s parts are in `components/ui/listbox.tsx`, and its keyboard in `use-list-navigation.ts`.
   - `Listbox` takes an `id` and renders `role="listbox"`; `marks` turns on the check column for lists that pick a current value. `ListboxGroup` takes a `label` and renders `role="group"` named by a visible heading (People, Agents, Files). `ListboxOption` takes `id`, `active` (the keyboard's place), `selected` (the value it stands for), `disabled`, `onPick`, and `icon`, `description`, `hint` and `title`. A mouse-down on an option is default-prevented, so a field keeps focus, and a click picks it.
   - `useListNavigation({ id, open, count, active, onActiveChange, onPick, onClose, isDisabled, loop })` returns `fieldProps`, `listProps`, `optionId(i)` and `handleKeyDown`. `fieldProps` go on a field that keeps focus: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant` and the key handler. `listProps` go on a `Listbox` that is itself the focus target: `tabIndex={0}`, `aria-activedescendant` and the key handler. `handleKeyDown` returns whether it took the key, for a field that already has its own key handler. The caller keeps its index state; the composer's mention, command and busy-send state gain the ARIA, not new state.
5. Both primitives share one look in `components/ui/menu.css`, in `@layer components`, keyed on `data-slot`, Radix's `data-highlighted`, `data-disabled` and `data-state`, `aria-disabled`, and `data-active` for options.
   - The surface is `--surface-1` with a 1px `--line` border at `--radius-md`, `--shadow-popover` and `--space-1` padding, 14em to 26em wide (capped at the window width less `--space-4`). A focusable listbox in a sheet has no shadow and shows `--focus-ring` when focused.
   - A row is at least `--control-height-sm` (28px), with `--size-ui` text (13px; there is no `--size-sm` token), `var(--space-1) var(--space-2)` padding, `--radius-sm` and a `--space-2` gap before a 14px icon. A description makes it taller.
   - A highlighted row, an active option and a hovered option take `--surface-hover`. That marks where the keyboard or pointer is, not a selection, so no row takes a `--brand` fill; the check is the selection. Danger items are `--danger`. Disabled rows are 0.5 opacity with `cursor: not-allowed`.
   - Checkable items and marked lists keep a 14px check column, so labels line up whether or not a row is checked. In a menu that has checkable items, plain items and notes are indented by an empty 14px `::before` column rather than padding, because `check:spacing` fails on a raw length in padding.
   - Labels and group headings are `--size-xs`, `--text-faint`, `--weight-medium`. Descriptions are `--size-xs`, `--text-muted`. Hints are `--size-xs`, `--text-faint`.
   - There is no pop-in animation. The old `.wb-proj-menu` had `wb-pop-in`; whether to add one back is open.
6. The reaction picker becomes a `Menu` of `MenuCheckboxItem`s with emoji labels, laid out as a row by a layout class on `MenuContent`. Radix moves through items with Up and Down, and Left and Right open and close submenus; the picker keeps Left and Right as well through its own key handler, which moves focus to the previous or next item. The pills (`aria-pressed`) become `Chip pressed`, with the emoji as `icon` and the count as the label, inside `ChipGroup type="multiple" aria-label="Reactions"`; the read-only case passes `disabled`.
7. MoveProjectSheet becomes a `Listbox` of `ListboxOption`s on `listProps`, not a `ChoiceGroup` of radios, because its rows carry ProjectPicker's glyph, name, path and count and should look the same in both places.
8. Jump to date becomes a `Menu` of `MenuItem`s: each day is an action.
9. Keyboard, by family:
   - A and B: Radix's. Enter, Space or ArrowDown on the trigger opens the menu and focuses the first enabled item; arrows wrap; typeahead; Escape closes and returns focus; Tab closes.
   - C: the field keeps focus. ArrowUp and ArrowDown move the active option and wrap, Enter picks it, and Escape closes the popup and is consumed so a sheet underneath stays open. Home and End stay with the text.
   - D: ProjectPicker's search field drives the list as in C. MoveProjectSheet's list is one Tab stop; arrows, Home and End move the active option, which it also selects, as a radio group would.
10. `src/renderer/__tests__/rawMenus.test.ts` counts, per file, opening tags whose own attributes give `role=` one of `menu`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `listbox` or `option`. It shares its tag scan with `rawChoiceButtons.test.ts` through `src/renderer/__tests__/jsxScan.ts`. Its allowances, in `rawMenus.allowances.json`, started at 60 sites in 17 files; a file's count can only go down, and a stale allowance fails the test. When the migration takes the file to `{}`, the test asserts zero and the file goes. A CSS test in `formControls.test.ts` then fails on any app rule that names an old menu class or keys a look on `[aria-checked`, `[aria-selected`, `[role='menu` or `[role='option']` outside `components/ui`, and the two menu allowances ADR 0066 left in that test go. `bun run check:sheet-layout` has a `view=menus` view and checks that every menu row and listbox option is at least 28px in every view.

Testing: Radix opens a DropdownMenu on a primary pointer-down, not a click, so `fireEvent.click` on a `MenuTrigger` does nothing. The renderer tests run on happy-dom, which has `PointerEvent`, so no polyfill is needed. Tests open a menu with `openMenu(trigger)` (a pointer-down and pointer-up with `button: 0`) and then `await flushMenu()`, because Radix moves focus on open, typeahead and close one timer tick late. Both live in `src/renderer/__tests__/openMenu.ts`. Radix items are `div role="menuitem"` with `aria-disabled` and run `onSelect`, not `onClick`, so tests assert `aria-disabled="true"` rather than `toBeDisabled()`.

## Consequences

The primitives, the ratchet and `view=menus` are built; no screen uses them yet. As each family moves, these are the visible changes, by screen:

- Action menus (the vault's row ⋯, tool approval, message actions, project sources, task controls, the thread header, service tiles, the Circles dock, the agent button, Jump to date): every menu takes the one surface and 28px rows. Arrows, typeahead and Escape work in all of them. The Circles dock and the agent button close on Escape through Radix instead of `useDismiss`. ThreadHead's disabled "Move to project…" keeps its reason as a `MenuNote` rather than a `title`.
- Menus with a current choice: a Circle row's Notifications becomes a submenu with a radio group; picking a level still closes the whole menu and saves only on a change. The writing-voice menu becomes a label, a radio group of the ready voices and "Use {agent}'s voice", a separator and "Manage voices…", and gains Escape. The current voice and the current notification level show the leading check instead of an active fill or a trailing mark.
- Reactions: the pill takes the chip's 28px height, `--radius-full` border and `--brand` tint when it's yours.
- Composer and field popups (@ mentions, / commands, the busy-send menu, the vault's Known sites): rows take the shared look, and screen readers hear the active row. The busy-send menu's hint lines move to the description slot, and its Always queue checkbox moves to a footer outside the listbox, still reachable by pointer; keyboard users set the same preference in Settings.
- Project picker and Move to project: rows take the shared look. Without a search field, the picker's list takes focus as Move to project's does. Move to project's list becomes one Tab stop with arrow keys.

Amendments:

- ADR 0018 §5's primitive list gains `Menu` and `Listbox`. `Menu` is what the list's DropdownMenu entry names; `components/ui` never had a DropdownMenu.
- ADR 0066 §14's exemptions for the reaction pill and the move-project destination list close when Reactions and MoveProjectSheet move. Its two menu allowances in `formControls.test.ts` go with the CSS test in §10.

ADR 0066 §14 named three more exemptions. The chat rail's open-view rows now say `aria-current="page"` instead of `aria-pressed`. The four tab lists are on `Tabs` (ADR 0018 §5, amended 2026-11-18), with their own ratchet in `rawTabs.test.ts`. The start-up screen's tool wheel is a radio group on `useRovingRadio` when its tiles pick the story card, counted as an illustrated control rather than an exemption. That leaves the Circle place side-panel icon buttons, which wait on an icon-button change to `Button` after the menus move, since most menu triggers are hand-built icon buttons too.

| File | Role |
| --- | --- |
| `src/renderer/components/ui/menu.tsx` | `Menu` and its parts |
| `src/renderer/components/ui/listbox.tsx` | `Listbox`, `ListboxGroup` and `ListboxOption` |
| `src/renderer/components/ui/use-list-navigation.ts` | Keyboard and ARIA for a listbox, from a field or on the list |
| `src/renderer/components/ui/menu.css` | The shared menu and listbox look |
| `src/renderer/__tests__/rawMenus.test.ts` | The ratchet, at zero |
| `src/renderer/__tests__/jsxScan.ts` | The tag scan both ratchets use |
| `src/renderer/__tests__/openMenu.ts` | `openMenu` and `flushMenu` for tests |
