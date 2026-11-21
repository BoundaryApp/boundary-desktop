import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { poolBridge } from '../../../__tests__/confidentialFixtures';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { NewWritingVoiceSheet } from '../NewWritingVoiceSheet';

const status = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  appSharedModel: { slot: 'confidential' as const, modelId: 'qwen' },
  slots: { local: { configured: true, modelId: 'qwen3:14b', health: 'reachable' as const } },
};

describe('NewWritingVoiceSheet', () => {
  beforeEach(() => {
    resetIpcStoresForTests();
    stubElectronAPI({
      onboarding: { getStatus: vi.fn().mockResolvedValue(status), onStatus: () => () => {} },
      confidential: poolBridge(),
    });
  });
  afterEach(() => {
    stubElectronAPI({ confidential: { getState: vi.fn(() => new Promise<never>(() => undefined)) } });
    resetIpcStoresForTests();
  });

  it('names a pool app default by its model', async () => {
    render(<NewWritingVoiceSheet open onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('Calibrates with Confidential · Qwen 3.8 27B')).toBeTruthy();
  });
});
