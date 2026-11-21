import { act, fireEvent } from '@testing-library/react';

/**
 * Opens a Menu from its trigger the way a mouse does. Radix opens a DropdownMenu on a primary
 * pointer-down, not on click, so `fireEvent.click` on a MenuTrigger does nothing.
 */
export function openMenu(trigger: Element): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' });
}

/** Radix moves focus (on open, typeahead and close) one timer tick later. */
export const flushMenu = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
