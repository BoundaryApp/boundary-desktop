import React, { useId } from 'react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';
import { openSettings } from '../settingsNavigation';

const HINT = {
  'Chat replies': 'How it talks to you here',
  Drafts: 'Posts, emails and documents it writes for you',
} as const;

const NEW = '__new';
const MANAGE = '__manage';

function notReady(voice: WritingVoiceView): string | null {
  if (voice.status === 'calibrating') return 'Calibrating';
  if (voice.status === 'not-calibrated') return 'Not calibrated';
  return null;
}

/** One of an agent's two voice settings (ADR 0056 §5): a voice, No voice, or a way to Settings. */
export const WritingVoicePicker: React.FC<{
  label: keyof typeof HINT;
  value: string | null;
  voices: WritingVoiceView[];
  onChange: (id: string | null) => void;
  disabled?: boolean;
}> = ({ label, value, voices, onChange, disabled = false }) => {
  const id = useId();
  return (
    <div className="wb-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === NEW) {
            e.target.value = value ?? '';
            openSettings({ tab: 'writing-voices', newWritingVoice: true });
          } else if (next === MANAGE) {
            e.target.value = value ?? '';
            openSettings({ tab: 'writing-voices' });
          } else {
            onChange(next || null);
          }
        }}
      >
        <option value="">No voice</option>
        {voices.map((voice) => {
          const reason = notReady(voice);
          return (
            <option key={voice.id} value={voice.id} disabled={Boolean(reason)}>
              {reason ? `${voice.name} · ${reason}` : voice.name}
            </option>
          );
        })}
        <option value={NEW}>New voice…</option>
        <option value={MANAGE}>Manage voices…</option>
      </select>
      <small>{HINT[label]}</small>
    </div>
  );
};
