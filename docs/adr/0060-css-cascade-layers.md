# 0060. App stylesheets in cascade layers

- Date: 2026-11-13
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md)

## Context

Tailwind v4 puts its utilities in `@layer utilities`. The app's own stylesheets (`workbench.css` and about fifteen others) were unlayered, and unlayered rules outrank every layer whatever their specificity. A utility class on an element lost to any app rule that set the same property on it, with nothing to show why.

That caused bugs found by hand. The Test runs role picker sat in a sheet field whose `.wb-field select` padding beat the picker's `h-[30px]` and clipped the name. `.wb-field span` restyled the red error spans in three connect sheets, and `.wb-field input` removed the monospace face and red border from those sheets' fields. It also left dead utilities across the code: Button's `px-3` never applied to its workbench variants, and several hand-styled controls carried transition and focus utilities that the shell's rules replaced.

## Decision

1. The layer order is `theme, base, components, utilities, markdown`. `src/index.css` declares it, and every app stylesheet repeats the statement as its first line, so the order holds whichever stylesheet a document loads first.
2. App rules go in `@layer components`. A utility class on an element wins over an app rule for the same property.
3. A rule that has to override a utility class goes in `@layer utilities` (today only `.wb-reading .text-xs`).
4. `@layer markdown` holds the rules that restyle replies. Streamdown renders markdown with its own Tailwind classes, and the reply look has to win over them.
5. `tokens.css` stays unlayered; it only defines custom properties. `@property` rules stay at the top level.
6. Shared interaction styles that a component's own utilities would otherwise outrank are utilities in `index.css`: `control-transition` and `field-focus`, with the same values as the shell's rules in `workbench.css`.
7. A test (`src/renderer/__tests__/formControls.test.ts`) fails when a stylesheet has a rule outside a layer or lacks the order statement.

## Consequences

- Tailwind classes in JSX now do what they say. A class that loses to an app rule is no longer a silent failure.
- Components keep their rendering. Utilities that were dead under the old order were removed or moved so nothing outranks the workbench look: Button's padding and width now go only on its Tailwind variants (and its disabled opacity on those and `outline`; [0061](0061-one-button.md) §6 later moved all of Button's styles into `button.css`), and duplicate utilities on a few elements are gone. A computed-style comparison of the chat, Settings, Circles and Services screens in both themes found no difference before and after.
- Visible changes, each where the code already asked for it:
  - The name, address and key fields in the Actual, Bitwarden, Email, Twenty and confidential-provider sheets set in monospace (`font-mono`), and an invalid one shows its red border (`border-danger`), focused or not. `.wb-field input` overrode both before.
  - Three Buttons in the deploy experiment that pass `w-full` fill their row.
  - An outline Button disabled inside `.wb-inf` dims to 0.5 instead of 0.45.
- An app rule can no longer restyle a utility-classed element by specificity alone. Remove the utility, or put the override in `@layer utilities`.
