import { describe, expect, it } from 'vitest';
import {
  engineLabelForRuntime,
  shortenApiEndpoint,
} from '../containerRuntime/runtimeDiagnostics';
import type { ContainerRuntime } from '../containerRuntime/types';

function runtime(partial: Partial<ContainerRuntime>): ContainerRuntime {
  return {
    kind: 'docker',
    origin: 'system',
    cliPath: 'docker',
    composeArgv: ['compose'],
    env: {},
    apiEndpoint: 'unix:///var/run/docker.sock',
    version: { cli: '27.0.0', compose: '2.29.0' },
    ...partial,
  };
}

describe('runtimeDiagnostics helpers', () => {
  it('labels system Docker and bundled Podman', () => {
    expect(engineLabelForRuntime(runtime({}))).toBe('Docker Desktop / Docker Engine');
    expect(
      engineLabelForRuntime(
        runtime({
          kind: 'podman',
          origin: 'bundled',
          cliPath: '/app/podman',
          composeBinaryPath: '/app/docker-compose',
          composeArgv: [],
        })
      )
    ).toBe('Boundary’s bundled Podman');
  });

  it('shortens long unix endpoints while leaving short ones intact', () => {
    expect(shortenApiEndpoint('unix:///var/run/docker.sock')).toBe(
      'unix:///var/run/docker.sock'
    );
    const long =
      'unix:///Users/you/Library/Application Support/Boundary/container-runtime/machine/boundary/podman.sock';
    const shortened = shortenApiEndpoint(long, 48);
    expect(shortened.startsWith('…')).toBe(true);
    expect(shortened.length).toBeLessThanOrEqual(48);
    expect(shortened.endsWith('podman.sock')).toBe(true);
  });
});
