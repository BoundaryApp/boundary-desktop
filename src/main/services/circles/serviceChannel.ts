/**
 * The `service` channel between two members' devices (ADR 0048 §1): a member's agent calls a
 * service another member shares, such as their Twenty. A protocol of its own beside `inference`,
 * so peers on builds without it turn the channel down and nothing else changes for them.
 */
import type { SecretStream } from 'hyperswarm';
import { GatewayLink, isId, isString, onLinkOpen, type LinkDiag, type LinkSpec } from './gatewayLink';
import type { ServiceGateway, ServiceRequest } from './serviceGateway';

export type ServiceLink = GatewayLink<ServiceRequest>;

const SERVICE: LinkSpec<ServiceRequest> = {
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

export function onServiceOpen(connection: SecretStream, onOpen: () => void): void {
  onLinkOpen(connection, SERVICE.protocol, onOpen);
}

/** Null when the stream already has this channel or is gone. */
export function openServiceLink(
  connection: SecretStream,
  device: string,
  gateway: ServiceGateway,
  onClose?: () => void,
  diag?: LinkDiag
): ServiceLink | null {
  return GatewayLink.attach(SERVICE, connection, device, gateway, onClose, diag);
}
