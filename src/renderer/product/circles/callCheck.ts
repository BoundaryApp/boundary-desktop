/**
 * The call transport check (Circle calls spec phase 1). Real WebRTC connections between this Mac
 * and another member's, set up with session descriptions sent as compressed call parts over peer
 * signals, each measured once connected. Media is generated (a tone and a moving canvas), so no
 * camera or microphone is used. Every Mac taking part runs the app with `BOUNDARY_CALLS_CHECK=1`
 * and answers offers on its own.
 */
import {
  CALL_CHECK_STUN,
  type CallCheckMode,
  type CallCheckResult,
} from '../../../shared/callCheck';
import { CallPartAssembler, isCallPart, packCallMessage, type CallPart } from '../../../shared/callSignalParts';

/** Load runs open this many connections to one person, each with video both ways: a six-way mesh. */
export const LOAD_STREAMS = 5;
const GATHER_MS = 5_000;
const ANSWER_MS = 20_000;
const CONNECT_MS = 20_000;
const SETTLE_MS = 4_000;
const LOAD_MS = 20_000;
const LOAD_SAMPLE_MS = 5_000;

type CheckMessage =
  | { t: 'offer'; run: string; stream: number; mode: CallCheckMode; kind: 'connect' | 'load'; sdp: string }
  | { t: 'answer'; run: string; stream: number; sdp: string }
  | { t: 'bye'; run: string };

/** How the check reaches main; a test passes a fake. */
export interface CallCheckTransport {
  send(circleKey: string, to: string, part: CallPart): Promise<boolean>;
  onPart(handler: (signal: { circleKey: string; from: string; part: CallPart }) => void): () => void;
  /** This Mac's public IPv4 address as the DHT sees it, or null. */
  publicAddress(): Promise<string | null>;
  report(result: CallCheckResult): Promise<CallCheckResult | null>;
}

export const electronCallCheckTransport: CallCheckTransport = {
  send: (circleKey, to, part) => window.electronAPI.circles.callSignalSend({ key: circleKey, to, part }),
  onPart: (handler) => window.electronAPI.circles.onCallSignal(handler),
  publicAddress: async () => {
    const result = await window.electronAPI.circles.publicAddress();
    const host = result.success ? result.address?.host : null;
    return host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : null;
  },
  report: (result) => window.electronAPI.circles.callCheckResult(result),
};

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

type StatsList = Array<Record<string, unknown> & { id: string; type: string }>;

function statsList(report: RTCStatsReport | StatsList): StatsList {
  return Array.isArray(report) ? report : ([...report.values()] as StatsList);
}

type CandidateType = NonNullable<CallCheckResult['localType']>;

