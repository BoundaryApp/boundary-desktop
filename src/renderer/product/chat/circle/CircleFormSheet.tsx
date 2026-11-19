import React from 'react';
import { Sheet } from '../../../components/ui/sheet';
import { Button } from '../../../components/ui/button';

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
        <Button variant="secondary" block type="button" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" block type="submit" disabled={busy || !canSubmit}>
          {submitLabel}
        </Button>
      </>
    }
  >
    {children}
  </Sheet>
);
