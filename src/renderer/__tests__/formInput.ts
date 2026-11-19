import { fireEvent } from '@testing-library/react';

/**
 * Types into a textarea the way the browser does: through the native value setter, so React's
 * onChange sees the new value, then an input event.
 */
export function setValue(el: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
}
