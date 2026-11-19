import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../button';

const rendered = (props: React.ComponentProps<typeof Button>) => {
  const { container } = render(<Button {...props}>Go</Button>);
  return container.querySelector('button')!.className.split(/\s+/);
};

describe('Button', () => {
  it('lets a block button shrink to share a flex row, as the full-width workbench buttons did', () => {
    // .wb-btn-solid and .wb-btn-ghost are width: 100%; in a flex row they split the row.
    const classes = rendered({ variant: 'secondary', block: true });
    expect(classes).toContain('shrink');
    expect(classes).not.toContain('shrink-0');
  });

  it('keeps a button sized to its label from shrinking', () => {
    expect(rendered({ variant: 'secondary' })).toContain('shrink-0');
  });
});

const readCss = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../button.css'), 'utf8');

type Variant = NonNullable<React.ComponentProps<typeof Button>['variant']>;
type Size = NonNullable<React.ComponentProps<typeof Button>['size']>;

// What each variant/size pair renders. The look comes from these classes in button.css.
const expected: Record<Variant, Record<Size, string[]>> = {
  primary: { default: ['wb-btn-solid'], sm: ['wb-btn-solid', 'is-sm'], icon: ['wb-btn-solid', 'is-icon'] },
  secondary: { default: ['wb-btn-ghost'], sm: ['wb-btn-tiny', 'is-sm'], icon: ['wb-btn-ghost', 'is-icon'] },
  danger: {
    default: ['wb-btn-danger'],
    sm: ['wb-btn-tiny', 'is-danger', 'is-sm'],
    icon: ['wb-btn-danger', 'is-icon'],
  },
  quiet: { default: ['wb-btn-quiet'], sm: ['wb-btn-quiet', 'is-sm'], icon: ['wb-btn-quiet', 'is-icon'] },
  brand: { default: ['wb-btn-brand'], sm: ['wb-btn-brand', 'is-sm'], icon: ['wb-btn-brand', 'is-icon'] },
  link: { default: ['wb-btn-link'], sm: ['wb-btn-link', 'is-sm'], icon: ['wb-btn-link', 'is-icon'] },
};

const pairs = (Object.keys(expected) as Variant[]).flatMap((variant) =>
  (Object.keys(expected[variant]) as Size[]).map((size) => [variant, size] as const),
);

/** Classes that name a look rather than behaviour Button keeps as utilities. */
const look = /^(bg|text|px|py|h|w|font|border|underline)-|^(hover|disabled):(bg|text|opacity|underline)/;

describe('Button classes', () => {
  it.each(pairs)('%s %s renders the wb-btn class and its look classes only', (variant, size) => {
    const classes = rendered({ variant, size });
    expect(classes).toContain('wb-btn');
    for (const name of expected[variant][size]) expect(classes).toContain(name);
    const lookClasses = classes.filter((name) => name.startsWith('wb-btn') || name.startsWith('is-'));
    expect(lookClasses.sort()).toEqual(['wb-btn', ...expected[variant][size]].sort());
    expect(classes.filter((name) => look.test(name))).toEqual([]);
  });

  it('adds is-block for a block button', () => {
    expect(rendered({ variant: 'quiet', block: true })).toContain('is-block');
    expect(rendered({ variant: 'quiet' })).not.toContain('is-block');
  });

  it('button.css defines every class buttonVariants emits', () => {
    const emitted = new Set(['wb-btn', 'is-block', ...Object.values(expected).flatMap((sizes) => Object.values(sizes).flat())]);
    for (const name of emitted) expect(readCss()).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
  });

  it('dims every disabled button to the same opacity', () => {
    const opacities = [...readCss().matchAll(/:disabled[^{]*\{[^}]*opacity:\s*([\d.]+)/g)].map((m) => m[1]);
    expect(opacities.length).toBeGreaterThan(0);
    expect(new Set(opacities)).toEqual(new Set(['0.5']));
  });

  it('starts with the layer-order statement, then the components and utilities layers', () => {
    const css = readCss();
    expect(css.startsWith('@layer theme, base, components, utilities, markdown;')).toBe(true);
    expect([...css.matchAll(/^@layer (\w+) \{/gm)].map((m) => m[1])).toEqual(['components', 'utilities']);
  });

  it('sets block width in the components layer, where a container rule can size any button to its label', () => {
    const css = readCss();
    const utilities = css.slice(css.indexOf('@layer utilities {'));
    const components = css.slice(css.indexOf('@layer components {'), css.indexOf('@layer utilities {'));
    expect(utilities).not.toContain('is-block');
    expect(components).toMatch(/:where\(\.wb-btn\)\.is-block \{\s*width: 100%;/);
  });

  it('lets the Inference screen size its danger buttons with its other buttons', () => {
    const inference = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../product/inference/inference.css'), 'utf8');
    expect(inference).toMatch(/\.wb-inf \.wb-btn-danger[,\s][^{]*\{[^}]*width: auto;[^}]*font-size: var\(--size-small\);/);
  });
});
