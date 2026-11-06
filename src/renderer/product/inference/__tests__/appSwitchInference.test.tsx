import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSwitchEvent } from '../../../../shared/types/onboarding';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { endAppSwitch } from '../../../onboarding/appSwitch';
import { InferenceScreen } from '../InferenceScreen';

const slot = (modelId: string) => ({
  configured: true,
  endpointUrl: 'http://example.com/v1',
  modelId,
  health: 'reachable' as const,
});
const CIRCLE = 'c'.repeat(64);
const BO = 'b'.repeat(64);
const sharedEntry = { slot: 'peer' as const, modelId: 'qwen3-8b', peer: { circleId: CIRCLE, providerId: BO } };
const onLocal = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: { local: slot('qwen3:14b'), openrouter: slot('openai/gpt-4o') },
  appFallbacks: [{ slot: 'openrouter' as const }, sharedEntry],
};
const onOpenRouter = { ...onLocal, appDefault: 'openrouter' as const, appFallbacks: [{ slot: 'local' as const }, sharedEntry] };
const circleState = {
  status: 'running',
  displayName: 'Ada',
  providers: { [BO]: { private: false, trusted: true } },
  sharing: { models: [], circles: [], paused: false, away: false },
  snapshot: {
    identity: 'a'.repeat(64),
    circles: [
      {
        key: CIRCLE,
        name: 'Workshop',
        myRole: 'member',
        writable: true,
        needsUpdate: false,
        members: [],
        invites: [],
        offers: [
          {
            identity: BO,
            name: 'Bo',
            isMine: false,
            models: [{ id: 'qwen3-8b', tools: true, contextLength: 16_384 }],
            available: true,
            away: false,
            online: true,
          },
        ],
      },
    ],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let current: typeof onLocal | typeof onOpenRouter = onLocal;

function mount() {
  current = onLocal;
  let push: (event: AppSwitchEvent) => void = () => undefined;
  const setAppDefault = deferred<object>();
  const setAppSharedModel = deferred<object>();
  const cancelAppSwitch = deferred<object>();
  const cancel = vi.fn(() => cancelAppSwitch.promise);
  const keep = (result: object) => {
    const status = (result as { status?: typeof current }).status;
    if (status) current = status;
    return result;
  };
  stubElectronAPI({
    onboarding: {
      getStatus: vi.fn().mockResolvedValue(onLocal),
      describeAppStack: vi.fn().mockResolvedValue({ entries: [], noPrivate: false }),
      getAppSwitch: vi.fn().mockResolvedValue({ appSwitch: null }),
      onAppSwitch: vi.fn((listener: (event: AppSwitchEvent) => void) => {
        push = listener;
        return () => undefined;
      }),
      setAppDefault: vi.fn(() => setAppDefault.promise.then(keep)),
      setAppSharedModel: vi.fn(() => setAppSharedModel.promise.then(keep)),
      // Saves what it's given, so a second move starts from the first one's result.
      setAppFallbacks: vi.fn(async ({ fallbacks }: { fallbacks: unknown[] }) => {
        current = { ...current, appFallbacks: fallbacks as typeof current.appFallbacks };
        return { success: true, status: current };
      }),
      cancelAppSwitch: cancel,
      probeSlotHealth: vi.fn().mockResolvedValue({}),
      listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    },
    circles: { getState: vi.fn().mockResolvedValue(circleState) },
  });
  render(<InferenceScreen />);
  return { push: (event: AppSwitchEvent) => act(() => push(event)), setAppDefault, setAppSharedModel, cancelAppSwitch, cancel };
}

const stack = () => screen.getByRole('list', { name: 'Model stack, first to last' });
const firstModel = () => within(stack()).getAllByRole('listitem')[0].querySelector('b')?.textContent ?? '';
const moveUp = async (name: RegExp) => (await screen.findAllByRole('button', { name }))[0];
const stageEvent = (stage: 'applying' | 'restarting' | 'starting') => ({
  appSwitch: {
    target: { slot: 'openrouter' as const },
    previous: { slot: 'local' as const },
    phase: 'switching' as const,
    stage,
  },
});

beforeEach(() => resetIpcStoresForTests());
afterEach(() => {
  endAppSwitch();
  cleanup();
});

describe('changing the first model in Inference', () => {
  it('draws the new first model at once and shows real stages under it', async () => {
    const { push, setAppDefault } = mount();
    fireEvent.click(await moveUp(/Move OpenRouter.* up/));
    expect(firstModel()).toMatch(/OpenRouter/);
    const bar = screen.getByRole('progressbar', { name: 'Switching model' });
    expect(within(stack()).getAllByRole('listitem')[0].contains(bar)).toBe(true);
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect((screen.getByRole('button', { name: /Move Local.* down/ }) as HTMLButtonElement).disabled).toBe(true);

    push(stageEvent('restarting'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByText('Restarting the assistant…')).toBeTruthy();

    await act(async () => {
      setAppDefault.resolve({ success: true, status: onOpenRouter });
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(await screen.findByText('Saved. The assistant now starts with the first model.')).toBeTruthy();
    expect(firstModel()).toMatch(/OpenRouter/);
  });

  it('Cancel draws the previous model first again before main has answered', async () => {
    const { push, setAppDefault, cancelAppSwitch, cancel } = mount();
    fireEvent.click(await moveUp(/Move OpenRouter.* up/));
    push(stageEvent('applying'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(firstModel()).toMatch(/Local/);
    expect(screen.getByRole('progressbar', { name: 'Going back to the previous model' })).toBeTruthy();
    expect(screen.getByText('Cancelled. Going back to this model…')).toBeTruthy();

    // A stage main sent before it heard the Cancel doesn't bring the target back.
    push(stageEvent('restarting'));
    expect(firstModel()).toMatch(/Local/);

    await act(async () => {
      cancelAppSwitch.resolve({ success: true, status: onLocal });
      setAppDefault.resolve({ success: true, cancelled: true, status: onLocal });
    });
    expect(screen.queryByText(/Saved\./)).toBeNull();
    push({ appSwitch: null });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect((screen.getByRole('button', { name: /Move Local.* down/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a restart under way finishes and runs again', async () => {
    const { push, cancelAppSwitch } = mount();
    fireEvent.click(await moveUp(/Move OpenRouter.* up/));
    push(stageEvent('starting'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/already restarting, so it finishes and then restarts once more/)).toBeTruthy();
    await act(async () => cancelAppSwitch.resolve({ success: true, status: onLocal }));
  });

  it('shows a failure to go back', async () => {
    const { push } = mount();
    await moveUp(/Move OpenRouter.* up/);
    push({ appSwitch: null, error: 'The previous model is saved, but the assistant didn’t go back to it: down' });
    expect(screen.getByRole('alert').textContent).toMatch(/didn’t go back to it/);
  });

  it('works the same for a shared model', async () => {
    const { push, cancelAppSwitch } = mount();
    fireEvent.click(await moveUp(/Move Bo's qwen3-8b up/));
    fireEvent.click(await moveUp(/Move Bo's qwen3-8b up/));
    expect(firstModel()).toMatch(/Bo's qwen3-8b/);
    expect(within(stack()).getAllByRole('listitem')[0].querySelector('[role="progressbar"]')).toBeTruthy();

    push({ appSwitch: { target: sharedEntry, previous: { slot: 'local' }, phase: 'switching', stage: 'applying' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(firstModel()).toMatch(/Local/);
    await act(async () => cancelAppSwitch.resolve({ success: true, status: onLocal }));
  });

  it('goes back to a shared model on Cancel', async () => {
    const { push } = mount();
    await moveUp(/Move OpenRouter.* up/);
    push({ appSwitch: { target: { slot: 'openrouter' }, previous: sharedEntry, phase: 'reverting', stage: 'applying' } });
    expect(firstModel()).toMatch(/Bo's qwen3-8b/);
    expect(within(stack()).getAllByRole('listitem')[0].querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it('says a running reply holds the move until the next message', async () => {
    const { setAppDefault } = mount();
    fireEvent.click(await moveUp(/Move OpenRouter.* up/));
    await act(async () => {
      setAppDefault.resolve({ success: true, deferred: true, status: onOpenRouter });
    });
    expect(await screen.findByText(/A reply is still running, so the change applies to your next message/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows a switch still running when Inference opens', async () => {
    const { push } = mount();
    await moveUp(/Move OpenRouter.* up/);
    push(stageEvent('starting'));
    cleanup();
    render(<InferenceScreen />);
    expect(await screen.findByRole('progressbar')).toBeTruthy();
  });
});
