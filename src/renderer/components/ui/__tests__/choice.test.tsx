import React, { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from '../checkbox';
import { ChoiceGroup } from '../choice-group';
import { ChoiceRow } from '../choice-row';
import { Radio } from '../radio';
import { Switch } from '../switch';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../choice.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Each rule in choice.css as [selector, body]. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => [match[1].trim(), match[2]] as const)
  .filter(([selector]) => !selector.startsWith('@'));

const LOOK_CLASS = /^(h|w|size|bg|border|rounded|accent|text)-/;

describe('Checkbox and Radio', () => {
  it.each([
    ['checkbox', Checkbox],
    ['radio', Radio],
  ] as const)('%s renders a native input with its slot and passes props through', (type, Control) => {
    const onChange = vi.fn((event: React.ChangeEvent<HTMLInputElement>) => event.target.checked);
    const ref = createRef<HTMLInputElement>();
    const { rerender } = render(
      <Control name="n" ref={ref} onChange={onChange} aria-invalid data-testid="box" className="mt-1" />,
    );
    const input = screen.getByTestId('box') as HTMLInputElement;
    expect(input.type).toBe(type);
    expect(input.dataset.slot).toBe(type);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(ref.current).toBe(input);
    expect([...input.classList].filter((name) => LOOK_CLASS.test(name))).toEqual([]);
    fireEvent.click(input);
    expect(onChange).toHaveReturnedWith(true);

    rerender(<Control name="n" disabled data-testid="box" />);
    expect((screen.getByTestId('box') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Switch', () => {
  it('merges className instead of replacing the look', () => {
    render(<Switch checked label="Mute" className="ml-auto" onChange={vi.fn()} />);
    const control = screen.getByRole('switch', { name: 'Mute' });
    expect(control.classList.contains('ml-auto')).toBe(true);
    expect(control.dataset.slot).toBe('switch');
    expect(control.classList.contains('wb-switch')).toBe(false);
    expect(control.classList.contains('is-on')).toBe(false);
  });

  it('can be named by a label element through id', () => {
    render(
      <>
        <label htmlFor="s">Camera</label>
        <Switch id="s" checked={false} onChange={vi.fn()} />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'Camera' })).toBeTruthy();
  });
});

describe('ChoiceRow', () => {
  it('toggles its control when the title is clicked', () => {
    const onBox = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <ChoiceRow control={<Checkbox onChange={(event) => onBox(event.target.checked)} />} title="Use git" />
        <ChoiceRow
          controlAt="end"
          variant="card"
          control={<Switch checked={false} onChange={onSwitch} />}
          title="Coding"
          description="Lets the agent edit files."
        />
      </>,
    );
    fireEvent.click(screen.getByText('Use git'));
    expect(onBox).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText('Coding'));
    expect(onSwitch).toHaveBeenCalledWith(true);
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('draws an aside after the text', () => {
    const { container } = render(
      <ChoiceRow variant="card" control={<Radio name="n" />} title="Code" aside={<span>Coding</span>} />,
    );
    const aside = container.querySelector("[data-slot='choice-row-aside']")!;
    expect(aside.textContent).toBe('Coding');
    expect(aside.previousElementSibling?.getAttribute('data-slot')).toBe('choice-row-text');
  });

  it('marks its variant and where the control sits', () => {
    const { container } = render(
      <ChoiceRow variant="card" controlAt="end" control={<Switch checked onChange={vi.fn()} />} title="Coding" />,
    );
    const row = container.querySelector('label')!;
    expect(row.dataset.slot).toBe('choice-row');
    expect(row.dataset.variant).toBe('card');
    expect(row.dataset.controlAt).toBe('end');
    expect(row.firstElementChild?.getAttribute('data-slot')).toBe('choice-row-control');
  });

  it('toggles its own control, not a select in its description', () => {
    const onSwitch = vi.fn();
    render(
      <ChoiceRow
        controlAt="end"
        control={<Switch checked={false} label="Prefer one provider" onChange={onSwitch} />}
        title="Prefer one provider"
        description={
          <>
            <span>Moves only if cheaper by more than:</span>
            <select aria-label="Threshold">
              <option>10%</option>
            </select>
          </>
        }
      />,
    );
    fireEvent.click(screen.getByText('Prefer one provider'));
    expect(onSwitch).toHaveBeenCalledWith(true);
  });
});

describe('ChoiceGroup', () => {
  it('is a radiogroup named by its caption', () => {
    render(
      <ChoiceGroup label="Server" kind="radio" hint="Pick the one you signed up on.">
        <ChoiceRow control={<Radio name="server" />} title="US" />
        <ChoiceRow control={<Radio name="server" />} title="EU" />
      </ChoiceGroup>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Server' });
    expect(group.classList.contains('wb-field')).toBe(true);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByText('Pick the one you signed up on.').className).toBe('wb-field-hint');
  });

  it('can be named by aria-label with no caption', () => {
    const { container } = render(
      <ChoiceGroup aria-label="Access" kind="radio">
        <ChoiceRow control={<Radio name="access" />} title="Read" />
      </ChoiceGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Access' })).toBeTruthy();
    expect(container.querySelector('.wb-field-label')).toBeNull();
  });

  it('is a group for checkboxes', () => {
    render(
      <ChoiceGroup label="Mailboxes" kind="checkbox">
        <ChoiceRow control={<Checkbox />} title="Inbox" />
      </ChoiceGroup>,
    );
    expect(screen.getByRole('group', { name: 'Mailboxes' })).toBeTruthy();
  });
});

describe('choice.css', () => {
  it('styles every slot and keeps raw values out', () => {
    for (const slot of [
      'checkbox',
      'radio',
      'switch',
      'switch-thumb',
      'choice-row',
      'choice-row-control',
      'choice-row-text',
      'choice-row-title',
      'choice-row-description',
      'choice-row-aside',
      'choice-group',
    ]) {
      expect(css, slot).toContain(`[data-slot='${slot}']`);
    }
    expect(css).toContain("[data-variant='card']");
    expect(css).toContain("[aria-invalid='true']");
    const values = rules.map(([, body]) => body.replace(/var\([^()]*\)/g, 'var()')).join('\n');
    expect(values).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(values).not.toMatch(/rgba?\(/);
    // Hairline borders are 1px, as on every card in the app; any other length is a token.
    expect(values.replace(/\b1px solid\b/g, '')).not.toMatch(/\d(\.\d+)?px\b/);
  });

  it('takes its accent only from --brand', () => {
    const allowed = new Set(['--brand', '--surface-0', '--on-glyph', '--line', '--line-strong', '--danger']);
    const stateful = rules.filter(([selector]) => /:checked|aria-checked='true'|:focus-visible|aria-invalid/.test(selector));
    expect(stateful.length).toBeGreaterThan(4);
    for (const [selector, body] of stateful) {
      expect(body, selector).not.toContain('accent-color');
      const colors = [...body.matchAll(/var\((--[a-z0-9-]+)\)/g)]
        .map((match) => match[1])
        .filter((token) => !/^--(choice|switch|space|radius|dur|ease|focus-ring)/.test(token));
      expect(colors.filter((token) => !allowed.has(token)), selector).toEqual([]);
    }
  });
});
