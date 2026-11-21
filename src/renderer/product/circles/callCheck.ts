/**
 * The call transport check (Circle calls spec phase 1). Real WebRTC connections between this Mac
 * and another member's, set up with session descriptions sent as compressed call parts over peer
 * signals, each measured once connected. Media is generated (a tone and a moving canvas), so no
 * camera or microphone is used. Every Mac taking part runs the app with `BOUNDARY_CALLS_CHECK=1`
 * and answers offers on its own.
 */
import {
  CALL_CHECK_STUN,
  usesTunnel,
  type CallCheckMode,
  type CallCheckMedia,
  type CallCheckResult,
  type CallCheckSample,
  type CallTunnelStats,
} from '../../../shared/callCheck';
import { CallPartAssembler, isCallPart, packCallMessage, type CallPart } from '../../../shared/callSignalParts';
import { readConnectStats, readMediaStats, selectedPairId, statsList, tunnelCandidate, type StatsList } from './calls/callStats';

/** Load runs open this many connections to one person, each with video both ways: a six-way mesh. */
export const LOAD_STREAMS = 5;
const GATHER_MS = 5_000;
const ANSWER_MS = 20_000;
const CONNECT_MS = 20_000;
const SETTLE_MS = 4_000;
const LOAD_MS = 20_000;
/** Load and long runs take a sample this often, and log each one as `call.sample`. */
const SAMPLE_MS = 5_000;
/** How often to read what ICE has tried while a connection is still being set up. */
const ICE_WATCH_MS = 1_000;
/** A long call: one video connection held this long. */
export const LONG_MS = 180_000;

type CheckMessage =
  | {
      t: 'offer';
      run: string;
      stream: number;
      mode: CallCheckMode;
      kind: CheckKind;
      sdp: string;
      /** Tunnel modes: the id both Macs open their tunnel endpoint under. */
      tunnel?: number;
    }
  | { t: 'answer'; run: string; stream: number; sdp: string }
  | { t: 'bye'; run: string };

type CheckKind = CallCheckResult['kind'];

/** How the check reaches main; a test passes a fake. */
export interface CallCheckTransport {
  send(circleKey: string, to: string, part: CallPart): Promise<boolean>;
  onPart(handler: (signal: { circleKey: string; from: string; part: CallPart }) => void): () => void;
  /** This Mac's public IPv4 address as the DHT sees it, or null. */
  publicAddress(): Promise<string | null>;
  /** Log a result; main adds CPU use and the Circles connection to `to`. Returns what was logged. */
  report(circleKey: string, to: string, result: CallCheckResult): Promise<CallCheckResult | null>;
  /** Log one sample of a connection being measured. */
  sample(sample: CallCheckSample): Promise<boolean>;
  /** Open, read or close this Mac's tunnel endpoint for one connection; null when main refused. */
  tunnel(
    action: 'open' | 'stats' | 'close',
    circleKey: string,
    to: string,
    id: number
  ): Promise<{ port?: number; stats?: CallTunnelStats | null } | null>;
}

export const electronCallCheckTransport: CallCheckTransport = {
  send: (circleKey, to, part) => window.electronAPI.circles.callSignalSend({ key: circleKey, to, part }),
  onPart: (handler) => window.electronAPI.circles.onCallSignal(handler),
  publicAddress: async () => {
    const result = await window.electronAPI.circles.publicAddress();
    const host = result.success ? result.address?.host : null;
    return host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
  },
  report: (key, to, result) => window.electronAPI.circles.callCheckResult({ key, to, result }),
  sample: (sample) => window.electronAPI.circles.callCheckSample(sample),
  tunnel: async (action, key, to, tunnel) => {
    const result = await window.electronAPI.circles.callTunnel({ action, key, to, tunnel });
    return result.success ? { port: result.port, stats: result.stats } : null;
  },
};

/** Drop a description's candidates, so `tunnel` mode can only connect through the tunnel. */
export function stripCandidates(sdp: string): string {
  return sdp
    .split('\r\n')
    .filter((line) => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates')
    .join('\r\n');
}

/** The tunnel's counts as result fields. */
export function tunnelFields(stats: CallTunnelStats): Partial<CallCheckResult> {
  return {
    tunnelMtu: stats.mtu,
    tunnelPackets: stats.packetsOut + stats.packetsIn,
    tunnelSplit: stats.split,
    tunnelDropped: stats.dropped,
    tunnelBytes: stats.bytesOut + stats.bytesIn,
  };
}

function randomTunnelId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] & 0xffffff) || 1;
}

