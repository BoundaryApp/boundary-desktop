/**
 * The `service` channel between two members' devices (ADR 0048 §1): a member's agent calls a
 * service another member shares, such as their Twenty. A protocol of its own beside `inference`,
 * so peers on builds without it turn the channel down and nothing else changes for them.
 */
import { isId, isString, type GatewayLink, type LinkSpec } from './gatewayLink';
import type { ServiceRequest } from './serviceGateway';

export type ServiceLink = GatewayLink<ServiceRequest>;

export const SERVICE_LINK: LinkSpec<ServiceRequest> = {
  protocol: 'boundary/service/1',
  parse(value) {
    const request = value as ServiceRequest;
    if (typeof request !== 'object' || request === null) return null;
    if (!isId(request.id) || !isString(request.circle) || !isString(request.service)) return null;
    if (request.level !== 'read' && request.level !== 'write') return null;
    if (!isString(request.method) || !isString(request.path)) return null;
    if (request.accept !== undefined && !isString(request.accept)) return null;
    if (request.body !== undefined && !isString(request.body)) return null;
    return {
      id: request.id,
      circle: request.circle,
      service: request.service,
      level: request.level,
      method: request.method,
      path: request.path,
      ...(request.accept !== undefined ? { accept: request.accept } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    };
  },
  events: { link: 'service-link', call: 'service-call' },
  describe: (request) => ({
    circle: request.circle.slice(0, 8),
    service: request.service,
    level: request.level,
    method: request.method,
    path: request.path,
    bodyBytes: Buffer.byteLength(request.body ?? ''),
  }),
};
