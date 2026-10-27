import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
} from '../../../shared/types/hermesChat';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { grantFor } from './codingFolderView';
import {
  createAndList,
  getCodingFoldersState,
  grantAndList,
  onCodingGrantsChanged,
  runCodingChange,
  useCodingFolders,
  type CodingChangeMode,
} from './codingFoldersStore';
import type { NewFolderInput } from './NewFolderForm';
import { useCodingGrant } from './useCodingGrant';
import type { Projects } from './useProjects';

/** A "now" grant refused because a coding task started after the sheet checked. */
function busyGrantText(name: string, what = 'added'): string {
  return `A coding task started, so ${name} wasn’t ${what}. Try again to wait for it or stop it.`;
}

/**
 * The Project tab's folders (ADR 0013, ADR 0028): what the project's sources look like, the
 * Add folder sheet, coding grants for added and new folders, and removing a folder.
 */
export function useProjectSources(
  project: HermesProjectRecord | null,
  projects: Pick<
    Projects,
    'setConnecting' | 'setProjectError' | 'setProjectToast' | 'applyProjectsResult' | 'refreshProjects'
  >
) {
  const { setConnecting, setProjectError, setProjectToast, applyProjectsResult, refreshProjects } =
    projects;
  const [sourcesInspect, setSourcesInspect] = useState<HermesProjectSourcesInspect | null>(null);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const addSourceSheet = useSheetAction();
  const codingFolders = useCodingFolders();
  const { apply: applyGrant } = useCodingGrant();

  const refreshSources = useCallback(async (projectId: string | null) => {
    if (!projectId) {
      setSourcesInspect(null);
      return;
    }
    const result = await window.electronAPI.projects.inspectSources({ projectId });
    if (result.success && result.inspect) {
      setSourcesInspect(result.inspect);
      return;
    }
    setSourcesInspect(null);
  }, []);

  const projectKey = project?.id ?? null;
  useEffect(() => {
    void refreshSources(projectKey);
  }, [projectKey, refreshSources]);

  // A coding grant changes a project's flag and its folders' visibility (ADR 0028).
  const projectKeyRef = useRef(projectKey);
  projectKeyRef.current = projectKey;
  useEffect(
    () =>
      onCodingGrantsChanged(() => {
        void refreshProjects();
        void refreshSources(projectKeyRef.current);
      }),
    [refreshProjects, refreshSources]
  );

  const handleChangeFolder = useCallback(async () => {
    if (!project) return;
    const picked = await window.electronAPI.projects.pickFolder();
    if (picked.canceled || !picked.hostPath) return;
    setConnecting(true);
    try {
      const result = await window.electronAPI.projects.changeFolder({
        projectId: project.id,
        hostPath: picked.hostPath,
      });
      if (!result.success) {
        setProjectError(result.error ?? 'Could not change folder.');
        return;
      }
      applyProjectsResult(result);
      void refreshSources(project.id);
    } finally {
      setConnecting(false);
    }
  }, [project, refreshSources, setConnecting, setProjectError, applyProjectsResult]);

  const handleAddReference = useCallback(
    async (hostPath: string) => {
      if (!project) return;
      setConnecting(true);
      try {
        await addSourceSheet.run(async () => {
          const result = await window.electronAPI.projects.addSourceFolder({
            projectId: project.id,
            hostPath,
          });
          if (result.canceled) return;
          if (result.inspect) {
            setSourcesInspect(result.inspect);
          }
          if (!result.success) {
            addSourceSheet.setError(result.error ?? 'Could not attach that folder.');
            if (result.inspect) setAddSourceOpen(false);
            return;
          }
          setAddSourceOpen(false);
        });
      } finally {
        setConnecting(false);
      }
    },
    [project, addSourceSheet, setConnecting]
  );

  // Remove a folder; a coding folder loses its grant first, then its sources.yaml row.
  const removeFolder = useCallback(
    async (projectId: string, sourceId: string, hostPath: string | null) => {
      if (hostPath && grantFor(hostPath, getCodingFoldersState().grants)) {
        const revoked = await runCodingChange([hostPath], () =>
          window.electronAPI.codingFolders.revoke({ hostPath, stopRunningTask: true })
        );
        if (!revoked.success) return;
      }
      const result = await window.electronAPI.projects.removeSource({ projectId, sourceId });
      if (result.inspect && projectId === projectKeyRef.current) {
        setSourcesInspect(result.inspect);
      }
      if (!result.success && result.error) {
        setProjectError(result.error);
      }
    },
    [setProjectError]
  );

  // Code in it: grant first, so adding the sources.yaml row needs no read-only remount.
  const handleAddCode = useCallback(
    (hostPath: string, mode: CodingChangeMode) => {
      if (!project) return;
      const projectId = project.id;
      const name = hostPath.split('/').filter(Boolean).pop() ?? hostPath;
      setAddSourceOpen(false);
      void applyGrant([hostPath], mode, grantAndList({ projectId, hostPath, origin: 'add' })).then(
        (result) => {
          if (result.busy?.busy) setProjectToast({ text: busyGrantText(name) });
          if (!result.success) return;
          setProjectToast({
            text: `${name} is ready for coding`,
            undo: () => {
              setProjectToast(null);
              void window.electronAPI.projects.inspectSources({ projectId }).then((res) => {
                const row = res.inspect?.sources.find((source) => source.hostPath === hostPath);
                if (row) void removeFolder(projectId, row.id, hostPath);
              });
            },
          });
        }
      );
    },
    [project, applyGrant, removeFolder, setProjectToast]
  );

  // New folder… (ADR 0028 §8): create it, then grant it or add it as reference.
  const handleCreateFolder = useCallback(
    (input: NewFolderInput) => {
      if (!project) return;
      const projectId = project.id;

      if (input.access === 'reference') {
        void addSourceSheet.run(async () => {
          const created = await window.electronAPI.codingFolders.createFolder({
            projectId,
            parent: input.parent,
            name: input.name,
            initGit: input.initGit,
            grant: false,
            stopRunningTask: false,
          });
          if (!created.success || !created.hostPath) {
            addSourceSheet.setError(created.error ?? 'Could not create that folder.');
            return;
          }
          return handleAddReference(created.hostPath);
        });
        return;
      }

      const target = `${input.parent.replace(/\/+$/, '')}/${input.name}`;
      setAddSourceOpen(false);
      const run = createAndList({
        projectId,
        parent: input.parent,
        name: input.name,
        initGit: input.initGit,
      });
      void applyGrant([target], input.mode, run).then((result) => {
        if (result.busy?.busy) setProjectToast({ text: busyGrantText(input.name, 'created') });
        if (result.success) {
          setProjectToast({ text: `Created ${input.name} and it’s ready for coding` });
        }
      });
    },
    [project, addSourceSheet, applyGrant, handleAddReference, setProjectToast]
  );

  const handleRemoveSource = useCallback(
    async (sourceId: string) => {
      if (!project) return;
      const hostPath =
        sourcesInspect?.sources.find((source) => source.id === sourceId)?.hostPath ?? null;
      setConnecting(true);
      try {
        await removeFolder(project.id, sourceId, hostPath);
      } finally {
        setConnecting(false);
      }
    },
    [project, removeFolder, sourcesInspect, setConnecting]
  );

  const handleRefreshIndex = useCallback(async () => {
    if (!project) return;
    const result = await window.electronAPI.projects.refreshIndex({ projectId: project.id });
    if (result.success && result.inspect) {
      setSourcesInspect(result.inspect);
    } else if (result.error) {
      setProjectError(result.error);
    }
  }, [project, setProjectError]);

  return {
    inspect: sourcesInspect,
    changeFolder: (): void => void handleChangeFolder(),
    revealHub: () => {
      if (project) void window.electronAPI.projects.reveal({ projectId: project.id });
    },
    revealSource: (sourceId: string) => {
      if (project) {
        void window.electronAPI.projects.revealSource({ projectId: project.id, sourceId });
      }
    },
    refreshIndex: (): void => void handleRefreshIndex(),
    removeSource: (sourceId: string): void => void handleRemoveSource(sourceId),
    /** The Add folder sheet. */
    addFolder: {
      open: addSourceOpen,
      busy: addSourceSheet.busy,
      error: addSourceSheet.error,
      managed: codingFolders.managed,
      command: codingFolders.command,
      show: () => {
        addSourceSheet.setError(null);
        setAddSourceOpen(true);
      },
      cancel: () => addSourceSheet.dismiss(() => setAddSourceOpen(false)),
      reference: (hostPath: string): void => void handleAddReference(hostPath),
      code: handleAddCode,
      createFolder: handleCreateFolder,
    },
  };
}