const IPV4_HOST_CANDIDATE = /^a=candidate:\S+ 1 udp \d+ \S+ (\d+) typ host/;

/**
 * Add a server-reflexive candidate on the DHT's public address for each UDP host candidate, on the
 * same port. It only works where the NAT keeps the port, which is what the `swarm` mode measures.
 */
export function addSwarmCandidates(sdp: string, publicHost: string): string {
  const lines = sdp.split('\r\n');
  const out: string[] = [];
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const match = IPV4_HOST_CANDIDATE.exec(lines[i]);
    if (!match) continue;
    const port = match[1];
    added += 1;
    out.push(`a=candidate:swarm${added} 1 udp 1686052607 ${publicHost} ${port} typ srflx raddr 0.0.0.0 rport ${port}`);
  }
  return out.join('\r\n');
}

/** Frames a second sent and received over a window, and why sending was held back. */
export function readLoadStats(
  before: RTCStatsReport | StatsList,
  after: RTCStatsReport | StatsList,
  seconds: number
): Partial<CallCheckResult> {
  const frames = (report: StatsList, type: string, field: string) =>
    report
      .filter((entry) => entry.type === type && entry.kind === 'video')
      .reduce((sum, entry) => sum + Number(entry[field] ?? 0), 0);
  const a = statsList(before);
  const b = statsList(after);
  const outbound = b.find((entry) => entry.type === 'outbound-rtp' && entry.kind === 'video');
  const reason = String(outbound?.qualityLimitationReason ?? 'none');
  return {
    sentFps: (frames(b, 'outbound-rtp', 'framesEncoded') - frames(a, 'outbound-rtp', 'framesEncoded')) / seconds,
    receivedFps: (frames(b, 'inbound-rtp', 'framesDecoded') - frames(a, 'inbound-rtp', 'framesDecoded')) / seconds,
    limitedBy: (['none', 'cpu', 'bandwidth'].includes(reason) ? reason : 'other') as CallCheckResult['limitedBy'],
  };
}

/**
 * What ICE had to work with and what it tried: candidates on each side by type, pairs by
 * outcome, and its connectivity checks. Zero checks answered means no packet came back on any path.
 */
export function readIceStats(report: RTCStatsReport | StatsList): Partial<CallCheckResult> {
  const stats = statsList(report);
  const count = (type: string, candidateType: string) =>
    stats.filter((entry) => entry.type === type && entry.candidateType === candidateType).length;
  const pairs = stats.filter((entry) => entry.type === 'candidate-pair');
  const sum = (field: string) => pairs.reduce((total, pair) => total + Number(pair[field] ?? 0), 0);
  return {
    localHost: count('local-candidate', 'host'),
    localSrflx: count('local-candidate', 'srflx'),
    localRelay: count('local-candidate', 'relay'),
    remoteHost: count('remote-candidate', 'host'),
    remoteSrflx: count('remote-candidate', 'srflx'),
    remotePrflx: count('remote-candidate', 'prflx'),
    pairs: pairs.length,
    pairsSucceeded: pairs.filter((pair) => pair.state === 'succeeded').length,
    pairsFailed: pairs.filter((pair) => pair.state === 'failed').length,
    checksSent: sum('requestsSent'),
    checksAnswered: sum('responsesReceived'),
    checksReceived: sum('requestsReceived'),
  };
}

/**
 * Read what ICE has tried every second while a connection is being set up. Chromium leaves
 * failed pairs and their candidates out of its stats once ICE gives up, so a failed row uses the
 * last reading that still had pairs.
 */
export function watchIce(
  pc: Pick<RTCPeerConnection, 'getStats'>,
  everyMs = ICE_WATCH_MS
): { last: () => Partial<CallCheckResult>; stop: () => void } {
  let last: Partial<CallCheckResult> = {};
  let stopped = false;
  const read = () => {
    void pc
      .getStats()
      .then((report) => {
        if (stopped) return;
        const ice = readIceStats(report);
        if ((ice.pairs ?? 0) > 0 || !last.pairs) last = ice;
      })
      .catch((): undefined => undefined);
  };
  const timer = setInterval(read, everyMs);
  read();
  return {
    last: () => last,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomRun(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function iceServers(mode: CallCheckMode): RTCIceServer[] {
  return mode === 'stun' || mode === 'stun+tunnel' ? [{ urls: CALL_CHECK_STUN }] : [];
}

/** A tone, and for load runs a moving 640×360 picture at 30 frames a second. */
class GeneratedMedia {
  private audio: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly tracks: MediaStreamTrack[] = [];

  constructor(video: boolean) {
    this.audio = new AudioContext();
    const tone = this.audio.createOscillator();
    const gain = this.audio.createGain();
    gain.gain.value = 0.02;
    const out = this.audio.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    this.tracks.push(...out.stream.getAudioTracks());
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    let frame = 0;
    this.timer = setInterval(() => {
      frame += 1;
      context.fillStyle = `hsl(${frame % 360} 50% 40%)`;
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#fff';
      context.fillRect((frame * 7) % 640, 140, 80, 80);
    }, 1000 / 30);
    this.tracks.push(...canvas.captureStream(30).getVideoTracks());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const track of this.tracks) track.stop();
    void this.audio?.close();
    this.audio = null;
  }
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, GATHER_MS);
  });
}

