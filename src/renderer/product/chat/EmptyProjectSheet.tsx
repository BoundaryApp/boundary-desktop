import React, { useEffect, useState } from 'react';
import { Sheet } from '../../components/ui/sheet';

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
      kicker="New project · no folder yet"
      title="Create empty project"
      error={error}
      actions={
        <>
          <button
            type="button"
            className="wb-btn-solid"
            disabled={busy || !name.trim()}
            onClick={submit}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p className="wb-sheet-lede">
        Boundary keeps its files in its own data folder. You can attach folders from this Mac
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
