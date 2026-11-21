import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import type { InferenceStack, InferenceStackEntry } from '../../../../shared/types/inferenceChain';
import { localDay } from '../../../../shared/utils/localDay';
import { CIRCLE_KEY as CIRCLE, circleOffer, circleSnapshot, runningCircles } from '../../../__tests__/circleFixtures';
import { poolBridge } from '../../../__tests__/confidentialFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { InferenceScreen } from '../InferenceScreen';
import { LevelStackSheet } from '../LevelStackSheet';

const MAYA = 'b'.repeat(64);
const maya = { slot: 'peer' as const, modelId: 'qwen3-32b', peer: { circleId: CIRCLE, providerId: MAYA } };
const MAYA_KEY = `peer:${CIRCLE}:${MAYA}:qwen3-32b`;

function circles(trusted: boolean): CirclesState {
  const offer = circleOffer({ identity: MAYA, name: 'Maya', models: [{ id: 'qwen3-32b', tools: true, contextLength: 32_768 }] });
  return runningCircles({
    providers: { [MAYA]: { private: false, trusted } },
    circles: [circleSnapshot({ name: 'Book club', offers: [offer] })],
  });
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
    expect(screen.getByText(/Replies are limited to 8.2K of context/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add a model' })).toBeNull();
  });

  it('closes Add a model from its backdrop', async () => {
    setUp();
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    const backdrop = screen.getByRole('dialog', { name: 'Add a model' }).parentElement!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(screen.queryByRole('dialog', { name: 'Add a model' })).toBeNull();
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

  it('says a connected person who paused sharing isn’t sharing now', async () => {
    setUp();
    const paused = circles(true);
    paused.snapshot.circles[0]!.offers[0]!.available = false;
    api.circles.getState.mockResolvedValue(paused);
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(within(person).getByText(/Offered in Book club · Not sharing now/)).toBeTruthy();
    expect(within(person).queryByText(/Online/)).toBeNull();
  });

  it('says a person who paused and then dropped is offline', async () => {
    setUp();
    const gone = circles(true);
    Object.assign(gone.snapshot.circles[0]!.offers[0]!, { available: false, online: false });
    api.circles.getState.mockResolvedValue(gone);
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(within(person).getByText(/Offered in Book club · Offline/)).toBeTruthy();
  });

  it('says what the user used of a person’s models today', async () => {
    setUp();
    api.circles.getState.mockResolvedValue({
      ...circles(true),
      used: { day: localDay(new Date()), counts: { [MAYA]: { requests: 3, tokens: 4200 } } },
    });
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(await within(person).findByText('You used 3 requests and 4.2K tokens today.')).toBeTruthy();
  });
});

const pool = { slot: 'confidential' as const, modelId: 'qwen' };
const POOL_KEY = 'confidential:qwen';

function poolStack(stale: InferenceStackEntry['stale'] = null): InferenceStack {
  const [local] = stack(false).entries;
  return {
    entries: [local, { entry: pool, key: POOL_KEY, stale, private: false, privateCut: true }],
    noPrivate: false,
  };
}

function setUpPools(fallbacks: unknown[]) {
  setUp({ fallbacks });
  api.onboarding.describeAppStack.mockResolvedValue(fallbacks.length ? poolStack() : { ...poolStack(), entries: poolStack().entries.slice(0, 1) });
  stubElectronAPI({ confidential: poolBridge() });
}

describe('Inference with confidential pools', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('adds a pool from Add model under the local model', async () => {
    setUpPools([]);
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Add model/ }));
    const sheet = within(screen.getByRole('list', { name: 'Models you can add' }));
    const row = (await sheet.findByText('Confidential · Qwen 3.8 27B')).closest('li')!;
    await waitFor(() => expect(row.textContent).toContain('2 of your providers · from $0.012 a turn'));
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.onboarding.setAppFallbacks).toHaveBeenCalledWith({ fallbacks: [pool] }));
    expect(api.onboarding.setAppDefault).not.toHaveBeenCalled();
  });

  it('opens the pool’s side panel from its rung', async () => {
    setUpPools([pool]);
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(2));
    const rung = rungs()[1];
    await waitFor(() => expect(rung.textContent).toContain('2 providers · New chats go to NEAR AI Cloud, about $0.012 a turn'));
    expect(within(rung).getByText('Confidential · Qwen 3.8 27B')).toBeTruthy();
    expect(rung.querySelector('.is-warn')).toBeNull();
    fireEvent.click(rung.querySelector<HTMLButtonElement>('.wb-inf-open')!);
    const side = within(screen.getByRole('complementary', { name: 'Model details' }));
    expect(await side.findByRole('list', { name: 'Who serves, cheapest first' })).toBeTruthy();
    expect(side.getByText('Not added. Pools only use providers you add.')).toBeTruthy();
    expect(side.queryByRole('button', { name: 'Test' })).toBeNull();
    expect(side.getByRole('button', { name: 'Remove from stack' })).toBeTruthy();
    // Full width in the stack sheet, as the Test button above it; .wb-inf sizes both to their label here.
    expect(side.getByRole('button', { name: 'Remove from stack' }).className).toContain('is-block');
  });

  it('moves a pool to the top, which makes it the app default', async () => {
    setUpPools([pool]);
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(2));
    const up = screen.getByRole('button', { name: /Move Confidential · .* up/ });
    expect(up).toHaveProperty('disabled', false);
    fireEvent.click(up);
    await waitFor(() => expect(api.onboarding.setAppSharedModel).toHaveBeenCalledWith({ entry: pool }));
    await waitFor(() => expect(api.onboarding.setAppFallbacks).toHaveBeenLastCalledWith({ fallbacks: [{ slot: 'local' }] }));
    expect(api.onboarding.setAppDefault).not.toHaveBeenCalled();
  });

  it('lets the first entry go when a pool would then be first', async () => {
    setUpPools([pool]);
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(2));
    fireEvent.click(rungs()[0].querySelector<HTMLButtonElement>('.wb-inf-open')!);
    const side = within(screen.getByRole('complementary', { name: 'Model details' }));
    expect(side.getByRole('button', { name: 'Remove from stack' })).toHaveProperty('disabled', false);
  });

  it('answers a dry run from a pool that serves, and skips one nobody serves', async () => {
    setUpPools([pool, { slot: 'openrouter' }]);
    const unreachable = { ...slots, local: { ...slots.local, health: 'unreachable' } };
    api.onboarding.getStatus.mockResolvedValue({ ...status, appFallbacks: [pool, { slot: 'openrouter' }], slots: unreachable } as never);
    const [local, poolEntry] = poolStack().entries;
    const cloud = stack(false).entries[2];
    api.onboarding.describeAppStack.mockResolvedValue({ entries: [local, poolEntry, cloud], noPrivate: false });
    const { unmount } = render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('status').textContent).toMatch(/Answered by Confidential · Qwen 3\.8 27B.* 1 skipped\. Nothing was sent/);
    unmount();

    const [, stalePool] = poolStack('pool-no-provider').entries;
    api.onboarding.describeAppStack.mockResolvedValue({ entries: [local, stalePool, cloud], noPrivate: false });
    render(<InferenceScreen />);
    await waitFor(() => expect(rungs()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    // The rung's warning and the dry run's step both say why.
    expect(within(rungs()[1]).getAllByText('No added provider serves this model now')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toMatch(/Answered by OpenRouter.* 2 skipped\. Nothing was sent/);
  });

  it('a pool in a project stack is described, and can’t come first there', async () => {
    setUpPools([]);
    render(
      <LevelStackSheet
        titleId="project-stack"
        kicker="Project"
        title="Model stack"
        lede="Chats in this project use this stack."
        initial={[{ slot: 'local' }, pool]}
        privacyLocked={false}
        save={vi.fn().mockResolvedValue(null)}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(rungs()).toHaveLength(2));
    const rung = rungs()[1];
    expect(within(rung).getByText('Confidential · Qwen 3.8 27B')).toBeTruthy();
    await waitFor(() => expect(rung.textContent).toContain('New chats go to NEAR AI Cloud'));
    expect(rung.querySelector('.is-warn')).toBeNull();
    expect(screen.getByRole('button', { name: /Move Confidential · .* up/ })).toHaveProperty('disabled', true);
    expect(
      screen.queryByText(
        'A confidential pool can follow Local or OpenRouter here, but can’t come first. To start with one, put it first in Inference, then go back to the Chat stack here.'
      )
    ).toBeTruthy();
  });
});