function connected(pc: RTCPeerConnection): Promise<boolean> {
  if (pc.connectionState === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_MS);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' || pc.connectionState === 'failed') {
        clearTimeout(timer);
        resolve(pc.connectionState === 'connected');
      }
    });
  });
}

/** Wait for the connection; when it fails, what ICE had tried by its last reading. Null once connected. */
async function iceFailure(pc: RTCPeerConnection): Promise<Partial<CallCheckResult> | null> {
  const ice = watchIce(pc);
  const ok = await connected(pc).finally(ice.stop);
  return ok ? null : ice.last();
}

/** Runs checks as caller and answers other members' offers. One per renderer. */
export class CallCheck {
  private assembler = new CallPartAssembler();
  private answers = new Map<string, (sdp: string) => void>();
  private open = new Map<
    string,
    {
      pc: RTCPeerConnection;
      media: GeneratedMedia;
      sink: HTMLAudioElement;
      peer: { circleKey: string; to: string };
      tunnel?: { circleKey: string; to: string; id: number; port: number };
    }
  >();
  private listeners = new Set<(result: CallCheckResult) => void>();
  readonly results: CallCheckResult[] = [];
  private stopListening: () => void;

  constructor(private transport: CallCheckTransport) {
    this.stopListening = transport.onPart(({ circleKey, from, part }) => {
      if (!isCallPart(part)) return;
      void this.assembler.add(from, part).then((message) => {
        if (message) void this.receive(circleKey, from, message as CheckMessage);
      });
    });
  }

