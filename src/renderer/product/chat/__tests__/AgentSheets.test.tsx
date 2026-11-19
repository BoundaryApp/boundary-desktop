import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';
import { AgentCreateSheet } from '../AgentSheets';
import { useAgentSheets } from '../useAgentSheets';

const create = vi.fn();
const update = vi.fn();
const setWritingVoices = vi.fn();

const plain: WritingVoiceView = {
  id: 'plain',
  name: 'Plain',
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: '',
  calibratedAt: null,
  sampleHash: '',
  style: null,
  samplesChanged: false,
  step: null,
};

beforeEach(() => {
  for (const fn of [create, update, setWritingVoices]) fn.mockReset();
  setWritingVoices.mockResolvedValue({ success: true, agent: {} });
  stubElectronAPI({
    agents: {
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
      setWritingVoices: (...a: unknown[]) => setWritingVoices(...a),
    },
    writingVoices: {
      list: vi.fn().mockResolvedValue({ success: true, voices: [plain] }),
      onProgress: () => (): void => undefined,
    },
  });
});

describe('AgentCreateSheet writing voices', () => {
  it('sends the picked voices with the new agent', async () => {
    const onCreate = vi.fn();
    render(<AgentCreateSheet open onCancel={vi.fn()} onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Juniper' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Gardens.' } });
    await screen.findAllByRole('option', { name: 'Plain' });
    fireEvent.change(screen.getByLabelText('Chat replies'), { target: { value: 'plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voices: { chatRepliesVoiceId: 'plain', draftsVoiceId: null } })
    );
  });

  it('starts from the agent’s voices when editing', async () => {
    render(
      <AgentCreateSheet
        open
        mode="edit"
        initialValues={{ displayName: 'Juniper', role: 'Gardens.', voices: { chatRepliesVoiceId: null, draftsVoiceId: 'plain' } }}
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    );
    await screen.findAllByRole('option', { name: 'Plain' });
    expect((screen.getByLabelText('Drafts') as HTMLSelectElement).value).toBe('plain');
  });
});

describe('useAgentSheets writing voices', () => {
  const lists = { refreshAgents: vi.fn(async () => undefined), setThreadError: vi.fn() };
  const openDm = vi.fn(async () => 'dm');

  it('sets voices after creating an agent that has some', async () => {
    create.mockResolvedValue({ success: true, agent: { slug: 'juniper' } });
    const { result } = renderHook(() => useAgentSheets({ lists, openDm }));
    await act(async () => {
      result.current.create.submit({
        displayName: 'Juniper',
        handle: 'juniper',
        role: 'Gardens.',
        voices: { chatRepliesVoiceId: 'plain', draftsVoiceId: null },
      });
    });
    expect(setWritingVoices).toHaveBeenCalledWith('juniper', { chatRepliesVoiceId: 'plain', draftsVoiceId: null });
  });

  it('leaves voices alone when a new agent has none', async () => {
    create.mockResolvedValue({ success: true, agent: { slug: 'juniper' } });
    const { result } = renderHook(() => useAgentSheets({ lists, openDm }));
    await act(async () => {
      result.current.create.submit({
        displayName: 'Juniper',
        handle: 'juniper',
        role: 'Gardens.',
        voices: { chatRepliesVoiceId: null, draftsVoiceId: null },
      });
    });
    expect(setWritingVoices).not.toHaveBeenCalled();
  });

  it('saves changed voices on edit and shows a failure in the chat', async () => {
    update.mockResolvedValue({ success: true });
    setWritingVoices.mockResolvedValue({ success: false, error: "Pick a voice that's ready." });
    const { result } = renderHook(() => useAgentSheets({ lists, openDm }));
    act(() =>
      result.current.startEdit({
        slug: 'juniper',
        displayName: 'Juniper',
        handle: 'juniper',
        role: 'Gardens.',
        builtIn: false,
        createdAt: '',
        chatRepliesVoiceId: null,
        draftsVoiceId: null,
      })
    );
    await act(async () => {
      result.current.create.submit({
        displayName: 'Juniper',
        handle: 'juniper',
        role: 'Gardens.',
        voices: { chatRepliesVoiceId: null, draftsVoiceId: 'plain' },
      });
    });
    expect(setWritingVoices).toHaveBeenCalledWith('juniper', { chatRepliesVoiceId: null, draftsVoiceId: 'plain' });
    expect(lists.setThreadError).toHaveBeenCalledWith("Pick a voice that's ready.");
  });
});
