/**
 * Tells a device it was removed from a Circle. An admin stops replicating with a removed device,
 * so the removal entry itself never reaches it (ADR 0032 §6); this one message does.
 *
 * A frame is the Circle's key. The connection is authenticated, so the receiver knows which device
 * sent it and acts only when that device is an admin in its own view of the Circle. Every message
 * goes over the encrypted stream. A peer on a build without this channel never opens it, and
 * frames waiting for it go when the connection closes.
 */
import type { SecretStream } from 'hyperswarm';
import { FrameChannel } from './frameChannel';

const REMOVAL_PROTOCOL = 'boundary/circle-removal/1';
/** Notices held while the channel opens: one small frame per Circle the device was removed from. */
const MAX_WAITING_NOTICES = 16;

export class RemovalLink {
  /** Null when the stream already has this channel or is gone. */
  static attach(connection: SecretStream, onFrame: (circleKey: Buffer) => void): RemovalLink | null {
    const channel = FrameChannel.attach(connection, {
      protocol: REMOVAL_PROTOCOL,
      maxWaiting: MAX_WAITING_NOTICES,
      onframe: onFrame,
    });
    return channel ? new RemovalLink(channel) : null;
  }

  private constructor(private readonly channel: FrameChannel) {}

  /** False when the notice was dropped: the channel closed, or it isn't open and is full. */
  send(circleKey: Buffer): boolean {
    return this.channel.send(circleKey);
  }
}
