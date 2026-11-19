import React, { createContext, useContext } from 'react';

/**
 * The document a piece of UI is drawn in. The app's page can render into a second window it
 * opened (ADR 0058), and UI there must listen, portal and read focus in that window's document,
 * not the page's. Outside a provider it is the page's own document.
 */
const OwnerDocumentContext = createContext<Document | null>(null);

export const OwnerDocumentProvider: React.FC<{ doc: Document; children: React.ReactNode }> = ({
  doc,
  children,
}) => <OwnerDocumentContext.Provider value={doc}>{children}</OwnerDocumentContext.Provider>;

export function useOwnerDocument(): Document {
  return useContext(OwnerDocumentContext) ?? document;
}

/** The owner document's window; the page's window outside a provider. */
export function useOwnerWindow(): Window {
  return useOwnerDocument().defaultView ?? window;
}

/**
 * Whether `value` is a DOM node from any window. A child window's elements belong to that
 * window's realm, so `instanceof Node` against the page's `Node` is false for them.
 */
export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
    typeof (value as { nodeName?: unknown }).nodeName === 'string'
  );
}

/** Whether `value` is an element from any window (see `isNode`). */
export function isElement(value: unknown): value is Element {
  return isNode(value) && value.nodeType === 1 && typeof (value as { closest?: unknown }).closest === 'function';
}

/**
 * Copies text through the clipboard of the window this is drawn in. Chromium refuses a write
 * from a window without focus, and the page's own window is hidden while the desktop panel is
 * in use. Resolves false when nothing was copied.
 */
export function useCopyText(): (text: string) => Promise<boolean> {
  const win = useOwnerWindow();
  return (text) =>
    Promise.resolve()
      .then(() => win.navigator.clipboard.writeText(text))
      .then(() => true)
      .catch(() => false);
}
