import React, { useState } from 'react';
import { X } from 'lucide-react';
import { SetupShell } from '../SetupShell';
import { useSetup } from '../SetupContext';
import type { SetupStepProps } from '../types';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { EmptyProjectSheet } from '../../product/chat/EmptyProjectSheet';
import { ProjectGlyph } from '../../product/chat/ProjectGlyph';
import type { FirstRunFolder, FirstRunFolderPick } from '../../../shared/types/setupProgress';
import { APP_NAME } from '../../../shared/buildIdentity';

type FolderRow =
  | ({ kind: 'host-folder'; key: string } & FirstRunFolderPick)
  | { kind: 'empty'; key: string; name: string };

function toFolder(row: FolderRow): FirstRunFolder | null {
  if (row.kind === 'empty') return { kind: 'empty', name: row.name };
  return row.refuseMessage ? null : { kind: 'host-folder', hostPath: row.hostPath };
}

/**
 * First-run Folders step (first-run spec, Phase 2): picks are saved here and become projects
 * once the stack is ready. Refused folders stay on screen with the reason and are never saved.
 */
export const FoldersStep: React.FC<SetupStepProps> = ({ title, description }) => {
  const { updateSetupProgress } = useSetup();
  const [rows, setRows] = useState<FolderRow[]>([]);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folders = rows.map(toFolder).filter((folder): folder is FirstRunFolder => folder !== null);

  const choose = async () => {
    setError(null);
    try {
      const picked = await window.electronAPI.setup.pickFolders();
      if (picked.canceled) return;
      setRows((prev) => {
        const known = new Set(prev.map((row) => row.key));
        const added = picked.folders
          .filter((folder) => !known.has(`host:${folder.hostPath}`))
          .map((folder): FolderRow => ({ kind: 'host-folder', key: `host:${folder.hostPath}`, ...folder }));
        return [...prev, ...added];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addEmpty = (name: string) => {
    setRows((prev) =>
      prev.some((row) => row.key === `empty:${name}`)
        ? prev
        : [...prev, { kind: 'empty', key: `empty:${name}`, name }]
    );
    setEmptyOpen(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.setup.saveFolders({ folders });
      if (!result.success) {
        setError(result.error ?? 'Could not save these folders.');
        return;
      }
      updateSetupProgress(result.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SetupShell
      title={title}
      description={description}
      actions={
        <Button type="button" disabled={busy || folders.length === 0} onClick={() => void save()}>
          Continue
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => void choose()}>
          Choose folder…
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setEmptyOpen(true)}>
          Create empty project
        </Button>
      </div>

      {rows.length > 0 && (
        <ul className="grid gap-1.5" aria-label="Picked folders">
          {rows.map((row) => {
            const refused = row.kind === 'host-folder' && row.refuseMessage;
            return (
              <li
                key={row.key}
                className={
                  refused
                    ? 'flex items-center gap-2.5 rounded-lg border border-danger-line bg-surface-1 px-2.5 py-2'
                    : 'flex items-center gap-2.5 rounded-lg border border-line bg-surface-1 px-2.5 py-2'
                }
              >
                <ProjectGlyph project={{ id: row.key, name: row.name }} muted={Boolean(refused)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg">{row.name}</span>
                  {row.kind === 'host-folder' ? (
                    <span
                      className={
                        refused
                          ? 'block text-2xs text-danger'
                          : 'block truncate font-mono text-2xs text-fg-faint'
                      }
                    >
                      {row.refuseMessage ?? row.displayPath}
                    </span>
                  ) : (
                    <span className="block truncate text-2xs text-fg-faint">
                      Empty project, no folder yet
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.name}`}
                  disabled={busy}
                  onClick={() => setRows((prev) => prev.filter((item) => item.key !== row.key))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-fg-faint">
        Folders start read-only. {APP_NAME} asks before the coding agent edits anything.
      </p>

      {error && <Callout variant="destructive">{error}</Callout>}

      <EmptyProjectSheet open={emptyOpen} onCreate={addEmpty} onCancel={() => setEmptyOpen(false)} />
    </SetupShell>
  );
};
