import React, { useEffect, useState } from 'react';
import { useEscapeToClose } from '../useAppShortcuts';

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
  useEscapeToClose(onCancel, busy || !open);
  const [name, setName] = useState('');

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  if (!open) return null;

  const submit = () => {
    if (name.trim()) onCreate(name.trim());
  };

  return (
    <div className="wb-sheet-backdrop" role="presentation">
      <div className="wb-sheet" role="dialog" aria-labelledby="wb-empty-project-title">
        <div className="wb-sheet-kicker">New project · no folder yet</div>
        <h2 id="wb-empty-project-title">Create empty project</h2>
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
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions">
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
        </div>
      </div>
    </div>
  );
};
