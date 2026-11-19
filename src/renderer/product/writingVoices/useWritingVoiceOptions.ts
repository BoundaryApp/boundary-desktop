import { useEffect, useState } from 'react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';

/** The voices a picker offers; reloads when a calibration ends, so a new Ready voice appears. */
export function useWritingVoiceOptions(): WritingVoiceView[] {
  const [voices, setVoices] = useState<WritingVoiceView[]>([]);

  useEffect(() => {
    let live = true;
    const load = (): void =>
      void window.electronAPI.writingVoices.list().then((result) => {
        if (live && 'voices' in result) setVoices(result.voices);
      });
    load();
    const off = window.electronAPI.writingVoices.onProgress((progress) => {
      if (progress.status !== 'calibrating') load();
    });
    // A voice deleted, renamed or edited in Settings, maybe in another window.
    const offChanged = window.electronAPI.writingVoices.onChanged(load);
    return () => {
      live = false;
      off();
      offChanged();
    };
  }, []);

  return voices;
}
