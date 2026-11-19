/**
 * The `inference` channel between two members' devices (ADR 0034 §2): a member asks another's
 * gateway for one of their shared models.
 */
import type { SecretStream } from 'hyperswarm';
import { GatewayLink, isId, isString, onLinkOpen, type LinkDiag, type LinkResponse, type LinkSpec } from './gatewayLink';
import type { GatewayRequest, InferenceGateway } from './inferenceGateway';

export type SharedModelResponse = LinkResponse;
export type InferenceLink = GatewayLink<GatewayRequest>;

const INFERENCE: LinkSpec<GatewayRequest> = {
  protocol: 'boundary/inference/1',
  parse(value) {
    const request = value as GatewayRequest;
    if (typeof request !== 'object' || request === null) return null;
    if (!isId(request.id) || !isString(request.circle) || !isString(request.method) || !isString(request.path)) return null;
    if (request.body !== undefined && !isString(request.body)) return null;
    return { id: request.id, circle: request.circle, method: request.method, path: request.path, body: request.body };
  },
  events: { link: 'link', call: 'shared' },
  describe: (request) => ({
    circle: request.circle.slice(0, 8),
    method: request.method,
    path: request.path,
    bodyBytes: Buffer.byteLength(request.body ?? ''),
  }),
};

export function onInferenceOpen(connection: SecretStream, onOpen: () => void): void {
  onLinkOpen(connection, INFERENCE.protocol, onOpen);
}

/** Null when the stream already has this channel or is gone. */
export function openInferenceLink(
  connection: SecretStream,
  device: string,
  gateway: InferenceGateway,
  onClose?: () => void,
  diag?: LinkDiag
): InferenceLink | null {
  return GatewayLink.attach(INFERENCE, connection, device, gateway, onClose, diag);
}
