import { describe, expect, it, vi } from 'vitest';
import {
  applyComposeProgressEvent,
  createLifecycleSnapshot,
  parseComposeProgressLine,
  progressFromComposeText,
  resolveContainerFromImageRef,
  resolveContainerFromProgressId,
  seedServiceProgress,
} from '../../../../shared/assistantStackLifecycle';
import { __test } from '../AssistantStackService';

describe('assistantStackLifecycle', () => {
  it('maps the proxy and OpenCode MCP images to their own cards', () => {
    expect(resolveContainerFromImageRef('boundary-assistant-opencode-mcp:local')).toBe(
      'boundary-opencode-mcp'
    );
    expect(resolveContainerFromImageRef('boundary-assistant-llm-proxy:local')).toBe(
      'boundary-llm-proxy'
    );
    expect(resolveContainerFromImageRef('assistant-opencode:local')).toBe('boundary-opencode');
    expect(resolveContainerFromImageRef('boundary-assistant-hermes-worker:local')).toBe(
      'boundary-hermes-worker'
    );
  });

  it('maps the shared database images without catching n8n postgres', () => {
    expect(resolveContainerFromImageRef('postgres:18-alpine')).toBe('boundary-postgres-db');
    expect(resolveContainerFromImageRef('crystaldba/postgres-mcp:0.3.0')).toBe(
      'boundary-sql-mcp-ro'
    );
    expect(resolveContainerFromImageRef('postgres:16-alpine')).toBeNull();
    expect(resolveContainerFromProgressId('Container boundary-sql-mcp-rw')).toBe(
      'boundary-sql-mcp-rw'
    );
    expect(resolveContainerFromProgressId('Container boundary-n8n-postgres')).not.toBe(
      'boundary-postgres-db'
    );
  });

  it('seeds one card per Boundary container', () => {
    const services = seedServiceProgress();
    expect(services).toHaveLength(14);
    expect(services.map((s) => s.containerName)).toContain('boundary-hermes');
    expect(services.map((s) => s.containerName)).toContain('boundary-opencode');
    expect(services.map((s) => s.containerName)).toContain('boundary-llm-proxy');
    expect(services.map((s) => s.containerName)).toContain('boundary-hermes-worker');
    expect(services.every((s) => s.state === 'pending' && s.progress === 0.05)).toBe(true);
  });

  it('maps image pull parent_id events onto service cards with download fill', () => {
    let services = seedServiceProgress();
    services = applyComposeProgressEvent(services, {
      id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Working',
      text: 'Pulling',
    });
    expect(services.find((s) => s.containerName === 'boundary-gpt-researcher')).toMatchObject({
      state: 'working',
      statusText: 'Pulling',
    });
    expect(
      services.find((s) => s.containerName === 'boundary-gpt-researcher')!.progress
    ).toBeGreaterThan(0);

    // Sibling cards that are still idle should show waiting/queued, not blank Waiting 0%.
    expect(
      services.find((s) => s.containerName === 'boundary-hermes')?.statusText
    ).toMatch(/Queued|Waiting to start/);

    services = applyComposeProgressEvent(services, {
      id: 'fcf0ff3b834b',
      parent_id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Working',
      text: 'Downloading',
      current: 50_000_000,
      total: 100_000_000,
    });
    const gptr = services.find((s) => s.containerName === 'boundary-gpt-researcher')!;
    expect(gptr.state).toBe('working');
    expect(gptr.progress).toBeGreaterThan(0.3);
    expect(gptr.progress).toBeLessThan(1);
    expect(gptr.statusText).toMatch(/Downloading/);
    expect(services.find((s) => s.containerName === 'boundary-hermes')).toMatchObject({
      statusText: 'Queued — waiting on other images…',
      progress: 0.08,
    });
    // Layer Done must not mark the whole service done.
    services = applyComposeProgressEvent(services, {
      id: 'fcf0ff3b834b',
      parent_id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Done',
      text: 'Download complete',
      percent: 100,
    });
    expect(services.find((s) => s.containerName === 'boundary-gpt-researcher')?.state).toBe(
      'working'
    );
  });

  it('marks local images as Image cached from docker images listing', async () => {
    const { applyLocalImageListing } = await import(
      '../../../../shared/assistantStackLifecycle'
    );
    const primed = applyLocalImageListing(seedServiceProgress(), [
      'nousresearch/hermes-agent:v2026.8.3',
      'neo4j:5.26-community',
      'gptresearcher/gpt-researcher:0.8.1',
    ]);
    expect(primed.find((s) => s.containerName === 'boundary-hermes')).toMatchObject({
      statusText: 'Image cached',
      progress: 0.2,
      state: 'pending',
    });
    expect(primed.find((s) => s.containerName === 'boundary-lightrag-neo4j')).toMatchObject({
      statusText: 'Image cached',
    });
    expect(primed.find((s) => s.containerName === 'boundary-opencode')?.statusText).toBe(
      'Queued…'
    );

    // While a peer downloads, cached siblings become Waiting to start.
    const duringPull = applyComposeProgressEvent(primed, {
      id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Working',
      text: 'Downloading',
      current: 10,
      total: 100,
    });
    expect(duringPull.find((s) => s.containerName === 'boundary-hermes')).toMatchObject({
      statusText: 'Waiting to start…',
      progress: 0.2,
    });
    expect(duringPull.find((s) => s.containerName === 'boundary-gpt-researcher')?.statusText).toMatch(
      /Downloading/
    );
  });

  it('resolves Container-prefixed and service names', () => {
    expect(resolveContainerFromProgressId('Container boundary-hermes')).toBe('boundary-hermes');
    expect(resolveContainerFromProgressId('Container boundary-hermes-webui')).toBe(
      'boundary-hermes-webui'
    );
    expect(resolveContainerFromProgressId('boundary-n8n')).toBe('boundary-n8n');
    expect(resolveContainerFromProgressId('hermes-webui')).toBe('boundary-hermes-webui');
    expect(resolveContainerFromProgressId('gpt-researcher')).toBe('boundary-gpt-researcher');
    expect(resolveContainerFromProgressId('Network boundary-assistant_default')).toBeNull();
    expect(resolveContainerFromProgressId('Image gptresearcher/gpt-researcher:0.8.1')).toBe(
      'boundary-gpt-researcher'
    );
  });

  it('maps compose text to fill progress with healthy as only 100% on start', () => {
    expect(progressFromComposeText('Working', 'Pulling')).toMatchObject({
      state: 'working',
      progress: 0.35,
    });
    expect(progressFromComposeText('Working', 'Creating')).toMatchObject({
      state: 'working',
      progress: 0.65,
    });
    expect(progressFromComposeText('Done', 'Created')).toMatchObject({
      state: 'working',
      progress: 0.7,
    });
    expect(progressFromComposeText('Working', 'Starting')).toMatchObject({
      state: 'working',
      progress: 0.8,
    });
    expect(progressFromComposeText('Done', 'Started')).toMatchObject({
      state: 'working',
      progress: 0.85,
    });
    expect(progressFromComposeText('Done', 'Healthy')).toMatchObject({
      state: 'done',
      progress: 1,
    });
    expect(progressFromComposeText('Working', 'Stopping')).toMatchObject({
      state: 'working',
      progress: 0.4,
    });
    expect(progressFromComposeText('Done', 'Stopped')).toMatchObject({
      state: 'done',
      progress: 1,
    });
  });

  it('parses NDJSON progress lines and ignores junk', () => {
    expect(parseComposeProgressLine('not json')).toBeNull();
    expect(
      parseComposeProgressLine(
        JSON.stringify({ id: 'Container boundary-searxng', status: 'Working', text: 'Starting' })
      )
    ).toEqual({
      id: 'Container boundary-searxng',
      status: 'Working',
      text: 'Starting',
    });
  });

  it('applies events onto matching services only', () => {
    let services = seedServiceProgress();
    services = applyComposeProgressEvent(services, {
      id: 'Container boundary-lightrag',
      status: 'Working',
      text: 'Creating',
    });
    const target = services.find((s) => s.containerName === 'boundary-lightrag');
    const other = services.find((s) => s.containerName === 'boundary-hermes');
    expect(target?.state).toBe('working');
    expect(target?.progress).toBe(0.65);
    expect(other?.state).toBe('pending');
    expect(other?.progress).toBe(0.08);
    expect(other?.statusText).toMatch(/Queued/);

    services = applyComposeProgressEvent(services, {
      id: 'boundary-lightrag',
      status: 'Done',
      text: 'Started',
    });
    expect(services.find((s) => s.containerName === 'boundary-lightrag')).toMatchObject({
      state: 'working',
      progress: 0.85,
      statusText: 'Started',
    });

    services = applyComposeProgressEvent(services, {
      id: 'boundary-lightrag',
      status: 'Done',
      text: 'Healthy',
    });
    expect(services.find((s) => s.containerName === 'boundary-lightrag')).toMatchObject({
      state: 'done',
      progress: 1,
      statusText: 'Healthy',
    });
  });

  it('Pull → Created → Started → Healthy is strictly non-decreasing', () => {
    let services = seedServiceProgress();
    const phases: Array<{ status: string; text: string; image?: boolean }> = [
      { status: 'Working', text: 'Pulling', image: true },
      { status: 'Done', text: 'Created' },
      { status: 'Done', text: 'Started' },
      { status: 'Done', text: 'Healthy' },
    ];
    let last = 0;
    for (const phase of phases) {
      services = applyComposeProgressEvent(services, {
        id: phase.image
          ? 'Image gptresearcher/gpt-researcher:0.8.1'
          : 'Container boundary-gpt-researcher',
        status: phase.status,
        text: phase.text,
      });
      const p = services.find((s) => s.containerName === 'boundary-gpt-researcher')!.progress;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    expect(last).toBe(1);
  });

  it('createLifecycleSnapshot marks ready services done', () => {
    const snap = createLifecycleSnapshot('ready', { message: 'ok' });
    expect(snap.phase).toBe('ready');
    expect(snap.services.every((s) => s.state === 'done' && s.progress === 1)).toBe(true);
  });

  it('markStackReadyAfterEnsure sets Hermes healthy and Started cards Ready', async () => {
    const { markStackReadyAfterEnsure } = await import(
      '../../../../shared/assistantStackLifecycle'
    );
    const services = seedServiceProgress().map((s) => {
      if (s.containerName === 'boundary-hermes') {
        return { ...s, state: 'working' as const, progress: 0.85, statusText: 'Started' };
      }
      if (s.containerName === 'boundary-opencode') {
        return { ...s, state: 'working' as const, progress: 0.9, statusText: 'Started' };
      }
      if (s.containerName === 'boundary-searxng') {
        return { ...s, state: 'working' as const, progress: 0.4, statusText: 'Pulling' };
      }
      return s;
    });
    const ready = markStackReadyAfterEnsure(services);
    expect(ready.find((s) => s.containerName === 'boundary-hermes')).toMatchObject({
      progress: 1,
      statusText: 'Healthy',
      state: 'done',
    });
    expect(ready.find((s) => s.containerName === 'boundary-opencode')).toMatchObject({
      progress: 1,
      statusText: 'Ready',
      state: 'done',
    });
    expect(ready.find((s) => s.containerName === 'boundary-searxng')).toMatchObject({
      progress: 0.4,
      statusText: 'Pulling',
    });
  });

  it('handleProgressLine updates in-memory lifecycle snapshot', () => {
    __test.resetLifecycle();
    __test.setLifecycleSnapshot(createLifecycleSnapshot('starting'));
    __test.handleProgressLine(
      JSON.stringify({
        id: 'Container boundary-opencode',
        status: 'Done',
        text: 'Started',
      })
    );
    const snap = __test.getLifecycleSnapshot();
    expect(snap.services.find((s) => s.containerName === 'boundary-opencode')).toMatchObject({
      state: 'working',
      progress: 0.85,
      statusText: 'Started',
    });
  });

  it('sibling-queue never lowers a card already past image-cached', async () => {
    const { markSiblingServicesQueued } = await import(
      '../../../../shared/assistantStackLifecycle'
    );
    const services = seedServiceProgress().map((s) => {
      if (s.containerName === 'boundary-gpt-researcher') {
        return {
          ...s,
          state: 'working' as const,
          progress: 0.45,
          statusText: 'Downloading 80%',
        };
      }
      if (s.containerName === 'boundary-hermes') {
        return {
          ...s,
          state: 'working' as const,
          progress: 0.5,
          statusText: 'Image cached',
        };
      }
      return s;
    });
    const queued = markSiblingServicesQueued(services);
    const hermes = queued.find((s) => s.containerName === 'boundary-hermes')!;
    expect(hermes.progress).toBeGreaterThanOrEqual(0.5);
    expect(hermes.statusText).toBe('Waiting to start…');
  });

  it('marks Pulled cards as Waiting to start while a peer is still downloading', async () => {
    const { markSiblingServicesQueued, PROGRESS } = await import(
      '../../../../shared/assistantStackLifecycle'
    );
    const services = seedServiceProgress().map((s) => {
      if (s.containerName === 'boundary-gpt-researcher') {
        return {
          ...s,
          state: 'working' as const,
          progress: 0.4,
          statusText: 'Downloading 40%',
        };
      }
      if (s.containerName === 'boundary-hermes') {
        return {
          ...s,
          state: 'working' as const,
          progress: PROGRESS.pulled,
          statusText: 'Pulled',
        };
      }
      return s;
    });
    const queued = markSiblingServicesQueued(services);
    expect(queued.find((s) => s.containerName === 'boundary-hermes')).toMatchObject({
      statusText: 'Waiting to start…',
      progress: PROGRESS.pulled,
      state: 'pending',
    });
    expect(queued.find((s) => s.containerName === 'boundary-gpt-researcher')?.statusText).toBe(
      'Downloading 40%'
    );
  });

  it('createLifecycleSnapshot stamps stage and updatedAt', () => {
    const snap = createLifecycleSnapshot('starting', {
      message: 'Preparing…',
      stage: 'provision',
    });
    expect(snap.stage).toBe('provision');
    expect(snap.stageStartedAt).toEqual(expect.any(Number));
    expect(snap.updatedAt).toEqual(expect.any(Number));
  });

  it('startElapsedHeartbeat emits elapsed messages then stops', async () => {
    vi.useFakeTimers();
    try {
      const { startElapsedHeartbeat } = await import(
        '../../../../shared/assistantStackLifecycle'
      );
      const ticks: string[] = [];
      const stop = startElapsedHeartbeat((message) => ticks.push(message), 'Initializing Hermes', 1000);
      expect(ticks).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ticks[0]).toMatch(/Initializing Hermes… 1s/);
      await vi.advanceTimersByTimeAsync(2000);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      stop();
      const afterStop = ticks.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(ticks).toHaveLength(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('download fraction drop for a new layer does not lower fill', () => {
    let services = seedServiceProgress();
    services = applyComposeProgressEvent(services, {
      id: 'layer-a',
      parent_id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Working',
      text: 'Downloading',
      current: 90,
      total: 100,
    });
    const afterHigh = services.find((s) => s.containerName === 'boundary-gpt-researcher')!.progress;
    expect(afterHigh).toBeGreaterThan(0.4);

    services = applyComposeProgressEvent(services, {
      id: 'layer-b',
      parent_id: 'Image gptresearcher/gpt-researcher:0.8.1',
      status: 'Working',
      text: 'Downloading',
      current: 10,
      total: 100,
    });
    const afterLow = services.find((s) => s.containerName === 'boundary-gpt-researcher')!;
    expect(afterLow.progress).toBeGreaterThanOrEqual(afterHigh);
  });

  it('mergeServicesById preserves higher previous progress', async () => {
    const { mergeServicesById } = await import('../../../../shared/assistantStackLifecycle');
    const previous = seedServiceProgress().map((s) =>
      s.containerName === 'boundary-hermes'
        ? { ...s, progress: 0.7, state: 'working' as const, statusText: 'Created' }
        : s
    );
    const incoming = seedServiceProgress('pending', 'Waiting…', 0.05);
    const merged = mergeServicesById(previous, incoming, 'test-reseed');
    expect(merged.find((s) => s.containerName === 'boundary-hermes')!.progress).toBe(0.7);
  });

  it('monotonicProgress logs and clamps regressions in non-production', async () => {
    const { monotonicProgress } = await import('../../../../shared/assistantStackLifecycle');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(monotonicProgress(0.6, 0.2, 'unit-test')).toBe(0.6);
    expect(spy).toHaveBeenCalledWith(
      '[assistant-stack] progress regression blocked',
      expect.objectContaining({ previous: 0.6, next: 0.2, context: 'unit-test' })
    );
    spy.mockRestore();
  });
});
