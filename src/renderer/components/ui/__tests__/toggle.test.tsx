import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Chip } from '../chip';
import { ChipGroup } from '../chip-group';
import { Segmented } from '../segmented';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../toggle.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const LOOK_CLASS = /^(h|w|size|bg|border|rounded|text|px|py|p)-/;
const abc = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B', disabled: true },
  { value: 'c', label: 'C' },
];

describe('Segmented', () => {
  it('keeps one Tab stop on the selected segment', () => {
    render(
      <Segmented
        aria-label="Pick"
        value="b"
        onChange={vi.fn()}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ]}
      />,
    );
    expect(screen.getAllByRole('radio').map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('arrow keys skip disabled segments and wrap', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Segmented aria-label="Pick" value="a" onChange={onChange} options={abc} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'C' }));
    rerender(<Segmented aria-label="Pick" value="c" onChange={onChange} options={abc} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'C' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    rerender(<Segmented aria-label="Pick" value="a" onChange={onChange} options={abc} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'A' }), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    rerender(<Segmented aria-label="Pick" value="c" onChange={onChange} options={abc} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'C' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    const calls = onChange.mock.calls.length;
    fireEvent.keyDown(screen.getByRole('radio', { name: 'C' }), { key: 'End' });
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'C' }));
  });

  it('puts the Tab stop on the first enabled segment when the value is disabled', () => {
    render(<Segmented aria-label="Pick" value="b" onChange={vi.fn()} options={abc} />);
    expect(screen.getAllByRole('radio').map((el) => el.tabIndex)).toEqual([0, -1, -1]);
  });

  it('does not select a disabled segment on click', () => {
    const onChange = vi.fn();
    render(<Segmented aria-label="Pick" value="a" onChange={onChange} options={abc} />);
    fireEvent.click(screen.getByRole('radio', { name: 'B' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('can be named by aria-labelledby', () => {
    render(
      <>
        <span id="cap">Signs in with</span>
        <Segmented aria-labelledby="cap" value="a" onChange={vi.fn()} options={abc} />
      </>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Signs in with' })).toBeTruthy();
  });

  it('renders data-size and data-block', () => {
    render(<Segmented aria-label="Pick" size="sm" block value="a" onChange={vi.fn()} options={abc} />);
    const group = screen.getByRole('radiogroup');
    expect(group.dataset.slot).toBe('segmented');
    expect(group.dataset.size).toBe('sm');
    expect(group.hasAttribute('data-block')).toBe(true);
    expect(screen.getAllByRole('radio')[0].dataset.slot).toBe('segmented-item');
  });
});

describe('Chip', () => {
  it('in a single ChipGroup is a radio', () => {
    const onValueChange = vi.fn();
    render(
      <ChipGroup type="single" value="x" onValueChange={onValueChange} aria-label="Kind">
        <Chip value="x">X</Chip>
        <Chip value="y">Y</Chip>
      </ChipGroup>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Kind' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenCalledWith('y');
  });

  it('single group puts the Tab stop on the first enabled chip and skips disabled ones', () => {
    const onValueChange = vi.fn();
    render(
      <ChipGroup type="single" value="none" onValueChange={onValueChange} aria-label="Kind">
        <Chip value="x" disabled>
          X
        </Chip>
        <Chip value="y">Y</Chip>
        <Chip value="z">Z</Chip>
      </ChipGroup>,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(radios[2], { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenLastCalledWith('y');
    fireEvent.keyDown(radios[1], { key: 'ArrowLeft' });
    expect(onValueChange).toHaveBeenLastCalledWith('z');
  });

  it('on its own is a toggle button', () => {
    const onPressedChange = vi.fn();
    const { rerender } = render(
      <Chip pressed={false} onPressedChange={onPressedChange}>
        Unseen
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Unseen' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(onPressedChange).toHaveBeenCalledWith(true);
    rerender(
      <ChipGroup type="multiple" aria-label="Filters">
        <Chip pressed>Unseen</Chip>
      </ChipGroup>,
    );
    expect(screen.getByRole('group', { name: 'Filters' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unseen' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('throws when used the wrong way', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <ChipGroup type="single" value="x" onValueChange={vi.fn()} aria-label="Kind">
          <Chip>X</Chip>
        </ChipGroup>,
      ),
    ).toThrow();
    expect(() => render(<Chip>Alone</Chip>)).toThrow();
    error.mockRestore();
  });
});

describe('toggle look', () => {
  it('puts no look string in a class on a Segmented, Chip or ChipGroup', () => {
    const { container } = render(
      <>
        <Segmented aria-label="S" size="sm" block value="a" onChange={vi.fn()} options={abc} />
        <ChipGroup type="single" value="x" onValueChange={vi.fn()} aria-label="Kind">
          <Chip value="x" icon={<svg />}>
            X
          </Chip>
        </ChipGroup>
        <ChipGroup type="multiple" aria-label="Filters">
          <Chip pressed>Y</Chip>
        </ChipGroup>
      </>,
    );
    const classes = [...container.querySelectorAll('[data-slot]')].flatMap((el) => [...el.classList]);
    expect(classes.filter((name) => LOOK_CLASS.test(name))).toEqual([]);
  });

  it('passes a caller class through', () => {
    render(<Segmented aria-label="S" className="mb-3" value="a" onChange={vi.fn()} options={abc} />);
    expect(screen.getByRole('radiogroup').classList.contains('mb-3')).toBe(true);
  });

  it('toggle.css styles every slot and keeps raw values out', () => {
    for (const part of [
      "[data-slot='segmented']",
      "[data-slot='segmented-item']",
      "[data-slot='chip']",
      "[data-slot='chip-group']",
      "[data-size='sm']",
      '[data-block]',
      "[aria-checked='true']",
      "[aria-pressed='true']",
    ]) {
      expect(css, part).toContain(part);
    }
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => !match[1].trim().startsWith('@'))
      .map((match) => match[2].replace(/var\([^()]*\)/g, 'var()'))
      .join('\n');
    expect(bodies).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(bodies).not.toMatch(/rgba?\(/);
    expect(bodies.replace(/\b(1|14)px\b/g, '')).not.toMatch(/\d(\.\d+)?px\b/);
  });
});
