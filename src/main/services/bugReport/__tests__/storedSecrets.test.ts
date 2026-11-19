import { describe, expect, it, vi } from 'vitest';

const persistDebugLog = vi.fn();
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: (...args: unknown[]) => persistDebugLog(...args) }));
// The real sources read electron-store and the keychain; these tests pass their own.
vi.mock('../../assistant/assistantPaths', () => ({}));
vi.mock('../../assistant/calendar/calendarStore', () => ({ decryptCalendarPassword: vi.fn(), listCalendarAccounts: vi.fn() }));
vi.mock('../../hostBridge/hostBridgeStore', () => ({ storedHostBridgeTokens: vi.fn() }));
vi.mock('../../inference/confidential/confidentialStore', () => ({}));
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({ storedApiKeys: vi.fn() }));
vi.mock('../../updates/ipcHandlers', () => ({}));

const { storedSecretValues } = await import('../storedSecrets');

describe('storedSecretValues', () => {
  it('gathers every source once, dropping empties and local placeholder keys', async () => {
    const values = await storedSecretValues([
      { name: 'a', read: async () => ['key-one', null, '', ' key-two '] },
      { name: 'b', read: async () => ['key-one', 'ollama', 'lm-studio', undefined] },
    ]);
    expect(values.sort()).toEqual(['key-one', 'key-two']);
  });

  it('skips a source that throws and logs its name without the error text', async () => {
    const values = await storedSecretValues([
      { name: 'broken', read: async () => Promise.reject(new TypeError('value abc123 leaked')) },
      { name: 'fine', read: async () => ['key-three'] },
    ]);
    expect(values).toEqual(['key-three']);
    expect(persistDebugLog).toHaveBeenCalledWith('bug-report', 'secret source unreadable', {
      source: 'broken',
      error: 'TypeError',
    });
  });
});
