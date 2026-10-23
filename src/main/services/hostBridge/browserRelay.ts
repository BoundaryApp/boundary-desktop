import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpMux, type CdpClient } from './cdpMux';
import type { SitePolicy } from './cdpPolicy';
import { ChromePipe, type ChromeLaunchConfig } from './chromePipe';

/**
 * The browser half of the bridge (ADR 0027 §4–6): Boundary's Chrome on a debugging pipe, shared
 * between Hermes's CDP clients through the multiplexer. Runs in the bridge utilityProcess; the
 * listener's token, Origin and Host checks run before anything here.
 *
 * Chrome starts on the first connection (or when the user opens it to sign in) and stays open
 * until the bridge stops, so logins and open tabs carry across agent sessions.
 */

export interface BrowserRelayConfig {
  /** The user turned "Hermes uses Boundary's browser" on. */
  enabled: boolean;
  /** `null` when Google Chrome isn't installed. */
  chrome: ChromeLaunchConfig | null;
  policy: SitePolicy;
}

const START_TIMEOUT_MS = 15_000;

export class BrowserRelay {
  private pipe: ChromePipe | null = null;
  private mux: CdpMux | null = null;
  private starting: Promise<CdpMux> | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  constructor(
    private config: BrowserRelayConfig,
    private readonly log: (message: string, data?: Record<string, unknown>) => void
  ) {}

  configure(config: BrowserRelayConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;
    if (wasEnabled && !config.enabled && this.mux) {
      // Turned off: disconnect Hermes now. Chrome stays open with the user's tabs.
      this.mux.chromeClosed();
      this.mux = this.pipe ? this.newMux(this.pipe) : null;
      void this.mux?.start();
    }
  }

  /** Why Hermes can't use the browser right now, or `null`. */
  unavailableReason(): string | null {
    if (!this.config.enabled) return "Boundary's browser is turned off. Turn it on in Boundary's Settings.";
    if (!this.config.chrome) return "Boundary's browser needs Google Chrome, and it isn't installed.";
    return null;
  }

  status(): { running: boolean; clients: number } {
    return { running: Boolean(this.pipe?.running), clients: this.mux?.clientCount ?? 0 };
  }

  /** Accept an authenticated WebSocket upgrade and attach it to Chrome. */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const mux = await this.ensureChrome();
    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const client: CdpClient = {
        send: (message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
        close: () => ws.close(),
      };
      mux.addClient(client);
      ws.on('message', (data) => mux.handleClientMessage(client, data.toString()));
      ws.on('close', () => mux.removeClient(client));
      ws.on('error', () => ws.close());
    });
  }

  /** Start Chrome if needed and show a window, so the user can sign in to sites. */
  async open(): Promise<void> {
    if (!this.config.chrome) throw new Error("Boundary's browser needs Google Chrome, and it isn't installed.");
    const alreadyRunning = Boolean(this.pipe?.running);
    await this.ensureChrome(true);
    if (alreadyRunning) this.pipe?.send({ id: 2_100_000_001, method: 'Target.createTarget', params: { url: 'about:blank', newWindow: true } });
  }

  async close(): Promise<void> {
    const pipe = this.pipe;
    this.mux?.chromeClosed();
    this.pipe = null;
    this.mux = null;
    this.starting = null;
    await pipe?.close();
    this.wss.close();
  }

  private newMux(pipe: ChromePipe): CdpMux {
    return new CdpMux({ sendToChrome: (message) => pipe.send(message), policy: () => this.config.policy, log: this.log });
  }

  private ensureChrome(evenIfDisabled = false): Promise<CdpMux> {
    if (this.mux && this.pipe?.running) return Promise.resolve(this.mux);
    if (this.starting) return this.starting;
    const reason = evenIfDisabled ? null : this.unavailableReason();
    const chrome = this.config.chrome;
    if (reason || !chrome) return Promise.reject(new Error(reason ?? 'Google Chrome is not installed.'));

    this.starting = (async () => {
      let mux: CdpMux | null = null;
      const pipe = ChromePipe.launch(
        chrome,
        (message) => mux?.handleChromeMessage(message),
        (code) => {
          this.log('chrome exited', { code });
          mux?.chromeClosed();
          if (this.pipe === pipe) {
            this.pipe = null;
            this.mux = null;
          }
        }
      );
      mux = this.newMux(pipe);
      const started = await Promise.race([
        mux.start().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), START_TIMEOUT_MS)),
      ]);
      if (!started || !pipe.running) {
        await pipe.close();
        throw new Error(
          "Boundary's browser didn't start. If a Chrome window from an earlier Boundary session is still open, quit it and try again."
        );
      }
      this.pipe = pipe;
      this.mux = mux;
      this.log('chrome started', {});
      return mux;
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
}
