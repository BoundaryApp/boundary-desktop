import React from 'react';
import { Sheet } from '../../../components/ui/sheet';

/** A Circle sheet that is one form: Cancel and a submit button, with the call's error. */
export const CircleFormSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  busy: boolean;
  titleId: string;
  title: string;
  error: string | null;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  children: React.ReactNode;
}> = ({ open, onClose, busy, titleId, title, error, submitLabel, canSubmit, onSubmit, children }) => (
  <Sheet
    open={open}
    onClose={onClose}
    busy={busy}
    titleId={titleId}
    title={title}
    error={error}
    as="form"
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
    actions={
      <>
        <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="wb-btn-solid" disabled={busy || !canSubmit}>
          {submitLabel}
        </button>
      </>
    }
  >
    {children}
  </Sheet>
);
