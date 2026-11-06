import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleSharing, CirclesState } from '../../../../shared/types/circles';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { useAppCommand } from '../../useAppShortcuts';
import { CircleSharingLine, CircleSharingPanel } from '../CircleSharingPanel';
import { useCirclesState } from '../useCircles';

const getStatus = vi.fn();
const getState = vi.fn();
const setSharing = vi.fn();
const listConfiguredEndpointModels = vi.fn();
const push = vi.hoisted(() => ({ current: null as ((state: unknown) => void) | null }));
stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    setSharing: (...args: unknown[]) => setSharing(...args),
    onState: (cb: (state: unknown) => void) => {
      push.current = cb;
      return () => undefined;
    },
  },
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    listConfiguredEndpointModels: (...args: unknown[]) => listConfiguredEndpointModels(...args),
  },
});

const A = 'a'.repeat(64);
const SHARING: CircleSharing = { models: [{ id: 'qwen3-8b', tools: true }], circles: [A], paused: false, away: false };
const NOT_SHARING: CircleSharing = { models: [], circles: [], paused: false, away: false };

function state(sharing: CircleSharing, overrides: Partial<CirclesState> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: {},
    sharing,
    snapshot: {
      identity: 'f'.repeat(64),
      circles: [{ key: A, name: 'Workshop', myRole: 'member', writable: true, members: [], invites: [], offers: [] }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listConfiguredEndpointModels.mockResolvedValue({ success: true, models: [{ id: 'qwen3-8b', contextLength: 32768 }, { id: 'gemma' }] });
  getStatus.mockResolvedValue({ configured: true, slots: { local: { configured: true, modelId: 'qwen3-8b', health: 'reachable' } } });
});
afterEach(() => cleanup());

describe('CircleSharingLine', () => {
  it.each([
    ['someone in no Circle', state(NOT_SHARING, { snapshot: { identity: '', circles: [] } }), 'Not sharing. Create or join a Circle to share this model.'],
    ['someone sharing nothing', state(NOT_SHARING), 'Not sharing with your Circles.'],
    ['paused', state({ ...SHARING, paused: true }), "Paused: members can't use your models."],
    ['sharing', state(SHARING), 'Shared with Workshop.'],
    ['sharing in away mode', state({ ...SHARING, away: true }), 'Shared with Workshop, with away mode on.'],
  ])('says the state for %s', async (_name, circles, text) => {
    render(<CircleSharingLine circles={circles} />);
    expect(await screen.findByText(text)).toBeTruthy();
  });
});

describe('Shared from this Mac', () => {
  const SHARED: CircleSharing = { models: [{ id: 'qwen3-8b', tools: true, contextLength: 32768 }], circles: [A], paused: false, away: false };
  const local = { configured: true, endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3-8b', health: 'reachable' };
  const unreachable = { configured: true, slots: { local: { ...local, health: 'unreachable' } } };
  beforeEach(() => getStatus.mockResolvedValue({ configured: true, slots: { local } }));
  const withBo = (sharing: CircleSharing, overrides: Partial<CirclesState> = {}): CirclesState => {
    const base = state(sharing, overrides);
    const [circle] = base.snapshot.circles;
    return {
      ...base,
      snapshot: {
        ...base.snapshot,
        circles: [
          {
            ...circle,
            members: [
              { identity: 'f'.repeat(64), name: 'Ada', role: 'member', isMe: true, online: true },
              { identity: 'b'.repeat(64), name: 'Bo', role: 'member', isMe: false, online: true },
            ],
          },
        ],
      },
    };
  };

  /** The panel as Inference mounts it, kept current from pushed state. */
  function Panel() {
    const circles = useCirclesState();
    return circles.status === 'stopped' ? null : <CircleSharingPanel circles={circles} />;
  }

  /** Mount with this sharing; `setSharing` answers as main does, by pushing the new state. */
  async function mount(sharing: CircleSharing, overrides: Partial<CirclesState> = {}) {
    const circles = withBo(sharing, overrides);
    getState.mockResolvedValue(circles);
    setSharing.mockImplementation(async (next: CircleSharing) => {
      const pushed = { ...circles, sharing: next };
      push.current?.(pushed);
      return { success: true, state: pushed };
    });
    render(<Panel />);
    return screen.findByRole('group', { name: 'Shared from this Mac' });
  }

  it('takes someone sharing nothing through a model and a Circle', async () => {
    const panel = await mount(NOT_SHARING);
    expect(within(panel).getByText(/You aren't sharing a model/)).toBeTruthy();
    expect(await within(panel).findByText('32K context')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Pause sharing' })).toBeNull();

    await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: /qwen3-8b/ })));
    expect(setSharing).toHaveBeenLastCalledWith({ ...NOT_SHARING, models: SHARED.models });
    expect(within(panel).getByText(/Turn on a Circle below/)).toBeTruthy();

    await act(async () => fireEvent.click(within(panel).getByRole('switch', { name: 'Share with Workshop' })));
    expect(setSharing).toHaveBeenLastCalledWith(SHARED);
    expect(within(panel).getByText(/Members of Workshop can use this model while .+ is open\./)).toBeTruthy();
  });

  it('pauses and resumes', async () => {
    const panel = await mount(SHARED);
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
    expect(setSharing).toHaveBeenLastCalledWith({ ...SHARED, paused: true });
    expect(within(panel).getByRole('alert').textContent).toMatch(/Paused: members can't use your models\./);
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Resume sharing' })));
    expect(setSharing).toHaveBeenLastCalledWith(SHARED);
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('turns away mode on and says what each state means', async () => {
    const panel = await mount(SHARED);
    const away = () => within(panel).getByRole('switch', { name: 'Away mode' });
    expect(within(panel).getByText(/Off: members can't use your models while this Mac sleeps/)).toBeTruthy();
    await act(async () => fireEvent.click(away()));
    expect(setSharing).toHaveBeenLastCalledWith({ ...SHARED, away: true });
    expect(away().getAttribute('aria-checked')).toBe('true');
    expect(within(panel).getByText(/This Mac stays awake/)).toBeTruthy();

    // Main releases the power-save blocker while paused.
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
    expect(within(panel).getByText(/On, but this Mac can sleep while sharing is paused/)).toBeTruthy();
    await act(async () => fireEvent.click(away()));
    expect(setSharing).toHaveBeenLastCalledWith({ ...SHARED, paused: true, away: false });
  });

  it('stops sharing with one Circle and keeps the models', async () => {
    const panel = await mount(SHARED);
    await act(async () => fireEvent.click(within(panel).getByRole('switch', { name: 'Share with Workshop' })));
    expect(setSharing).toHaveBeenLastCalledWith({ ...SHARED, circles: [] });
  });

  it('keeps a shared model the server no longer lists, so it can be turned off', async () => {
    const old = { ...SHARED, models: [{ id: 'old-model', tools: true }] };
    const panel = await mount(old);
    await act(async () => fireEvent.click(within(panel).getByRole('checkbox', { name: 'old-model' })));
    expect(setSharing).toHaveBeenLastCalledWith({ ...old, models: [] });
  });

  it('says when the local server stops members using a shared model, with pause taking priority', async () => {
    getStatus.mockResolvedValue(unreachable);
    const panel = await mount(SHARED);
    expect((await within(panel).findByRole('alert')).textContent).toMatch(/local model server isn't responding/);
    await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Pause sharing' })));
    expect(within(panel).getByRole('alert').textContent).toMatch(/^Paused/);
  });

  it('says when Circles are not connected', async () => {
    const panel = await mount(SHARED, { status: 'starting' });
    expect((await within(panel).findByRole('alert')).textContent).toMatch(/Circles aren't connected: members can't use your models/);
  });

  it.each([
    ['no local server', { configured: false, slots: {} }],
    ['a local server that is not responding', unreachable],
  ])('offers no sharing with %s', async (_name, status) => {
    getStatus.mockResolvedValue(status);
    getState.mockResolvedValue(withBo(NOT_SHARING));
    render(<Panel />);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.queryByRole('group', { name: 'Shared from this Mac' })).toBeNull();
  });

  it('sends someone with models chosen but no local server to Inference', async () => {
    getStatus.mockResolvedValue({ configured: false, slots: {} });
    const commands: string[] = [];
    const Listener = () => {
      useAppCommand((command) => commands.push(command));
      return null;
    };
    render(<Listener />);
    const panel = await mount({ ...NOT_SHARING, models: SHARED.models });
    expect(await within(panel).findByText(/Connect a local model server in Settings/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Open Inference' }));
    expect(commands).toEqual(['go-inference']);
  });

  it('shows a refusal from main', async () => {
    const panel = await mount(NOT_SHARING);
    setSharing.mockResolvedValue({ success: false, error: 'Share at most 32 models.', state: withBo(NOT_SHARING) });
    fireEvent.click(await within(panel).findByRole('checkbox', { name: /gemma/ }));
    expect(await within(panel).findByText('Share at most 32 models.')).toBeTruthy();
  });

  it('sets a limit for one person, and takes it off again', async () => {
    const panel = await mount(SHARED);
    const usage = within(panel).getByRole('region', { name: 'Usage today' });
    fireEvent.change(within(usage).getByLabelText('Limit for one person'), { target: { value: 'b'.repeat(64) } });
    fireEvent.change(within(usage).getByLabelText('Requests a day for Bo'), { target: { value: '20' } });
    await act(async () => fireEvent.click(within(within(usage).getByRole('region', { name: 'Limit for Bo' })).getByRole('button', { name: 'Save limit' })));
    expect(setSharing).toHaveBeenLastCalledWith({
      ...SHARED,
      limits: { everyone: {}, members: { ['b'.repeat(64)]: { requestsPerDay: 20 } } },
    });
    expect(within(usage).getByRole('option', { name: 'Bo · own limit' })).toBeTruthy();
    await act(async () => fireEvent.click(within(usage).getByRole('button', { name: 'Use the limit for everyone' })));
    expect(setSharing).toHaveBeenLastCalledWith({ ...SHARED, limits: { everyone: {}, members: {} } });
  });
});
