import React, { useEffect, useId, useState } from 'react';
import { APP_NAME } from '../../../../shared/buildIdentity';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { SharedFolderListing } from '../../../../shared/types/sharedFolders';
import { formatBytes } from '../../../../shared/utils/format';
import { Callout } from '../../../components/ui/alert';
import { Field } from '../../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { displayHostPath } from '../chatTelemetryFormat';
import { myRole } from './sharedFolderView';
import { Button } from '../../../components/ui/button';
import { ChoiceGroup } from '../../../components/ui/choice-group';
import { ChoiceRow } from '../../../components/ui/choice-row';
import { Radio } from '../../../components/ui/radio';
import { StackCapabilityNote, useStackCapability } from '../../stackCapabilities';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import { useAction } from '../../circles/useCircles';

const api = () => window.electronAPI.circles;

type UseIn = 'project' | 'existing' | 'none';

/**
 * Add a folder offered in a Circle to this Mac (shared folders spec, Flows: Adding): where it
 * goes, and whether it becomes a project (the default, decision 5). Nothing downloads before this.
 * `onAdded` gets the new project's id, or null for none.
 */
export const AddSharedFolderSheet: React.FC<{
  circle: CircleSnapshot;
  folder: SharedFolderListing | null;
  onClose: () => void;
  onAdded: (projectId: string | null) => void;
}> = ({ circle, folder, onClose, onAdded }) => {
  const useInName = useId();
  const [root, setRoot] = useState<string | null>(null);
  const hostFolders = useStackCapability('hostFolders');
  const [useIn, setUseIn] = useState<UseIn>(hostFolders ? 'project' : 'none');
  // The capabilities can answer after the sheet opens.
  useEffect(() => {
    if (!hostFolders) setUseIn('none');
  }, [hostFolders]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [existingId, setExistingId] = useState('');
  const { busy, error, run, setError } = useAction();
  const folderKey = folder?.key;
  const folderName = folder?.name;

  useEffect(() => {
    if (!folderKey || !folderName) return;
    setUseIn(hostFolders ? 'project' : 'none');
    setError(null);
    setRoot(null);
    let live = true;
    void window.electronAPI.projects.list().then((result) => {
      if (!live || !result.success) return;
      const listed = (result.projects ?? []).map((project) => ({ id: project.id, name: project.name }));
      setProjects(listed);
      setExistingId(listed[0]?.id ?? '');
    });
    void api()
      .folderDefaultRoot({ circle: circle.name, name: folderName })
      .then((path) => {
        if (live) setRoot(path);
      });
    return () => {
      live = false;
    };
  }, [folderKey, folderName, circle.name]);

  if (!folder) return null;
  const reader = myRole(folder, circle) === 'reader';

  const change = async () => {
    const chosen = await window.electronAPI.projects.pickFolder();
    if (!chosen.success || chosen.canceled || !chosen.hostPath) return;
    setRoot(`${chosen.hostPath.replace(/\/+$/, '')}/${folder.name}`);
  };

  const add = async () => {
    if (!root) return;
    const result = await run(async () => {
      const added = await api().folderAdd({ circle: circle.key, key: folder.key, root });
      if (added.success === false) return added;
      let projectId: string | null = null;
      if (useIn === 'project') {
        const project = await window.electronAPI.projects.createHost({ hostPath: root, name: folder.name });
        // The folder is on this Mac either way; a project that failed can be made later.
        if (!project.success) {
          onAdded(null);
          return {
            success: false,
            error: `${folder.name} is on this Mac, but the project wasn’t created: ${project.error ?? 'unknown error'}`,
          };
        }
        projectId = project.project?.id ?? null;
      } else if (useIn === 'existing' && existingId) {
        // An extra folder in that project, read by Hermes (ADR 0028's reference folders).
        const attached = await window.electronAPI.projects.addSourceFolder({ projectId: existingId, hostPath: root });
        if (!attached.success) {
          onAdded(null);
          return {
            success: false,
            error: `${folder.name} is on this Mac, but it wasn’t added to the project: ${attached.error ?? 'unknown error'}`,
          };
        }
        projectId = existingId;
      }
      return { success: true, projectId };
    });
    if (!result || result.success === false) return;
    onClose();
    onAdded(result.projectId);
  };

  const size = folder.offered ? `, ${formatBytes(folder.offered.bytes)}` : '';
  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="wb-add-shared-folder"
      title={`Add ${folder.name} to this Mac`}
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmDisabled={!root || (useIn === 'existing' && !existingId)}
          confirmLabel={busy ? 'Adding…' : folder.offered ? `Add and download ${formatBytes(folder.offered.bytes)}` : 'Add and download'}
          onConfirm={() => void add()}
        />
      }
    >
      <p className="wb-sheet-lede">
        {folder.offered ? `${folder.offered.files.toLocaleString()} files when shared${size}. ` : ''}Changes sync while{' '}
        {APP_NAME} is open.
      </p>
      <Field label="Location" htmlFor="wb-add-shared-folder-root">
        <span className="wb-add-shared-root">
          <Input id="wb-add-shared-folder-root" type="text" className="flex-1 font-mono" value={root ? displayHostPath(root) : ''} readOnly />
          <Button variant="secondary" block type="button" disabled={busy} onClick={() => void change()}>
            Change…
          </Button>
        </span>
      </Field>
      {hostFolders ? null : <StackCapabilityNote capability="hostFolders" size="sm" />}
      <ChoiceGroup kind="radio" aria-label="Use it in">
        {hostFolders ? (
          <ChoiceRow
            variant="card"
            control={<Radio name={useInName} checked={useIn === 'project'} onChange={() => setUseIn('project')} />}
            title={`A new project named ${folder.name}`}
            description="Chats about it start there. The project, its chats and its settings stay yours."
          />
        ) : null}
        {hostFolders && projects.length ? (
          <ChoiceRow
            variant="card"
            control={<Radio name={useInName} checked={useIn === 'existing'} onChange={() => setUseIn('existing')} />}
            title="An existing project"
            description="Added as a reference folder: Hermes reads it there and nothing writes to it. Choose a new project if agents should work in it."
          />
        ) : null}
        <ChoiceRow
          variant="card"
          control={<Radio name={useInName} checked={useIn === 'none'} onChange={() => setUseIn('none')} />}
          title="No project for now"
          description="Only the folder. You can make a project from it later."
        />
      </ChoiceGroup>
      {useIn === 'existing' ? (
        <Field label="Project" htmlFor="wb-add-shared-folder-project">
          <NativeSelect id="wb-add-shared-folder-project" value={existingId} onChange={(event) => setExistingId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Callout size="sm" role={undefined}>
        {reader
          ? 'You can read it; your copy is read-only.'
          : `You can edit it. What you and your agents write here goes to everyone in ${circle.name} who added it.`}{' '}
        If you leave {circle.name}, your copy stays on this Mac.
      </Callout>
    </Sheet>
  );
};
