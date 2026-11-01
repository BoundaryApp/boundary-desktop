import { describe, expect, it } from 'vitest';
import { BOUNDARY_ASSISTANT_CONTAINER_NAMES } from '../../../../shared/assistantStackConstants';
import { seedServiceProgress } from '../../../../shared/assistantStackLifecycle';
import type { AssistantStackServiceProgress } from '../../../../shared/types/assistantStack';
import { expectedOffsets, type StartTiming } from '../../../../shared/startupTiming';
import {
  STARTUP_TOOLS,
  stageCopy,
  startupEstimate,
  startupProgress,
  toolFill,
  toolState,
} from '../startupModel';

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

const timing = (overrides: Partial<StartTiming> = {}): StartTiming => ({
  startedAt: 0,
  kind: 'relaunch',
  expected: expectedOffsets('relaunch', []),
  expectedServices: {},
  reached: {},
  fromHistory: true,
  ...overrides,
});

describe('startupProgress', () => {
  it('fills to the end only when the stack is ready', () => {
    expect(startupProgress('compose', timing(), 60_000)).toBeLessThan(1);
    expect(startupProgress('ready', timing(), 60_000)).toBe(1);
  });

  it('shows a sliver before main has sent any timing', () => {
    expect(startupProgress('compose', undefined, 60_000)).toBe(0.02);
  });
});

describe('startupEstimate', () => {
  it('says nothing specific until this Mac has finished a start of this kind', () => {
    expect(startupEstimate(timing({ fromHistory: false }), 0)).toMatchObject({
      text: 'This usually takes a few minutes',
      unknown: true,
    });
  });

  it('keeps a figure from climbing', () => {
    const estimate = startupEstimate(timing(), 0, 2);
    expect(estimate.minutes).toBe(2);
    expect(estimate.text).toBe('A couple of minutes left');
  });

  it('stops giving a figure once a start runs well past it', () => {
    expect(startupEstimate(timing(), 20 * 60_000, 1).text).toBe('Taking longer than usual');
  });
});

describe('stageCopy', () => {
  it('says checking, not downloading, on a later launch', () => {
    expect(stageCopy('provision', 'first-run')).toBe('Downloading your tools');
    expect(stageCopy('provision', 'launch')).toBe('Checking your tools');
  });
});

describe('toolFill', () => {
  const timing = (expectedServices: StartTiming['expectedServices'] = {}): StartTiming => ({
    startedAt: 0,
    kind: 'relaunch',
    expected: expectedOffsets('relaunch', []),
    expectedServices,
    reached: {},
    fromHistory: true,
  });
  const queued = seedServiceProgress('pending', 'Queued…', 0.05);

  it('follows time toward when earlier starts had the tool up', () => {
    const history = timing({ 'boundary-n8n': 100_000 });
    expect(toolFill(tool('automations'), queued, history, 50_000)).toBeCloseTo(0.5);
  });

  it('waits for the slowest of a tool\'s containers', () => {
    const history = timing({
      'boundary-lightrag': 40_000,
      'boundary-lightrag-neo4j': 100_000,
    });
    expect(toolFill(tool('memory'), queued, history, 50_000)).toBeCloseTo(0.5);
  });

  it('uses the milestone default for a container with no history', () => {
    const run = timing();
    expect(toolFill(tool('search'), queued, run, run.expected.apiBootstrapDone / 2)).toBeCloseTo(0.5);
  });

  it('stops short of full when a tool runs late, and fills only when done', () => {
    const history = timing({ 'boundary-searxng': 10_000 });
    expect(toolFill(tool('search'), queued, history, 3_600_000)).toBeLessThan(1);
    const done = withService(queued, 'boundary-searxng', { state: 'done', progress: 1 });
    expect(toolFill(tool('search'), done, history, 1_000)).toBe(1);
  });

  it('jumps ahead on what Compose reports, but not on pull progress', () => {
    const history = timing({ 'boundary-searxng': 100_000 });
    const pulling = withService(queued, 'boundary-searxng', { state: 'working', progress: 0.55 });
    expect(toolFill(tool('search'), pulling, history, 10_000)).toBeCloseTo(0.1);
    const started = withService(queued, 'boundary-searxng', { state: 'working', progress: 0.85 });
    expect(toolFill(tool('search'), started, history, 10_000)).toBeCloseTo(0.85);
  });
});
