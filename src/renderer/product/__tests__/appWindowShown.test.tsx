import React from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { Window as HappyWindow } from 'happy-dom';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../__tests__/electronApiFake';
import { OwnerDocumentProvider } from '../../components/ui/ownerDocument';
import { onAppWindowShown, useAppWindowShown, usePaintsOnScreen } from '../appWindowShown';

let send: (shown: boolean) => void;
const child = new HappyWindow();

beforeEach(() => {
  installElectronAPI();
  stubElectronAPI({
    appWindow: {
      onShown: vi.fn((callback: (shown: boolean) => void): (() => void) => {
        send = callback;
        return () => undefined;
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.classList.remove('wb-window-hidden');
});

describe('whether Boundary’s window is showing (ADR 0058, Consequences)', () => {
  it('starts shown, follows main, and marks the page while hidden', () => {
    const { result } = renderHook(() => useAppWindowShown());
    expect(result.current).toBe(true);
    act(() => send(false));
    expect(result.current).toBe(false);
    expect(document.body.classList.contains('wb-window-hidden')).toBe(true);
    act(() => send(true));
    expect(result.current).toBe(true);
    expect(document.body.classList.contains('wb-window-hidden')).toBe(false);
  });

  it('tells a listener each change until it stops listening', () => {
    const heard = vi.fn();
    const stop = onAppWindowShown(heard);
    act(() => send(false));
    stop();
    act(() => send(true));
    expect(heard.mock.calls).toEqual([[false]]);
  });

  it('keeps work in the desktop windows going while the app window is hidden', () => {
    function Paints({ label }: { label: string }) {
      return <span aria-label={label}>{usePaintsOnScreen() ? 'paints' : 'paused'}</span>;
    }
    const doc = child.document as unknown as Document;
    render(
      <>
        <Paints label="page" />
        {createPortal(
          <OwnerDocumentProvider doc={doc}>
            <Paints label="panel" />
          </OwnerDocumentProvider>,
          doc.body
        )}
      </>
    );
    act(() => send(false));
    expect(screen.getByLabelText('page').textContent).toBe('paused');
    expect(doc.body.textContent).toBe('paints');
  });
});
