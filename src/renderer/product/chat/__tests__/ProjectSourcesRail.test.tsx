import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { EMPTY_RANKING, QWEN_RANKING, poolBridge } from '../../../__tests__/confidentialFixtures';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import type {
  HermesProjectRecord,
  HermesProjectRemoveResult,
  HermesProjectSourcesInspect,
} from '../../../../shared/types/hermesChat';
import type { CirclesState } from '../../../../shared/types/circles';
import { replied } from '../../../__tests__/mockReplies';
import { ProjectSourcesRail } from '../ProjectSourcesRail';
import { patchProjectInference } from '../useProjects';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';
import { flushMenu, openMenu } from '../../../__tests__/openMenu';
import { takeInferenceStatus } from '../../../onboarding/inferenceStatus';

const getStatus = vi.fn();
const patchProject = vi.fn();
const listCodingFolders = vi.fn();
const codingAgentBusy = vi.fn();
const setProjectFolderCoding = vi.fn();
const inspectRemove = vi.fn();
const removeProject = vi.fn();

stubElectronAPI({
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
  },
  projects: {
    patch: (...args: unknown[]) => patchProject(...args),
    inspectRemove: (...args: unknown[]) => inspectRemove(...args),
    remove: (...args: unknown[]) => removeProject(...args),
  },
  codingFolders: {
    list: (...args: unknown[]) => listCodingFolders(...args),
    busy: (...args: unknown[]) => codingAgentBusy(...args),
    setProjectFolder: (...args: unknown[]) => setProjectFolderCoding(...args),
    onProgress: () => () => {},
  },
});

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
    ...partial,
  };
}

const noop = () => {};

/** The rail for `project` with only its hub, every handler a no-op; `props` overrides any. */
const railElement = (props: Partial<React.ComponentProps<typeof ProjectSourcesRail>> = {}) => (
  <ProjectSourcesRail
    project={project}
    inspect={inspect({})}
    onChangeFolder={noop}
    onChooseFolder={noop}
    onRevealHub={noop}
    onRevealSource={noop}
    onRefreshIndex={noop}
    onAddFolder={noop}
    onRemoveSource={noop}
    connecting={false}
    rpcAvailable
    role={null}
    {...props}
  />
);
const renderRail = (props: Partial<React.ComponentProps<typeof ProjectSourcesRail>> = {}) => render(railElement(props));

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

