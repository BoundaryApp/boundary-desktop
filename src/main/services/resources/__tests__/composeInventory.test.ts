import { describe, expect, it } from 'vitest';
import { mapComposeInventory } from '../composeInventory';

describe('mapComposeInventory', () => {
  it('keeps observe-only fields and drops urls', () => {
    const projects = mapComposeInventory([
      {
        id: 'abc',
        name: 'boundary-assistant',
        status: 'running',
        path: '/Users/me/assistant',
        lastUpdated: '2026-09-25T12:00:00.000Z',
        services: [
          {
            name: 'hermes',
            status: 'running',
            image: 'boundary-hermes',
            ports: ['8642:8642'],
            health: 'healthy',
          },
        ],
      },
    ]);

    expect(projects).toEqual([
      {
        id: 'abc',
        name: 'boundary-assistant',
        status: 'running',
        path: '/Users/me/assistant',
        services: [{ name: 'hermes', status: 'running', ports: ['8642:8642'] }],
      },
    ]);
    expect(projects[0]).not.toHaveProperty('urls');
  });
});
