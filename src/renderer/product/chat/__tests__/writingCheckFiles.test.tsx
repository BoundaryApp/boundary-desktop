import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import type { WritingCheckFileResult } from '../../../../shared/types/writingCheck';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { WritingCheckPane, type WritingCheckRequest } from '../WritingCheckPane';
import { useWritingCheck } from '../useWritingCheck';

let bridge: FakeBridge;
let chat: FakeHermesChat;
const readFileForCheck = vi.fn<(p: { projectId: string; relativePath: string }) => Promise<WritingCheckFileResult>>();
const pickFileForCheck = vi.fn<(p: { projectId: string }) => Promise<WritingCheckFileResult>>();

const project = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Job Search',
  containerPath: '/opt/projects/job-search',
} as HermesProjectRecord;

const LETTER = 'Great question! I hope this helps.';
const MODIFIED = '2026-11-11T10:42:00.000Z';

beforeEach(() => {
  readFileForCheck.mockReset();
  pickFileForCheck.mockReset();
  ({ bridge, chat } = installChatBridge('s1', {
    // The pane asks whether the detector add-on is on; here it isn't.
    writingCheck: {
      detectorStatus: async () => ({ available: false }),
      readFile: readFileForCheck,
      pickFile: pickFileForCheck,
    },
  }));
  chat.history = [
    { role: 'user', content: 'Write the letters', rowId: 1 },
    {
      role: 'assistant',
      content: 'Done.',
      rowId: 2,
      files: ['/opt/projects/job-search/letters/acme.md', '/opt/projects/job-search/photo.png'],
    },
  ];
});

afterEach(async () => {
  await ipcCalls.settle();
  cleanup();
  expect(bridge.unfaked).toEqual([]);
});

describe('Check on a file the agent wrote', () => {
  it('appears beside text files only and asks for that file', async () => {
    const onCheckProjectFile = vi.fn();
    render(
      <HostedChatRuntime sessionId="s1">
        <WorkbenchThread
          {...threadProps({
            sessionId: 's1',
            activeProject: project,
            projects: [project],
            activeProjectId: 'p1',
            onCheckProjectFile,
          })}
        />
      </HostedChatRuntime>
    );
    await ipcCalls.settle();
    const files = within(screen.getByLabelText('Files written'));
    const rows = files.getAllByRole('listitem');
    expect(within(rows[0]).getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(within(rows[1]).queryByRole('button', { name: 'Check' })).toBeNull();
    await act(async () => fireEvent.click(within(rows[0]).getByRole('button', { name: 'Check' })));
    expect(onCheckProjectFile).toHaveBeenCalledWith('p1', 'letters/acme.md');
  });
});

describe('useWritingCheck with files', () => {
  it('reads the file and sends its text, path and time to the pane', async () => {
    readFileForCheck.mockResolvedValue({
      success: true,
      file: { relativePath: 'letters/acme.md', text: LETTER, modifiedAt: MODIFIED },
    });
    const { result } = renderHook(() => useWritingCheck('t1'));
    await act(async () => result.current.checkFile('p1', 'letters/acme.md'));
    expect(readFileForCheck).toHaveBeenCalledWith({ projectId: 'p1', relativePath: 'letters/acme.md' });
    expect(result.current.check).toMatchObject({
      seq: 1,
      markdown: LETTER,
      source: 'letters/acme.md',
      file: { projectId: 'p1', relativePath: 'letters/acme.md', modifiedAt: MODIFIED },
    });
  });

  it('shows a refusal in the pane instead of a result', async () => {
    readFileForCheck.mockResolvedValue({ success: false, error: 'That file is outside the project folder.' });
    const { result } = renderHook(() => useWritingCheck('t1'));
    await act(async () => result.current.checkFile('p1', '../x.md'));
    expect(result.current.check).toMatchObject({ error: 'That file is outside the project folder.', markdown: '' });
  });

  it('opens the picker and leaves the pane alone on cancel', async () => {
    pickFileForCheck.mockResolvedValue({ success: false, canceled: true });
    const { result } = renderHook(() => useWritingCheck('t1'));
    await act(async () => result.current.pickFile('p1'));
    expect(pickFileForCheck).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(result.current.check).toBeNull();
  });
});

describe('The pane for a file', () => {
  const fileCheck = (extra: Partial<WritingCheckRequest> = {}): WritingCheckRequest => ({
    seq: 1,
    messageId: '',
    markdown: LETTER,
    source: 'letters/acme.md',
    file: { projectId: 'p1', relativePath: 'letters/acme.md', modifiedAt: MODIFIED },
    ...extra,
  });

  it('names the file and when it changed, and checks it again on request', async () => {
    const onRecheckFile = vi.fn();
    render(
      <WritingCheckPane check={fileCheck()} onClose={vi.fn()} onShowReply={vi.fn()} onRecheckFile={onRecheckFile} />
    );
    expect(screen.getByText('letters/acme.md')).toBeTruthy();
    expect(screen.getByText(/^modified /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show in chat' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check again' })));
    expect(onRecheckFile).toHaveBeenCalledWith({ projectId: 'p1', relativePath: 'letters/acme.md', modifiedAt: MODIFIED });
  });

  it('shows a refusal and no result', () => {
    render(
      <WritingCheckPane
        check={fileCheck({ markdown: '', error: 'That file is over 1 MB, too large to check.' })}
        onClose={vi.fn()}
        onShowReply={vi.fn()}
        onRecheckFile={vi.fn()}
      />
    );
    expect(screen.getByRole('alert').textContent).toBe('That file is over 1 MB, too large to check.');
    expect(screen.queryByTestId('check-count')).toBeNull();
  });
});
