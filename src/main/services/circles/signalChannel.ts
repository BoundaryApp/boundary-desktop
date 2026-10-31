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
import { buffer, type Encoding } from 'compact-encoding';
import Protomux, { type ProtomuxChannel, type ProtomuxMessage } from 'protomux';
import type { SecretStream } from 'hyperswarm';
import { SIGNAL_RECEIVE_RATE, SIGNAL_SEND_RATE, SignalRate } from './circleSignals';

const SIGNAL_PROTOCOL = 'boundary/signal/1';
/** Frames held while the channel opens. A peer that never opens it closes it, which clears them. */
const MAX_WAITING_FRAMES = 16;

/** One length-prefixed buffer: a channel's whole message. */
export const frameEncoding: Encoding<Buffer> = {
  preencode: (state, value) => buffer.preencode(state, value),
  encode: (state, value) => buffer.encode(state, value),
  decode: (state) => buffer.decode(state) ?? Buffer.alloc(0),
};

/** Call `onOpen` when the other side opens the channel first, as `onInferenceOpen` does. */
export function onSignalOpen(connection: SecretStream, onOpen: () => void): void {
  Protomux.from(connection).pair({ protocol: SIGNAL_PROTOCOL }, onOpen);
}

export class SignalLink {
  private readonly message: ProtomuxMessage<Buffer>;
  private readonly sendRate = new SignalRate(SIGNAL_SEND_RATE, Date.now());
  private readonly receiveRate = new SignalRate(SIGNAL_RECEIVE_RATE, Date.now());
  private waiting: Buffer[] = [];
  private isOpen = false;
  private isClosed = false;

  /** Null when the stream already has this channel or is gone. */
  static attach(
    connection: SecretStream,
    onFrame: (raw: Buffer) => void,
    onRateLimited: () => void,
    onClose: () => void
  ): SignalLink | null {
    const channel = Protomux.from(connection).createChannel({
      protocol: SIGNAL_PROTOCOL,
      onopen: () => link.onOpened(),
      onclose: () => {
        link.onClosed();
        onClose();
      },
    });
    if (!channel) return null;
    const link: SignalLink = new SignalLink(channel, onFrame, onRateLimited);
    channel.open();
    return link;
  }

  private constructor(
    channel: ProtomuxChannel,
    onFrame: (raw: Buffer) => void,
    onRateLimited: () => void
  ) {
    this.message = channel.addMessage({
      encoding: frameEncoding,
      onmessage: (raw) => {
        if (this.receiveRate.take(Date.now())) onFrame(raw);
        else onRateLimited();
      },
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** False when this wasn't sent: the channel closed or is backed up, or the send limit is spent. */
  send(frame: Buffer): boolean {
    if (this.isClosed || (!this.isOpen && this.waiting.length >= MAX_WAITING_FRAMES)) return false;
    if (!this.sendRate.take(Date.now())) return false;
    if (this.isOpen) this.message.send(frame);
    else this.waiting.push(frame);
    return true;
  }

  private onOpened(): void {
    this.isOpen = true;
    for (const frame of this.waiting) this.message.send(frame);
    this.waiting = [];
  }

  private onClosed(): void {
    this.isOpen = false;
    this.isClosed = true;
    this.waiting = [];
  }
}
