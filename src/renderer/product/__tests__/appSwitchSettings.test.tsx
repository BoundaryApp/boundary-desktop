import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSwitchEvent } from '../../../shared/types/onboarding';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductSettingsScreen } from '../ProductSettingsScreen';
import { endAppSwitch } from '../../onboarding/appSwitch';

const slot = (modelId: string) => ({
  configured: true,
  endpointUrl: 'http://example.com/v1',
  modelId,
  health: 'reachable' as const,
});
const onLocal = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: { local: slot('qwen3:14b'), openrouter: slot('openai/gpt-4o') },
  appFallbacks: [],
};
const onOpenRouter = { ...onLocal, appDefault: 'openrouter' as const };

const CIRCLE = 'c'.repeat(64);
const BO = 'b'.repeat(64);
const sharedEntry = { slot: 'peer' as const, modelId: 'qwen3-8b', peer: { circleId: CIRCLE, providerId: BO } };
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

function mount() {
  let push: (event: AppSwitchEvent) => void = () => undefined;
  const setAppDefault = deferred<object>();
  const setAppSharedModel = deferred<object>();
  const cancelAppSwitch = deferred<object>();
  const cancel = vi.fn(() => cancelAppSwitch.promise);
  stubElectronAPI({
    onboarding: {
      getStatus: vi.fn().mockResolvedValue(onLocal),
      getAppSwitch: vi.fn().mockResolvedValue({ appSwitch: null }),
      onAppSwitch: vi.fn((listener: (event: AppSwitchEvent) => void) => {
        push = listener;
        return () => undefined;
      }),
      setAppDefault: vi.fn(() => setAppDefault.promise),
      setAppSharedModel: vi.fn(() => setAppSharedModel.promise),
      cancelAppSwitch: cancel,
      probeSlotHealth: vi.fn().mockResolvedValue({}),
      listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    },
    circles: { getState: vi.fn().mockResolvedValue(circleState) },
  });
  render(<ProductSettingsScreen onBack={() => undefined} initialTab="general" />);
  return { push: (event: AppSwitchEvent) => act(() => push(event)), setAppDefault, setAppSharedModel, cancelAppSwitch, cancel };
}

// The first match: a shared model is listed again under Fallbacks.
const choice = async (name: RegExp) => (await screen.findAllByRole('button', { name }))[0];
const stageEvent = (stage: 'applying' | 'restarting' | 'starting') => ({
  appSwitch: {
    target: { slot: 'openrouter' as const },
    previous: { slot: 'local' as const },
    phase: 'switching' as const,
    stage,
  },
});

afterEach(() => {
  endAppSwitch();
  cleanup();
});

describe('switching the app default in Settings', () => {
  it('moves the choice at once and shows real stages under the model being switched to', async () => {
    const { push, setAppDefault } = mount();
    const openRouter = await choice(/OpenRouter · openai/);
    const local = await choice(/Local · qwen3/);
    expect(local.className).toContain('is-on');

    fireEvent.click(openRouter);
    expect(openRouter.className).toContain('is-on');
    expect(local.className).not.toContain('is-on');
    const bar = screen.getByRole('progressbar', { name: 'Switching model' });
    expect(openRouter.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect((local as HTMLButtonElement).disabled).toBe(true);

    push(stageEvent('restarting'));
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3');
    expect(screen.getByText('Restarting the assistant…')).toBeTruthy();

    await act(async () => {
      setAppDefault.resolve({ success: true, status: onOpenRouter });
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(await screen.findByText('App default updated.')).toBeTruthy();
    expect(openRouter.className).toContain('is-on');
  });

  it('Cancel returns to the previous model before main has answered', async () => {
    const { push, setAppDefault, cancelAppSwitch, cancel } = mount();
    const openRouter = await choice(/OpenRouter · openai/);
    const local = await choice(/Local · qwen3/);
    fireEvent.click(openRouter);
    push(stageEvent('applying'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(local.className).toContain('is-on');
    expect(openRouter.className).not.toContain('is-on');
    expect(screen.getByRole('progressbar', { name: 'Going back to the previous model' })).toBeTruthy();
    expect(screen.getByText('Cancelled. Going back to this model…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    // A stage main sent before it heard the Cancel doesn't bring the target back.
    push(stageEvent('restarting'));
    expect(local.className).toContain('is-on');

    await act(async () => {
      cancelAppSwitch.resolve({ success: true, status: onLocal });
      setAppDefault.resolve({ success: true, cancelled: true, status: onLocal });
    });
    expect(screen.queryByText('App default updated.')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();

    push({ appSwitch: null });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect((local as HTMLButtonElement).disabled).toBe(false);
  });

  it('says a restart under way finishes and runs again', async () => {
    const { push, cancelAppSwitch } = mount();
    fireEvent.click(await choice(/OpenRouter · openai/));
    push(stageEvent('starting'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/already restarting, so it finishes and then restarts once more/)).toBeTruthy();
    await act(async () => cancelAppSwitch.resolve({ success: true, status: onLocal }));
  });

  it('shows a failure to go back', async () => {
    const { push } = mount();
    await choice(/OpenRouter · openai/);
    push({ appSwitch: null, error: 'The previous model is saved, but the assistant didn’t go back to it: down' });
    expect(screen.getByRole('alert').textContent).toMatch(/didn’t go back to it/);
  });

  it('works the same for a shared model', async () => {
    const { push, cancelAppSwitch } = mount();
    const shared = await choice(/Bo's qwen3-8b/);
    const local = await choice(/Local · qwen3/);
    fireEvent.click(shared);
    expect(shared.className).toContain('is-on');
    expect(local.className).not.toContain('is-on');
    expect(shared.nextElementSibling?.querySelector('[role="progressbar"]')).toBeTruthy();

    push({ appSwitch: { target: sharedEntry, previous: { slot: 'local' }, phase: 'switching', stage: 'applying' } });
    fireEvent.click(within(shared.parentElement!).getByRole('button', { name: 'Cancel' }));
    expect(local.className).toContain('is-on');
    expect(shared.className).not.toContain('is-on');
    await act(async () => cancelAppSwitch.resolve({ success: true, status: onLocal }));
  });

  it('goes back to a shared model on Cancel', async () => {
    const { push } = mount();
    const shared = await choice(/Bo's qwen3-8b/);
    const openRouter = await choice(/OpenRouter · openai/);
    push({ appSwitch: { target: { slot: 'openrouter' }, previous: sharedEntry, phase: 'reverting', stage: 'applying' } });
    expect(shared.className).toContain('is-on');
    expect(openRouter.className).not.toContain('is-on');
    expect(shared.nextElementSibling?.querySelector('[role="progressbar"]')).toBeTruthy();
  });

  it('says a running reply holds the move until the next message', async () => {
    const { setAppDefault } = mount();
    fireEvent.click(await choice(/OpenRouter · openai/));
    await act(async () => {
      setAppDefault.resolve({ success: true, deferred: true, status: onOpenRouter });
    });
    expect(await screen.findByText(/A reply is still running, so the assistant moves on your next message/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows a switch still running when Settings opens', async () => {
    const { push } = mount();
    await choice(/OpenRouter · openai/);
    push(stageEvent('starting'));
    cleanup();
    render(<ProductSettingsScreen onBack={() => undefined} initialTab="general" />);
    expect(await screen.findByRole('progressbar')).toBeTruthy();
  });
});
