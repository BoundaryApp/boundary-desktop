import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

const listProjects = vi.fn();
const selectProject = vi.fn();

stubElectronAPI({
  projects: {
    list: (...args: unknown[]) => listProjects(...args),
    select: (...args: unknown[]) => selectProject(...args),
  },
  hermesChat: {
    listProjectMarks: vi.fn(async () => []),
  },
});

import { useProjects } from '../useProjects';

function renderProjects() {
  const lists = { threads: [], setThreads: vi.fn(), setChannels: vi.fn(), agents: [] };
  return renderHook(
    ({ activeThreadId }: { activeThreadId: string | null }) =>
      useProjects({
        cached: null,
        ids: { activeThreadId, sameChat: (a, b) => Boolean(a && a === b) },
        lists,
        activeAgent: null,
        showCenter: vi.fn(),
      }),
    { initialProps: { activeThreadId: 't-site' as string | null } }
  );
}

describe('useProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjects.mockResolvedValue({ success: true, activeId: 'p1', projects: [] });
    selectProject.mockResolvedValue({ success: true });
  });

  it('follows the open chat without selecting in main, and catches main up for an empty composer', async () => {
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.activeProjectId).toBe('p1'));

    act(() => result.current.followProject('p2'));
    expect(result.current.activeProjectId).toBe('p2');
    expect(selectProject).not.toHaveBeenCalled();

    // Nothing open: the next send starts a chat in main's active project.
    rerender({ activeThreadId: null });
    await waitFor(() => expect(selectProject).toHaveBeenCalledWith({ projectId: 'p2' }));
  });
});
