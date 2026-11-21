import { useCallback, useEffect, useState } from 'react';
import type { InspectorTab } from './inspectorTabs';
import { useInspectorBeside, useInspectorOpenPref } from './inspectorOpenPref';

/** Popups that handle Escape themselves; Escape closes them before the overlay. */
const ESCAPE_OWNERS = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

export interface InspectorPanel {
  open: boolean;
  /** Below 1280px: drawn over the center pane, closed again in each conversation (ADR 0069 §5). */
  overlay: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the inspector, on `tab` when given. */
  openAt: (tab?: InspectorTab) => void;
  /** The toggle: closes, or opens on Project while it has a warning (§4). */
  toggle: () => void;
  tabRequest: { tab: InspectorTab; seq: number } | null;
}

/**
 * Whether the chat inspector is open (ADR 0069). From 1280px up that is the stored, app-wide
 * choice. Below it the inspector overlays the center pane and stays open only for the view
 * (`viewKey`) it was opened in, without changing the stored choice.
 */
export function useInspectorPanel({
  viewKey,
  available,
  warning,
}: {
  viewKey: string;
  /** False where the screen leaves the inspector out (the Tasks board). */
  available: boolean;
  /** The Project tab's worst banner, or null. */
  warning: string | null;
}): InspectorPanel {
  const [stored, setStored] = useInspectorOpenPref();
  const beside = useInspectorBeside();
  const [overlayFor, setOverlayFor] = useState<string | null>(null);
  const [tabRequest, setTabRequest] = useState<InspectorPanel['tabRequest']>(null);
  const open = available && (beside ? stored : overlayFor === viewKey);

  // A request is for the opening it came with; a later opening starts on the default tab.
  useEffect(() => {
    if (!open) setTabRequest(null);
  }, [open, viewKey]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (beside) setStored(next);
      else setOverlayFor(next ? viewKey : null);
    },
    [beside, setStored, viewKey]
  );

  const openAt = useCallback(
    (tab?: InspectorTab) => {
      if (tab) setTabRequest((previous) => ({ tab, seq: (previous?.seq ?? 0) + 1 }));
      setOpen(true);
    },
    [setOpen]
  );

  const toggle = useCallback(() => {
    if (open) setOpen(false);
    else openAt(warning ? 'project' : undefined);
  }, [open, setOpen, openAt, warning]);

  useEffect(() => {
    if (!open || beside) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(ESCAPE_OWNERS)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, beside, setOpen]);

  return { open, overlay: !beside, setOpen, openAt, toggle, tabRequest };
}
