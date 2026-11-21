import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { openMenu } from '../../../__tests__/openMenu';
import {
  countProjectSources,
  inspectRemoveProject,
  inspectSources,
  listProjects,
  listThreads,
  moveToProject,
  removeProject,
  renderScreen,
  selectProject,
  setUpScreen,
  tearDownScreen,
  undoProjectMove,
} from './workbenchChatScreenHarness';

vi.mock('../HermesChatRuntimeProvider', () => import('./workbenchChatScreenMocks'));
vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'));

describe('WorkbenchChatScreen chrome', () => {
  beforeEach(setUpScreen);
  afterEach(tearDownScreen);

  describe('chats belong to projects (ADR 0024)', () => {
    const p2 = {
      id: 'p2',
      name: 'Landing site',
      hostPath: '/Users/ada/code/site',
      containerPath: '/opt/projects/site',
      slug: 'site',
      kind: 'host-folder',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
      listProjects.mockResolvedValue({
        success: true,
        activeId: 'p1',
        projects: [
          {
            id: 'p1',
            name: 'Job Search',
            hostPath: '/Users/ada/Documents/Job Search',
            containerPath: '/opt/projects/job-search',
            slug: 'job-search',
            kind: 'host-folder',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          p2,
        ],
      });
      listThreads.mockResolvedValue({
        success: true,
        threads: [
          {
            id: 't-hermes',
            title: 'Plan the launch',
            agentSlug: 'assistant',
            kind: 'hermes',
            projectId: 'p1',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 't-site',
            title: 'Hero rewrite',
            agentSlug: 'assistant',
            kind: 'hermes',
            projectId: 'p2',
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      });
    });

    it('opens a project page from the picker and leaves the open chat where it is', async () => {
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      // The rail lists only the shown project's chats.
      expect(screen.queryByRole('button', { name: 'Hero rewrite' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Go to project' }));
      fireEvent.click(screen.getByRole('option', { name: /Landing site/ }));

      await waitFor(() => expect(selectProject).toHaveBeenCalledWith({ projectId: 'p2' }));
      for (const [payload] of selectProject.mock.calls) {
        expect(payload).not.toHaveProperty('sessionId');
      }
      expect(await screen.findByLabelText('Start a chat in Landing site')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Hero rewrite' }).length).toBeGreaterThan(0);
      expect(moveToProject).not.toHaveBeenCalled();
    });

    it('brings the rail to a chat opened from another project without selecting it in main', async () => {
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      const list = await screen.findByRole('list', { name: 'All chats' });
      fireEvent.click(within(list).getByText('Hero rewrite'));
      expect(await screen.findByText('thread:Hero rewrite')).toBeTruthy();
      expect(await screen.findByRole('button', { name: 'All chats in Landing site…' })).toBeTruthy();
      // Following the open chat is navigation only: no projects.set_active, no picker reorder.
      expect(selectProject).not.toHaveBeenCalled();
    });

    it('moves selected chats from All chats, says what changes, and undoes', async () => {
      moveToProject.mockResolvedValue({
        success: true,
        moved: [{ sessionId: 't-site', fromProjectId: 'p2', toProjectId: null, markId: 'm1' }],
      });
      undoProjectMove.mockResolvedValue({ success: true, moved: [] });
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      await screen.findByRole('list', { name: 'All chats' });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Hero rewrite' }));
      fireEvent.click(screen.getByRole('button', { name: 'Move to project…' }));

      const dialog = await screen.findByRole('dialog', { name: /Move “Hero rewrite”/ });
      // The sheet reads a source count, never the full inspect that reads every file.
      await waitFor(() => expect(countProjectSources).toHaveBeenCalledWith({ projectId: 'p1' }));
      const inspectsBefore = inspectSources.mock.calls.length;
      fireEvent.click(within(dialog).getByRole('option', { name: /No project/ }));
      expect(within(dialog).getByText(/works without a project folder/)).toBeTruthy();
      expect(inspectSources.mock.calls.length).toBe(inspectsBefore);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move to No project' }));

      await waitFor(() =>
        expect(moveToProject).toHaveBeenCalledWith({ sessionIds: ['t-site'], projectId: null })
      );
      const toast = await screen.findByText('Moved to No project');
      fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(undoProjectMove).toHaveBeenCalledWith({
          moves: [{ sessionId: 't-site', fromProjectId: 'p2', toProjectId: null, markId: 'm1' }],
        })
      );
      expect(await screen.findByText('Move undone')).toBeTruthy();
    });
  });

  describe('removing a project (ADR 0067)', () => {
    it('removing the active project leaves the picker on No project', async () => {
      inspectRemoveProject.mockResolvedValue({
        success: true,
        projectId: 'p1',
        name: 'Job Search',
        kind: 'host-folder',
        hostPath: '/Users/ada/Documents/Job Search',
        requiresTypedName: false,
      });
      // A second project keeps the picker on screen; with none left the rail shows its empty state.
      const site = {
        id: 'p2',
        name: 'Landing site',
        hostPath: '/Users/ada/code/site',
        containerPath: '/opt/projects/site',
        slug: 'site',
        kind: 'host-folder',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const listed = await listProjects.getMockImplementation()?.();
      listProjects.mockResolvedValue({
        success: true,
        activeId: 'p1',
        projects: [...(listed?.projects ?? []), site],
      });
      removeProject.mockResolvedValue({
        success: true,
        removed: true,
        projects: [site],
        activeId: null,
      });
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      const picker = screen.getByRole('button', { name: 'Go to project' });
      expect(picker.textContent).toContain('Job Search');

      openMenu(screen.getByRole('button', { name: 'Project actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove project…' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove project' }));

      await waitFor(() => expect(removeProject).toHaveBeenCalledWith({ projectId: 'p1' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Go to project' }).textContent).toContain(
          'No project'
        )
      );
      expect(screen.queryByRole('heading', { name: 'Remove Job Search?' })).toBeNull();
    });
  });
});
