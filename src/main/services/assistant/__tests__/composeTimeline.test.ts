import { describe, expect, it } from 'vitest';
import { ComposeTimeline } from '../composeTimeline';

describe('ComposeTimeline', () => {
  it('keeps the first time of each status and the latest one per container', () => {
    const timeline = new ComposeTimeline(1_000);
    timeline.record({ id: 'Container boundary-hermes', status: 'Working', text: 'Creating' }, 2_000);
    timeline.record({ id: 'Container boundary-hermes', status: 'Working', text: 'Starting' }, 5_000);
    timeline.record({ id: 'Container boundary-hermes', status: 'Working', text: 'Waiting' }, 6_000);
    timeline.record({ id: 'Container boundary-hermes', status: 'Working', text: 'Starting' }, 9_000);

    expect(timeline.summary()).toEqual({
      'boundary-hermes': {
        steps: { Creating: 1_000, Starting: 4_000, Waiting: 5_000 },
        last: 'Starting',
        lastMs: 8_000,
      },
    });
  });

  it('ignores events it cannot tie to a container or that carry no text', () => {
    const timeline = new ComposeTimeline(0);
    timeline.record({ id: 'Network boundary_default', status: 'Done', text: 'Created' }, 10);
    timeline.record({ id: 'Container boundary-hermes', status: 'Working' }, 20);
    expect(timeline.summary()).toEqual({});
  });
});
