/**
 * Turns a call's connections into `call.connect` and `call.end` log events (metadata only). A
 * connected link's stats are read when it connects and then every `LOG_SAMPLE_MS`, so the end
 * event can use the last reading even though the link is closing by then: the path at the end,
 * how often it changed, and loss, bitrate and video freezes over the call.
 */
import type { CallLogInput } from '../../../../shared/calls/callLog';
import { readConnectStats, readMediaStats, selectedPairId } from '../callCheck';

export const LOG_SAMPLE_MS = 5_000;

type Report = Parameters<typeof readConnectStats>[0];

export interface StatsSource {
  getStats(): Promise<Report>;
  /** The tunnel endpoint's port, which tells a tunnel path from a direct one. */
  readonly tunnelPort: number | null;
}

interface Watched {
  peer: string;
  first: Report;
  firstAt: number;
  last: Report;
  lastAt: number;
  pairId: string | null;
  switches: number;
}

const round = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 10) / 10);

/** Drops undefined values so the event holds only what was measured. */
function defined<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

export class CallLogger {
  private watched = new Map<StatsSource, Watched>();
  /** Links that ended, so a connect still reading stats doesn't start watching one. */
  private gone = new WeakSet<StatsSource>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private s: string;

  constructor(
    session: string,
    private log: (input: CallLogInput) => void
  ) {
    this.s = session.slice(0, 8);
  }

  async connected(report: { identity: string; role: 'offer' | 'answer'; ms: number }, link: StatsSource): Promise<void> {
    const peer = report.identity.slice(0, 8);
    const base: CallLogInput = { kind: 'connect', s: this.s, peer, role: report.role, ms: round(report.ms) };
    const stats = await link.getStats().catch((): null => null);
    if (!stats) {
      this.log(base);
      return;
    }
    const connect = readConnectStats(stats, link.tunnelPort ?? undefined);
    this.log(
      defined({
        ...base,
        path: connect.path,
        localType: connect.localType,
        remoteType: connect.remoteType,
        rttMs: round(connect.rttMs),
      })
    );
    if (this.gone.has(link)) return;
    const now = Date.now();
    this.watched.set(link, { peer, first: stats, firstAt: now, last: stats, lastAt: now, pairId: selectedPairId(stats), switches: 0 });
    this.timer ??= setInterval(() => void this.sample(), LOG_SAMPLE_MS);
  }

  ended(report: { identity: string; seconds: number }, link: StatsSource): void {
    this.gone.add(link);
    const watched = this.watched.get(link);
    this.watched.delete(link);
    if (this.watched.size === 0) this.stop();
    const base: CallLogInput = { kind: 'end', s: this.s, peer: report.identity.slice(0, 8), seconds: report.seconds };
    if (!watched) {
      this.log(base);
      return;
    }
    const connect = readConnectStats(watched.last, link.tunnelPort ?? undefined);
    const media = readMediaStats(watched.first, watched.last, (watched.lastAt - watched.firstAt) / 1000);
    this.log(
      defined({
        ...base,
        path: connect.path,
        pathSwitches: watched.switches,
        rttMs: round(connect.rttMs),
        lossInPct: round(media.lossInPct),
        kbpsIn: round(media.kbpsIn),
        kbpsOut: round(media.kbpsOut),
        freezes: media.freezes,
      })
    );
  }

  dispose(): void {
    this.watched.clear();
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    await Promise.all(
      [...this.watched].map(async ([link, watched]) => {
        const stats = await link.getStats().catch((): null => null);
        if (!stats || this.watched.get(link) !== watched) return;
        const pairId = selectedPairId(stats);
        if (pairId && watched.pairId && pairId !== watched.pairId) watched.switches++;
        watched.pairId = pairId ?? watched.pairId;
        watched.last = stats;
        watched.lastAt = Date.now();
      })
    );
  }
}
