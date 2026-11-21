# 0063. One text field and select

- Date: 2026-11-15
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md), [0060](0060-css-cascade-layers.md), [0061](0061-one-button.md), [0064](0064-one-checkbox-radio-and-switch.md)

## Context

`components/ui` had an `Input` with 8 uses and a Radix `Select` with one (the model picker), and no `Textarea`, though 0018 §5 lists one. Product code in `src/renderer` held 67 raw text `<input>`s, 13 `<textarea>`s and 22 `<select>`s in 49 files. Most carried no class or only `mono`, `font-mono` or `border-danger`, so their look came from the container: `.wb-field input, .wb-field select, .wb-field textarea` styled about 55 sheet and Settings fields, and fourteen more container rules (`.wb-settings-field > input`, `.wb-vault-unlock input`, `.wb-vault-agent select`, `.wb-proj-menu-search input`, `.wb-voice-group select`, `.wb-task-composer textarea`, `.wb-project-start textarea`, `.wb-circle-edit textarea`, `.wb-circle-share select` and others) styled the rest. Seven classes carried a control's look on the element (`.wb-all-search`, `.wb-all-select`, `.wb-find-input`, `.wb-circles-search`, `.wb-folder-role`, `.wb-report-body`, `.wb-agent-browser-sites`), and two sites styled theirs with inline Tailwind.

Heights followed from padding: a sheet field was about 39px, a Settings row field about 35px, `<Input>` 32px, the Radix trigger 36px and the compact pickers 22 to 30px. Backgrounds were `--surface-0` in sheets and `--surface-1` in `<Input>` and the searches.

0060 recorded what this cost: `.wb-field select` padding clipped the Test runs role picker, and `.wb-field input` removed the monospace face and red border from the add-on connect sheets' fields.

## Decision

1. `components/ui` has three form controls: `Input`, `Textarea` and `NativeSelect`. The Radix `Select` stays for pickers whose options need more than one line of text (today only the model picker), and its `SelectTrigger` takes the same look and sizes. `PasswordField` renders `Input`.
2. Forms use a native `<select>`, not Radix. The desktop agent panel is a small window, and a native menu can pass its edge where a Radix popper is clipped to it. The native control brings macOS keyboard handling, typeahead and VoiceOver, and tests drive it with `selectOptions` without jsdom stubs. The caret is the base-layer rule in `index.css`. The open list is the system menu, with plain-text options.
3. Props: each control takes its element's props. `Input` and `NativeSelect` add `size` (`default` or `sm`), which replaces the HTML `size` attribute. `Textarea` adds `variant`: `field` is the bordered box; `bare` has no border, background, padding, focus ring or resize, for a composer whose container draws the box, and sets no height so the composer's autosizing still applies. Invalid is the `aria-invalid` attribute and disabled the native attribute.
4. Two sizes: `default` is `--control-height` (34px) with 13px text, `sm` is `--control-height-sm` (28px) with 12px text. Searches and filters in lists, menus and docks, toolbar selects and compact pickers take `sm`. A text field fills its column; a select fills it at the default size and sizes to its options when small. A field text area is at least `--textarea-min-height` (88px) and resizes by height.
5. One look: `--surface-0` background, a 1px `--line` border, `--radius-md`, `--text`, placeholder `--text-faint`. Monospace fields pass `font-mono`.
6. Focus is the `field-focus` utility on every control except a bare text area. Invalid (`aria-invalid="true"`) draws a `--danger` border, focused or not; that rule sits in `@layer utilities` so it outranks `field-focus` (0060 §3). Disabled is 0.5 opacity and `cursor: not-allowed`.
7. The look lives in `components/ui/control.css`, in `@layer components`, keyed on `data-slot` (`input`, `textarea`, `native-select`, `select-trigger`) and `data-size`. Components emit `data-slot`, `data-size` (or `data-variant`) and `field-focus`, and no Tailwind look strings. Layout utilities from call sites (`flex-1`, `max-w-[160px]`, `pr-9`) still go in `className`.
8. While call sites moved, every container rule that styled a bare control was fenced with `:not(:where([data-slot]))`, so it stopped matching a control the moment its site moved and kept its specificity for the sites that hadn't. Once every site had moved, the fenced rules were deleted.
9. `src/renderer/__tests__/rawFormControls.test.ts` fails on any raw text `<input>`, `<textarea>` or `<select>` in `src/renderer` outside tests and `components/ui`. A checkbox, radio, range, hidden or file input doesn't count; an input with a dynamic `type` does. `formControls.test.ts` fails on any app rule whose selector ends in a bare `input`, `textarea` or `select`, outside an allowlist that names its reason for each entry: the shell's transition and focus rules (which skip `data-slot` controls, per 0064 §10), the thread header's drag region, assistant-ui's composer and message editor, and the range slider. `check:sheet-layout` fails on a text field or select that isn't 34px or 28px tall, and on an invalid control whose border isn't `--danger`.

## Consequences

- Sheet fields go from about 39px to 34px, Settings row fields from about 35px to 34px, `<Input>` from 32px to 34px and the model picker's trigger from 36px to 34px. Compact controls are 28px: the All chats filter selects (about 22px before), the ProjectPicker search, DM find, the Circles dock search, the Writing voice rename and never-list fields, the voice picker (30px), Circle usage's limit fields and picker (30px), the replies-at-once field (26px), the Circle thread kind picker and the shared-folder role picker, whose text grows from 11px to 12px.
- `<Input>` and the controls that used `--surface-1` (All chats search, ProjectPicker search, Circles dock search, the share sheet, Circle message edit, the Passwords agent picker) darken one step. The All chats filter selects lose their pill shape, the DM find field rounds from 6px to 8px and the Writing voice fields from `--radius-sm` to `--radius-md`. Sheet text areas lose 1px of padding each side.
- The DM find field gains the `--surface-0` background instead of none, and the Share to Circle selects set their text at 13px instead of 12px.
- The Circle, DM and project start composers no longer draw the shell's 3px focus glow: a bare text area has no focus ring, and its box is the focus cue. A disabled composer shows the not-allowed cursor.
- The All chats search, Circles dock search and task text areas draw the `field-focus` ring instead of `--focus-ring` or a 2px brand outline, and Settings row fields draw it instead of only a brand border. Disabled fields in the Passwords sheet dim instead of greying their text.
- The Actual, Bitwarden, Email and Twenty slug fields mark an invalid slug with `aria-invalid` instead of a `border-danger` class, so screen readers announce them as invalid.
- A raw text field, text area or select fails the ratchet, and a container rule on a bare control fails the CSS test.
- ADR 0018 §5's list changes: `Select` becomes `NativeSelect` for forms, with the Radix `Select` kept for rich pickers.
- The design-system sheet's demo input (32px, `--surface-1`) is overridden by this ADR, not restyled; the sheet is the visual record.
- Checkboxes, radios and switches are covered by [0064](0064-one-checkbox-radio-and-switch.md). The range slider, assistant-ui's composer and message editor, and experiments' inputs keep their own rules.
