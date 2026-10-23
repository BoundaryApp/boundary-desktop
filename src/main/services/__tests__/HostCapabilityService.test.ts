import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_STACK_REQUIREMENTS,
  formatBytes,
} from '../../../shared/assistantStackRequirements';
import {
  acknowledgeHostCapability,
  assessHostCapability,
  daemonInfoFormat,
  evaluateHostCapability,
  type HostCapabilityProbes,
} from '../capability/HostCapabilityService';
import { getCapabilityStatus } from '../capability/CapabilityStore';

function gib(n: number): number {
  return n * 1024 * 1024 * 1024;
}

function createProbes(overrides: Partial<{
  runtimeRunning: boolean;
  composeVersion: string | null;
  totalMemoryBytes: number;
  cpuCores: number;
  freeDiskBytes: number;
  stackAlreadyRunning: boolean;
}> = {}): HostCapabilityProbes {
  const values = {
    runtimeRunning: true,
    composeVersion: '2.29.0',
    totalMemoryBytes: gib(16),
    cpuCores: 8,
    freeDiskBytes: gib(40),
    stackAlreadyRunning: false,
    ...overrides,
  };
  return {
    isRuntimeRunning: async () => values.runtimeRunning,
    getComposeVersion: async () => values.composeVersion,
    getTotalMemoryBytes: () => values.totalMemoryBytes,
    getCpuCoreCount: () => values.cpuCores,
    getFreeDiskBytes: async () => values.freeDiskBytes,
    isAssistantStackRunning: async () => values.stackAlreadyRunning,
  };
}

describe('daemonInfoFormat', () => {
  it('uses ServerVersion for Docker and Version.Version for Podman', () => {
    expect(daemonInfoFormat('docker')).toBe('{{.ServerVersion}}');
    expect(daemonInfoFormat('podman')).toBe('{{.Version.Version}}');
  });
});

describe('evaluateHostCapability', () => {
  it('passes when all probes meet requirements', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 4,
      freeDiskBytes: gib(30),
    });
    expect(assessment.passed).toBe(true);
    expect(assessment.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails runtime when daemon is down', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: false,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(40),
    });
    expect(assessment.passed).toBe(false);
    expect(assessment.checks.find((c) => c.id === 'runtime')?.passed).toBe(false);
    expect(assessment.checks.find((c) => c.id === 'runtime')?.detail).toMatch(/bundled container engine/i);
  });

  it('fails compose when missing', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: null,
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(40),
    });
    expect(assessment.passed).toBe(false);
    expect(assessment.checks.find((c) => c.id === 'compose')?.passed).toBe(false);
  });

  it('fails memory just below the threshold', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: ASSISTANT_STACK_REQUIREMENTS.minTotalMemoryBytes - 1,
      cpuCores: 8,
      freeDiskBytes: gib(40),
    });
    expect(assessment.passed).toBe(false);
    const memory = assessment.checks.find((c) => c.id === 'memory');
    expect(memory?.passed).toBe(false);
    expect(memory?.required).toBe(`≥ ${formatBytes(ASSISTANT_STACK_REQUIREMENTS.minTotalMemoryBytes)}`);
  });

  it('fails cpu and disk independently', () => {
    const lowCpu = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 2,
      freeDiskBytes: gib(40),
    });
    expect(lowCpu.checks.find((c) => c.id === 'cpu')?.passed).toBe(false);

    const lowDisk = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(10),
    });
    expect(lowDisk.checks.find((c) => c.id === 'disk')?.passed).toBe(false);
  });

  it('includes Docker/bundled detail when runtime is resolved', () => {
    const docker = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(40),
      runtime: {
        kind: 'docker',
        origin: 'system',
        cliPath: 'docker',
        composeArgv: ['compose'],
        env: {},
        apiEndpoint: 'unix:///var/run/docker.sock',
        version: { cli: '27.0.0', compose: '2.29.0' },
      },
    });
    expect(docker.checks.find((c) => c.id === 'runtime')?.detail).toMatch(/Docker/i);

    const bundled = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(40),
      runtime: {
        kind: 'podman',
        origin: 'bundled',
        cliPath: '/podman',
        composeBinaryPath: '/docker-compose',
        composeArgv: [],
        env: {},
        apiEndpoint: 'unix:///tmp/podman.sock',
        version: { cli: '5.0.0', compose: '2.29.0' },
      },
    });
    expect(bundled.checks.find((c) => c.id === 'runtime')?.detail).toMatch(/bundled/i);
  });

  it('includes lastRuntimeError on failed runtime and compose checks', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: false,
      composeVersion: null,
      totalMemoryBytes: gib(16),
      cpuCores: 8,
      freeDiskBytes: gib(40),
      lastRuntimeError: 'Bundled Podman assets are missing.',
    });
    expect(assessment.checks.find((c) => c.id === 'runtime')?.detail).toMatch(
      /Bundled Podman assets are missing/
    );
    expect(assessment.checks.find((c) => c.id === 'compose')?.detail).toMatch(
      /Bundled Podman assets are missing/
    );
  });

  it('passes when the assistant stack is already running even if resources are low', () => {
    const assessment = evaluateHostCapability({
      runtimeRunning: true,
      composeVersion: '2.29.0',
      totalMemoryBytes: gib(4),
      cpuCores: 2,
      freeDiskBytes: gib(5),
      stackAlreadyRunning: true,
    });
    expect(assessment.passed).toBe(true);
    expect(assessment.stackAlreadyRunning).toBe(true);
  });
});

describe('detectAssistantStackRunning', () => {
  it('requires boundary-hermes and boundary-hermes-webui containers', async () => {
    const { detectAssistantStackRunning } = await import('../capability/HostCapabilityService');
    expect(
      await detectAssistantStackRunning(async () => ['hermes', 'hermes-webui'])
    ).toBe(false);
    expect(
      await detectAssistantStackRunning(async () => [
        'boundary-hermes',
        'boundary-hermes-webui',
        'boundary-searxng',
      ])
    ).toBe(true);
  });

  it('requires the checkout names in local-stack mode', async () => {
    const { detectAssistantStackRunning } = await import('../capability/HostCapabilityService');
    expect(
      await detectAssistantStackRunning(async () => ['hermes', 'hermes-webui'], true)
    ).toBe(true);
    expect(
      await detectAssistantStackRunning(
        async () => ['boundary-hermes', 'boundary-hermes-webui'],
        true
      )
    ).toBe(false);
  });
});

describe('assessHostCapability + acknowledge', () => {
  beforeEach(() => {
    // Reset capability store via a failing then passing path is awkward;
    // clear by assessing fail then assessing pass without acknowledge.
  });

  it('persists assessment and keeps acknowledge after a later failure', async () => {
    await assessHostCapability(createProbes({ runtimeRunning: true }));
    const ack = acknowledgeHostCapability();
    expect(ack.success).toBe(true);
    expect(getCapabilityStatus().acknowledged).toBe(true);

    await assessHostCapability(createProbes({ runtimeRunning: false }));
    expect(getCapabilityStatus().acknowledged).toBe(true);
    expect(getCapabilityStatus().lastAssessment?.passed).toBe(false);
  });

  it('allows acknowledge without a passing assessment', async () => {
    await assessHostCapability(createProbes({ runtimeRunning: false }));
    const ack = acknowledgeHostCapability();
    expect(ack.success).toBe(true);
    expect(getCapabilityStatus().acknowledged).toBe(true);
  });
});
