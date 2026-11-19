import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS } from '../../../../shared/types/confidential';
import type {
  AddProviderResult,
  ConfidentialProviderView,
  ConfidentialSpend,
  ConfidentialState,
} from '../../../../shared/types/confidentialState';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { ConfidentialProviders } from '../ConfidentialProviders';

/** Offers as main prices them: qwen and dsflash as Prem lists them, glmflash at fp8. */
const OFFERS: Record<string, ConfidentialProviderView['offers'][number]> = {
  qwen: { modelId: 'qwen', precision: null, price: { inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 }, turnCost: 0.015 },
  dsflash: { modelId: 'dsflash', precision: null, price: { inputPerM: 0.35, cachedInputPerM: 0, outputPerM: 1.4 }, turnCost: 0.014 },
  glmflash: { modelId: 'glmflash', precision: 'fp8', price: { inputPerM: 2, cachedInputPerM: null, outputPerM: 8 }, turnCost: 0.17 },
};

function provider(overrides: Partial<ConfidentialProviderView>): ConfidentialProviderView {
  const models = overrides.models ?? ['qwen', 'dsflash'];
  return {
    offers: models.map((modelId) => OFFERS[modelId]),
    id: 'prem',
    name: 'Prem',
    level: 'B',
    levelReason: 'Encrypts on your Mac to the enclave.',
    keyUrl: 'https://dashboard.prem.io/api-keys',
    billing: 'Prepaid by card',
    models: ['qwen', 'dsflash'],
    added: false,
    keyPreview: null,
    live: null,
    problem: null,
    ...overrides,
  };
}

function live(balance: number | null): NonNullable<ConfidentialProviderView['live']> {
  return {
    balance,
    rateLimitedUntil: null,
    attestation: 'passed',
    healthy: true,
    unhealthyUntil: null,
    keyUnavailable: false,
    toolsWork: true,
    medianTtfbMs: null,
    livePrices: { qwen: { inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 } },
  };
}

const prem = provider({ added: true, keyPreview: { configured: true, preview: 'sk-…4f2a' }, live: live(18.4) });
const near = provider({
  id: 'near',
  name: 'NEAR AI Cloud',
  models: ['qwen'],
  added: true,
  keyPreview: { configured: true, preview: 'nr-…77' },
  live: live(2.1),
});
const chutes = provider({ id: 'chutes', name: 'Chutes', level: 'C', models: ['qwen'] });
const privatemode = provider({
  id: 'privatemode',
  name: 'Privatemode',
  level: 'A',
  keyUrl: 'https://privatemode.ai',
  models: ['glmflash'],
});

function enabled(providers: ConfidentialProviderView[], catalog = {}): ConfidentialState {
  return {
    enabled: true,
    catalog: { available: true, publishedAt: '2026-11-08T00:00:00Z', stale: false, signatureFailed: false, ...catalog },
    models: [
      { id: 'qwen', name: 'Qwen 3.8 27B' },
      { id: 'dsflash', name: 'DeepSeek V4.1 Flash' },
      { id: 'glmflash', name: 'GLM 5.3 Flash' },
    ],
    providers,
    settings: DEFAULT_POOL_SETTINGS,
  };
}

let api: ReturnType<typeof stubElectronAPI>;

async function mount(
  state: ConfidentialState,
  addResults: AddProviderResult[] = [],
  addRequest?: number,
  spend: ConfidentialSpend | null = null,
) {
  const addProvider = vi.fn();
  for (const result of addResults) addProvider.mockResolvedValueOnce(result);
  api = stubElectronAPI({
    confidential: {
      getState: vi.fn().mockResolvedValue(state),
      addProvider,
      removeProvider: vi.fn().mockResolvedValue(state),
      refresh: vi.fn().mockResolvedValue(state),
      getSpend: vi.fn().mockResolvedValue(spend),
    },
    urls: { openUrl: vi.fn().mockResolvedValue({ success: true }) },
  });
  const view = render(<ConfidentialProviders addRequest={addRequest} />);
  await act(async () => undefined);
  return view;
}

const card = () => screen.getByRole('article', { name: 'Confidential providers' });
const dialog = () => screen.getByRole('dialog');

async function walkToKey(name: string) {
  fireEvent.click(within(card()).getByRole('button', { name: 'Add a provider' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: new RegExp(name) }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
  fireEvent.click(within(dialog()).getByRole('button', { name: `Add ${name}` }));
}

async function submitKey(key: string) {
  fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: key } });
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Check and add' }));
  });
}

