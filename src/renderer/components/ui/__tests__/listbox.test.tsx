import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Listbox, ListboxGroup, ListboxOption } from '../listbox';
import { useListNavigation } from '../use-list-navigation';

const NAMES = ['Ada', 'Grace', 'Linus'];

/** A text field driving a popup list, as the composer drives @ mentions. */
function Mentions({ onPick = vi.fn(), disabled = [] as number[] }: { onPick?: (name: string) => void; disabled?: number[] }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  const nav = useListNavigation({
    id: 'mentions',
    open,
    count: NAMES.length,
    active: index,
    onActiveChange: setIndex,
    onPick: (i) => onPick(NAMES[i]),
    onClose: () => setOpen(false),
    isDisabled: (i) => disabled.includes(i),
  });
  return (
    <div>
      <input aria-label="Message" {...nav.fieldProps} />
      {open ? (
        <Listbox id="mentions" aria-label="Mention">
          <ListboxGroup label="People">
            {NAMES.map((name, i) => (
              <ListboxOption
                key={name}
                id={nav.optionId(i)}
                active={i === index}
                selected={i === index}
                disabled={disabled.includes(i)}
                onPick={() => onPick(name)}
              >
                {name}
              </ListboxOption>
            ))}
          </ListboxGroup>
        </Listbox>
      ) : null}
    </div>
  );
}

/** A focusable list that selects on arrows, as a sheet's destination list does. */
function Destinations({ onChange = vi.fn() }: { onChange?: (i: number) => void }) {
  const [value, setValue] = useState(1);
  const nav = useListNavigation({
    id: 'dest',
    open: true,
    count: NAMES.length,
    active: value,
    onActiveChange: (i) => {
      setValue(i);
      onChange(i);
    },
  });
  return (
    <Listbox id="dest" aria-label="Destination" marks {...nav.listProps}>
      {NAMES.map((name, i) => (
        <ListboxOption key={name} id={nav.optionId(i)} active={i === value} selected={i === value} onPick={() => setValue(i)}>
          {name}
        </ListboxOption>
      ))}
    </Listbox>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Message' });
const option = (name: string) => screen.getByRole('option', { name });

describe('useListNavigation with a field', () => {
  it('wires the field to the list as a combobox', () => {
    render(<Mentions />);
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(field().getAttribute('aria-controls')).toBe('mentions');
    expect(field().getAttribute('aria-autocomplete')).toBe('list');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Ada').id);
  });

  it('arrows move the active option and wrap', () => {
    render(<Mentions />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Grace').id);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Linus').id);
    expect(option('Linus').getAttribute('data-active')).not.toBeNull();
  });

  it('arrows skip disabled options', () => {
    render(<Mentions disabled={[1]} />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Linus').id);
  });

  it('leaves Home and End to the text field', () => {
    render(<Mentions />);
    const event = fireEvent.keyDown(field(), { key: 'End' });
    expect(event).toBe(true);
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Ada').id);
  });

  it('Enter picks the active option', () => {
    const onPick = vi.fn();
    render(<Mentions onPick={onPick} />);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('Grace');
  });

  it('Escape closes the list and is consumed', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => outer(event.defaultPrevented)}>
        <Mentions />
      </div>,
    );
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field().getAttribute('aria-expanded')).toBe('false');
    expect(field().getAttribute('aria-activedescendant')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it('a mouse pick leaves focus in the field', () => {
    const onPick = vi.fn();
    render(<Mentions onPick={onPick} />);
    field().focus();
    const down = fireEvent.mouseDown(option('Linus'));
    expect(down).toBe(false);
    fireEvent.click(option('Linus'));
    expect(onPick).toHaveBeenCalledWith('Linus');
    expect(document.activeElement).toBe(field());
  });

  it('a disabled option says so and is not picked', () => {
    const onPick = vi.fn();
    render(<Mentions onPick={onPick} disabled={[2]} />);
    expect(option('Linus').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option('Linus'));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a group is named by its heading', () => {
    render(<Mentions />);
    expect(screen.getByRole('group', { name: 'People' })).toBeTruthy();
  });
});

describe('useListNavigation on a focusable list', () => {
  it('is one Tab stop and selects on arrows, Home and End', () => {
    const onChange = vi.fn();
    render(<Destinations onChange={onChange} />);
    const list = screen.getByRole('listbox', { name: 'Destination' });
    expect(list.tabIndex).toBe(0);
    expect(list.getAttribute('aria-activedescendant')).toBe(option('Grace').id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(list, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    expect(option('Linus').getAttribute('aria-selected')).toBe('true');
  });

  it('draws a check column when marks is set', () => {
    render(<Destinations />);
    const list = screen.getByRole('listbox', { name: 'Destination' });
    expect(list.hasAttribute('data-marks')).toBe(true);
    expect(option('Grace').querySelector("[data-slot='listbox-option-indicator']")).not.toBeNull();
  });
});