/** The inspector's stack rows, first to last. */
const stackRows = () =>
  within(screen.getByRole('list', { name: /in order$/ }))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

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
    renderRail();
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(1);
    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.queryByText('Index')).toBeNull();
    expect(screen.queryByText('scratch.md')).toBeNull();
    expect(screen.queryByText('notes/resume.md')).toBeNull();
    expect(screen.queryByText('Opens under the hub')).toBeNull();
  });

  it('lists the Chat stack it inherits, and saves its own stack from Edit stack', async () => {
    const onProjectsUpdated = vi.fn();
    renderRail({ patchInference: (id, pin) => patchProjectInference(id, pin, onProjectsUpdated) });
    await waitFor(() => expect(stackRows()).toEqual(['1Local · qwen3:14bOn this Mac']));
    expect(screen.getByText('Chats here use the Chat stack, in order')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to Chat stack' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stack for this project' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add model' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(patchProject).toHaveBeenCalledWith({
        projectId: 'p1',
        inference: { mode: 'local', modelId: 'qwen3:14b', fallbacks: [{ slot: 'openrouter' }] },
      });
    });
    expect(onProjectsUpdated).toHaveBeenCalled();
  });

  describe('Private (ADR 0033 §4)', () => {
    const rail = (inference: HermesProjectRecord['inference']) =>
      renderRail({ project: { ...project, inference } });

    it('turns on from a switch that keeps the pin', async () => {
      rail({ mode: 'local', modelId: 'qwen3:14b' });
      await waitFor(() => expect(stackRows()[0]).toMatch(/Local · qwen3:14b/));
      const toggle = screen.getByRole('switch', { name: /^Private/ });
      expect(document.getElementById(toggle.getAttribute('aria-describedby')!)?.textContent).toMatch(/local model/);
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(patchProject).toHaveBeenCalledWith({
          projectId: 'p1',
          inference: { mode: 'local', modelId: 'qwen3:14b', privacyLocalOnly: true },
        });
      });
    });

    it('shows an error when the switch’s pin call rejects, and can be pressed again', async () => {
      patchProject.mockRejectedValueOnce(new Error('IPC gone'));
      rail({ mode: 'local', modelId: 'qwen3:14b' });
      await waitFor(() => expect(stackRows()[0]).toMatch(/Local · qwen3:14b/));
      const toggle = screen.getByRole('switch', { name: /^Private/ });
      fireEvent.click(toggle);
      expect(await screen.findByText('Could not update the project.')).toBeTruthy();
      expect(toggle.hasAttribute('disabled')).toBe(false);
    });

    it('says when the stack starts on the cloud, and lets only Local come first', async () => {
      rail({
        mode: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        privacyLocalOnly: true,
        fallbacks: [{ slot: 'local' }],
      });
      expect(await screen.findByText(/OpenRouter · claude-sonnet-4 isn’t private, so chats here can’t send/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
      const sheet = await screen.findByRole('dialog', { name: 'Stack for this project' });
      expect(within(sheet).getByText('This project is private, so the first model must be Local.')).toBeTruthy();
      expect(within(sheet).getByText('No private model. Private projects can’t send.')).toBeTruthy();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Move Local · qwen3:14b up' }));
      // The line moves with the order, in the same render (settings spec decision 3).
      expect(within(sheet).getByText('Private projects stop here')).toBeTruthy();
      await waitFor(() => {
        expect(patchProject).toHaveBeenCalledWith({
          projectId: 'p1',
          inference: {
            mode: 'local',
            modelId: 'qwen3:14b',
            privacyLocalOnly: true,
            fallbacks: [{ slot: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }],
          },
        });
      });
    });

    describe('Allow level B (confidential inference spec decision 10)', () => {
      const pool = { slot: 'confidential' as const, modelId: 'qwen' };
      const allowedB = {
        mode: 'local' as const,
        modelId: 'qwen3:14b',
        privacyLocalOnly: true,
        allowConfidentialLevelB: true,
        fallbacks: [pool],
      };
      /** Only level B providers serve qwen: a private project ranks it empty below floor B. */
      const bridge = () => ({
        ...poolBridge(),
        rank: vi.fn(({ privateProject, projectFloor }: { privateProject: boolean; projectFloor?: string }) =>
          Promise.resolve(privateProject && projectFloor !== 'B' ? EMPTY_RANKING : QWEN_RANKING)
        ),
      });

      beforeEach(() => resetIpcStoresForTests());
      afterEach(() => {
        stubElectronAPI({ confidential: { getState: vi.fn(() => new Promise<never>(() => undefined)) } });
        resetIpcStoresForTests();
      });

      it('shows the row with Don’t allow, which turns it off', async () => {
        stubElectronAPI({ confidential: bridge() });
        rail(allowedB);
        expect(await screen.findByText('Level B providers allowed')).toBeTruthy();
        expect(
          screen.getByText('Chats here may use providers whose hardware is checked but whose code in the enclave isn’t.')
        ).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Don’t allow' }));
        await waitFor(() => {
          expect(patchProject).toHaveBeenCalledWith({
            projectId: 'p1',
            inference: { ...allowedB, allowConfidentialLevelB: false },
          });
        });
      });

      it('hides the row while pools are off', async () => {
        rail(allowedB);
        await waitFor(() => expect(stackRows()[0]).toMatch(/Local · qwen3:14b/));
        expect(screen.queryByText('Level B providers allowed')).toBeNull();
      });

      it('clears it when Private turns off', async () => {
        stubElectronAPI({ confidential: bridge() });
        rail(allowedB);
        fireEvent.click(await screen.findByRole('switch', { name: /^Private/ }));
        await waitFor(() => {
          expect(patchProject).toHaveBeenCalledWith({
            projectId: 'p1',
            inference: { ...allowedB, privacyLocalOnly: false, allowConfidentialLevelB: false },
          });
        });
      });

      it('uses a pool only level B serves, and puts it past the private cut after Don’t allow', async () => {
        const confidential = bridge();
        stubElectronAPI({ confidential });
        const { rerender } = rail(allowedB);
        await waitFor(() => expect(stackRows()[1]).toMatch(/Confidential · Qwen 3\.8 27B/));
        await waitFor(() => expect(confidential.rank).toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true, projectFloor: 'B' }));
        expect(stackRows()[1]).not.toMatch(/Not used: this project is private/);

        rerender(railElement({ project: { ...project, inference: { ...allowedB, allowConfidentialLevelB: false } } }));
        await waitFor(() => expect(stackRows()[1]).toMatch(/Not used: this project is private/));
        expect(confidential.rank).toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true, projectFloor: 'A' });
        expect(screen.queryByText('Level B providers allowed')).toBeNull();
      });

      it('sends from an inherited stack that starts with a pool while one serves it, as main does', async () => {
        const confidential = bridge();
        stubElectronAPI({ confidential });
        getStatus.mockResolvedValue({ ...bothConfigured, appSharedModel: pool });
        const inherits = { mode: 'inherit' as const, privacyLocalOnly: true, allowConfidentialLevelB: true };
        const { rerender } = rail(inherits);
        await waitFor(() => expect(confidential.rank).toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true, projectFloor: 'B' }));
        await waitFor(() => expect(stackRows()[0]).toMatch(/Confidential · Qwen 3\.8 27B/));
        expect(stackRows()[0]).not.toMatch(/Not used: this project is private/);
        expect(screen.queryByText(/isn’t private/)).toBeNull();

        rerender(railElement({ project: { ...project, inference: { ...inherits, allowConfidentialLevelB: false } } }));
        expect(await screen.findByText(/Confidential · Qwen 3\.8 27B isn’t private, so chats here can’t send/)).toBeTruthy();
      });
    });

    it('sends from a shared model whose provider is marked private', async () => {
      const peer = { slot: 'peer' as const, modelId: 'llama', peer: { circleId: 'c1', providerId: 'bo' } };
      const circlesState: CirclesState = {
        status: 'running',
        displayName: 'Ada',
        snapshot: { identity: 'ada', circles: [] },
        providers: { bo: { private: true, trusted: true } },
        sharing: { models: [], circles: [], paused: false, away: false },
      };
      stubElectronAPI({ circles: { getState: vi.fn().mockResolvedValue(circlesState), onState: () => () => {} } });
      getStatus.mockResolvedValue({ ...bothConfigured, appSharedModel: peer });
      rail({ mode: 'inherit', privacyLocalOnly: true });
      await waitFor(() => expect(stackRows()[0]).toMatch(/llama/));
      expect(screen.queryByText(/isn’t private/)).toBeNull();
    });

    it('shows a cloud fallback as not used', async () => {
      rail({
        mode: 'local',
        modelId: 'qwen3:14b',
        privacyLocalOnly: true,
        fallbacks: [{ slot: 'openrouter' }],
      });
      expect(await screen.findByText('Not used: this project is private.')).toBeTruthy();
      expect(screen.queryByText(/can’t send/)).toBeNull();
    });
  });

  it("reorders a pinned project's own stack, and goes back to the Chat stack (ADR 0033 §1)", async () => {
    renderRail({
      project: { ...project, inference: { mode: 'local', modelId: 'qwen3:14b', fallbacks: [{ slot: 'openrouter' }] } },
    });
    await waitFor(() =>
      expect(stackRows()).toEqual(['1Local · qwen3:14bOn this Mac', '2OpenRouter · claude-sonnet-4Cloud'])
    );
    expect(screen.getByText('This project’s stack, in order')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stack for this project' });
    // Outside a private project the privacy line means nothing here, so it isn't drawn.
    expect(within(sheet).queryByText('Private projects stop here')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move OpenRouter · claude-sonnet-4 up' }));
    await waitFor(() => {
      expect(patchProject).toHaveBeenCalledWith({
        projectId: 'p1',
        inference: { mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4', fallbacks: [{ slot: 'local', modelId: 'qwen3:14b' }] },
      });
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    patchProject.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Chat stack' }));
    await waitFor(() => {
      expect(patchProject).toHaveBeenCalledWith({ projectId: 'p1', inference: { mode: 'inherit' } });
    });
  });

  it('follows an app default changed elsewhere without a project change', async () => {
    renderRail();
    await waitFor(() => expect(stackRows()[0]).toMatch(/Local · qwen3:14b/));
    // Settings makes OpenRouter the app default and passes on the status main returned.
    await act(async () =>
      takeInferenceStatus({ status: { ...bothConfigured, appDefault: 'openrouter' } })
    );
    expect(stackRows()[0]).toMatch(/OpenRouter · claude-sonnet-4/);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('shows a quiet pin on the glyph when the project is pinned', () => {
    renderRail({
      project: {
        ...project,
        inference: { mode: 'local', modelId: 'qwen3:14b' },
      },
    });
    expect(document.querySelector('.wb-inf-pin.is-local')).toBeTruthy();
  });

  it('opens each source from its Open button and keeps Remove on extras only', () => {
    const onRevealSource = vi.fn();
    const onRemoveSource = vi.fn();
    renderRail({
      inspect: inspect({
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
      }),
      onRevealSource,
      onRemoveSource,
    });
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

  it('marks a project folder that is shared with a Circle, and says who gets what is written', async () => {
    stubElectronAPI({
      circles: {
        foldersOnMac: async () => ({
          success: true,
          folders: [
            {
              key: 'k',
              circle: 'c',
              circleName: 'Studio',
              name: 'Job Search',
              root: `${project.hostPath}/`,
              role: 'editor',
              defaultRole: 'editor',
              people: 4,
              managers: ['Maya'],
              ended: null as number | null,
            },
          ],
        }),
      },
    });
    renderRail();
    expect(await screen.findByText('Shared · Studio')).toBeTruthy();
    expect(
      screen.getByText(
        'Everyone in Studio can edit. Anything you or Hermes writes here goes to all 4 people in it. If you allow coding, the coding agent’s changes sync too.'
      )
    ).toBeTruthy();
  });

  it('offers Check a file… in the project menu when the screen can show a check', () => {
    const onCheckFile = vi.fn();
    renderRail({ onCheckFile });
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Check a file…' }));
    expect(onCheckFile).toHaveBeenCalledTimes(1);
  });

  it('has no Check a file… without a place to show it', () => {
    renderRail();
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Check a file…' })).toBeNull();
  });

  it('the menu has Remove project… and it opens the sheet', async () => {
    inspectRemove.mockResolvedValue({
      success: true,
      projectId: 'p1',
      name: 'Job Search',
      kind: 'host-folder',
      hostPath: project.hostPath,
      requiresTypedName: false,
    });
    const result: HermesProjectRemoveResult = { success: true, removed: true, projects: [], activeId: null };
    removeProject.mockResolvedValue(result);
    const onProjectRemoved = vi.fn();
    renderRail({ onProjectRemoved });
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.at(-1)?.textContent).toBe('Remove project…');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove project…' }));

    expect(await screen.findByRole('heading', { name: 'Remove Job Search?' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove project' }));

    await waitFor(() => expect(onProjectRemoved).toHaveBeenCalledWith(result));
    expect(screen.queryByRole('heading', { name: 'Remove Job Search?' })).toBeNull();
  });

  it('the Remove project… item is disabled while connecting', () => {
    renderRail({ connecting: true });
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.getByRole('menuitem', { name: 'Remove project…' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('hides Refresh index for hub-only', () => {
    renderRail();
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Refresh index' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Change folder' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Open in Finder' })).toBeTruthy();
  });

  it('closes the project actions menu on an outside click and on Escape', async () => {
    renderRail();
    const more = screen.getByRole('button', { name: 'Project actions' });
    openMenu(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    // Radix listens for outside presses a tick after opening.
    await flushMenu();
    const outside = screen.getByText('project');
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu(more);
    await flushMenu();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await flushMenu();
    expect(document.activeElement).toBe(more);
  });

  it('keeps Add separate from Change folder', () => {
    const onAddFolder = vi.fn();
    const onChangeFolder = vi.fn();
    renderRail({ onChangeFolder, onAddFolder });
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onChangeFolder).not.toHaveBeenCalled();
  });

  it('shows a stale banner and Refresh index in the menu after a remounted extra', () => {
    renderRail({
      inspect: inspect({
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
      }),
    });
    expect(
      screen.getAllByText('Read-only').some((el) => el.closest('.wb-src'))
    ).toBe(true);
    expect(screen.getByText('Index is behind the files.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    openMenu(screen.getByRole('button', { name: 'Project actions' }));
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
      renderRail({ inspect: withTokens() });
      expect(
        await screen.findByText('Coding agent can edit · Hermes after its next restart')
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Restart Hermes now' })).toBeTruthy();
      // The 0013 writable warning is for folders inside someone else's grant, not this one.
      expect(screen.queryByText('This extra folder is writable.')).toBeNull();
    });

    it('allows coding on the project folder from a popover', async () => {
      renderRail({ inspect: withTokens() });
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

    it('closes the allow-coding popover on Escape and returns focus to its button', async () => {
      renderRail({ inspect: withTokens() });
      const allow = await screen.findByRole('button', { name: 'Allow coding…' });
      fireEvent.click(allow);
      expect(screen.getByRole('dialog')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(allow);
    });

    it('offers to wait when a coding task is running', async () => {
      codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['Fix header layout'] });
      renderRail({ inspect: withTokens() });
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding…' }));
      expect(await screen.findByRole('button', { name: 'Allow when it finishes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop task and allow' })).toBeTruthy();
      expect(screen.getByText(/Fix header layout/)).toBeTruthy();
    });

    it('offers the wait or stop choice again when a task started after the check', async () => {
      setProjectFolderCoding.mockResolvedValue({
        success: false,
        managed: true,
        grants: [],
        error: 'A coding task is running.',
        busy: { busy: true, sessions: ['Fix header layout'] },
      });
      renderRail({ inspect: withTokens() });
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding…' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Allow coding' }));
      await waitFor(() => expect(setProjectFolderCoding).toHaveBeenCalled());
      expect(await screen.findByRole('button', { name: 'Allow when it finishes' })).toBeTruthy();
      expect(screen.getByText(/Fix header layout/)).toBeTruthy();
    });

    it('hides Allow coding on a developer stack', async () => {
      listCodingFolders.mockResolvedValue({ success: false, managed: false, grants: [] });
      renderRail({ inspect: withTokens() });
      await replied(listCodingFolders);
      expect(screen.queryByRole('button', { name: 'Allow coding…' })).toBeNull();
    });
  });
});
