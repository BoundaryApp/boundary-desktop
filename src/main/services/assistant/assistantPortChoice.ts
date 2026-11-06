import {
  BOUNDARY_ASSISTANT_PORT_OFFSETS,
  portsForIsolationMode,
} from '../../../shared/assistantStackConstants';
import type {
  AssistantStackIsolationMode,
  AssistantStackPorts,
} from '../../../shared/types/assistantStack';

export interface AssistantPortSet {
  ports: AssistantStackPorts;
  isolationMode: AssistantStackIsolationMode;
  /** 0 for the defaults. */
  portOffset: number;
}

export interface BusyPortSet {
  portOffset: number;
  ports: { service: keyof AssistantStackPorts; port: number }[];
}

/** Returned when no set is free. Tell it apart with `'busy' in choice`. */
export interface AssistantPortsBusy {
  busy: BusyPortSet[];
  message: string;
}

/** The port sets to try, in order: the defaults (unless skipped), then each offset. */
export function portSetCandidates(options: { includeDefaults: boolean }): AssistantPortSet[] {
  const offsets: AssistantPortSet[] = BOUNDARY_ASSISTANT_PORT_OFFSETS.map((portOffset) => ({
    ports: portsForIsolationMode('offset-ports', portOffset),
    isolationMode: 'offset-ports',
    portOffset,
  }));
  if (!options.includeDefaults) return offsets;
  return [
    { ports: portsForIsolationMode('default-ports'), isolationMode: 'default-ports', portOffset: 0 },
    ...offsets,
  ];
}

/** The first candidate whose ports are all free, or every candidate's busy ports. */
export async function chooseAssistantPorts(
  candidates: AssistantPortSet[],
  isPortFree: (port: number) => Promise<boolean>
): Promise<AssistantPortSet | AssistantPortsBusy> {
  const busy: BusyPortSet[] = [];
  for (const candidate of candidates) {
    const entries = Object.entries(candidate.ports) as [keyof AssistantStackPorts, number][];
    const free = await Promise.all(entries.map(([, port]) => isPortFree(port)));
    const taken = entries
      .filter((_, i) => !free[i])
      .map(([service, port]) => ({ service, port }));
    if (taken.length === 0) return candidate;
    busy.push({ portOffset: candidate.portOffset, ports: taken });
  }
  return { busy, message: describeBusyPorts(busy) };
}

function describeBusyPorts(busy: BusyPortSet[]): string {
  const sets = busy
    .map((set) => set.ports.map(({ service, port }) => `${port} (${service})`).join(', '))
    .join('; ');
  return (
    `No free set of ports for the assistant stack. In use: ${sets}. ` +
    'Stop whatever holds one of these sets (`lsof -nP -iTCP:<port> -sTCP:LISTEN` shows it), then start again.'
  );
}
