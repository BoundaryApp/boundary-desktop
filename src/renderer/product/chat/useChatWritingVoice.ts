import { useCallback, useEffect, useRef, useState } from 'react';
import type { WritingVoiceMark } from '../../../shared/types/hermesChat';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';

/**
 * A chat's kept writing voice (ADR 0056 §6). A chat with no session yet keeps it here; its
 * first send takes it, and main stores it on the session that send creates.
 */
export function useChatWritingVoice(sessionId: string | null, voices: WritingVoiceView[]) {
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [marks, setMarks] = useState<WritingVoiceMark[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) return undefined;
    let live = true;
    void window.electronAPI.writingVoices.getChat(sessionId).then((result) => {
      if (!live || !result.success || !result.voice) return;
      setVoiceId(result.voice.voiceId);
      setVoiceName(result.voice.voiceName);
      setMarks(result.voice.marks);
    });
    return () => {
      live = false;
    };
    // A voices change (one deleted, one recalibrated) can change whether the kept one holds.
  }, [sessionId, voices]);

  const keep = useCallback(
    async (id: string | null) => {
      setError(null);
      if (!sessionId) {
        pendingRef.current = id;
        setVoiceId(id);
        setVoiceName(id ? (voices.find((v) => v.id === id)?.name ?? null) : null);
        return;
      }
      const result = await window.electronAPI.writingVoices.setChat(sessionId, id);
      if (!result.success || !result.voice) {
        setError(result.error);
        return;
      }
      setVoiceId(result.voice.voiceId);
      setVoiceName(result.voice.voiceName);
      setMarks(result.voice.marks);
    },
    [sessionId, voices]
  );

  /** The voice a new chat's first send carries, taken once. */
  const takeForNewChat = useCallback((): string | null => {
    const id = pendingRef.current;
    pendingRef.current = null;
    return id;
  }, []);

  return { voiceId, voiceName, marks, error, keep, takeForNewChat };
}
