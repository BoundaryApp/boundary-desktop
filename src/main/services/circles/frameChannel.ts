/**
 * One Protomux channel that carries whole frames over a peer connection. Frames sent before the
 * other side opens the channel wait here, up to a cap, and go out in order when it opens. Closing
 * the channel clears them, so a peer that never opens it holds nothing past the connection.
 */
import { buffer, type Encoding } from 'compact-encoding';
import Protomux, { type ProtomuxMessage } from 'protomux';
import type { SecretStream } from 'hyperswarm';

/** One length-prefixed buffer: a channel's whole message. */
const frameEncoding: Encoding<Buffer> = {
  preencode: (state, value) => buffer.preencode(state, value),
  encode: (state, value) => buffer.encode(state, value),
  decode: (state) => buffer.decode(state) ?? Buffer.alloc(0),
};

export interface FrameChannelOptions {
  protocol: string;
  /** Frames held while the channel opens; more are refused. */
  maxWaiting: number;
  onframe: (frame: Buffer) => void;
  onclose?: () => void;
}

export class FrameChannel {
  private message: ProtomuxMessage<Buffer> | null = null;
  private waiting: Buffer[] = [];
  private isOpen = false;
  private isClosed = false;

  /** Null when the stream already has this channel or is gone. */
  static attach(connection: SecretStream, options: FrameChannelOptions): FrameChannel | null {
    const link = new FrameChannel(options.maxWaiting);
    const channel = Protomux.from(connection).createChannel({
      protocol: options.protocol,
      onopen: () => link.onOpened(),
      onclose: () => {
        link.onClosed();
        options.onclose?.();
      },
    });
    if (!channel) return null;
    link.message = channel.addMessage({ encoding: frameEncoding, onmessage: options.onframe });
    channel.open();
    return link;
  }

  private constructor(private readonly maxWaiting: number) {}

  get closed(): boolean {
    return this.isClosed;
  }

  /** Whether `send` would take a frame now: the channel is open, or has room to hold one. */
  canSend(): boolean {
    return !this.isClosed && (this.isOpen || this.waiting.length < this.maxWaiting);
  }

  /** False when the frame was dropped: the channel closed, or it isn't open and is full. */
  send(frame: Buffer): boolean {
    if (!this.canSend()) return false;
    if (this.isOpen) this.message?.send(frame);
    else this.waiting.push(frame);
    return true;
  }

  private onOpened(): void {
    this.isOpen = true;
    for (const frame of this.waiting) this.message?.send(frame);
    this.waiting = [];
  }

  private onClosed(): void {
    this.isOpen = false;
    this.isClosed = true;
    this.waiting = [];
  }
}
