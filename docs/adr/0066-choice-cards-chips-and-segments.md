# 0066. Choice cards, chips and segments

- Date: 2026-11-17
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md), [0060](0060-css-cascade-layers.md), [0061](0061-one-button.md), [0063](0063-one-text-field-and-select.md), [0064](0064-one-checkbox-radio-and-switch.md)

## Context

ADR 0064 left `<button role="radio">` choice cards and chips as "the next candidates for a primitive". In `src/renderer` outside tests and `components/ui`, 32 sites in 18 files still drew a pick by hand with `role="radio"` on a non-input or with `aria-pressed`, in three kinds:

| Kind | Sites | Look |
| --- | --- | --- |
| Choice card (radio, or `aria-pressed`) | 12 | `.wb-choice`, `.wb-inference-choice` and `.wb-conf-choice`, each with its own dot or none |
| Segment (radio, or `aria-pressed`) | 9 | `.wb-seg`, `.wb-vault-seg`, `.wb-tasks-scope` and a copy of `Segmented`'s Tailwind strings in Twenty's access switch |
| Chip (radio, or `aria-pressed`) | 10 | `.wb-all-chip`, `.wb-check-filter`, a Tailwind pill in the add-on store, a `Button` with a `✓ ` prefix, and five `Button`s that swapped between `primary` and `secondary` in the email provider pick |

Selection drew four different colors: `--gen` on the New folder, Web search and shared-folder cards and the New folder segment, `--brand` borders on Calendars and the confidential provider cards, a `--brand-dim` fill on those same cards, and neutral fills on the rest (`--surface-2` on the vault segments, and on All chats and Mentions chips the same fill as hover, so a selected chip looked like a hovered one). Segment tracks were about 22, 26, 30 and 34px tall.

The cards had no arrow keys: each card was a Tab stop. Exclusive picks written with `aria-pressed` (the vault and tasks segments, the email providers, the confidential provider cards) were announced as toggles, though only one could be on. `Segmented` drew its look in Tailwind strings, and Twenty's access switch copied them.

## Decision

1. There are three kinds. A choice card is a radio with a title and description. A segment is one of two to four short options that sit together as one control. A chip is a filter or tag in a wrapping row. Each kind has one component, and the kinds stay apart because their layout and keyboard differ.
2. Choice cards are ADR 0064's `ChoiceGroup kind="radio"`, `ChoiceRow variant="card"` and `Radio`. There is no `ChoiceCard` component, because the card row already draws the bordered, tinted card. Each group's radios share a `name` from one `useId()` per group, so two groups on a sheet don't uncheck each other.
3. Cards are native radios, which gives them arrow keys, `name` grouping, label activation and the platform's announcements. A native radio fires `change` only when it becomes checked, so a handler's side effects belong on `onChange`.
4. Segments are `Segmented`, extended, and chips are the new `Chip` and `ChipGroup`. Both are `<button role="radio">` in a roving group, not native radios: tests drive `Segmented` with `keyDown` arrows that jsdom doesn't turn into native radio movement, and a pill drawn around a hidden input needs `:has()` for every state. Exclusive picks that used `aria-pressed` become radios. Independent toggles (Unseen, Waiting, store filters, writing-check categories, channel members) stay `aria-pressed` and stay Tab stops.
5. `ChoiceRow` takes `aside`, drawn after the text and centred (`data-slot="choice-row-aside"`), for a pill such as "Coding" or "Below your minimum". It isn't combined with `controlAt="end"`. `ChoiceGroup` takes either `label` (a visible caption) or `aria-label` (no caption), not both.
6. `Segmented` takes `options`, `value`, `onChange`, `aria-label` or `aria-labelledby`, and optionally `size` (`default` or `sm`), `block` (stretch the track and split it evenly), `disabled` and `className`. `SegmentedOption` takes `disabled` and `title` besides `value`, `label` and `icon`. It renders `data-slot="segmented"`, `data-size` and `data-block`, and `data-slot="segmented-item"` on each button.
7. `ChipGroup` is `type="single"` (`role="radiogroup"`, `value`, `onValueChange`) or `type="multiple"` (`role="group"`), each with an `aria-label`. `Chip` takes `value` in a single group and renders `role="radio"` with `aria-checked`. Anywhere else it takes `pressed` and `onPressedChange` and renders `aria-pressed`. Using a chip the wrong way throws in development only (`import.meta.env.DEV`).
8. Keyboard for segments and single chip groups lives in `useRovingRadio`. There is one Tab stop: the selected item, or the first enabled one when none is selected or the selected one is disabled. Arrow keys select and focus the next or previous enabled item, wrapping, and Home and End select the first and last enabled. Disabled items are skipped. An arrow whose target is already the value doesn't call `onChange`. Cards use the platform's radio keys, and toggle chips take Tab, then Space or Enter.
9. Sizes: a segmented track is `--control-height` (34px), or `--control-height-sm` (28px) at `size="sm"`, with segments 6px shorter so a track lines up with a button or field of its size. A chip is `--control-height-sm` (28px). Cards size to their content.
10. Looks come from tokens. A card is ADR 0064's card row. A segmented track is `--surface-1` with a 1px `--line` border at `--radius-md`; its selected segment is `--surface-hover` with `--text`, neutral on purpose, since a segmented control always has one option on and reads as the current setting. A chip is a `--radius-full` pill with a 1px `--line` border, `--text-muted` at `--size-xs`, hover `--surface-hover`; when on (`aria-checked` or `aria-pressed`) it takes a `--brand-dim` fill, a `--brand` 45% border and `--text`, so a selected chip no longer matches a hovered one. Focus draws `--focus-ring`. Disabled is 0.5 opacity with `cursor: not-allowed`; a disabled `Segmented` dims its track once.
11. The segment and chip look lives in `components/ui/toggle.css`, in `@layer components`, keyed on `data-slot`, `data-size` and `data-block`. `ChoiceRow`'s `aside` goes in `choice.css`. Components emit no Tailwind look strings; layout utilities from call sites still go in `className`.
12. While sites moved, app rules that styled a button inside a container (`.wb-seg button*`, `.wb-vault-seg button*`, `.wb-tasks-scope button*`) were fenced with `:not(:where([data-slot]))`, so a site that kept a wrapper class for layout couldn't restyle a primitive. The fences held until the last site moved and went with the rules they fenced, as did the class rules for the old cards and chips (`.wb-choice`, `.wb-all-chip`, `.wb-check-filter`, `.wb-conf-choice`, `.wb-inference-choice`).
13. `src/renderer/__tests__/rawChoiceButtons.test.ts` fails when a file has more `role="radio"` (on anything but a native input) or `aria-pressed` sites than its entry in the five exemptions below, so the ratchet allows no site outside them. The scan reads attribute names at the tag's own level, so a `<button aria-pressed>` passed in a prop of another tag counts once. `formControls.test.ts` fails on any app rule that styles the old classes (`.wb-choice`, `.wb-all-chip`, `.wb-seg` and the rest) or keys a look on `[aria-pressed`, `[aria-checked` or `[role='radio']` outside `components/ui`; the two menu rules (`menuitemradio` and the reaction picker) are allowed by name. `.wb-member-picks` and `.wb-check-filters` stay as layout classes on a ChipGroup. `bun run check:sheet-layout` has a `view=toggles` view, and checks segmented tracks at 34px or 28px and chips at 28px in every view.
14. These stay outside the primitives, each named in the ratchet's exemptions (10 sites in 5 files): the chat rail's open-view rows (4, which should say `aria-current`), the Circle place side-panel icon buttons (3), the reaction pill (1), a tile in the start-up screen's tool wheel (1), and the move-project destination list (1, drawn as menu rows). Menus (`menuitemradio` and the reaction picker), the four tab lists and `src/experiments/**` are also unchanged. Tabs have no primitive in `components/ui`.

