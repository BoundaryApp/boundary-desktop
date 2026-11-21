import { afterEach, describe, expect, it } from 'vitest';
import {
  getRuntimeProvisionProgress,
  getRuntimeProvisionStage,
  onRuntimeProvisionStage,
  resetRuntimeProvisionProgressForTests,
  setRuntimeProvisionProgress,
  setRuntimeProvisionStage,
} from '../containerRuntime/provisionProgress';

describe('runtime provision stage', () => {
  afterEach(() => resetRuntimeProvisionProgressForTests());

  it('records the stages a resolve enters, in order, with when the current one began', () => {
    setRuntimeProvisionStage('docker', 1_000);
    setRuntimeProvisionStage('configure', 2_000);
    setRuntimeProvisionStage('create', 3_000);
    expect(getRuntimeProvisionStage()).toEqual({
      stage: 'create',
      reached: ['docker', 'configure', 'create'],
      stageStartedAt: 3_000,
    });
  });

  it('starts over at docker, so a second resolve drops the first one’s stages', () => {
    setRuntimeProvisionStage('docker', 1_000);
    setRuntimeProvisionStage('start', 2_000);
    setRuntimeProvisionStage('docker', 5_000);
    expect(getRuntimeProvisionStage()).toEqual({ stage: 'docker', reached: ['docker'], stageStartedAt: 5_000 });
  });

  it('keeps the start time when the current stage is entered again', () => {
    const seen: string[] = [];
    const stop = onRuntimeProvisionStage((snapshot) => seen.push(snapshot.stage));
    setRuntimeProvisionStage('docker', 1_000);
    setRuntimeProvisionStage('create', 2_000);
    // The krunkit fallback reports Create a second time.
    setRuntimeProvisionStage('create', 9_000);
    stop();
    expect(seen).toEqual(['docker', 'create']);
    expect(getRuntimeProvisionStage()?.stageStartedAt).toBe(2_000);
  });

  it('enters a message’s stage before taking the message, and a bare message keeps the stage', () => {
    setRuntimeProvisionStage('docker');
    setRuntimeProvisionProgress('Creating the engine…', 'create');
    setRuntimeProvisionProgress('Using bundled machine image…');
    expect(getRuntimeProvisionStage()?.stage).toBe('create');
    expect(getRuntimeProvisionProgress()).toBe('Using bundled machine image…');
  });
});
