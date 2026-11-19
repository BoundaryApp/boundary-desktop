import React, { useCallback, useEffect, useState } from 'react';
import { SettingsSection } from '../../components/settings/SettingsSection';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';
import { NewWritingVoiceSheet } from './NewWritingVoiceSheet';
import { WritingVoiceCard } from './WritingVoiceCard';
import { Button } from '../../components/ui/button';
import './writingVoices.css';

/** Settings → Writing voices (ADR 0056 §2). */
export const WritingVoicesPanel: React.FC<{
  /** Open on the create sheet, as an agent sheet's New voice… asks. */
  startCreating?: boolean;
}> = ({ startCreating = false }) => {
  const [voices, setVoices] = useState<WritingVoiceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(startCreating);

  const load = useCallback(async () => {
    const result = await window.electronAPI.writingVoices.list();
    if ('voices' in result) setVoices(result.voices);
    else setError(result.error);
  }, []);

  useEffect(() => {
    let live = true;
    void window.electronAPI.writingVoices.list().then((result) => {
      if (!live) return;
      if ('voices' in result) setVoices(result.voices);
      else setError(result.error);
    });
    // A step only moves the card; an ending reloads it, since the folder has changed.
    const off = window.electronAPI.writingVoices.onProgress((progress) => {
      if (!live) return;
      if (progress.status === 'calibrating') {
        setVoices((current) =>
          (current ?? []).map((v) =>
            v.id === progress.id ? { ...v, status: progress.status, step: progress.step } : v
          )
        );
      } else {
        void load();
      }
    });
    const offChanged = window.electronAPI.writingVoices.onChanged(() => {
      if (live) void load();
    });
    return () => {
      live = false;
      off();
      offChanged();
    };
  }, [load]);

  const replace = (next: WritingVoiceView) =>
    setVoices((current) => (current ?? []).map((v) => (v.id === next.id ? next : v)));

  return (
    <>
      <SettingsSection id="settings-writing-voices" title="Writing voices">
        <p className="wb-voice-lede">
          Agents write in these voices. Each one is calibrated from samples of someone's writing.
        </p>
        {error ? <p className="wb-voice-lede">{error}</p> : null}
        {voices && voices.length === 0 ? <p className="wb-voice-lede">No writing voices yet.</p> : null}
        {(voices ?? []).map((voice) => (
          <WritingVoiceCard
            key={voice.id}
            voice={voice}
            onChange={replace}
            onDeleted={(id) => setVoices((current) => (current ?? []).filter((v) => v.id !== id))}
          />
        ))}
        <div>
          <Button variant="secondary" size="sm" type="button" onClick={() => setCreating(true)}>
            New voice…
          </Button>
        </div>
      </SettingsSection>
      <NewWritingVoiceSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => void load()}
      />
    </>
  );
};
