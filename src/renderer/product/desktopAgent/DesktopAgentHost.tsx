import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DESKTOP_BUTTON_WINDOW, DESKTOP_PANEL_WINDOW } from '../../../shared/types/desktopAgent';
import { OwnerDocumentProvider } from '../../components/ui/ownerDocument';
import { adoptStyles, openChildWindow } from './childDocument';
import { useAppCommand, useShortcutKeys } from '../useAppShortcuts';
import { setDesktopPanelOpen, toggleDesktopPanel, useDesktopPanelOpen } from './desktopPanel';
import { useDesktopAgentSwitch } from './useDesktopAgentSwitch';

/**
 * Opens `name` while `wanted`, takes the page's styles into it, and closes it when no longer
 * wanted or on unmount. `onGone` hears the window go by itself (closed by the OS or main).
 */
function useChildWindow(name: string, wanted: boolean, onGone: () => void): Document | null {
  const [doc, setDoc] = useState<Document | null>(null);
  // Read when the window goes, so a new callback each render doesn't reopen the window.
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  // Bumped when the window goes by itself, so a still-wanted window opens again.
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!wanted) return undefined;
    const child = openChildWindow(name);
    if (!child) return undefined;
    const target = child.document;
    target.title = name;
    const stopStyles = adoptStyles(target);
    let closing = false;
    const gone = (): void => {
      if (closing) return;
      setDoc(null);
      onGoneRef.current();
      setRound((was) => was + 1);
    };
    child.addEventListener('pagehide', gone);
    setDoc(target);
    return () => {
      closing = true;
      child.removeEventListener('pagehide', gone);
      stopStyles();
      setDoc(null);
      child.close();
    };
  }, [name, wanted, round]);
  return doc;
}

const noop = (): void => undefined;
const closePanel = (): void => setDesktopPanelOpen(false);

/** In the panel's window, ⌘J closes it; the app's other shortcuts belong to Boundary's window. */
const PANEL_KEYS = ['toggle-agent'] as const;
function PanelKeys(): null {
  useShortcutKeys(PANEL_KEYS);
  return null;
}

/**
 * The desktop button and panel (ADR 0058): with the switch on, the page opens their windows and
 * draws `button` and `panel` into them. They render under the shell's providers, so they read the
 * same chat runtimes, Circle stores and drafts as the app window.
 */
export const DesktopAgentHost: React.FC<{ button: React.ReactNode; panel: React.ReactNode }> = ({ button, panel }) => {
  const { available, on } = useDesktopAgentSwitch();
  const active = available && on;
  const panelOpen = useDesktopPanelOpen();
  const buttonDoc = useChildWindow(DESKTOP_BUTTON_WINDOW, active, noop);
  const panelDoc = useChildWindow(DESKTOP_PANEL_WINDOW, active && panelOpen, closePanel);

  useEffect(() => {
    if (!active) setDesktopPanelOpen(false);
  }, [active]);

  // ⌘J opens and closes the panel from any screen, Chat included (§11).
  useAppCommand((command) => {
    if (command === 'toggle-agent' && active) toggleDesktopPanel();
  });

  return (
    <>
      {buttonDoc
        ? createPortal(<OwnerDocumentProvider doc={buttonDoc}>{button}</OwnerDocumentProvider>, buttonDoc.body)
        : null}
      {panelDoc
        ? createPortal(
            <OwnerDocumentProvider doc={panelDoc}>
              <PanelKeys />
              {panel}
            </OwnerDocumentProvider>,
            panelDoc.body
          )
        : null}
    </>
  );
};
