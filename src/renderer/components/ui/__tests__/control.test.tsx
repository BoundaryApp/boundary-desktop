import React, { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '../input';
import { NativeSelect } from '../native-select';
import { Textarea } from '../textarea';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../control.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const LOOK_CLASS = /^(h|px|py|bg|border|rounded|text)-/;

describe('Input and NativeSelect', () => {
  it.each([
    ['input', Input],
    ['native-select', NativeSelect],
  ] as const)('%s renders its slot, size and focus look, and no look classes', (slot, Control) => {
    for (const size of ['default', 'sm'] as const) {
      const { unmount } = render(<Control size={size} data-testid="control" className="flex-1" />);
      const control = screen.getByTestId('control');
      expect(control.dataset.slot).toBe(slot);
      expect(control.dataset.size).toBe(size);
      expect(control.classList.contains('field-focus')).toBe(true);
      expect(control.classList.contains('flex-1')).toBe(true);
      expect([...control.classList].filter((name) => LOOK_CLASS.test(name))).toEqual([]);
      unmount();
    }
  });

  it('defaults to the default size', () => {
    render(<Input data-testid="control" />);
    expect(screen.getByTestId('control').dataset.size).toBe('default');
  });
});

describe('Textarea', () => {
  it('renders data-variant="field" by default, with the focus look', () => {
    render(<Textarea data-testid="area" />);
    const area = screen.getByTestId('area');
    expect(area.dataset.slot).toBe('textarea');
    expect(area.dataset.variant).toBe('field');
    expect(area.classList.contains('field-focus')).toBe(true);
  });

  it('bare renders data-variant="bare" without a focus look', () => {
    render(<Textarea variant="bare" data-testid="area" className="wb-circle-composer-input" />);
    const area = screen.getByTestId('area');
    expect(area.dataset.variant).toBe('bare');
    expect(area.classList.contains('field-focus')).toBe(false);
    expect(area.classList.contains('wb-circle-composer-input')).toBe(true);
  });
});

describe('props pass through', () => {
  it('Input passes aria-invalid, disabled, ref and onChange through', () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<Input ref={ref} aria-invalid disabled={false} onChange={onChange} data-testid="c" />);
    const control = screen.getByTestId('c') as HTMLInputElement;
    expect(ref.current).toBe(control);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(control, { target: { value: 'a' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Textarea passes aria-invalid, disabled, ref and onChange through', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    render(<Textarea ref={ref} aria-invalid disabled onChange={onChange} data-testid="c" />);
    const control = screen.getByTestId('c') as HTMLTextAreaElement;
    expect(ref.current).toBe(control);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.disabled).toBe(true);
    fireEvent.change(control, { target: { value: 'a' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('NativeSelect passes aria-invalid, disabled, ref and onChange through', () => {
    const ref = createRef<HTMLSelectElement>();
    const onChange = vi.fn();
    render(
      <NativeSelect ref={ref} aria-invalid disabled onChange={onChange} data-testid="c" defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </NativeSelect>,
    );
    const control = screen.getByTestId('c') as HTMLSelectElement;
    expect(ref.current).toBe(control);
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.disabled).toBe(true);
    fireEvent.change(control, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('control.css', () => {
  it('styles every slot and size, and puts the invalid rule in the utilities layer', () => {
    for (const slot of ['input', 'textarea', 'native-select', 'select-trigger']) {
      expect(css, slot).toContain(`[data-slot='${slot}']`);
    }
    expect(css).toContain("[data-size='sm']");
    const utilities = css.slice(css.indexOf('@layer utilities {'));
    expect(css.indexOf('@layer utilities {')).toBeGreaterThan(0);
    expect(utilities).toContain("[aria-invalid='true']");
    expect(css.slice(0, css.indexOf('@layer utilities {'))).not.toContain('aria-invalid');
  });

  it('takes its values from tokens', () => {
    const declarations = [...css.matchAll(/[\w-]+:\s*([^;{}]+);/g)].map((match) => match[1]);
    // Hairline borders are 1px, as on every field and card in the app; any other length is a token.
    const raw = declarations.filter((value) =>
      /#[0-9a-f]{3,8}\b|rgb\(|\b\d+(\.\d+)?px\b/i.test(value.replace(/var\([^)]*\)/g, '').replace(/\b1px solid\b/g, '')),
    );
    expect(raw).toEqual([]);
  });
});
