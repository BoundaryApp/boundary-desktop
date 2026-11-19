import { useEffect, useRef, useState } from 'react';
import { StreamPacer } from './streamPacer';

let pacingEnabled = true;

/**
 * Turn pacing off (or back on) for every reply mounted after the call. Renderer tests
 * that check what a reply says rather than how it appears run with it off.
 */
export function setStreamPacingEnabled(enabled: boolean): void {
  pacingEnabled = enabled;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * The part of a streamed reply to show now, paced by {@link StreamPacer}. A reply that
 * wasn't streaming when it mounted (history) shows whole, and so does every reply under
 * reduced motion. `pacing` stays true until the reveal has caught up after the stream ends.
 */
export function usePacedText(text: string, running: boolean): { text: string; pacing: boolean } {
  const [active] = useState(() => pacingEnabled && running && !prefersReducedMotion());
  const pacerRef = useRef<StreamPacer | null>(null);
  const [frame, setFrame] = useState({ shown: 0, pacing: active });

  if (active && pacerRef.current == null) pacerRef.current = new StreamPacer();

  useEffect(() => {
    const pacer = pacerRef.current;
    if (!pacer) return;
    pacer.update(text, !running, performance.now());
    let id = 0;
    const step = () => {
      const next = pacer.tick(performance.now());
      setFrame((prev) => (prev.shown === next.shown && prev.pacing === next.pacing ? prev : next));
      if (next.pacing) id = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(id);
  }, [text, running]);

  if (!active) return { text, pacing: false };
  return { text: text.slice(0, frame.shown), pacing: frame.pacing };
}
