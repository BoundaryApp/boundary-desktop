# 0064. One checkbox, radio and switch

- Date: 2026-11-15
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md), [0060](0060-css-cascade-layers.md), [0061](0061-one-button.md), [0063](0063-one-text-field-and-select.md)

## Context

`components/ui` had a `Switch` and nothing for checkboxes or radios. Product code in `src/renderer` held 18 raw `<input type="checkbox">`s in 15 files and 8 raw `<input type="radio">`s in 7 files. Thirteen of the checkboxes and all eight radios had no look rule, so they drew the system control in macOS accent blue. The rest took their color from containers: `.wb-toggle-row input`, `.wb-check-row input` and `.wb-coding-access-git input` set `accent-color: var(--gen)`, `.wb-all-check` set `--brand`, and `.wb-circle-pick-box` drew a 16px round box by hand.

A switch had four looks. `Switch` drew `.wb-switch` (26×14px, `--line` track), Circle controls replaced that class with `.wb-circle-switch` (34×20px, `--line-strong` track, `#fff` thumb), What's new drew its own `<button role="switch">` (32×18px, `--text` thumb), the project inspector's Private row was a `role="switch"` button that drew a 14px checkbox, and New project's coding row was a checkbox `<input role="switch">`.

Rows around the controls repeated the same parts with different rules: four card rows (`.wb-toggle-row`, `.wb-check-row`, `.wb-conf-radio`, `.wb-conf-switch`), a Tailwind label string on 14 add-on and Circle sites, and eight hand-written `role="radiogroup"` or `role="group"` blocks that each repeated their `aria-label` in a caption span.

## Decision

1. `components/ui` has five choice components: `Checkbox`, `Radio`, `Switch`, `ChoiceRow` and `ChoiceGroup`. Native radios group by `name`, so there is no `RadioGroup` holding state.
2. Checkboxes and radios are native `<input>`s drawn with `appearance: none`, and `Switch` is a `<button role="switch">`. They follow shadcn's conventions (`data-slot`, `cn`, one file per component) but don't wrap Radix: native inputs keep `.checked`, `change` events, `name`, form reset, label activation and arrow keys between radios, which tests and handlers rely on, and none of Radix's checkbox, radio-group or switch packages is installed. No site uses an indeterminate state, so none is drawn.
3. Props: `Checkbox` takes an input's props without `type`. `Radio` takes them without `type` and requires `name`. `Switch` takes `checked`, `onChange`, `label`, `labelledBy`, `describedBy`, `id`, `disabled` and `className`; `className` is merged for layout and no longer replaces the look. `ChoiceRow` takes `control`, `title`, `description`, `descriptionId`, `variant` (`plain` or `card`) and `controlAt` (`start` or `end`, for switch rows). A `Switch` named by `label` in a row points `describedBy` at the row's `descriptionId`, so its description is still read. `ChoiceGroup` takes `label`, `kind` (`radio` or `checkbox`), `hint` and `className`. `Checkbox` and `Radio` draw `aria-invalid`; `Switch` applies its value at once, so it has no invalid state.
4. One size each: checkboxes and radios are 16×16 (`--choice-size`, `--choice-border`), and a switch is 32×18 with a 14px thumb (`--switch-width`, `--switch-height`).
5. Every accent reads `--brand`: the checked fill and border, the radio dot, the switch track, a card row's border while checked, and the focus ring. Changing `--brand` in `tokens.css` recolors every choice control. A checked checkbox draws `--choice-check`, a white check in both themes. A switch thumb is `--on-glyph`.
6. Focus draws `--focus-ring`, the ring buttons draw. Disabled is 0.5 opacity; inside a `ChoiceRow` the row dims once and the control isn't dimmed again. Invalid draws a `--danger` border.
7. `ChoiceRow` is the wrapping `<label>`, so a row is one click target. `plain` is a 12px row with the title in `--text` and the description in `--text-muted`; `card` adds a `--line` border at `--radius-lg`, tinted with `--brand` while its control is checked. It replaces `.wb-toggle-row`, `.wb-check-row`, `.wb-conf-radio` and `.wb-conf-switch`.
8. `ChoiceGroup` is `Field` for a set of rows: a caption with the `.wb-field-label` look, the rows, an optional hint and `.wb-field`'s bottom margin. It renders `role="radiogroup"` or `role="group"` named by the caption through `aria-labelledby`.
9. The look lives in `components/ui/choice.css`, in `@layer components`, keyed on `data-slot`. Components emit no Tailwind look strings.
10. The shell rule `.workbench :is(input, textarea, select):focus-visible` skips any element with `data-slot`. The range slider, assistant-ui's composer and message editor, and experiments' inputs still rely on it.
11. `src/renderer/__tests__/rawChoiceControls.test.ts` fails on any `<input type="checkbox">` or `<input type="radio">`, or any element with `role="switch"` other than `<Switch>`, in `src/renderer` outside tests and `components/ui`. `formControls.test.ts` fails on a container rule that styles a bare checkbox or radio (0063's CSS test), and on a rule that restyles `.wb-switch`, `.wb-circle-switch` or `.wn-switch button`.

## Consequences

- Switches change size: the default `Switch` grows from 26×14 to 32×18 in Agent browser, Settings, Updates, Bug report, the composer's Tools toggle, Circle notifications, Join call and Pool settings, and Circle controls shrink from 34×20.
- System checkboxes and radios grow from 13px to 16px and lose the macOS accent blue. The coding toggle, New folder's git row and a coding-access prompt's git box go from `--gen` to `--brand`. Circle message select boxes become square.
- The What's new thumb is white instead of `--text`, and a switch track is `--line-strong` when off instead of `--line`.
- Checkboxes and radios draw the 2px offset ring on focus instead of the 3px glow. A disabled row dims its text with its control, and New folder's unavailable git row dims to 0.5 instead of 0.75.
- The coding toggle row loses its blue background and keeps a tinted border. Pool settings' cards and New folder's git row gain the tinted border while checked, and Pool settings' cards round to `--radius-lg`. Pool settings' switch rows become labels, so clicking their text toggles the switch.
- Add-on and Pool settings group captions take the sheet field caption look (11px, uppercase, faint).
- The project inspector's Private row draws a switch at the row's end instead of a checkbox, and New project's coding row draws a switch.
- `Switch`'s `className` no longer changes its look.
- ADR 0018 §5's primitive list gains `Checkbox`, `Radio`, `Switch`, `ChoiceRow` and `ChoiceGroup`.
- Choice cards and chips (`<button role="radio">`), and menu items with checkbox and radio roles, still have their own looks. They are the next candidates for a primitive.
