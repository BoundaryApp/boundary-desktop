import React, { useEffect, useState } from 'react';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { APP_NAME } from '../../../shared/buildIdentity';

interface EmptyProjectSheetProps {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onCreate: (name: string) => void;
  onCancel: () => void;
}

/** 0005 secondary path: a project with no host folder yet. */
export const EmptyProjectSheet: React.FC<EmptyProjectSheetProps> = ({
  open,
  busy = false,
  error = null,
  onCreate,
  onCancel,
}) => {
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  if (!open) return null;

  const submit = () => {
    if (name.trim()) onCreate(name.trim());
  };

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      busy={busy}
      titleId="wb-empty-project-title"
      title="Create empty project"
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onCancel}
          confirmLabel={busy ? 'Creating…' : 'Create project'}
          confirmDisabled={!name.trim()}
          onConfirm={submit}
        />
      }
    >
      <p className="wb-sheet-lede">
        {APP_NAME} keeps its files in its own data folder. You can attach folders from this Mac
        later in the Project tab.
      </p>
      <label className="wb-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          disabled={busy}
          autoFocus
          placeholder="Trip planning"
        />
      </label>
    </Sheet>
  );
};