/** The selected pair's candidate types and round trip, and the audio delay, from one stats report. */
export function readConnectStats(report: RTCStatsReport | StatsList): Partial<CallCheckResult> {
  const stats = statsList(report);
  const byId = new Map(stats.map((entry) => [entry.id, entry]));
  const transport = stats.find((entry) => entry.type === 'transport');
  const pair =
    (transport?.selectedCandidatePairId ? byId.get(String(transport.selectedCandidatePairId)) : undefined) ??
    stats.find((entry) => entry.type === 'candidate-pair' && entry.nominated === true && entry.state === 'succeeded');
  const out: Partial<CallCheckResult> = {};
  if (pair) {
    const local = byId.get(String(pair.localCandidateId));
    const remote = byId.get(String(pair.remoteCandidateId));
    if (local?.candidateType) out.localType = local.candidateType as CandidateType;
    if (remote?.candidateType) out.remoteType = remote.candidateType as CandidateType;
    if (typeof pair.currentRoundTripTime === 'number') out.rttMs = pair.currentRoundTripTime * 1000;
  }
  const audio = stats.find((entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio');
  const emitted = Number(audio?.jitterBufferEmittedCount ?? 0);
  if (audio && emitted > 0 && out.rttMs !== undefined) {
    out.audioDelayMs = out.rttMs / 2 + (Number(audio.jitterBufferDelay) / emitted) * 1000;
  }
  return out;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomRun(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function iceServers(mode: CallCheckMode): RTCIceServer[] {
  return mode === 'stun' ? [{ urls: CALL_CHECK_STUN }] : [];
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

/** Runs checks as caller and answers other members' offers. One per renderer. */
export class CallCheck {
  private assembler = new CallPartAssembler();
  private answers = new Map<string, (sdp: string) => void>();
  private open = new Map<string, { pc: RTCPeerConnection; media: GeneratedMedia; sink: HTMLAudioElement }>();
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

  /** Several connections at once, each with video both ways, in one mode. */
  async checkLoad(circleKey: string, to: string, mode: CallCheckMode, streams = LOAD_STREAMS): Promise<void> {
    const run = randomRun();
    await Promise.all(Array.from({ length: streams }, (_, stream) => this.call(circleKey, to, mode, 'load', stream, run)));
  }

  private async record(result: CallCheckResult): Promise<void> {
    const logged = (await this.transport.report(result).catch((): null => null)) ?? result;
    this.results.push(logged);
    for (const listener of this.listeners) listener(logged);
  }

  private async send(circleKey: string, to: string, message: CheckMessage): Promise<Partial<CallCheckResult>> {
    const packed = await packCallMessage(message);
    for (const part of packed.parts) await this.transport.send(circleKey, to, part);
    return { descriptionBytes: packed.rawBytes, descriptionSent: packed.sentChars, descriptionParts: packed.parts.length };
  }

  private async localDescription(pc: RTCPeerConnection, mode: CallCheckMode): Promise<string> {
    await gathered(pc);
    const sdp = pc.localDescription?.sdp ?? '';
    if (mode !== 'swarm') return sdp;
    const host = await this.transport.publicAddress();
    return host ? addSwarmCandidates(sdp, host) : sdp;
  }

  private start(key: string, mode: CallCheckMode, kind: 'connect' | 'load'): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: iceServers(mode) });
    const media = new GeneratedMedia(kind === 'load');
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
    this.open.set(key, { pc, media, sink });
    return pc;
  }

  private close(key: string): void {
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    entry.pc.close();
    entry.media.stop();
    entry.sink.srcObject = null;
  }

  /** Measure an open connection and record it. */
  private async measure(pc: RTCPeerConnection, base: CallCheckResult, kind: 'connect' | 'load'): Promise<void> {
    if (kind === 'connect') {
      await sleep(SETTLE_MS);
      await this.record({ ...base, ...readConnectStats(await pc.getStats()) });
      return;
    }
    await sleep(LOAD_MS - LOAD_SAMPLE_MS);
    const before = await pc.getStats();
    await sleep(LOAD_SAMPLE_MS);
    const after = await pc.getStats();
    await this.record({
      ...base,
      ...readConnectStats(after),
      ...readLoadStats(before, after, LOAD_SAMPLE_MS / 1000),
      streams: [...this.open.keys()].filter((key) => key.startsWith(`${base.run}/`)).length,
    });
  }

  private async call(
    circleKey: string,
    to: string,
    mode: CallCheckMode,
    kind: 'connect' | 'load',
    stream: number,
    run: string
  ): Promise<void> {
    const key = `${run}/${stream}`;
    const base: CallCheckResult = { run, kind, mode, role: 'caller', connected: false };
    try {
      const pc = this.start(key, mode, kind);
      await pc.setLocalDescription(await pc.createOffer());
      const sdp = await this.localDescription(pc, mode);
      const answered = new Promise<string | null>((resolve) => {
        this.answers.set(key, resolve);
        setTimeout(() => resolve(null), ANSWER_MS);
      });
      const sizes = await this.send(circleKey, to, { t: 'offer', run, stream, mode, kind, sdp });
      Object.assign(base, sizes);
      const started = performance.now();
      const answer = await answered;
      this.answers.delete(key);
      if (!answer) {
        await this.record({ ...base, failedAt: 'answer' });
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (!(await connected(pc))) {
        await this.record({ ...base, failedAt: 'ice' });
        return;
      }
      base.connected = true;
      base.msToConnect = performance.now() - started;
      await this.measure(pc, base, kind);
    } catch {
      await this.record({ ...base, failedAt: 'error' });
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
    const { run, stream, mode, kind } = message;
    const key = `${run}/${stream}`;
    const base: CallCheckResult = { run, kind, mode, role: 'answerer', connected: false };
    try {
      const pc = this.start(key, mode, kind);
      const started = performance.now();
      await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      const sdp = await this.localDescription(pc, mode);
      Object.assign(base, await this.send(circleKey, from, { t: 'answer', run, stream, sdp }));
      if (!(await connected(pc))) {
        await this.record({ ...base, failedAt: 'ice' });
        this.close(key);
        return;
      }
      base.connected = true;
      base.msToConnect = performance.now() - started;
      await this.measure(pc, base, kind);
      // The caller says bye when it has measured too; close anyway if that never arrives.
      setTimeout(() => this.close(key), ANSWER_MS);
    } catch {
      await this.record({ ...base, failedAt: 'error' });
      this.close(key);
    }
  }
}
