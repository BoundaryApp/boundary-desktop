import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';

const setSessionCwd = vi.fn().mockResolvedValue(undefined);
const getDefaultCwd = vi.fn().mockResolvedValue('/opt/data');

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    setSessionCwd: (...args: unknown[]) => setSessionCwd(...args),
    getDefaultCwd: (...args: unknown[]) => getDefaultCwd(...args),
    storedSessionId: (id: string) => id,
  }),
}));

import {
  getSessionProjectId,
  migrateSessionInference,
  resetHermesAgentsStoreForTests,
  setSessionProjectId,
  setStandingDmSessionId,
  listSessionProjectMarks,
} from '../hermesAgentStore';
import {
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
  removeStoredHermesProject,
} from '../hermesProjectStore';
import { beginRunningTurn, resetRunningTurnsForTests } from '../hermesRunningTurns';
import {
  applyConversationFolder,
  conversationProjectId,
  fileThreads,
  listConversationProjectMarks,
  moveConversationsToProject,
  projectForCwd,
  resetHermesChatProjectsForTests,
  undoProjectMove,
} from '../hermesChatProjects';

function project(id: string, slug: string, name: string): HermesProjectRecord {
  return {
    id,
    name,
    hostPath: `/Users/ada/${slug}`,
    containerPath: `/opt/projects/${slug}`,
    slug,
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const job = project('p-job', 'job', 'Job Search');
const job2 = project('p-job2', 'job-2', 'Job Search 2');
const site = project('p-site', 'site', 'Landing site');

describe('chats belong to projects (ADR 0024)', () => {
  beforeEach(() => {
    resetHermesAgentsStoreForTests();
    resetHermesProjectsStoreForTests();
    resetRunningTurnsForTests();
    resetHermesChatProjectsForTests();
    setSessionCwd.mockClear();
    getDefaultCwd.mockClear();
    for (const p of [job, job2, site]) upsertStoredHermesProject(p);
  });

  describe('projectForCwd', () => {
    it('matches a folder or anything inside it, never a sibling that shares a prefix', () => {
      const all = [job, job2, site];
      expect(projectForCwd('/opt/projects/job', all)?.id).toBe('p-job');
      expect(projectForCwd('/opt/projects/job/src/', all)?.id).toBe('p-job');
      expect(projectForCwd('/opt/projects/job-2/notes', all)?.id).toBe('p-job2');
      expect(projectForCwd('/opt/data', all)).toBeNull();
      expect(projectForCwd(undefined, all)).toBeNull();
    });
  });

  describe('fileThreads', () => {
    it('files unfiled chats once by their last cwd, and keeps what was filed', () => {
      setSessionProjectId('kept', 'p-site');
      const filed = fileThreads([
        { id: 'from-job', title: 'a', cwd: '/opt/projects/job/src' },
        { id: 'from-telegram', title: 'b', cwd: '/opt/data' },
        { id: 'no-cwd', title: 'c' },
        { id: 'kept', title: 'd', cwd: '/opt/projects/job' },
      ]);
      expect(filed.map((t) => [t.id, t.projectId])).toEqual([
        ['from-job', 'p-job'],
        ['from-telegram', null],
        ['no-cwd', null],
        ['kept', 'p-site'],
      ]);
      // The cwd is main's business; it never reaches the renderer.
      expect(filed.every((t) => !('cwd' in t))).toBe(true);
      // Saved: a later cwd no longer moves the chat.
      expect(getSessionProjectId('from-job')).toBe('p-job');
      expect(getSessionProjectId('from-telegram')).toBeNull();
      const again = fileThreads([{ id: 'from-job', title: 'a', cwd: '/opt/projects/site' }]);
      expect(again[0].projectId).toBe('p-job');
    });

    it("files WebUI chats left under No project again from their workspace, once", () => {
      setSessionProjectId('web-job', null);
      setSessionProjectId('web-moved', null);
      setSessionProjectId('web-elsewhere', null);
      setSessionProjectId('tui-job', null);
      // Moved to No project by hand: the mark keeps it there.
      setSessionProjectId('web-moved', 'p-site');
      moveConversationsToProject({ sessionIds: ['web-moved'], projectId: null });
      const threads = [
        { id: 'web-job', title: 'a', source: 'webui', cwd: '/opt/projects/job' },
        { id: 'web-moved', title: 'b', source: 'webui', cwd: '/opt/projects/job' },
        { id: 'web-elsewhere', title: 'c', source: 'webui', cwd: '/opt/projects' },
        { id: 'tui-job', title: 'd', source: 'tui', cwd: '/opt/projects/job' },
      ];
      expect(fileThreads(threads).map((t) => [t.id, t.projectId])).toEqual([
        ['web-job', 'p-job'],
        ['web-moved', null],
        ['web-elsewhere', null],
        ['tui-job', null],
      ]);
      expect(getSessionProjectId('web-job')).toBe('p-job');

      // Once only: a chat moved back to No project afterwards stays there.
      setSessionProjectId('web-job', null);
      expect(fileThreads(threads)[0].projectId).toBeNull();
    });

    it('waits to re-file until a list includes WebUI chats', () => {
      setSessionProjectId('web-job', null);
      fileThreads([{ id: 'other', title: 'x', source: 'boundary', cwd: '/opt/projects/site' }]);
      const [thread] = fileThreads([
        { id: 'web-job', title: 'a', source: 'webui', cwd: '/opt/projects/job' },
      ]);
      expect(thread.projectId).toBe('p-job');
    });

    it('shows a chat whose project was removed as No project, keeping the stored id', () => {
      setSessionProjectId('orphan', 'p-site');
      removeStoredHermesProject('p-site');
      expect(fileThreads([{ id: 'orphan', title: 'x' }])[0].projectId).toBeNull();
      expect(getSessionProjectId('orphan')).toBe('p-site');
    });
  });

  describe('moveConversationsToProject', () => {
    it('re-files a chat and marks the move in its transcript', () => {
      setSessionProjectId('s1', 'p-job');
      const result = moveConversationsToProject({ sessionIds: ['s1'], projectId: 'p-site' });
      expect(result.success).toBe(true);
      expect(result.moved).toEqual([
        expect.objectContaining({ sessionId: 's1', fromProjectId: 'p-job', toProjectId: 'p-site' }),
      ]);
      expect(conversationProjectId('s1')).toBe('p-site');
      expect(listConversationProjectMarks('s1')).toEqual([
        expect.objectContaining({
          kind: 'moved',
          fromProjectId: 'p-job',
          toProjectId: 'p-site',
          fromName: 'Job Search',
          toName: 'Landing site',
        }),
      ]);
    });

    it('leaves chats already in the target alone, and moves to No project', () => {
      setSessionProjectId('a', 'p-job');
      setSessionProjectId('b', null);
      const result = moveConversationsToProject({ sessionIds: ['a', 'b'], projectId: null });
      expect(result.moved.map((m) => m.sessionId)).toEqual(['a']);
      expect(conversationProjectId('a')).toBeNull();
    });

    it("records a DM's move as a folder change", () => {
      setStandingDmSessionId('ana', 'dm-ana');
      setSessionProjectId('dm-ana', 'p-job');
      moveConversationsToProject({ sessionIds: ['dm-ana'], projectId: 'p-site' });
      expect(listSessionProjectMarks('dm-ana')[0].kind).toBe('folder');
    });

    it('refuses while a turn runs, and moves nothing', () => {
      setSessionProjectId('busy', 'p-job');
      setSessionProjectId('idle', 'p-job');
      beginRunningTurn('r1', ['busy'], 'assistant');
      const result = moveConversationsToProject({ sessionIds: ['idle', 'busy'], projectId: 'p-site' });
      expect(result).toMatchObject({ success: false, errorCode: 'running', moved: [] });
      expect(conversationProjectId('idle')).toBe('p-job');
    });

    it('refuses a project that no longer exists', () => {
      const result = moveConversationsToProject({ sessionIds: ['s1'], projectId: 'gone' });
      expect(result).toMatchObject({ success: false, errorCode: 'not-found' });
    });

    it('undoes a move, removing its mark', () => {
      setSessionProjectId('s1', 'p-job');
      const { moved } = moveConversationsToProject({ sessionIds: ['s1'], projectId: 'p-site' });
      expect(undoProjectMove({ moves: moved }).success).toBe(true);
      expect(conversationProjectId('s1')).toBe('p-job');
      expect(listConversationProjectMarks('s1')).toEqual([]);
    });

    it('re-files a chat with no messages quietly', () => {
      setSessionProjectId('draft', 'p-job');
      const { moved } = moveConversationsToProject({
        sessionIds: ['draft'],
        projectId: 'p-site',
        quiet: true,
      });
      expect(moved[0].markId).toBe('');
      expect(listConversationProjectMarks('draft')).toEqual([]);
    });
  });

  describe('a session id that changes keeps its project', () => {
    it('carries the project and its marks to the new id', () => {
      setSessionProjectId('runtime-1', 'p-job');
      moveConversationsToProject({ sessionIds: ['runtime-1'], projectId: 'p-site' });
      migrateSessionInference('runtime-1', 'stored-1');
      expect(conversationProjectId('stored-1')).toBe('p-site');
      expect(listConversationProjectMarks('stored-1')).toHaveLength(1);
    });
  });

  describe('applyConversationFolder', () => {
    it("points the session at its own project's folder, once", async () => {
      setSessionProjectId('s1', 'p-job');
      await applyConversationFolder('s1');
      await applyConversationFolder('s1');
      expect(setSessionCwd).toHaveBeenCalledTimes(1);
      expect(setSessionCwd).toHaveBeenCalledWith('s1', '/opt/projects/job');
    });

    it("uses the gateway's default folder for a chat with no project", async () => {
      setSessionProjectId('s2', null);
      await applyConversationFolder('s2');
      expect(setSessionCwd).toHaveBeenCalledWith('s2', '/opt/data');
    });

    it('sets the new folder on the next turn after a move', async () => {
      setSessionProjectId('s3', 'p-job');
      await applyConversationFolder('s3');
      moveConversationsToProject({ sessionIds: ['s3'], projectId: 'p-site' });
      await applyConversationFolder('s3');
      expect(setSessionCwd).toHaveBeenLastCalledWith('s3', '/opt/projects/site');
    });

    it('finds the project under an id the renderer still holds', async () => {
      setSessionProjectId('stored-9', 'p-site');
      await applyConversationFolder('runtime-9', ['stored-9']);
      expect(setSessionCwd).toHaveBeenCalledWith('runtime-9', '/opt/projects/site');
    });

    it('keeps the turn going when the gateway cannot set a folder', async () => {
      setSessionCwd.mockRejectedValueOnce(new Error('unknown method'));
      setSessionProjectId('s4', 'p-job');
      await expect(applyConversationFolder('s4')).resolves.toBeUndefined();
    });
  });
});
