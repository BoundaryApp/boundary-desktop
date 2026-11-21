/**
 * What Circles needs from the app it runs in to share this Mac's resources with a Circle: the
 * local model, a service's keys and upstream, the workspaces used services write, the folder
 * rules and the guard on calls from the stack. The app supplies it once at startup with
 * `configureCircles`; Circles reads it when it needs it, never at module load.
 */
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { CodingGrantRefuseReason } from '../../../shared/types/codingFolders';
import type { SharedServicesDeps } from './sharedServices';
import type { UsedServicesDeps } from './usedServices';

/** Checks a call from the stack to a used service's listener. */
export interface AgentRequestGuard {
  check(
    headers: IncomingHttpHeaders,
    opts: { port: number; tokens: Readonly<Record<string, string>> }
  ): { agent: string } | { status: number; reason: string };
  /** The body up to `maxBytes`; null (and the request dropped) when it is larger. */
  readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null>;
}

export interface CirclesSharing {
  /** Model sharing: this Mac's local model, or null when none is connected. */
  localModel(): Promise<{ endpointUrl: string; apiKey?: string } | null>;
  /** Shared services (ADR 0048). */
  services: Pick<SharedServicesDeps, 'mintKeys' | 'revokeKeys' | 'upstreamFor'>;
  /** Used services (ADR 0048 §5). */
  workspaces: UsedServicesDeps['store'];
  pending: UsedServicesDeps['pending'];
  exclusive: UsedServicesDeps['exclusive'];
  hasHostCallbacks(): boolean;
  /** Throws when the stack's containers can't reach this machine. */
  requireHostCallbacks(): void;
  /** Shared folders (ADR 0049). */
  folders: {
    refuseReason(hostPath: string): CodingGrantRefuseReason | null;
    facts(hostPath: string): { isDirectory: boolean; isGit: boolean };
  };
  agentGuard: AgentRequestGuard;
}

let configured: CirclesSharing | null = null;

export function configureCircles(sharing: CirclesSharing): void {
  configured = sharing;
}

export function circlesSharing(): CirclesSharing {
  if (!configured) throw new Error('Circles sharing is not configured');
  return configured;
}
