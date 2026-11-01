import { describe, expect, it } from 'vitest';
import { agentAppAccessEnabled, checkInferenceRoute, type RouteEntry } from '../agentAppAccess';
import { listedHostTools } from '../toolCatalog';

const local: RouteEntry = { slot: 'local', modelId: 'qwen', endpoint: 'http://127.0.0.1:1234/v1' };
const trusted = (id: string) => id === 'friend';

describe('agentAppAccessEnabled', () => {
  it('is on for an unpackaged run and off for a packaged one', () => {
    expect(agentAppAccessEnabled({}, false)).toBe(true);
    expect(agentAppAccessEnabled({}, true)).toBe(false);
  });

  it('follows the variable when it is set', () => {
    expect(agentAppAccessEnabled({ BOUNDARY_AGENT_APP_ACCESS: '1' }, true)).toBe(true);
    expect(agentAppAccessEnabled({ BOUNDARY_AGENT_APP_ACCESS: 'true' }, true)).toBe(true);
    expect(agentAppAccessEnabled({ BOUNDARY_AGENT_APP_ACCESS: '0' }, false)).toBe(false);
  });
});

describe('listedHostTools', () => {
  const names = (agentAppAccess: boolean) =>
    listedHostTools({ offerCalendarSetup: false, agentAppAccess }).map((tool) => tool.name);

  it('lists the app tools only when access is on', () => {
    expect(names(false)).not.toContain('get_app_status');
    expect(names(false)).not.toContain('get_recent_problems');
    expect(names(true)).toEqual(expect.arrayContaining(['get_app_status', 'get_recent_problems']));
  });
});

describe('checkInferenceRoute', () => {
  it('passes a local model, including one on the local network', () => {
    expect(checkInferenceRoute([local], trusted).ok).toBe(true);
    const lan = { ...local, endpoint: 'http://192.168.1.20:8080/v1' };
    expect(checkInferenceRoute([lan], trusted).ok).toBe(true);
  });

  it('passes a Trusted shared model and refuses any other', () => {
    expect(checkInferenceRoute([{ slot: 'peer', modelId: 'm', providerId: 'friend' }], trusted).ok).toBe(true);
    expect(checkInferenceRoute([{ slot: 'peer', modelId: 'm', providerId: 'stranger' }], trusted)).toEqual({
      ok: false,
      reason: "Refused because m is shared by a provider who isn't Trusted.",
    });
    expect(checkInferenceRoute([{ slot: 'peer', modelId: 'm' }], trusted).ok).toBe(false);
  });

  it('refuses a chain with a cloud entry anywhere in it, and names the entry', () => {
    const cloud: RouteEntry = { slot: 'openrouter', modelId: 'gpt', endpoint: 'https://openrouter.ai/api/v1' };
    expect(checkInferenceRoute([local, cloud], trusted)).toEqual({
      ok: false,
      reason: 'Refused because gpt is a cloud model.',
    });
    expect(checkInferenceRoute([{ ...cloud, slot: 'infrastructure' }], trusted).ok).toBe(false);
  });

  it('refuses a local slot aimed at a remote host or an unreadable endpoint', () => {
    expect(checkInferenceRoute([{ ...local, endpoint: 'https://api.example.com/v1' }], trusted).ok).toBe(false);
    expect(checkInferenceRoute([{ ...local, endpoint: 'not a url' }], trusted).ok).toBe(false);
    expect(checkInferenceRoute([{ slot: 'local', modelId: 'qwen' }], trusted).ok).toBe(false);
  });

  it('refuses when no route is applied', () => {
    expect(checkInferenceRoute(null, trusted).ok).toBe(false);
    expect(checkInferenceRoute([], trusted).ok).toBe(false);
  });
});