describe('ConfidentialProviders', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when disabled', async () => {
    const { container } = await mount({ enabled: false });
    expect(api.confidential.getState).toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('opens the add sheet when asked from elsewhere, and again on a new request', async () => {
    const view = await mount(enabled([chutes, privatemode]), [], 1);
    expect(dialog()).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<ConfidentialProviders addRequest={2} />);
    expect(dialog()).toBeTruthy();
  });

  it('shows Not set and Add a provider with no providers', async () => {
    await mount(enabled([chutes, privatemode]));
    expect(within(card()).getByText('Not set')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Add a provider' }).className).toContain('wb-btn-solid');
    expect(within(card()).getByText(/What each provider sees\./)).toBeTruthy();
  });

  it('has a How pools work button in the panel, also with no providers, that opens the help sheet', async () => {
    await mount(enabled([chutes, privatemode]));
    fireEvent.click(within(card()).getByRole('button', { name: 'How pools work' }));
    expect(screen.getByRole('dialog', { name: 'How pools work' })).toBeTruthy();
  });

  it('closes Pool settings and opens the help sheet from its How pools work link', async () => {
    await mount(enabled([prem]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Pool settings' }));
    await act(async () => undefined);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Pool settings' })).getByRole('button', { name: 'How pools work' }));
    expect(screen.queryByRole('dialog', { name: 'Pool settings' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'How pools work' })).toBeTruthy();
  });

  it('shows Spend only once a provider is added, and opens the Spend sheet', async () => {
    await mount(enabled([chutes, privatemode]));
    expect(within(card()).queryByRole('button', { name: 'Spend' })).toBeNull();
    cleanup();
    resetIpcStoresForTests();
    await mount(enabled([prem, chutes]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Spend' }));
    await act(async () => undefined);
    expect(screen.getByRole('dialog', { name: 'Spend, last 30 days' })).toBeTruthy();
  });

  it('shows a provider’s last 30 days in Details, and All spend opens the Spend sheet in its place', async () => {
    const row = {
      providerId: 'prem',
      name: 'Prem',
      level: 'B' as const,
      turns: 41,
      turnsWithoutCounts: 0,
      inputTokens: 3_000_000,
      outputTokens: 100_000,
      cost: 0.61,
      balance: 18.4,
      removed: false,
    };
    await mount(enabled([prem]), [], undefined, { since: 0, rows: [row], totalTurns: 41, totalCost: 0.61 });
    fireEvent.click(within(card()).getByRole('button', { name: 'Details' }));
    await act(async () => undefined);
    expect(within(dialog()).getByText('41 turns · about $0.61')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'All spend' }));
    await act(async () => undefined);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Spend, last 30 days' })).toBeTruthy();
  });

  it('reads a sub-cent last 30 days as under $0.01, without about', async () => {
    const row = {
      providerId: 'prem',
      name: 'Prem',
      level: 'B' as const,
      turns: 3,
      turnsWithoutCounts: 0,
      inputTokens: 900,
      outputTokens: 100,
      cost: 0.0004,
      balance: 18.4,
      removed: false,
    };
    await mount(enabled([prem]), [], undefined, { since: 0, rows: [row], totalTurns: 3, totalCost: 0.0004 });
    fireEvent.click(within(card()).getByRole('button', { name: 'Details' }));
    await act(async () => undefined);
    expect(within(dialog()).getByText('3 turns · under $0.01')).toBeTruthy();
  });

  it('leaves the last 30 days out of Details when the provider has no row', async () => {
    await mount(enabled([prem]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Details' }));
    await act(async () => undefined);
    expect(within(dialog()).queryByText('Last 30 days')).toBeNull();
  });

  it('shows Pool settings only once a provider is added, and opens the sheet', async () => {
    await mount(enabled([chutes, privatemode]));
    expect(within(card()).queryByRole('button', { name: 'Pool settings' })).toBeNull();
    cleanup();
    resetIpcStoresForTests();
    await mount(enabled([prem, chutes]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Pool settings' }));
    expect(screen.getByRole('dialog', { name: 'Pool settings' })).toBeTruthy();
  });

  it('lists added providers with balance and a Low balance pill under $5', async () => {
    await mount(enabled([prem, near, chutes]));
    expect(within(card()).getByText('2 added')).toBeTruthy();
    const premRow = within(card()).getByRole('listitem', { name: 'Prem' });
    expect(premRow.textContent).toContain('Qwen 3.8 27B, DeepSeek V4.1 Flash · Balance $18.40');
    expect(within(premRow).getByText('Ready')).toBeTruthy();
    expect(within(premRow).getByRole('button', { name: 'Details' })).toBeTruthy();
    const nearRow = within(card()).getByRole('listitem', { name: 'NEAR AI Cloud' });
    expect(within(nearRow).getByText('Low balance')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Add a provider' }).className).toContain('wb-btn-ghost');
  });

  it('shows a callout with Top up for an empty balance', async () => {
    const empty = { ...prem, live: live(0), problem: 'no-balance' as const };
    await mount(enabled([empty]));
    expect(within(card()).getByText('Your Prem balance is $0.00. Prem refuses requests until you top up.')).toBeTruthy();
    expect(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByText('Balance empty')).toBeTruthy();
    fireEvent.click(within(card()).getByRole('button', { name: 'Top up at Prem' }));
    expect(api.urls.openUrl).toHaveBeenCalledWith('https://dashboard.prem.io/api-keys');
  });

  it('says a key that can’t be read needs entering again, on the card and in details', async () => {
    const unreadable = { ...prem, problem: 'key-unavailable' as const, live: { ...live(10), keyUnavailable: true } };
    await mount(enabled([unreadable]));
    expect(
      within(card()).getByText('Boundary can’t read the key it stored for Prem, so pools skip it. Remove Prem and add it again with its key.')
    ).toBeTruthy();
    expect(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByText('Key unreadable')).toBeTruthy();
    expect(within(card()).getByRole('button', { name: 'Check again' })).toBeTruthy();
    fireEvent.click(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByRole('button', { name: 'Details' }));
    expect(within(dialog()).getByText('Can’t be read. Remove Prem and add it again.')).toBeTruthy();
  });

  it('offers Check again for a failed hardware check and refreshes', async () => {
    const failed = { ...prem, problem: 'attestation-failed' as const };
    await mount(enabled([failed]));
    await act(async () => {
      fireEvent.click(within(card()).getByRole('button', { name: 'Check again' }));
    });
    expect(api.confidential.refresh).toHaveBeenCalled();
  });

  it('shows the stale and signature callouts', async () => {
    await mount(enabled([prem], { stale: true, signatureFailed: true }));
    expect(within(card()).getByText(/^Boundary’s provider list is (more than 7|\d+) days old$/)).toBeTruthy();
    expect(within(card()).getByText('The new provider list failed its signature check')).toBeTruthy();
  });

  it('walks the four add steps and calls addProvider with the key', async () => {
    await mount(enabled([prem, chutes, privatemode]), [
      {
        added: true,
        checks: [
          { step: 'key', ok: true, detail: 'Balance $10.00.' },
          { step: 'attestation', ok: true, detail: 'Hardware and code checked, matching level A.' },
          { step: 'models', ok: true, detail: 'GLM 5.3 Flash.' },
          { step: 'tools', ok: true, detail: 'A test tool call came back. Nothing you wrote was sent.' },
        ],
      },
    ]);
    fireEvent.click(within(card()).getByRole('button', { name: 'Add a provider' }));
    expect((within(dialog()).getByRole('button', { name: /Prem · added/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(within(dialog()).getByRole('button', { name: /Chutes/ })).getByText('Below your minimum')).toBeTruthy();
    expect((within(dialog()).getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog()).getByRole('button', { name: /Privatemode/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    expect(within(dialog()).getByText('Can’t read')).toBeTruthy();
    expect(within(dialog()).getByText(/Prepaid by card, at Privatemode\./)).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add Privatemode' }));
    expect((within(dialog()).getByRole('button', { name: 'Check and add' }) as HTMLButtonElement).disabled).toBe(true);
    await submitKey('sk-test');
    expect(api.confidential.addProvider).toHaveBeenCalledWith({ id: 'privatemode', apiKey: 'sk-test' });
    for (const title of ['Key accepted', 'Hardware checked', 'Models listed', 'Tools run']) {
      expect(within(dialog()).getByText(title)).toBeTruthy();
    }
    expect(within(dialog()).getByText('Balance $10.00.')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the key error on the key step for a refused key', async () => {
    const detail = 'Privatemode didn’t accept this key. Check you copied all of it.';
    await mount(enabled([privatemode]), [{ added: false, checks: [{ step: 'key', ok: false, detail }] }]);
    await walkToKey('Privatemode');
    await submitKey('bad');
    expect(within(dialog()).getByText(detail)).toBeTruthy();
    expect((within(dialog()).getByLabelText('API key') as HTMLInputElement).value).toBe('bad');
    expect(within(dialog()).getByRole('button', { name: 'Check and add' })).toBeTruthy();
  });

  it('shows the failed hardware check and adds nothing', async () => {
    const detail = 'Privatemode’s enclave didn’t pass. Privatemode isn’t added. Nothing was sent.';
    const failed: AddProviderResult = {
      added: false,
      checks: [
        { step: 'key', ok: true, detail: 'Balance $10.00.' },
        { step: 'attestation', ok: false, detail },
      ],
    };
    await mount(enabled([privatemode]), [failed, failed]);
    await walkToKey('Privatemode');
    await submitKey('sk-test');
    expect(within(dialog()).getByText('Hardware check failed')).toBeTruthy();
    expect(within(dialog()).getByText(detail)).toBeTruthy();
    expect(within(dialog()).queryByText('Tools run')).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Done' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Check again' }));
    });
    expect(api.confidential.addProvider).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));
    expect((within(dialog()).getByLabelText('API key') as HTMLInputElement).value).toBe('sk-test');
  });

  it('shows the last check for each step when the keychain fails', async () => {
    const keychain = 'The Mac keychain isn’t available, so Boundary can’t store the key.';
    await mount(enabled([privatemode]), [
      {
        added: false,
        checks: [
          { step: 'key', ok: true, detail: 'Balance $10.00.' },
          { step: 'attestation', ok: true, detail: 'Hardware and code checked, matching level A.' },
          { step: 'key', ok: false, detail: keychain },
        ],
      },
    ]);
    await walkToKey('Privatemode');
    await submitKey('sk-test');
    expect(within(dialog()).getByText(keychain)).toBeTruthy();
    expect(within(dialog()).queryByText('Balance $10.00.')).toBeNull();
    expect(within(within(dialog()).getByRole('list', { name: 'Checks' })).getAllByRole('listitem')).toHaveLength(2);
  });

  it('removes a provider after confirming', async () => {
    await mount(enabled([prem]));
    fireEvent.click(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByRole('button', { name: 'Details' }));
    expect(within(dialog()).getByText('sk-…4f2a')).toBeTruthy();
    expect(within(dialog()).getByText('Encrypts on your Mac to the enclave.')).toBeTruthy();
    expect(within(dialog()).getByRole('row', { name: /Qwen 3.8 27B/ }).textContent).toContain('$2.40');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove Prem' }));
    expect(api.confidential.removeProvider).not.toHaveBeenCalled();
    const confirm = within(dialog()).getAllByRole('button', { name: 'Remove Prem' }).at(-1)!;
    expect(confirm.className).toContain('wb-btn-danger');
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(api.confidential.removeProvider).toHaveBeenCalledWith({ id: 'prem' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a cost per turn for each model on Choose and the provider note on Key', async () => {
    const premNote = 'New Prem accounts can send 38,000 tokens a minute, about two agent steps.';
    await mount(enabled([provider({ note: premNote }), privatemode]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Add a provider' }));
    const premChoice = within(dialog()).getByRole('button', { name: /Prem/ });
    expect(premChoice.textContent).toContain('Qwen 3.8 27B $0.015 · DeepSeek V4.1 Flash $0.014 a turn · Prepaid by card');
    expect(within(dialog()).getByRole('button', { name: /Privatemode/ }).textContent).toContain('GLM 5.3 Flash $0.17 a turn');
    fireEvent.click(premChoice);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    expect(within(dialog()).queryByText(premNote)).toBeNull();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add Prem' }));
    expect(within(dialog()).getByText(premNote)).toBeTruthy();
  });

  it('shows runs in, the note, precision and a turn in details', async () => {
    const glm = provider({ ...prem, models: ['qwen', 'glmflash'], offers: [OFFERS.qwen, OFFERS.glmflash], note: 'Beta service.', runsIn: 'Switzerland' });
    await mount(enabled([glm]));
    fireEvent.click(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByRole('button', { name: 'Details' }));
    expect(within(dialog()).getByText('Runs in')).toBeTruthy();
    expect(within(dialog()).getByText('Switzerland')).toBeTruthy();
    expect(within(dialog()).getByText('Beta service.')).toBeTruthy();
    const qwen = within(dialog()).getByRole('row', { name: /Qwen 3.8 27B/ });
    expect(qwen.textContent).toContain('Not stated');
    expect(qwen.textContent).toContain('$0.015');
    const glmRow = within(dialog()).getByRole('row', { name: /GLM 5.3 Flash/ });
    expect(glmRow.textContent).toContain('fp8');
    expect(glmRow.textContent).toContain('$0.17');
  });

  it('leaves Runs in out of details when the list doesn’t say', async () => {
    await mount(enabled([prem]));
    fireEvent.click(within(within(card()).getByRole('listitem', { name: 'Prem' })).getByRole('button', { name: 'Details' }));
    expect(within(dialog()).queryByText('Runs in')).toBeNull();
  });

  it('shows the no-catalog text without an Add button', async () => {
    await mount(enabled([], { available: false, publishedAt: null }));
    expect(within(card()).getByText('Boundary’s provider list isn’t available.')).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: 'Add a provider' })).toBeNull();
  });
});
