/**
 * The ring for a call ringing while the window isn't in front. It is drawn here with Web Audio,
 * so no sound file ships and none needs a licence: two soft chimes, then quiet, every three
 * seconds. The pattern is one buffer played on a loop, so it keeps time with no timers while the
 * page is in the background.
 */

const RATE = 22_050;
const PERIOD_S = 3;
/** Each chime: start, length, and two partials in Hz. */
const CHIMES = [
  { at: 0, length: 0.45, tones: [659.25, 987.77] },
  { at: 0.55, length: 0.45, tones: [523.25, 783.99] },
];
const VOLUME = 0.18;

/** The samples of one period of the ring. */
export function ringSamples(rate = RATE): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(Math.round(PERIOD_S * rate));
  for (const chime of CHIMES) {
    const start = Math.round(chime.at * rate);
    const count = Math.round(chime.length * rate);
    for (let i = 0; i < count; i++) {
      const t = i / rate;
      // A quick rise and an exponential fall, so a chime neither clicks on nor stops dead.
      const envelope = Math.min(1, t / 0.01) * Math.exp(-t * 6) * (1 - i / count);
      let value = 0;
      for (const [n, tone] of chime.tones.entries()) value += Math.sin(2 * Math.PI * tone * t) / (n + 1);
      samples[start + i] += value * envelope * VOLUME;
    }
  }
  return samples;
}

type PlayingSound = { stop(): void };

let playing: PlayingSound | null = null;

function start(): PlayingSound | null {
  const Context = (window as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Context) return null;
  try {
    const context = new Context();
    const buffer = context.createBuffer(1, Math.round(PERIOD_S * RATE), RATE);
    buffer.copyToChannel(ringSamples(), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(context.destination);
    source.start();
    return {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        void context.close().catch((): undefined => undefined);
      },
    };
  } catch {
    return null;
  }
}

/** Start the ring, or stop it. Starting while it plays changes nothing. */
export function setRingSound(on: boolean): void {
  if (on) {
    playing ??= start();
    return;
  }
  playing?.stop();
  playing = null;
}
