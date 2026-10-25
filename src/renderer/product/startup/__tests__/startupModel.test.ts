import { describe, expect, it } from 'vitest';
import { BOUNDARY_ASSISTANT_CONTAINER_NAMES } from '../../../../shared/assistantStackConstants';
import { seedServiceProgress } from '../../../../shared/assistantStackLifecycle';
import type { AssistantStackServiceProgress } from '../../../../shared/types/assistantStack';
import { STARTUP_TOOLS, stageCopy, startupProgress, toolState } from '../startupModel';

function tool(id: string) {
  const found = STARTUP_TOOLS.find((t) => t.id === id);
  if (!found) throw new Error(`no tool ${id}`);
  return found;
}

function withService(
  services: AssistantStackServiceProgress[],
  containerName: string,
  patch: Partial<AssistantStackServiceProgress>
): AssistantStackServiceProgress[] {
  return services.map((s) => (s.containerName === containerName ? { ...s, ...patch } : s));
}

describe('STARTUP_TOOLS', () => {
  it('covers every stack container exactly once', () => {
    const covered = STARTUP_TOOLS.flatMap((t) => t.containers).sort();
    expect(covered).toEqual([...BOUNDARY_ASSISTANT_CONTAINER_NAMES].sort());
  });
});

describe('toolState', () => {
  const seeded = seedServiceProgress('pending', 'Queued…', 0.05);

  it('is pending until a container starts', () => {
    expect(toolState(tool('memory'), seeded)).toBe('pending');
  });

  it('is working while any of its containers works', () => {
    const services = withService(seeded, 'boundary-lightrag', { state: 'working', progress: 0.3 });
    expect(toolState(tool('memory'), services)).toBe('working');
  });

  it('is done only when all of its containers are done', () => {
    let services = withService(seeded, 'boundary-lightrag', { state: 'done', progress: 1 });
    expect(toolState(tool('memory'), services)).not.toBe('done');
    services = withService(services, 'boundary-lightrag-neo4j', { state: 'done', progress: 1 });
    expect(toolState(tool('memory'), services)).toBe('done');
  });

  it('reports an error from any of its containers', () => {
    const services = withService(seeded, 'boundary-opencode-mcp', { state: 'error' });
    expect(toolState(tool('coding'), services)).toBe('error');
  });
});

describe('startupProgress', () => {
  const services = seedServiceProgress('pending', 'Queued…', 0);

  it('moves forward through the stages', () => {
    const order = ['provision', 'hostSetup', 'hermesInit', 'compose', 'configureLlm', 'ready'] as const;
    const values = order.map((stage) => startupProgress(stage, services, 0));
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values.at(-1)).toBe(1);
  });

  it('creeps within a silent stage without reaching its end', () => {
    const early = startupProgress('provision', services, 5_000);
    const late = startupProgress('provision', services, 10 * 60_000);
    expect(late).toBeGreaterThan(early);
    expect(late).toBeLessThan(startupProgress('hostSetup', services, 0) + 1e-9);
  });

  it('follows container progress during compose', () => {
    const half = seedServiceProgress('working', 'Pulling…', 0.5);
    expect(startupProgress('compose', half, 0)).toBeGreaterThan(startupProgress('compose', services, 0));
  });
});

describe('stageCopy', () => {
  it('says checking, not downloading, on a later launch', () => {
    expect(stageCopy('provision', 'first-run')).toBe('Downloading your tools');
    expect(stageCopy('provision', 'launch')).toBe('Checking your tools');
  });
});
