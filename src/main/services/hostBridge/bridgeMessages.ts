import type { BrowserRelayConfig } from './browserRelay';
import type { ToolCallResult } from './mcpProtocol';

/** Which conditional tools `tools/list` includes (`listedHostTools`). */
export interface HostToolListing {
  offerCalendarSetup: boolean;
}

/**
 * Messages between main and the bridge utilityProcess. Tokens travel only in `start`, over the
 * parent port, never in argv or the environment.
 */

export type MainToBridge =
  | {
      type: 'start';
      mcpToken: string;
      browserToken: string;
      mcpPort?: number;
      browserPort?: number;
      browser: BrowserRelayConfig;
      listing: HostToolListing;
      /** An MCP session quiet for this long no longer counts as a connected Hermes client. */
      sessionIdleMs: number;
    }
  | { type: 'tool-result'; id: number; result: ToolCallResult }
  | { type: 'browser-config'; browser: BrowserRelayConfig }
  | { type: 'tool-listing'; listing: HostToolListing }
  | { type: 'browser-open'; id: number }
  | { type: 'browser-status'; id: number }
  /** `reason` answers tool calls still in flight. */
  | { type: 'stop'; reason?: string };

export type BridgeToMain =
  | { type: 'ready'; mcpPort: number; browserPort: number }
  | { type: 'start-failed'; error: string }
  | { type: 'tool-call'; id: number; name: string; args: Record<string, unknown> }
  | { type: 'browser-open-result'; id: number; error?: string }
  | { type: 'browser-status-result'; id: number; running: boolean; clients: number }
  /** How many Hermes clients (live MCP sessions that have listed the tools) are connected now. */
  | { type: 'hermes-clients'; count: number }
  | { type: 'stopped' }
  | { type: 'log'; message: string; data?: Record<string, unknown> };
