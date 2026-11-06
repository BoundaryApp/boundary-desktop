import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import type { InferenceStack } from '../../../../shared/types/inferenceChain';
import { localDay } from '../../../../shared/circleUsage';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { InferenceScreen } from '../InferenceScreen';

const CIRCLE = 'c'.repeat(64);
const MAYA = 'b'.repeat(64);
const maya = { slot: 'peer' as const, modelId: 'qwen3-32b', peer: { circleId: CIRCLE, providerId: MAYA } };
const MAYA_KEY = `peer:${CIRCLE}:${MAYA}:qwen3-32b`;

function circles(trusted: boolean): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: { [MAYA]: { private: false, trusted } },
    sharing: { models: [], circles: [], paused: false, away: false },
    snapshot: {
      identity: 'a'.repeat(64),
      circles: [
        {
          key: CIRCLE,
          name: 'Book club',
          myRole: 'member',
          writable: true,
          needsUpdate: false,
          members: [],
          invites: [],
          offers: [
            {
              identity: MAYA,
              name: 'Maya',
              isMine: false,
              models: [{ id: 'qwen3-32b', tools: true, contextLength: 32_768 }],
              available: true,
              away: false,
              online: true,
            },
          ],
        },
      ],
    },
  } as CirclesState;
}

const slots = {
  local: { configured: true, modelId: 'qwen3-8b', provider: 'local', health: 'reachable' },
  openrouter: { configured: true, modelId: 'anthropic/claude', provider: 'openrouter', health: 'reachable' },
};
const status = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local',
  appFallbacks: [maya, { slot: 'openrouter' }],
  slots,
};

function stack(untrusted: boolean): InferenceStack {
  return {
    entries: [
      { entry: { slot: 'local' }, key: 'local:', stale: null, private: true, privateCut: false, contextLength: 8_192 },
      {
        entry: maya,
        key: MAYA_KEY,
        stale: untrusted ? 'provider-untrusted' : null,
        private: false,
        privateCut: true,
        contextLength: 32_768,
      },
      { entry: { slot: 'openrouter' }, key: 'openrouter:', stale: null, private: false, privateCut: true, contextLength: 200_000 },
    ],
    contextLength: 8_192,
    noPrivate: false,
  };
}

let api: ReturnType<typeof stubElectronAPI>;

function setUp({ untrusted = false, fallbacks = status.appFallbacks as unknown[] } = {}) {
  api = stubElectronAPI({
    onboarding: {
      getStatus: vi.fn().mockResolvedValue({ ...status, appFallbacks: fallbacks }),
      describeAppStack: vi.fn().mockResolvedValue(stack(untrusted)),
      setAppFallbacks: vi.fn().mockResolvedValue({ success: true, status }),
      setAppDefault: vi.fn().mockResolvedValue({ success: true, status }),
      setAppSharedModel: vi.fn().mockResolvedValue({ success: true, status }),
      listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    },
    circles: {
      getState: vi.fn().mockResolvedValue(circles(!untrusted)),
      setProviderSettings: vi.fn().mockResolvedValue({ success: true, state: circles(true) }),
    },
  });
}

const rungs = () => within(screen.getByRole('list', { name: 'Model stack, first to last' })).getAllByRole('listitem');

describe('Inference', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws the stack in order, with where private projects stop and the context limit', async () => {
    setUp();
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    expect(rungs().map((row) => row.querySelector('b')?.textContent)).toEqual([
      expect.stringContaining('qwen3-8b'),
      expect.stringContaining('Maya'),
      expect.stringContaining('claude'),
    ]);
    // The line sits after the last entry a private project may use.
    expect(within(rungs()[0]).getByText('Private projects stop here')).toBeTruthy();
    expect(screen.getAllByText('Private projects stop here')).toHaveLength(1);
    expect(screen.getByText(/Replies are limited to 8K of context/)).toBeTruthy();
  });

  it('saves the fallbacks alone when the first model stays, and switches when it changes', async () => {
    setUp();
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /Move OpenRouter.* up/ }));
    await waitFor(() =>
      expect(api.onboarding.setAppFallbacks).toHaveBeenCalledWith({ fallbacks: [{ slot: 'openrouter' }, maya] })
    );
    expect(api.onboarding.setAppDefault).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Move Maya.* up/ }));
    await waitFor(() => expect(api.onboarding.setAppSharedModel).toHaveBeenCalledWith({ entry: maya }));
    await waitFor(() =>
      expect(api.onboarding.setAppFallbacks).toHaveBeenLastCalledWith({ fallbacks: [{ slot: 'local' }, { slot: 'openrouter' }] })
    );
    // The switch goes first, so the fallbacks are saved after it.
    const switched = vi.mocked(api.onboarding.setAppSharedModel).mock.invocationCallOrder[0];
    expect(vi.mocked(api.onboarding.setAppFallbacks).mock.invocationCallOrder.at(-1)).toBeGreaterThan(switched);
  });

  it('leaves the stack alone when the switch fails', async () => {
    setUp();
    vi.mocked(api.onboarding.setAppSharedModel).mockResolvedValueOnce({ success: false, error: 'Maya is offline.', status } as never);
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /Move Maya.* up/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Maya is offline.');
    expect(api.onboarding.setAppFallbacks).not.toHaveBeenCalled();
  });

  it('runs a request through the stack without sending it', async () => {
    setUp({ untrusted: true });
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('status').textContent).toMatch(/Answered by .*qwen3-8b.*Nothing was sent/);

    fireEvent.click(screen.getByRole('checkbox', { name: 'From a private project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('status').textContent).toMatch(/Answered by .*qwen3-8b/);
    expect(api.onboarding.sendLlmTestMessage).not.toHaveBeenCalled();
  });

  it('adds a connected model to the end of the stack', async () => {
    setUp({ fallbacks: [] });
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    const sheet = screen.getByRole('list', { name: 'Models you can add' });
    fireEvent.click(within(within(sheet).getByText(/OpenRouter/).closest('li')!).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.onboarding.setAppFallbacks).toHaveBeenCalledWith({ fallbacks: [{ slot: 'openrouter' }] }));
    expect(api.onboarding.setAppDefault).not.toHaveBeenCalled();
  });

  it('says when every connected model is already in the stack', async () => {
    setUp();
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    expect(screen.getByText(/Every connected model is already in the stack/)).toBeTruthy();
  });

  it('offers the fix on the entry that needs it', async () => {
    setUp({ untrusted: true });
    render(<InferenceScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Trust Maya' }));
    expect(api.circles.setProviderSettings).toHaveBeenCalledWith({ identity: MAYA, private: false, trusted: true });
  });

  it('lists what each person shares, with their trust beside it', async () => {
    setUp();
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(within(person).getByRole('button', { name: 'In your stack' })).toHaveProperty('disabled', true);
    expect(within(person).getByRole('switch', { name: 'Trusted' })).toBeTruthy();
  });

  it('says what the user used of a person’s models today', async () => {
    setUp();
    api.circles.getState.mockResolvedValue({
      ...circles(true),
      used: { day: localDay(new Date()), counts: { [MAYA]: { requests: 3, tokens: 4200 } } },
    });
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(await within(person).findByText('You used 3 requests and 4K tokens today.')).toBeTruthy();
  });
});

describe('Inference from a link', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => cleanup());

  it('marks the person the link named', async () => {
    setUp();
    render(<InferenceScreen focusPerson={{ person: MAYA, seq: 1 }} />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(person.className).toContain('is-focused');
  });
});
