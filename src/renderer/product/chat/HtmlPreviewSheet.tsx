import React, { useEffect, useState } from 'react';
import { Sheet } from '../../components/ui/sheet';
import { previewSrcdoc } from '../../../shared/htmlPreview';
import { Button } from '../../components/ui/button';

interface HtmlPreviewSheetProps {
  /** Path inside the container; the sheet is closed while this is null. */
  containerPath: string | null;
  onClose: () => void;
  /** Shows a Reveal button beside the title. */
  reveal?: () => void;
}

type Loaded = { path: string; html: string | null; name: string; error: string | null };

/** An HTML page an agent wrote, in a sandboxed frame: scripts run, nothing else is reachable. */
export const HtmlPreviewSheet: React.FC<HtmlPreviewSheetProps> = ({
  containerPath,
  onClose,
  reveal,
}) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!containerPath) {
      // Closed: reopening the same page shows Loading… instead of the earlier copy.
      setLoaded(null);
      return;
    }
    // A result for an earlier path must not replace the current one.
    let cancelled = false;
    void window.electronAPI.hermesChat.readHtmlPreview({ containerPath }).then((result) => {
      if (cancelled) return;
      setLoaded({
        path: containerPath,
        html: result.success ? (result.html ?? '') : null,
        name: result.name ?? '',
        error: result.success ? null : (result.error ?? 'That page couldn’t be opened.'),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [containerPath]);

  if (!containerPath) return null;

  const current = loaded?.path === containerPath ? loaded : null;
  const name = current?.name || containerPath.split('/').pop() || containerPath;

  return (
    <Sheet
      open
      onClose={onClose}
      titleId="wb-html-preview-title"
      title={name}
      titleAside={
        reveal ? (
          <Button variant="secondary" size="sm" type="button" onClick={reveal}>
            Reveal
          </Button>
        ) : undefined
      }
      error={current?.error}
      className="wb-preview-sheet"
      actions={
        <Button variant="secondary" block type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      {current?.html != null ? (
        <iframe
          className="wb-preview-frame"
          title={name}
          sandbox="allow-scripts"
          srcDoc={previewSrcdoc(current.html)}
        />
      ) : current ? null : (
        <p className="wb-sheet-lede">Loading…</p>
      )}
    </Sheet>
  );
};