  onResult(listener: (result: CallCheckResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopListening();
    for (const key of [...this.open.keys()]) this.close(key);
  }

  /** One connection in each mode, one after another. */
  async checkConnection(circleKey: string, to: string, modes: CallCheckMode[]): Promise<void> {
    for (const mode of modes) await this.call(circleKey, to, mode, 'connect', 0, randomRun());
  }

  /** One connection with video both ways, held for `LONG_MS` and sampled every few seconds. */
  async checkLong(circleKey: string, to: string, mode: CallCheckMode): Promise<void> {
    await this.call(circleKey, to, mode, 'long', 0, randomRun());
  }

  /** Several connections at once, each with video both ways, in one mode. */
  async checkLoad(circleKey: string, to: string, mode: CallCheckMode, streams = LOAD_STREAMS): Promise<void> {
    const run = randomRun();
    await Promise.all(Array.from({ length: streams }, (_, stream) => this.call(circleKey, to, mode, 'load', stream, run)));
  }

  /**
   * Record a result, with what ICE tried and the tunnel's counts when the connection is still
   * open, so a failure shows how far it got.
   */
  private async record(result: CallCheckResult, key: string, circleKey: string, to: string): Promise<void> {
    const entry = this.open.get(key);
    if (entry && result.pairs === undefined) {
      const report = await entry.pc.getStats().catch((): null => null);
      if (report) result = { ...result, ...readIceStats(report) };
    }
    if (entry?.tunnel) {
      const { id } = entry.tunnel;
      const reply = await this.transport.tunnel('stats', circleKey, to, id).catch((): null => null);
      if (reply?.stats) result = { ...result, ...tunnelFields(reply.stats) };
    }
    const logged = (await this.transport.report(circleKey, to, result).catch((): null => null)) ?? result;
    this.results.push(logged);
    for (const listener of this.listeners) listener(logged);
  }

  private async send(circleKey: string, to: string, message: CheckMessage): Promise<Partial<CallCheckResult>> {
    const packed = await packCallMessage(message);
    for (const part of packed.parts) await this.transport.send(circleKey, to, part);
    return { descriptionBytes: packed.rawBytes, descriptionSent: packed.sentChars, descriptionParts: packed.parts.length };
  }

  /** This Mac's description once its candidates are gathered, and how long gathering took. */
  private async localDescription(pc: RTCPeerConnection, mode: CallCheckMode): Promise<{ sdp: string; gatherMs: number }> {
    const started = performance.now();
    await gathered(pc);
    const gatherMs = performance.now() - started;
    const sdp = pc.localDescription?.sdp ?? '';
    if (mode !== 'swarm') return { sdp, gatherMs };
    const host = await this.transport.publicAddress();
    return { sdp: host ? addSwarmCandidates(sdp, host) : sdp, gatherMs };
  }

  private start(key: string, mode: CallCheckMode, kind: CheckKind, peer: { circleKey: string; to: string }): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(mode) });
    const media = new GeneratedMedia(kind !== 'connect');
    const stream = new MediaStream(media.tracks);
    for (const track of media.tracks) pc.addTrack(track, stream);
    // Chromium only reports the audio jitter buffer for received audio that something plays.
    const sink = new Audio();
    sink.muted = true;
    pc.addEventListener('track', (event) => {
      if (event.track.kind !== 'audio') return;
      sink.srcObject = new MediaStream([event.track]);
      void sink.play().catch((): undefined => undefined);
    });
    this.open.set(key, { pc, media, sink, peer });
    return pc;
  }

  private close(key: string): void {
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    if (entry.tunnel) {
      const { circleKey, to, id } = entry.tunnel;
      void this.transport.tunnel('close', circleKey, to, id).catch((): null => null);
    }
    entry.pc.close();
    entry.media.stop();
    entry.sink.srcObject = null;
  }

  /**
   * Open this Mac's tunnel endpoint for a connection and remember it, so closing the connection
   * closes it. Resolves to its port, or null when main refused.
   */
  private async openTunnel(key: string, circleKey: string, to: string, id: number): Promise<number | null> {
    const reply = await this.transport.tunnel('open', circleKey, to, id).catch((): null => null);
    const entry = this.open.get(key);
    if (!reply?.port || !entry) return null;
    entry.tunnel = { circleKey, to, id, port: reply.port };
    return reply.port;
  }

  /** Give the peer connection this Mac's tunnel endpoint, once its remote description is set. */
  private async addTunnel(pc: RTCPeerConnection, port: number): Promise<void> {
    await pc.addIceCandidate(tunnelCandidate(port, pc.getTransceivers()[0]?.mid ?? null));
  }

  /**
   * Measure an open connection and record it. Load and long runs take a sample every
   * `SAMPLE_MS` and log each; the result carries the last window's frame rates, so warm-up
   * doesn't drag them down, and the whole window's loss and video trouble.
   */
  private async measure(key: string, stream: number, pc: RTCPeerConnection, base: CallCheckResult): Promise<void> {
    const entry = this.open.get(key);
    if (!entry) return;
    const { circleKey, to } = entry.peer;
    const tunnelPort = entry.tunnel?.port;
    const kind = base.kind;
    const window = kind === 'connect' ? SETTLE_MS : SAMPLE_MS;
    const steps = kind === 'connect' ? 1 : (kind === 'load' ? LOAD_MS : LONG_MS) / SAMPLE_MS;
    const first = await pc.getStats();
    let previous = first;
    let pairId = selectedPairId(first);
    let switches = 0;
    let last: Partial<CallCheckResult> = {};
    let taken = 0;
    for (let step = 1; step <= steps; step++) {
      await sleep(window);
      // The other Mac said bye first: record what was measured so far.
      if (!this.open.has(key)) break;
      const current = await pc.getStats().catch((): null => null);
      if (!current) break;
      taken = step;
      const nowPair = selectedPairId(current);
      const switched = pairId !== null && nowPair !== null && nowPair !== pairId;
      if (switched) switches++;
      pairId = nowPair ?? pairId;
      const connect = readConnectStats(current, tunnelPort);
      last = kind === 'connect' ? {} : readLoadStats(previous, current, window / 1000);
      const sample: CallCheckSample = {
        run: base.run,
        stream,
        kind,
        mode: base.mode,
        role: base.role,
        t: (step * window) / 1000,
        switched,
        ...(connect.path ? { path: connect.path } : {}),
        ...(connect.rttMs !== undefined ? { rttMs: connect.rttMs } : {}),
        ...last,
        ...readMediaStats(previous, current, window / 1000),
      };
      void this.transport.sample(sample).catch((): boolean => false);
      previous = current;
    }
    await this.record(
      {
        ...base,
        ...readConnectStats(previous, tunnelPort),
        ...readIceStats(previous),
        ...readMediaStats(first, previous, (taken * window) / 1000),
        ...last,
        pathSwitches: switches,
        samples: taken,
        ...(kind === 'load' ? { streams: [...this.open.keys()].filter((open) => open.startsWith(`${base.run}/`)).length } : {}),
      },
      key,
      circleKey,
      to
    );
  }

  private async call(
    circleKey: string,
    to: string,
    mode: CallCheckMode,
    kind: CheckKind,
    stream: number,
    run: string
  ): Promise<void> {
    const key = `${run}/${stream}`;
    const base: CallCheckResult = { run, kind, mode, role: 'caller', connected: false };
    const record = (result: CallCheckResult) => this.record(result, key, circleKey, to);
    try {
      const pc = this.start(key, mode, kind, { circleKey, to });
      const tunnel = usesTunnel(mode) ? randomTunnelId() : undefined;
      const tunnelPort = tunnel ? await this.openTunnel(key, circleKey, to, tunnel) : null;
      if (tunnel && !tunnelPort) {
        await record({ ...base, failedAt: 'tunnel' });
        return;
      }
      await pc.setLocalDescription(await pc.createOffer());
      const { sdp, gatherMs } = await this.localDescription(pc, mode);
      base.gatherMs = gatherMs;
      const answered = new Promise<string | null>((resolve) => {
        this.answers.set(key, resolve);
        setTimeout(() => resolve(null), ANSWER_MS);
      });
      const sizes = await this.send(circleKey, to, { t: 'offer', run, stream, mode, kind, sdp, ...(tunnel ? { tunnel } : {}) });
      Object.assign(base, sizes);
      const started = performance.now();
      const answer = await answered;
      this.answers.delete(key);
      if (!answer) {
        await record({ ...base, failedAt: 'answer' });
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: mode === 'tunnel' ? stripCandidates(answer) : answer });
      if (tunnelPort) await this.addTunnel(pc, tunnelPort);
      const failed = await iceFailure(pc);
      if (failed) {
        await record({ ...base, ...failed, failedAt: 'ice' });
        return;
      }
      base.connected = true;
      base.msToConnect = performance.now() - started;
      await this.measure(key, stream, pc, base);
    } catch {
      await record({ ...base, failedAt: 'error' });
    } finally {
      if (stream === 0) await this.send(circleKey, to, { t: 'bye', run }).catch((): undefined => undefined);
      this.close(key);
    }
  }

  private async receive(circleKey: string, from: string, message: CheckMessage): Promise<void> {
    if (message.t === 'answer') {
      this.answers.get(`${message.run}/${message.stream}`)?.(message.sdp);
      return;
    }
    if (message.t === 'bye') {
      for (const key of [...this.open.keys()]) if (key.startsWith(`${message.run}/`)) this.close(key);
      return;
    }
    if (message.t !== 'offer') return;
    const { run, stream, mode, kind, tunnel } = message;
    const key = `${run}/${stream}`;
    const base: CallCheckResult = { run, kind, mode, role: 'answerer', connected: false };
    const record = (result: CallCheckResult) => this.record(result, key, circleKey, from);
    try {
      const pc = this.start(key, mode, kind, { circleKey, to: from });
      const started = performance.now();
      const tunnelPort = usesTunnel(mode) && tunnel ? await this.openTunnel(key, circleKey, from, tunnel) : null;
      if (usesTunnel(mode) && !tunnelPort) {
        await record({ ...base, failedAt: 'tunnel' });
        this.close(key);
        return;
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: mode === 'tunnel' ? stripCandidates(message.sdp) : message.sdp });
      if (tunnelPort) await this.addTunnel(pc, tunnelPort);
      await pc.setLocalDescription(await pc.createAnswer());
      const { sdp, gatherMs } = await this.localDescription(pc, mode);
      base.gatherMs = gatherMs;
      Object.assign(base, await this.send(circleKey, from, { t: 'answer', run, stream, sdp }));
      const failed = await iceFailure(pc);
      if (failed) {
        await record({ ...base, ...failed, failedAt: 'ice' });
        this.close(key);
        return;
      }
      base.connected = true;
      base.msToConnect = performance.now() - started;
      await this.measure(key, stream, pc, base);
      // The caller says bye when it has measured too; close anyway if that never arrives.
      setTimeout(() => this.close(key), ANSWER_MS);
    } catch {
      await record({ ...base, failedAt: 'error' });
      this.close(key);
    }
  }
}
