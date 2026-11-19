import React, { useCallback, useEffect, useState } from 'react';
import { useWhatsNew } from './state';
import { WhatsNewDialog, type CloseReason } from './WhatsNewDialog';
import { Button } from '../../components/ui/button';
import './whatsNew.css';

const TOAST_MS = 6_000;

const openers = new Set<(at: number) => void>();

/** Opens the slideshow at a slide, from the start-up card or anywhere else. */
export function openWhatsNew(at = 0): void {
  openers.forEach((open) => open(at));
}

/**
 * The slideshow over the whole app (ADR 0059). It lives above both the start-up screen and the
 * workbench, so one opened while the stack is still starting stays up when the app is ready.
 */
export const WhatsNewLayer: React.FC<{
  onOpenPage: (version: string) => void;
  onOpenGuide: (id: string) => void;
}> = ({ onOpenPage, onOpenGuide }) => {
  const state = useWhatsNew();
  const [at, setAt] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [toast, setToast] = useState(false);

  useEffect(() => {
    const open = (index: number) => {
      setDismissed(false);
      setAt(index);
    };
    openers.add(open);
    return () => void openers.delete(open);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const release = state?.current ?? null;
  const showing = at !== null || (!dismissed && Boolean(state?.pendingPopup));

  const close = useCallback(
    (reason: CloseReason) => {
      if (release) state?.markSeen(release.version);
      if (reason === 'opt-out') {
        state?.setPopups(false);
        setToast(true);
      }
      setAt(null);
      setDismissed(true);
    },
    [release, state]
  );

  return (
    <>
      {showing && release ? (
        <WhatsNewDialog
          release={release}
          missed={state?.missed ?? []}
          startAt={at ?? 0}
          onOpenPage={(version) => {
            close('done');
            onOpenPage(version);
          }}
          onOpenGuide={(id) => {
            close('done');
            onOpenGuide(id);
          }}
          onClose={close}
        />
      ) : null}
      {toast ? (
        <div className="wn-toast" role="status">
          <p>New releases won’t pop up anymore. They’re still under What’s new in the rail.</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              state?.setPopups(true);
              setToast(false);
            }}
          >
            Undo
          </Button>
        </div>
      ) : null}
    </>
  );
};
