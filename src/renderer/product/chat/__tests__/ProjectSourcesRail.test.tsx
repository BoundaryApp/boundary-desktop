import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
} from '../../../../shared/types/hermesChat';
import { ProjectSourcesRail } from '../ProjectSourcesRail';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';

const getStatus = vi.fn();
const patchProject = vi.fn();
const listCodingFolders = vi.fn();
const codingAgentBusy = vi.fn();
const setProjectFolderCoding = vi.fn();

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: (...args: unknown[]) => getStatus(...args),
  },
}));

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    patchProject: (...args: unknown[]) => patchProject(...args),
    listCodingFolders: (...args: unknown[]) => listCodingFolders(...args),
    codingAgentBusy: (...args: unknown[]) => codingAgentBusy(...args),
    setProjectFolderCoding: (...args: unknown[]) => setProjectFolderCoding(...args),
    onCodingFoldersProgress: () => () => undefined,
  },
}));

const project: HermesProjectRecord = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Documents/Job Search',
  containerPath: '/opt/projects/job-search',
  slug: 'job-search',
  kind: 'host-folder',
  inference: { mode: 'inherit' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function inspect(
  partial: Partial<HermesProjectSourcesInspect>
): HermesProjectSourcesInspect {
  return {
    projectId: 'p1',
    registryExists: true,
    stale: false,
    sources: [
      {
        id: 'project',
        path: '.',
        hostPath: project.hostPath,
        retrieval: 'files',
        visibility: 'hub',
        isHub: true,
      },
    ],
    index: [
      {
        sourceId: 'project',
        path: 'notes/resume.md',
        description: 'Resume',
        kind: 'relative',
        visible: true,
      },
    ],
    ...partial,
  };
}

const noop = () => undefined;

const bothConfigured = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: {
    local: {
      configured: true,
      modelId: 'qwen3:14b',
      health: 'reachable' as const,
    },
    openrouter: {
      configured: true,
      modelId: 'anthropic/claude-sonnet-4',
      health: 'reachable' as const,
    },
  },
};

