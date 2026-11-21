/**
 * The `signal` channel between two devices: one Protomux channel per connection, sharing the
 * muxer Corestore replicates over. A connection is per device, not per Circle, so each frame names
 * its Circle and the receiver checks membership (`CircleNetwork.onSignalFrame`).
 *
 * Like the inference channel, every message goes over the encrypted stream, so it arrives once
 * and in order. Nothing is kept for a peer that isn't connected. Frames sent in the moment
 * between connecting and the channel opening wait here, so a peer that has just shown as online
 * can be sent to.
 */
import Protomux from 'protomux';
import type { SecretStream } from 'hyperswarm';
import { SIGNAL_RECEIVE_RATE, SIGNAL_SEND_RATE, SignalRate } from './circleSignals';
import { FrameChannel } from './frameChannel';

const SIGNAL_PROTOCOL = 'boundary/signal/1';
/** Frames held while the channel opens. A peer that never opens it closes it, which clears them. */
const MAX_WAITING_FRAMES = 16;

/** Call `onOpen` when the other side opens the channel first, as the gateway links do (`onLinkOpen`). */
export function onSignalOpen(connection: SecretStream, onOpen: () => void): void {
  Protomux.from(connection).pair({ protocol: SIGNAL_PROTOCOL }, onOpen);
}

export class SignalLink {
  private readonly sendRate = new SignalRate(SIGNAL_SEND_RATE, Date.now());

  /** Null when the stream already has this channel or is gone. */
  static attach(
    connection: SecretStream,
    onFrame: (raw: Buffer) => void,
    onRateLimited: () => void,
    onClose: () => void
  ): SignalLink | null {
    const receiveRate = new SignalRate(SIGNAL_RECEIVE_RATE, Date.now());
    const channel = FrameChannel.attach(connection, {
      protocol: SIGNAL_PROTOCOL,
      maxWaiting: MAX_WAITING_FRAMES,
      onframe: (raw) => {
        if (receiveRate.take(Date.now())) onFrame(raw);
        else onRateLimited();
      },
      onclose: onClose,
    });
    return channel ? new SignalLink(channel) : null;
  }

  private constructor(private readonly channel: FrameChannel) {}

  get closed(): boolean {
    return this.channel.closed;
  }

  /** False when this wasn't sent: the channel closed or is backed up, or the send limit is spent. */
  send(frame: Buffer): boolean {
    // Check the channel first so a frame it would refuse doesn't spend the send limit.
    if (!this.channel.canSend()) return false;
    if (!this.sendRate.take(Date.now())) return false;
    return this.channel.send(frame);
  }
}
