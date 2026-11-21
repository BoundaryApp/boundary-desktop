import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS } from '../../../../../shared/types/confidential';

vi.mock('electron-store', () => ({
  default: class {
    get = (): undefined => undefined;
    set = (): void => undefined;
  },
}));
vi.mock('../../../secrets/osEncryption', () => ({
  isOsEncryptionAvailable: async () => true,
  encryptToBase64: async (value: string) => `sealed:${value}`,
  tryDecryptFromBase64: async (value: string): Promise<string | null> => (value.startsWith('sealed:') ? value.slice(7) : null),
  replaceCiphertext: (): null => null,
}));

import type { ConfidentialAdapter } from '../adapter';
import { ConfidentialStore, type StoredConfidential } from '../confidentialStore';
import { createConfidentialService } from '../createConfidentialService';
import { createFakeAdapter } from '../fakeAdapter';
import { SpendLog } from '../spendLog';

const resourcesDir = path.resolve(__dirname, '../../../../../../resources');
const signal = new AbortController().signal;

function memoryStore<T extends object>(data: T) {
  return {
    get: <K extends keyof T>(key: K): T[K] => data[key],
    set: <K extends keyof T>(key: K, value: T[K]): void => {
      data[key] = value;
    },
  };
}

/** A passing scripted adapter standing in for a real one. */
function standIn(providerId: string): ConfidentialAdapter {
  return createFakeAdapter(providerId, { offers: [], balance: null, attestation: 'pass', toolsWork: true, keyResult: 'ok', chatResults: ['ok'] });
}

function serviceWithSpies(dir = resourcesDir) {
  const near = vi.fn((_opts: { apiKey: string; models: string[] }) => standIn('near'));
  const prem = vi.fn((_opts: { apiKey: string; models: string[] }) => standIn('prem'));
  const tinfoil = vi.fn((_opts: { apiKey: string; models: string[] }) => standIn('tinfoil'));
  const privatemode = vi.fn((_opts: { apiKey: string; models: string[] }) => standIn('privatemode'));
  const data: StoredConfidential = { added: [], keys: {}, settings: { ...DEFAULT_POOL_SETTINGS } };
  const service = createConfidentialService({
    enabled: true,
    resourcesDir: dir,
    makeStore: () => new ConfidentialStore(memoryStore(data)),
    makeSpendLog: () => new SpendLog(memoryStore({ entries: [] }) as never),
    onChange: vi.fn(),
    liveAdapters: { near: near as never, prem: prem as never, tinfoil: tinfoil as never, privatemode: privatemode as never },
  });
  return { service, near, prem, tinfoil, privatemode };
}

describe('createConfidentialService', () => {
  it('builds no store when the flag is off, and reports disabled', async () => {
    const makeStore = vi.fn();
    const makeSpendLog = vi.fn();
    const service = createConfidentialService({
      enabled: false,
      resourcesDir: '/nowhere',
      makeStore,
      makeSpendLog,
      onChange: vi.fn(),
    });
    expect(makeStore).not.toHaveBeenCalled();
    expect(await service.spend()).toBeNull();
    expect(await service.state()).toEqual({ enabled: false });
    expect(await service.removeProvider('prem')).toEqual({ enabled: false });
    await service.refreshLive();
    expect(await service.rank('qwen', { privateProject: false })).toBeNull();
    expect(makeStore).not.toHaveBeenCalled();
    expect(makeSpendLog).not.toHaveBeenCalled();
  });

  it('builds the store and the spend log when the flag is on', () => {
    const makeStore = vi.fn(() => ({}) as never);
    const makeSpendLog = vi.fn(() => ({}) as never);
    createConfidentialService({ enabled: true, resourcesDir: '/nowhere', makeStore, makeSpendLog, onChange: vi.fn() });
    expect(makeStore).toHaveBeenCalledTimes(1);
    expect(makeSpendLog).toHaveBeenCalledTimes(1);
  });

  it('builds the real adapter for near, prem, tinfoil and privatemode and dev fakes for the rest', async () => {
    const { service, near, prem, tinfoil, privatemode } = serviceWithSpies();
    for (const id of ['near', 'prem', 'tinfoil', 'privatemode', 'chutes']) expect((await service.addProvider(id, `sk-${id}`)).added).toBe(true);
    expect(near).toHaveBeenCalledTimes(1);
    expect(prem).toHaveBeenCalledTimes(1);
    expect(tinfoil).toHaveBeenCalledTimes(1);
    expect(privatemode).toHaveBeenCalledTimes(1);
    const chutes = await service.adapter('chutes');
    if (!chutes) throw new Error('no chutes adapter');
    const body = JSON.stringify({ model: 'qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }] });
    const result = await chutes.chat(body, signal);
    if (result.ok === false) throw new Error('chat failed');
    expect(await result.response.text()).toContain('Chutes’s dev stand-in');
    expect(near).toHaveBeenCalledTimes(1);
    expect(prem).toHaveBeenCalledTimes(1);
  });

  it('passes Privatemode an empty pin list when the catalog has none, so every manifest is refused', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'confidential-catalog-'));
    try {
      const raw = JSON.parse(readFileSync(path.join(resourcesDir, 'confidential', 'dev-catalog.json'), 'utf8')) as { providers: Record<string, unknown>[] };
      const entry = raw.providers.find((provider) => provider.id === 'privatemode');
      if (entry) {
        delete entry.manifestSha256;
        entry.level = 'B';
      }
      mkdirSync(path.join(dir, 'confidential'));
      writeFileSync(path.join(dir, 'confidential', 'dev-catalog.json'), JSON.stringify(raw));
      const { service, privatemode } = serviceWithSpies(dir);
      await service.addProvider('privatemode', 'sk-privatemode');
      expect(privatemode).toHaveBeenCalledWith(expect.objectContaining({ manifestSha256: [] }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the catalog’s provider model ids to each adapter', async () => {
    const { service, near, prem, tinfoil, privatemode } = serviceWithSpies();
    await service.addProvider('near', 'sk-near');
    await service.addProvider('prem', 'sk-prem');
    await service.addProvider('tinfoil', 'sk-tinfoil');
    await service.addProvider('privatemode', 'sk-privatemode');
    expect(near).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-near',
        models: ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'],
        log: expect.any(Function),
      })
    );
    expect(prem).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-prem', models: ['qwen38-27b', 'deepseek-v4.1-flash-1017'], log: expect.any(Function) })
    );
    expect(tinfoil).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-tinfoil', models: ['deepseek-v4-1-flash'], log: expect.any(Function) }));
    expect(privatemode).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk-privatemode',
        models: ['glm-5.3-flash'],
        manifestSha256: ['d63eb5cf91cb3079fe25a848573a4d0e9d869f462dab4f71fd02bdb372f8e833'],
        log: expect.any(Function),
      })
    );
  });
});
