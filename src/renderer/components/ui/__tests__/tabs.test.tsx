import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const LOOK_CLASS = /^(h|w|size|bg|border|rounded|text|px|py|p)-/;

function Three({
  value = 'a',
  onValueChange = vi.fn(),
  variant,
}: {
  value?: string;
  onValueChange?: (value: string) => void;
  variant?: 'default' | 'bar';
}) {
  return (
    <Tabs value={value} onValueChange={onValueChange}>
      <TabsList aria-label="Views" variant={variant}>
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b" disabled>
          Beta
        </TabsTrigger>
        <TabsTrigger value="c" count={4}>
          Gamma
        </TabsTrigger>
      </TabsList>
      <TabsContent value="a">
        <button type="button">Inside A</button>
      </TabsContent>
      <TabsContent value="c">Inside C</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('wires the tablist, tabs and panels to each other', () => {
    render(<Three />);
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeTruthy();
    const alpha = screen.getByRole('tab', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Gamma/ }).getAttribute('aria-selected')).toBe('false');
    const panel = screen.getByRole('tabpanel', { name: 'Alpha' });
    expect(alpha.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(alpha.id);
  });

  it('selects on click, and not again for the current tab', () => {
    const onValueChange = vi.fn();
    render(<Three onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('tab', { name: /Gamma/ }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('c');
    onValueChange.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('arrow keys select the next enabled tab and wrap; Home and End go to the ends', () => {
    function Live() {
      const [value, setValue] = React.useState('a');
      return <Three value={value} onValueChange={setValue} />;
    }
    vi.useFakeTimers();
    try {
      render(<Live />);
      const alpha = screen.getByRole('tab', { name: 'Alpha' });
      const gamma = screen.getByRole('tab', { name: /Gamma/ });
      // Radix's roving focus moves focus on a timer after the key.
      const press = (el: HTMLElement, key: string) => {
        fireEvent.keyDown(el, { key });
        act(() => vi.runAllTimers());
      };
      act(() => alpha.focus());
      press(alpha, 'ArrowRight');
      expect(document.activeElement).toBe(gamma);
      expect(gamma.getAttribute('aria-selected')).toBe('true');
      press(gamma, 'ArrowRight');
      expect(document.activeElement).toBe(alpha);
      expect(alpha.getAttribute('aria-selected')).toBe('true');
      press(alpha, 'End');
      expect(document.activeElement).toBe(gamma);
      press(gamma, 'Home');
      expect(document.activeElement).toBe(alpha);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one Tab stop, which lands on the current tab', () => {
    render(<Three value="c" />);
    // The list holds the Tab stop until a tab has had focus, and hands focus to the current tab.
    const list = screen.getByRole('tablist');
    expect(list.tabIndex).toBe(0);
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, -1, -1]);
    act(() => list.focus());
    const gamma = screen.getByRole('tab', { name: /Gamma/ });
    expect(document.activeElement).toBe(gamma);
    expect(screen.getAllByRole('tab').map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('hides an inactive panel and renders none of its children', () => {
    const { container } = render(<Three />);
    const panels = container.querySelectorAll('[data-slot="tabs-content"]');
    expect(panels).toHaveLength(2);
    expect((panels[1] as HTMLElement).hidden).toBe(true);
    expect(panels[1].textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Inside A' })).toBeTruthy();
  });

  it('a panel is not a Tab stop unless the caller makes it one', () => {
    const { rerender } = render(
      <Tabs value="a" onValueChange={vi.fn()}>
        <TabsContent value="a">A</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel').hasAttribute('tabindex')).toBe(false);
    rerender(
      <Tabs value="a" onValueChange={vi.fn()}>
        <TabsContent value="a" tabIndex={0}>
          A
        </TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tabpanel').getAttribute('tabindex')).toBe('0');
  });

  it('renders the count and the variant as slots', () => {
    const { container } = render(<Three variant="bar" />);
    expect(container.querySelector('[data-slot="tabs-count"]')?.textContent).toBe('4');
    expect(screen.getByRole('tablist').getAttribute('data-variant')).toBe('bar');
    expect(screen.getByRole('tab', { name: /Gamma/ }).textContent).toBe('Gamma4');
  });

  it('puts the root on its child with asChild', () => {
    const { container } = render(
      <Tabs value="a" onValueChange={vi.fn()} asChild>
        <section className="frame">
          <TabsList aria-label="Views">
            <TabsTrigger value="a">Alpha</TabsTrigger>
          </TabsList>
        </section>
      </Tabs>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.tagName).toBe('SECTION');
    expect(frame.dataset.slot).toBe('tabs');
    expect(frame.className).toBe('frame');
  });

  it('no class on any part is a look string', () => {
    const { container } = render(<Three />);
    for (const el of container.querySelectorAll('[data-slot^="tabs"]')) {
      for (const name of el.classList) expect(name, el.getAttribute('data-slot') ?? '').not.toMatch(LOOK_CLASS);
    }
  });

  it('tabs.css styles every slot and keeps raw values out', () => {
    for (const part of [
      "[data-slot='tabs-list']",
      "[data-slot='tabs-trigger']",
      "[data-slot='tabs-count']",
      "[data-slot='tabs-content']",
      "[data-variant='bar']",
      "[aria-selected='true']",
    ]) {
      expect(css, part).toContain(part);
    }
    const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => !match[1].trim().startsWith('@'))
      .map((match) => match[2].replace(/var\([^()]*\)/g, 'var()'))
      .join('\n');
    expect(bodies).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(bodies).not.toMatch(/rgba?\(/);
    expect(bodies.replace(/\b(1|2)px\b/g, '')).not.toMatch(/\d(\.\d+)?px\b/);
  });
});
