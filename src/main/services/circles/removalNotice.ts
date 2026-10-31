/**
 * Tells a device it was removed from a Circle. An admin stops replicating with a removed device,
 * so the removal entry itself never reaches it (ADR 0032 §6); this one message does.
 *
 * A frame is the Circle's key. The connection is authenticated, so the receiver knows which device
 * sent it and acts only when that device is an admin in its own view of the Circle. Every message
 * goes over the encrypted stream. A peer on a build without this channel never opens it, and
 * frames waiting for it go when the connection closes.
 */
import Protomux, { type ProtomuxMessage } from 'protomux';
import type { SecretStream } from 'hyperswarm';
import { frameEncoding } from './signalChannel';

const REMOVAL_PROTOCOL = 'boundary/circle-removal/1';

export class RemovalLink {
  private message: ProtomuxMessage<Buffer> | null = null;
  private waiting: Buffer[] = [];
  private isOpen = false;

  /** Null when the stream already has this channel or is gone. */
  static attach(connection: SecretStream, onFrame: (circleKey: Buffer) => void): RemovalLink | null {
    const link = new RemovalLink();
    const channel = Protomux.from(connection).createChannel({
      protocol: REMOVAL_PROTOCOL,
      onopen: () => {
        link.isOpen = true;
        for (const frame of link.waiting) link.message?.send(frame);
        link.waiting = [];
      },
      onclose: () => {
        link.isOpen = false;
        link.waiting = [];
      },
    });
    if (!channel) return null;
    link.message = channel.addMessage({ encoding: frameEncoding, onmessage: onFrame });
    channel.open();
    return link;
  }

  send(circleKey: Buffer): void {
    if (this.isOpen) this.message?.send(circleKey);
    else this.waiting.push(circleKey);
  }
}
