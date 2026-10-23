import { describe, expect, it } from 'vitest';
import { SETUP_STEPS } from '../index';
import type { SetupFlowSnapshot } from '../../types';
import { resolveActiveSetupStep, areAllSetupStepsComplete } from '../../types';

const passAssessment = {
  passed: true,
  stackAlreadyRunning: false,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: [],
};

function snapshot(partial: Partial<SetupFlowSnapshot> = {}): SetupFlowSnapshot {
  return {
    capabilityStatus: { acknowledged: true, lastAssessment: passAssessment },
    capabilityAssessment: passAssessment,
    onboardingStatus: { configured: true, encryptionAvailable: true },
    onboardingLoading: false,
    assistantStackStatus: null,
    ...partial,
  };
}

describe('SETUP_STEPS assistant-stack gate', () => {
  it('selects assistant-stack after capability and LLM are complete', () => {
    const active = resolveActiveSetupStep(SETUP_STEPS, snapshot());
    expect(active?.id).toBe('assistant-stack');
  });

  it('completes when assistant stack setupComplete is true', () => {
    const ctx = snapshot({
      assistantStackStatus: {
        projectName: 'boundary-assistant',
        assistantRoot: '/tmp/assistant',
        dataDir: '/tmp/data',
        overlayPath: '/tmp/overlay.yml',
        ports: {
          gateway: 8642,
          apiServer: 8643,
          dashboard: 9119,
          webui: 8787,
          searxng: 8080,
        },
        isolationMode: 'default-ports',
        apiBaseUrl: 'http://127.0.0.1:8643/v1',
        healthUrl: 'http://127.0.0.1:8643/health',
        setupComplete: true,
        ready: true,
      },
    });
    expect(resolveActiveSetupStep(SETUP_STEPS, ctx)).toBeNull();
    expect(areAllSetupStepsComplete(SETUP_STEPS, ctx)).toBe(true);
  });
});