describe('Inference with a private project’s floor', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ranks a private project’s pool with the project’s floor, in the rung and its side panel', async () => {
    setUpPools([]);
    const rank = vi.mocked(window.electronAPI.confidential.rank);
    render(
      <LevelStackSheet
        titleId="project-stack"
        kicker="Project"
        title="Model stack"
        lede="Chats in this project use this stack."
        initial={[{ slot: 'local' }, pool]}
        privacyLocked
        projectFloor="B"
        save={vi.fn().mockResolvedValue(null)}
        onClose={vi.fn()}
      />
    );
    await waitFor(() => expect(rungs()).toHaveLength(2));
    expect(rank).toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true, projectFloor: 'B' });
    const calls = rank.mock.calls.length;
    fireEvent.click(rungs()[1].querySelector<HTMLButtonElement>('.wb-inf-open')!);
    const side = within(screen.getByRole('complementary', { name: 'Model details' }));
    await side.findByRole('list', { name: 'Who serves, cheapest first' });
    expect(rank.mock.calls.slice(calls)).toContainEqual([
      { modelId: 'qwen', privateProject: true, projectFloor: 'B' },
    ]);
    expect(rank).not.toHaveBeenCalledWith({ modelId: 'qwen', privateProject: true });
    expect(side.getByText('Level B or better in this project')).toBeTruthy();
  });
});

describe('Inference from a link', () => {
  beforeEach(() => resetIpcStoresForTests());

  it('marks the person the link named', async () => {
    setUp();
    render(<InferenceScreen focusPerson={{ person: MAYA, seq: 1 }} />);
    const person = await screen.findByRole('region', { name: 'Maya' });
    expect(person.className).toContain('is-focused');
  });
});
