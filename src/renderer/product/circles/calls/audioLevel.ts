/** How often `watchLevel` reports, about 15 times a second. */
const LEVEL_INTERVAL_MS = 66;

/**
 * Report the loudness of a stream's audio as the RMS of an `AnalyserNode`, from 0 to 1, until
 * the returned function is called. The stream's tracks are left running.
 */
export function watchLevel(stream: MediaStream, onLevel: (level: number) => void): () => void {
  if (stream.getAudioTracks().length === 0) return () => undefined;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onLevel(Math.min(1, Math.sqrt(sum / samples.length)));
  }, LEVEL_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    source.disconnect();
    void context.close().catch((): undefined => undefined);
  };
}
