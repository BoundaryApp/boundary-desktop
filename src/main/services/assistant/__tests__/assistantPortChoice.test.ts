import { describe, expect, it } from 'vitest';
import {
  BOUNDARY_ASSISTANT_PORT_OFFSETS,
  DEFAULT_ASSISTANT_STACK_PORTS,
  portsForIsolationMode,
} from '../../../../shared/assistantStackConstants';
import { chooseAssistantPorts, portSetCandidates } from '../assistantPortChoice';

const freeExcept =
  (...busy: number[]) =>
  async (port: number) =>
    !busy.includes(port);

describe('portSetCandidates', () => {
  it('starts with the defaults, then each offset', () => {
    const candidates = portSetCandidates({ includeDefaults: true });
    expect(candidates.map((c) => c.portOffset)).toEqual([0, ...BOUNDARY_ASSISTANT_PORT_OFFSETS]);
    expect(candidates[0]).toEqual({
      ports: DEFAULT_ASSISTANT_STACK_PORTS,
      isolationMode: 'default-ports',
      portOffset: 0,
    });
    expect(candidates[2].ports.llmProxyAdmin).toBe(24001);
  });

  it('leaves out the defaults for a separate instance', () => {
    const candidates = portSetCandidates({ includeDefaults: false });
    expect(candidates.map((c) => c.portOffset)).toEqual([...BOUNDARY_ASSISTANT_PORT_OFFSETS]);
    expect(candidates.every((c) => c.isolationMode === 'offset-ports')).toBe(true);
  });

  it('keeps every offset port below the macOS ephemeral range', () => {
    for (const { ports } of portSetCandidates({ includeDefaults: false })) {
      expect(Math.max(...Object.values(ports))).toBeLessThan(49152);
    }
  });
});

describe('chooseAssistantPorts', () => {
  it('takes the defaults when they are free', async () => {
    const choice = await chooseAssistantPorts(
      portSetCandidates({ includeDefaults: true }),
      freeExcept()
    );
    expect(choice).toMatchObject({ isolationMode: 'default-ports', portOffset: 0 });
  });

  it('moves to the next offset when one port of the first offset set is busy', async () => {
    // A developer stack holds 4001 and another project holds 18000 and 18080.
    const choice = await chooseAssistantPorts(
      portSetCandidates({ includeDefaults: false }),
      freeExcept(4001, 18000, 18080)
    );
    expect(choice).toEqual({
      isolationMode: 'offset-ports',
      portOffset: 20_000,
      ports: portsForIsolationMode('offset-ports', 20_000),
    });
  });

  it('names the busy ports of every set when none is free', async () => {
    const choice = await chooseAssistantPorts(
      portSetCandidates({ includeDefaults: true }),
      freeExcept(4001, 18000, 18080, 28643, 38787)
    );
    if (!('busy' in choice)) throw new Error('expected no free set');
    expect(choice.busy).toEqual([
      { portOffset: 0, ports: [{ service: 'llmProxyAdmin', port: 4001 }] },
      {
        portOffset: 10_000,
        ports: [
          { service: 'searxng', port: 18080 },
          { service: 'gptResearcher', port: 18000 },
        ],
      },
      { portOffset: 20_000, ports: [{ service: 'apiServer', port: 28643 }] },
      { portOffset: 30_000, ports: [{ service: 'webui', port: 38787 }] },
    ]);
    expect(choice.message).toBe(
      'No free set of ports for the assistant stack. In use: 4001 (llmProxyAdmin); ' +
        '18080 (searxng), 18000 (gptResearcher); 28643 (apiServer); 38787 (webui). ' +
        'Stop whatever holds one of these sets (`lsof -nP -iTCP:<port> -sTCP:LISTEN` shows it), then start again.'
    );
  });
});
