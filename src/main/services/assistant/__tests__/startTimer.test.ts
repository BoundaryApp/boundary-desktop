import { describe, expect, it, vi } from 'vitest';
import { StartTimer } from '../startTimer';

const startedEvent = (id: string) => ({ id, status: 'Done', text: 'Started' }) as const;

describe('StartTimer', () => {
  it('keeps the first time a milestone is reached', () => {
    const timer = new StartTimer('relaunch', () => [], 1_000);
    expect(timer.reach('prepared', 2_000)).toBe(true);
    expect(timer.reach('prepared', 9_000)).toBe(false);
    expect(timer.timing().reached.prepared).toBe(1_000);
  });

  it('reads the bootstraps and Hermes from Compose events', () => {
    const timer = new StartTimer('relaunch', () => [], 0);
    timer.noteComposeEvent(startedEvent('Container boundary-assistant-hermes-api-bootstrap-1'), 2_000);
    timer.noteComposeEvent(
      { id: 'Container boundary-assistant-hermes-api-bootstrap-1', text: 'Exited' },
      128_000
    );
    timer.noteComposeEvent(
      { id: 'Container boundary-assistant-hermes-browser-bootstrap-1', text: 'Exited' },
      210_000
    );
    timer.noteComposeEvent(startedEvent('Container boundary-hermes-worker'), 211_000);
    timer.noteComposeEvent(startedEvent('Container boundary-hermes'), 212_000);
    expect(timer.timing().reached).toMatchObject({
      toolsStarting: 2_000,
      apiBootstrapDone: 128_000,
      browserBootstrapDone: 210_000,
      hermesStarted: 212_000,
    });
  });

  it('says when an event passed a milestone, so main can tell the screen', () => {
    const timer = new StartTimer('relaunch', () => [], 0);
    expect(timer.noteComposeEvent(startedEvent('Container boundary-searxng'), 1)).toBe(true);
    expect(timer.noteComposeEvent(startedEvent('Container boundary-n8n'), 2)).toBe(false);
    expect(timer.noteComposeEvent({ id: 'Container boundary-searxng', text: 'Healthy' }, 3)).toBe(false);
  });

  it('uses the earlier runs of the kind the start turned out to be', () => {
    const earlierRuns = vi.fn((kind: string) =>
      kind === 'newContainers' ? [{ stackUp: 90_000 }] : []
    );
    const timer = new StartTimer('relaunch', earlierRuns, 0);
    expect(timer.timing().fromHistory).toBe(false);
    timer.setKind('newContainers');
    expect(timer.timing()).toMatchObject({ kind: 'newContainers', fromHistory: true });
    expect(timer.timing().expected.stackUp).toBe(90_000);
  });

  it('times each container by its latest Started or Healthy', () => {
    const timer = new StartTimer('relaunch', () => [], 0);
    timer.noteComposeEvent(startedEvent('Container boundary-assistant-hermes-api-bootstrap-1'), 1_000);
    timer.noteComposeEvent(startedEvent('Container boundary-searxng'), 2_000);
    timer.noteComposeEvent({ id: 'Container boundary-searxng', text: 'Healthy' }, 9_000);
    timer.noteComposeEvent({ id: 'Container boundary-n8n', text: 'Creating' }, 10_000);
    expect(timer.timing().reached.services).toEqual({ 'boundary-searxng': 9_000 });
  });

  it('expects each container at its median from earlier runs', () => {
    const runs = [
      { stackUp: 9, services: { 'boundary-n8n': 10_000 } },
      { stackUp: 9, services: { 'boundary-n8n': 30_000 } },
      { stackUp: 9, services: { 'boundary-n8n': 20_000 } },
      { stackUp: 9 },
    ];
    const timer = new StartTimer('relaunch', () => runs, 0);
    expect(timer.timing().expectedServices).toEqual({ 'boundary-n8n': 20_000 });
  });
});