## Consequences

Visible changes, by screen:

- Choice cards (Remove coding folder, Web search in Settings, Add folder, Add shared folder, Remove Circle folder, Share folder, Calendars' provider step, Add confidential provider): the selection tint goes from `--gen` to `--brand` (Calendars and the confidential cards already used it). A selected card loses its background fill and hover fill, descriptions go from `--text-faint` to `--text-muted`, and the 14px dot becomes the 16px `Radio`. The confidential cards round from `--radius-md` to `--radius-lg`, lose their `--surface-0` fill, and show their level badge in the title before the name. Arrow keys move between cards, and only the selected card is a Tab stop.
- Segments: New folder's Access becomes a 34px `Segmented block` without the `--gen` tint. Twenty workspace access goes from about 30px to 28px. Calendars' per-agent access goes to 28px on `--surface-1` with `--surface-hover` selected. Passwords' "Signs in with" goes to 34px. Tasks' List and Board and scope switches go from a 22px pill to a 28px track at `--radius-md`, with the focus ring in place of a 2px outline. All four take one Tab stop and arrow keys.
- Chips: All chats and Mentions chips go from about 24px to 28px and take the `--brand` tint when on. The store's filter chips lose the solid `--text` fill. Writing-check categories go from 22px to 28px, are tinted while shown and no longer fade to 0.55 opacity when hidden. New channel's member picks drop the `✓ ` prefix and become pills. Email's provider buttons become 28px chips.
- `Segmented`'s existing uses don't change, except that a disabled option dims and is skipped by arrow keys.
- Re-clicking the selected card no longer fires a handler, since a native radio fires `change` only when it becomes checked. Web search's notice, which any click used to clear, clears when the mode changes.
- A `ChoiceRow` is a `<label>`, so a link or button inside a card's description would also check the radio. None of the cards has one; a card that gains one stops the click.

Amendments:

- ADR 0018 §5's primitive list gains `Segmented`, `Chip` and `ChipGroup`, and names choice cards as `ChoiceRow` cards.
- ADR 0064 §3 gains `ChoiceRow`'s `aside` and `ChoiceGroup`'s `aria-label` form. Its Consequences line that names choice cards and chips as the next candidates is carried out by this ADR.

| File | Role |
| --- | --- |
| `src/renderer/components/ui/segmented.tsx` | `Segmented` |
| `src/renderer/components/ui/chip.tsx`, `chip-group.tsx` | `Chip` and `ChipGroup` |
| `src/renderer/components/ui/use-roving-radio.ts` | Roving focus and arrow keys for both |
| `src/renderer/components/ui/toggle.css` | The segment and chip look |
| `src/renderer/__tests__/rawChoiceButtons.test.ts` | The ratchet and its five exemptions |
