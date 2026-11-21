import React, { useRef, useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuNote,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../menu';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../menu.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const LOOK_CLASS = /^(h|w|size|bg|border|rounded|text|px|py|p)-/;

function RowMenu({
  onLeave = vi.fn(),
  onLevel = vi.fn(),
  onMute = vi.fn(),
}: {
  onLeave?: () => void;
  onLevel?: (level: string) => void;
  onMute?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <textarea aria-label="Composer" ref={composerRef} />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger>
          <button type="button">More</button>
        </MenuTrigger>
        <MenuContent aria-label="Circle">
          <MenuLabel>Circle</MenuLabel>
          <MenuItem onSelect={() => undefined}>Details</MenuItem>
          <MenuItem disabled onSelect={() => undefined}>
            Invite someone…
          </MenuItem>
          <MenuNote>Only admins can invite.</MenuNote>
          <MenuItem onSelect={() => composerRef.current?.focus()} hint="⌘Q">
            Quote
          </MenuItem>
          <MenuCheckboxItem checked={false} onCheckedChange={onMute}>
            Mute
          </MenuCheckboxItem>
          <MenuSub>
            <MenuSubTrigger>Notifications</MenuSubTrigger>
            <MenuSubContent aria-label="Notifications">
              <MenuRadioGroup value="all" onValueChange={onLevel}>
                <MenuRadioItem value="all">All messages</MenuRadioItem>
                <MenuRadioItem value="mentions">Mentions only</MenuRadioItem>
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
          <MenuSeparator />
          <MenuItem variant="danger" onSelect={onLeave}>
            Leave…
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'More' });
const item = (name: string) => screen.getByRole('menuitem', { name: (text) => text === name || text.startsWith(`${name} `) || text.startsWith(name + '⌘') });
const active = () => document.activeElement as HTMLElement;
/** Radix moves focus between items one tick after the key. */
const key = async (k: string) => {
  fireEvent.keyDown(active(), { key: k });
  await flushMenu();
};

describe('Menu', () => {
  it('opens from a pointer-down on its trigger', () => {
    render(<RowMenu />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    openMenu(trigger());
    expect(screen.getByRole('menu', { name: 'Circle' })).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('opens from Enter on its trigger and focuses the first item', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    expect(active()).toBe(item('Details'));
  });

  it('arrow keys skip disabled items and wrap', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    await key('ArrowDown');
    expect(active()).toBe(item('Quote'));
    await key('ArrowUp');
    await key('ArrowUp');
    expect(active()).toBe(item('Leave…'));
    await key('ArrowDown');
    expect(active()).toBe(item('Details'));
  });

  it('typeahead focuses the item that starts with the letter', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    await key('l');
    expect(active()).toBe(item('Leave…'));
  });

  it('Escape closes it and returns focus to the trigger', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    await key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(active()).toBe(trigger());
  });

  it('returns focus to the trigger on Escape after an earlier close by an outside press', async () => {
    render(<RowMenu />);
    openMenu(trigger());
    await flushMenu();
    const outside = screen.getByRole('textbox', { name: 'Composer' });
    fireEvent.pointerDown(outside);
    outside.focus();
    await flushMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(active()).toBe(outside);

    openMenu(trigger());
    await flushMenu();
    await key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(active()).toBe(trigger());
  });

  it('an item that moves focus keeps it after the menu closes', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    fireEvent.click(item('Quote'));
    await flushMenu();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(active()).toBe(screen.getByRole('textbox', { name: 'Composer' }));
  });

  it('selecting an item runs onSelect and closes the menu', () => {
    const onLeave = vi.fn();
    render(<RowMenu onLeave={onLeave} />);
    openMenu(trigger());
    fireEvent.click(item('Leave…'));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a disabled item says so and does nothing', () => {
    render(<RowMenu />);
    openMenu(trigger());
    expect(item('Invite someone…').getAttribute('aria-disabled')).toBe('true');
  });

  it('checkbox and radio items say whether they are checked and call their handlers', async () => {
    const onMute = vi.fn();
    const onLevel = vi.fn();
    render(<RowMenu onMute={onMute} onLevel={onLevel} />);
    openMenu(trigger());
    const mute = screen.getByRole('menuitemcheckbox', { name: 'Mute' });
    expect(mute.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(mute);
    expect(onMute).toHaveBeenCalledWith(true);

    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    item('Notifications').focus();
    await key('ArrowRight');
    const all = screen.getByRole('menuitemradio', { name: 'All messages' });
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Mentions only' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Mentions only' }));
    expect(onLevel).toHaveBeenCalledWith('mentions');
  });

  it('a submenu opens on ArrowRight and closes on ArrowLeft', async () => {
    render(<RowMenu />);
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    await flushMenu();
    item('Notifications').focus();
    await key('ArrowRight');
    expect(screen.getByRole('menu', { name: 'Notifications' })).toBeTruthy();
    expect(active().getAttribute('role')).toBe('menuitemradio');
    await key('ArrowLeft');
    expect(screen.queryByRole('menu', { name: 'Notifications' })).toBeNull();
    expect(active()).toBe(item('Notifications'));
  });

  it('renders its parts with data-slot and no look classes', () => {
    render(<RowMenu />);
    openMenu(trigger());
    const menu = screen.getByRole('menu', { name: 'Circle' });
    expect(menu.getAttribute('data-slot')).toBe('menu-content');
    expect(item('Leave…').getAttribute('data-variant')).toBe('danger');
    expect(item('Quote').querySelector("[data-slot='menu-item-hint']")?.textContent).toBe('⌘Q');
    for (const slot of ['menu-label', 'menu-note', 'menu-separator', 'menu-item-indicator']) {
      expect(menu.querySelector(`[data-slot='${slot}']`), slot).not.toBeNull();
    }
    for (const el of [menu, ...menu.querySelectorAll('*')]) {
      for (const name of el.classList) expect(name, el.outerHTML).not.toMatch(LOOK_CLASS);
    }
  });
});

describe('menu.css', () => {
  it('styles every slot and keeps raw values out', () => {
    for (const part of [
      "[data-slot='menu-content']",
      "[data-slot='menu-item']",
      "[data-slot='menu-item-indicator']",
      "[data-slot='menu-item-hint']",
      "[data-slot='menu-item-description']",
      "[data-slot='menu-label']",
      "[data-slot='menu-note']",
      "[data-slot='menu-separator']",
      "[data-slot='listbox']",
      "[data-slot='listbox-option']",
      "[data-slot='listbox-group-label']",
      '[data-highlighted]',
      '[data-active]',
      "[data-variant='danger']",
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
