// @ts-nocheck
/**
 * Vendored MIT sources from NousResearch/hermes-agent apps/shared.
 * Prefer importing through hermesGatewayClient.ts — this folder keeps the
 * upstream client for protocol fidelity and licensing attribution.
 */
export { JsonRpcGatewayClient } from './json-rpc-gateway';
export type {
  ConnectionState,
  GatewayClientOptions,
  GatewayEvent,
  GatewayEventName,
  WebSocketLike,
} from './json-rpc-gateway';
export { buildHermesWebSocketUrl } from './websocket-url';