describe('ProjectSourcesRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodingFoldersStoreForTests();
    listCodingFolders.mockResolvedValue({ success: true, managed: true, grants: [] });
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
    setProjectFolderCoding.mockResolvedValue({ success: true, managed: true, grants: [] });
    getStatus.mockResolvedValue(bothConfigured);
    patchProject.mockResolvedValue({
      success: true,
      project: { ...project, inference: { mode: 'local', modelId: 'qwen3:14b' } },
      projects: [{ ...project, inference: { mode: 'local', modelId: 'qwen3:14b' } }],
    });
  });

  it('lists the hub source with Open and does not show files', () => {
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({ registryExists: false, index: [] })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={noop}
      />
    );
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1);
    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.queryByText('Index')).toBeNull();
    expect(screen.queryByText('scratch.md')).toBeNull();
    expect(screen.queryByText('notes/resume.md')).toBeNull();
    expect(screen.queryByText('Opens under the hub')).toBeNull();
  });

  it('shows Inference options and patches a Local pin', async () => {
    const onProjectsUpdated = vi.fn();
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({ registryExists: false, index: [] })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={noop}
        onProjectsUpdated={onProjectsUpdated}
      />
    );
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Inherit app default/ })).toBeTruthy();
    });
    expect(screen.getByText('Privacy: local only')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Local · qwen3:14b.*pin this project/i }));
    await waitFor(() => {
      expect(patchProject).toHaveBeenCalledWith({
        projectId: 'p1',
        inference: { mode: 'local', modelId: 'qwen3:14b' },
      });
    });
    expect(onProjectsUpdated).toHaveBeenCalled();
  });

  it('shows a quiet pin on the glyph when the project is pinned', () => {
    render(
      <ProjectSourcesRail
        project={{
          ...project,
          inference: { mode: 'local', modelId: 'qwen3:14b' },
        }}
        inspect={inspect({ registryExists: false, index: [] })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={noop}
      />
    );
    expect(document.querySelector('.wb-inf-pin.is-local')).toBeTruthy();
  });

  it('opens each source from its Open button and keeps Remove on extras only', () => {
    const onRevealSource = vi.fn();
    const onRemoveSource = vi.fn();
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({
          sources: [
            {
              id: 'project',
              path: '.',
              hostPath: project.hostPath,
              retrieval: 'files',
              visibility: 'hub',
              isHub: true,
            },
            {
              id: 'notes-vault',
              path: '/Users/ada/Notes/this-project',
              hostPath: '/Users/ada/Notes/this-project',
              retrieval: 'files',
              visibility: 'readonly',
              isHub: false,
            },
          ],
        })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={onRevealSource}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={onRemoveSource}
      />
    );
    const opens = screen.getAllByRole('button', { name: 'Open' });
    expect(opens).toHaveLength(2);
    fireEvent.click(opens[0]);
    fireEvent.click(opens[1]);
    expect(onRevealSource).toHaveBeenNthCalledWith(1, 'project');
    expect(onRevealSource).toHaveBeenNthCalledWith(2, 'notes-vault');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemoveSource).toHaveBeenCalledWith('notes-vault');
  });

  it('hides Refresh index for hub-only', () => {
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({ registryExists: false, index: [] })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={noop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Refresh index' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Change folder' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open in Finder' })).toBeTruthy();
  });

  it('keeps Add separate from Change folder', () => {
    const onAddFolder = vi.fn();
    const onChangeFolder = vi.fn();
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({})}
        onChangeFolder={onChangeFolder}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={onAddFolder}
        onRemoveSource={noop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onChangeFolder).not.toHaveBeenCalled();
  });

  it('shows a stale banner and Refresh index in the menu after a remounted extra', () => {
    render(
      <ProjectSourcesRail
        project={project}
        inspect={inspect({
          stale: true,
          sources: [
            {
              id: 'project',
              path: '.',
              hostPath: project.hostPath,
              retrieval: 'files',
              visibility: 'hub',
              isHub: true,
            },
            {
              id: 'notes-vault',
              path: '/Users/ada/Notes/this-project',
              hostPath: '/Users/ada/Notes/this-project',
              retrieval: 'files',
              visibility: 'readonly',
              isHub: false,
            },
          ],
          nextStep: {
            tone: 'ok',
            title: 'Index is behind the files.',
            body: 'Refresh rewrites INDEX.md from this Mac.',
          },
        })}
        onChangeFolder={noop}
        onChooseFolder={noop}
        onRevealHub={noop}
        onRevealSource={noop}
        onRefreshIndex={noop}
        onAddFolder={noop}
        onRemoveSource={noop}
      />
    );
    expect(
      screen.getAllByText('Read-only').some((el) => el.closest('.wb-src'))
    ).toBe(true);
    expect(screen.getByText('Index is behind the files.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.getByRole('menuitem', { name: 'Refresh index' })).toBeTruthy();
  });

  describe('coding folders (ADR 0028)', () => {
    const tokens = '/Users/ada/Code/design-tokens';
    const withTokens = () =>
      inspect({
        sources: [
          {
            id: 'project',
            path: '.',
            hostPath: project.hostPath,
            retrieval: 'files',
            visibility: 'hub',
            isHub: true,
          },
          {
            id: 'design-tokens',
            path: tokens,
            hostPath: tokens,
            retrieval: 'files',
            visibility: 'writable',
            isHub: false,
          },
        ],
      });

    const renderRail = () =>
      render(
        <ProjectSourcesRail
          project={project}
          inspect={withTokens()}
          onChangeFolder={noop}
          onChooseFolder={noop}
          onRevealHub={noop}
          onRevealSource={noop}
          onRefreshIndex={noop}
          onAddFolder={noop}
          onRemoveSource={noop}
        />
      );

    it('shows a granted folder as Coding, says Hermes waits, and offers a Hermes restart', async () => {
      listCodingFolders.mockResolvedValue({
        success: true,
        managed: true,
        grants: [
          {
            capability: 'coding',
            resource: tokens,
            createdAt: '2026-10-07T00:00:00.000Z',
            expiresAt: null,
            projectId: 'p1',
            origin: 'add',
            createdByBoundary: false,
            state: 'ready',
            hermesPending: true,
          },
        ],
      });
      renderRail();
      expect(
        await screen.findByText('Coding agent can edit · Hermes after its next restart')
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Restart Hermes now' })).toBeTruthy();
      // The 0013 writable warning is for folders inside someone else's grant, not this one.
      expect(screen.queryByText('This extra folder is writable.')).toBeNull();
    });

    it('allows coding on the project folder from a popover', async () => {
      renderRail();
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding…' }));
      expect(screen.getByText('Let the coding agent work in Job Search?')).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding' }));
      await waitFor(() =>
        expect(setProjectFolderCoding).toHaveBeenCalledWith({
          projectId: 'p1',
          enabled: true,
          stopRunningTask: false,
        })
      );
    });

    it('offers to wait when a coding task is running', async () => {
      codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
      renderRail();
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding…' }));
      expect(await screen.findByRole('button', { name: 'Allow when it finishes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop task and allow' })).toBeTruthy();
      expect(screen.getByText(/Fix header layout/)).toBeTruthy();
    });

    it('hides Allow coding on a developer stack', async () => {
      listCodingFolders.mockResolvedValue({ success: false, managed: false, grants: [] });
      renderRail();
      await waitFor(() => expect(listCodingFolders).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow coding…' })).toBeNull());
    });
  });
});
