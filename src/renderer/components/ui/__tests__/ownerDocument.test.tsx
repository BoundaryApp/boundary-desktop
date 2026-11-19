import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, render } from '@testing-library/react';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnerDocumentProvider, isElement, isNode, useOwnerDocument, useOwnerWindow } from '../ownerDocument';
import { useDismiss, useEscapeToClose } from '../use-dismiss';
import { InfoTip } from '../info-tip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { isMacPlatform, useAppCommand, useShortcutKeys } from '../../../product/useAppShortcuts';
import type { AppCommand } from '../../../../shared/appCommands';

const childWindows: HappyWindow[] = [];

/**
 * A second document in its own window and realm, as a child window opened by the app's page
 * is (ADR 0058).
 */
function makeChildDocument(): Document {
  const child = new HappyWindow();
  childWindows.push(child);
  return child.document as unknown as Document;
}

/** Renders `children` into `doc`'s body under an owner-document provider, as the desktop host does. */
function InChild({ doc, children }: { doc: Document; children: React.ReactNode }) {
  return createPortal(<OwnerDocumentProvider doc={doc}>{children}</OwnerDocumentProvider>, doc.body);
}

afterEach(async () => {
  // Unmount first: the portals live in the child documents.
  cleanup();
  for (const child of childWindows.splice(0)) await child.happyDOM.close();
});

describe('owner document', () => {
  it('defaults to the page document and window', () => {
    let seen: { doc: Document; win: Window } | null = null;
    function Probe(): null {
      seen = { doc: useOwnerDocument(), win: useOwnerWindow() };
      return null;
    }
    render(<Probe />);
    expect(seen!.doc).toBe(document);
    expect(seen!.win).toBe(window);
  });

  it('gives the child document and its window inside a provider', () => {
    const child = makeChildDocument();
    let seen: { doc: Document; win: Window } | null = null;
    function Probe(): null {
      seen = { doc: useOwnerDocument(), win: useOwnerWindow() };
      return null;
    }
    render(
      <InChild doc={child}>
        <Probe />
      </InChild>
    );
    expect(seen!.doc).toBe(child);
    expect(seen!.win).toBe(child.defaultView);
  });
});

function Dismissable({ onDismiss }: { onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, true, onDismiss);
  return <div ref={ref}>popover</div>;
}

describe('isNode', () => {
  it('accepts a node from another realm, where instanceof Node fails', () => {
    // In Chromium a child window's elements come from its own realm's Node; happy-dom shares
    // classes across windows, so a foreign node is stood in for here.
    const foreign = { nodeType: 1, nodeName: 'DIV', contains: (): boolean => false };
    expect(foreign instanceof Node).toBe(false);
    expect(isNode(foreign)).toBe(true);
  });

  it('accepts a node from this realm', () => {
    expect(isNode(document.createElement('div'))).toBe(true);
  });

  it('rejects non-nodes', () => {
    expect(isNode(null)).toBe(false);
    expect(isNode(window)).toBe(false);
  });
});

describe('isElement', () => {
  it('accepts an element from another realm and rejects a text node', () => {
    const foreign = { nodeType: 1, nodeName: 'DIV', closest: (): null => null };
    expect(foreign instanceof Element).toBe(false);
    expect(isElement(foreign)).toBe(true);
    expect(isElement(document.createTextNode('hi'))).toBe(false);
    expect(isElement(null)).toBe(false);
  });
});

describe('useDismiss in a child document', () => {
  it('closes on a pointerdown in the owner document', () => {
    const child = makeChildDocument();
    const onDismiss = vi.fn();
    render(
      <InChild doc={child}>
        <Dismissable onDismiss={onDismiss} />
      </InChild>
    );
    child.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores the main document', () => {
    const child = makeChildDocument();
    const onDismiss = vi.fn();
    render(
      <InChild doc={child}>
        <Dismissable onDismiss={onDismiss} />
      </InChild>
    );
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('closes on Escape pressed in the owner document', () => {
    const child = makeChildDocument();
    const onDismiss = vi.fn();
    render(
      <InChild doc={child}>
        <Dismissable onDismiss={onDismiss} />
      </InChild>
    );
    child.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('useEscapeToClose in a child document', () => {
  function Closer({ onClose }: { onClose: () => void }): null {
    useEscapeToClose(onClose);
    return null;
  }

  it('listens on the owner window', () => {
    const child = makeChildDocument();
    const onClose = vi.fn();
    render(
      <InChild doc={child}>
        <Closer onClose={onClose} />
      </InChild>
    );
    child.defaultView!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not hear Escape in the main window', () => {
    const child = makeChildDocument();
    const onClose = vi.fn();
    render(
      <InChild doc={child}>
        <Closer onClose={onClose} />
      </InChild>
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('portals in a child document', () => {
  it('opens an info tip in the owner body', async () => {
    const child = makeChildDocument();
    render(
      <InChild doc={child}>
        <InfoTip label="Privacy">Only you see this.</InfoTip>
      </InChild>
    );
    const trigger = child.querySelector<HTMLButtonElement>('button[aria-label="About Privacy"]')!;
    await act(async () => {
      trigger.click();
    });
    const tip = child.querySelector('[role="note"]');
    expect(tip).not.toBeNull();
    expect(document.querySelector('[role="note"]')).toBeNull();
  });

  it('opens a select list in the owner body', async () => {
    const child = makeChildDocument();
    function Picker() {
      const [value, setValue] = useState('a');
      return (
        <Select value={value} onValueChange={setValue} open>
          <SelectTrigger aria-label="Chat">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">First chat</SelectItem>
            <SelectItem value="b">Second chat</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    await act(async () => {
      render(
        <InChild doc={child}>
          <Picker />
        </InChild>
      );
    });
    expect(child.querySelector('[data-slot="select-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="select-content"]')).toBeNull();
  });
});

describe('shortcut keys in a child document', () => {
  function Keys({ onCommand }: { onCommand: (command: AppCommand) => void }): null {
    useShortcutKeys();
    useAppCommand(onCommand);
    return null;
  }

  it('turns a shortcut pressed in the owner window into an app command', () => {
    const child = makeChildDocument();
    const onCommand = vi.fn();
    render(
      <InChild doc={child}>
        <Keys onCommand={onCommand} />
      </InChild>
    );
    child.defaultView!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: isMacPlatform(), ctrlKey: !isMacPlatform() }));
    expect(onCommand).toHaveBeenCalledWith('toggle-agent');
  });
});
