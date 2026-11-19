import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinkSafetyConfig, LinkSafetyModalProps } from 'streamdown';
import { Sheet } from '../../../components/ui/sheet';
import { useCopyText, useOwnerDocument } from '../../../components/ui/ownerDocument';
import { Button } from '../../../components/ui/button';

/** How long Copy URL reads "Copied" after a copy. */
const COPIED_MS = 2000;

/**
 * Asks before a link in a Circle message opens in the system browser, and offers the address
 * to copy instead. Drawn into the body of the document it is in: inside a message it would take the bubble's
 * colours, and a click on it would reach the message's own handlers.
 */
const LinkConfirmSheet: React.FC<LinkSafetyModalProps> = ({ isOpen, onClose, url }) => {
  const titleId = useId();
  const ownerDocument = useOwnerDocument();
  const copyText = useCopyText();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) return;
    setCopied(false);
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!isOpen) return null;

  const copy = async () => {
    if (await copyText(url)) {
      setError(null);
      setCopied(true);
    } else {
      setError('Couldn’t copy the link.');
    }
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.urls.openUrl(url);
      if (result.success === false) {
        setError(result.error ?? 'Couldn’t open the link.');
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    // Stops clicks here from reaching the message, which is this sheet's parent in React.
    <div onClick={(event) => event.stopPropagation()}>
      <Sheet
        open
        onClose={onClose}
        busy={busy}
        titleId={titleId}
        title="Open this link in your browser?"
        error={error}
        actions={
          <>
            <Button variant="secondary" block type="button" className="is-start" disabled={busy} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
            <Button variant="secondary" block type="button" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" block type="button" disabled={busy} onClick={() => void open()}>
              {busy ? 'Opening…' : 'Open in browser'}
            </Button>
          </>
        }
      >
        <p className="wb-sheet-lede">Someone in the Circle shared it. Check the address before you open it.</p>
        <p className="wb-link-confirm-url">{url}</p>
      </Sheet>
    </div>,
    ownerDocument.body
  );
};

/** Streamdown's `linkSafety` for Circle messages: every link asks first, in the sheet above. */
export const CIRCLE_LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkConfirmSheet {...props} />,
};
