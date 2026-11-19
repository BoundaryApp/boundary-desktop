# 0061. One Button

- Date: 2026-11-14
- Status: Proposed
- Related: [0018](0018-design-tokens-and-primitives.md), [0060](0060-css-cascade-layers.md)

## Context

ADR 0018 made `components/ui` primitives the building blocks for product chrome, and Button renders the workbench button classes so a `<Button>` and a hand-written button look the same. Most buttons never moved: 194 `<Button>` uses sat beside 326 raw `<button>`s that applied `.wb-btn-solid`, `.wb-btn-ghost`, `.wb-btn-tiny` or `.wb-btn-danger` by hand, plus two looks Button didn't offer (`.wb-inference-btn` on the Inference pages and `.wb-offline-actions .wb-btn` in the offline and pool-stop prompts).

Button's own names didn't match its look. `outline` rendered `.wb-btn-ghost`, while `ghost` was a different, borderless button. It also had a Tailwind `secondary` variant and an `lg` size that nothing used.

## Decision

1. Button has six variants, named for what they are in the design system: `primary` (the solid action, the default), `secondary` (bordered), `danger`, `quiet` (borderless chrome), `brand` (a recommended path, per 0018 §4) and `link`. They replace `default`, `outline`, `destructive` and `ghost`; the Tailwind `secondary` variant is removed.
2. Button has three sizes: `default` (`--control-height`, 34px), `sm` (`--control-height-sm`, 28px) and `icon`. `lg` is removed, and `check:sheet-layout` allows only 34px and 28px.
3. A button that looks like a button renders `<Button>`. Rows, chips, tabs, menu items and icon buttons stay raw elements until they get their own primitives.
4. `.wb-inference-btn` becomes `secondary` (its solid form `primary`). `.wb-offline-actions .wb-btn` becomes `secondary size="sm"` (its solid form `primary size="sm"`).
5. Button sizes to its label. A migrated button keeps a full-width look with `block`, except inside containers that already sized buttons to their label.
6. Button's styles live in `components/ui/button.css`, and every variant maps to classes there rather than to Tailwind look strings. The `.wb-btn-*` class names stay, so container rules that key on them keep working.
7. `src/renderer/__tests__/handStyledButtons.test.ts` fails when a `<button>` in `src/renderer` carries a workbench button class in its `className` text. It doesn't see a class picked from a variable or set on another component's element, such as the coding-busy choice's lookup table and the message editor's `ComposerPrimitive` buttons, which keep their hand-written classes.

## Consequences

- Inference buttons set their label at 13px instead of 12px.
- Offline and pool-stop prompt buttons are 28px tall instead of taking their height from padding.
- A full-width button centres its label instead of setting it at the left.
- Every disabled button dims to 0.5 opacity; danger buttons and those on the Inference pages were 0.45.
- ADR 0018 §5's Button variant list is replaced by §1 above.
