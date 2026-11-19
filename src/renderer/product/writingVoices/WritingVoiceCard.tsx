import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import type { WritingVoiceStep, WritingVoiceView } from '../../../shared/types/writingVoices';
import { DeleteWritingVoiceSheet } from './DeleteWritingVoiceSheet';
import { Button } from '../../components/ui/button';

/** The stack's limit on client context (change request 0010): longer guides can't reach chat. */
const MAX_STYLE_CHARS = 16_000;

const STEPS: Array<{ step: WritingVoiceStep; label: string }> = [
  { step: 'waiting', label: 'Waiting for another calibration' },
  { step: 'starting', label: 'Starting' },
  { step: 'reading', label: 'Reading the samples' },
  { step: 'writing', label: 'Writing the style guide' },
  { step: 'checking', label: 'Checking the style guide' },
];

const count = (n: number) => n.toLocaleString('en-US');

function metaLine(voice: WritingVoiceView): string {
  const parts = [`${voice.pieces} pieces, ${count(voice.words)} words`];
  if (voice.calibratedAt) {
    const date = new Date(voice.calibratedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    parts.push(`calibrated ${date}`);
  }
  if (voice.style) parts.push(`STYLE.md ${count(voice.style.chars)} characters`);
  return parts.join(' · ');
}

function StatusBadge({ voice }: { voice: WritingVoiceView }) {
  if (voice.status === 'calibrating') return <Badge variant="brand">Calibrating</Badge>;
  if (voice.status === 'not-calibrated') return <Badge>Not calibrated</Badge>;
  if (voice.samplesChanged) return <Badge variant="warn">Samples changed</Badge>;
  return <Badge variant="ok">Ready</Badge>;
}

/** One voice in Settings → Writing voices (writing voices spec, "The voice card"). */
export const WritingVoiceCard: React.FC<{
  voice: WritingVoiceView;
  onChange: (voice: WritingVoiceView) => void;
  onDeleted: (id: string) => void;
}> = ({ voice, onChange, onDeleted }) => {
  const api = window.electronAPI.writingVoices;
  const [editing, setEditing] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [samples, setSamples] = useState<Array<{ name: string; words: number }> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };

  const takeView = (result: { success: true; voice: WritingVoiceView } | { success: false; error: string }) => {
    if ('error' in result) {
      setError(result.error);
      return false;
    }
    onChange(result.voice);
    return true;
  };

  const calibrate = (): void =>
    void run(async (): Promise<void> => {
      const result = await api.calibrate(voice.id);
      if ('error' in result) setError(result.error);
    });

  const saveNeverDoes = (): void =>
    void run(async (): Promise<void> => {
      const lines = (editing ?? []).map((line) => line.trim()).filter(Boolean);
      if (takeView(await api.setNeverDoes(voice.id, lines))) setEditing(null);
    });

  const saveName = (): void =>
    void run(async (): Promise<void> => {
      if (takeView(await api.rename(voice.id, renaming ?? ''))) setRenaming(null);
    });

  const loadSamples = (): void =>
    void run(async (): Promise<void> => {
      const result = await api.samples(voice.id);
      if ('error' in result) setError(result.error);
      else setSamples(result.files);
    });

  const afterSamples = async (result: Parameters<typeof takeView>[0]) => {
    if (!takeView(result)) return;
    const next = await api.samples(voice.id);
    if ('files' in next) setSamples(next.files);
  };

  const addSamples = (): void =>
    void run(async (): Promise<void> => {
      const picked = await api.pick();
      if (!('paths' in picked)) return;
      await afterSamples(
        await api.addSamples(
          voice.id,
          picked.paths.map((p) => ({ kind: 'file' as const, path: p }))
        )
      );
    });

  const removeSample = (name: string): void =>
    void run(async (): Promise<void> => afterSamples(await api.removeSample(voice.id, name)));

  const calibrating = voice.status === 'calibrating';
  const current = STEPS.findIndex((s) => s.step === voice.step);

  return (
    <div className="wb-voice-card">
      <div className="wb-voice-card-top">
        <span className="wb-voice-card-name">
          {renaming === null ? (
            <b>{voice.name}</b>
          ) : (
            <span className="wb-voice-rename">
              <input
                aria-label="Voice name"
                value={renaming}
                maxLength={60}
                onChange={(e) => setRenaming(e.target.value)}
              />
              <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={saveName}>
                Save name
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
            </span>
          )}
          <small>{metaLine(voice)}</small>
        </span>
        <StatusBadge voice={voice} />
        {voice.status === 'not-calibrated' ? (
          <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={calibrate}>
            {voice.lastError ? 'Try again' : 'Calibrate'}
          </Button>
        ) : null}
        {voice.status === 'ready' && voice.samplesChanged ? (
          <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={calibrate}>
            Recalibrate
          </Button>
        ) : null}
      </div>

      {calibrating ? (
        <>
          <ol className="wb-voice-steps">
            {STEPS.filter((s) => s.step !== 'waiting' || voice.step === 'waiting').map((s) => {
              const index = STEPS.indexOf(s);
              const state = index < current ? 'is-done' : index === current ? 'is-now' : '';
              return (
                <li key={s.step} className={state} aria-current={index === current ? 'step' : undefined}>
                  {s.label}
                </li>
              );
            })}
          </ol>
          <p className="wb-voice-note">You can leave this page. The voice can be picked once it's ready.</p>
        </>
      ) : null}

      {voice.status === 'not-calibrated' && voice.lastError ? (
        <p className="wb-voice-error">{voice.lastError}</p>
      ) : null}

      {voice.style && voice.style.chars > MAX_STYLE_CHARS ? (
        <p className="wb-voice-error">
          Too long for chat replies (over 16,000 characters). Shorten STYLE.md.
        </p>
      ) : null}

      {voice.style && !calibrating ? (
        <>
          {voice.style.description ? <p className="wb-voice-desc">{voice.style.description}</p> : null}
          <div className="wb-voice-kicker">Never does</div>
          {editing === null ? (
            <ul className="wb-voice-never">
              {voice.style.neverDoes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <ul className="wb-voice-never is-editing">
              {editing.map((line, i) => (
                <li key={i}>
                  <input
                    aria-label="Never does"
                    value={line}
                    placeholder="Never …"
                    onChange={(e) =>
                      setEditing((rows) => (rows ?? []).map((r, j) => (j === i ? e.target.value : r)))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {error ? <p className="wb-voice-error">{error}</p> : null}

      {samples ? (
        <ul className="wb-voice-files">
          {samples.map((file) => (
            <li key={file.name}>
              <span className="wb-voice-file">{file.name}</span>
              <small>{count(file.words)} words</small>
              <button
                type="button"
                className="wb-voice-file-remove"
                aria-label={`Remove ${file.name}`}
                disabled={busy}
                onClick={() => removeSample(file.name)}
              >
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
          <li>
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={addSamples}>
              Add files…
            </Button>
          </li>
        </ul>
      ) : null}

      <div className="wb-voice-actions">
        {editing === null ? (
          voice.style && !calibrating ? (
            <Button variant="secondary" size="sm" type="button" onClick={() => setEditing([...voice.style!.neverDoes, ''])}>
              Edit
            </Button>
          ) : null
        ) : (
          <>
            <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={saveNeverDoes}>
              Save
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </>
        )}
        {voice.style ? (
          <Button variant="secondary" size="sm" type="button" onClick={() => void api.openStyle(voice.id)}>
            Open STYLE.md
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          type="button"
          aria-expanded={samples !== null}
          onClick={() => (samples ? setSamples(null) : loadSamples())}
        >
          Samples ({voice.pieces})
        </Button>
        <span className="wb-voice-actions-gap" />
        <Button variant="secondary" size="sm" type="button" onClick={() => setRenaming(voice.name)}>
          Rename
        </Button>
        <Button variant="secondary" size="sm" type="button" onClick={() => void api.reveal(voice.id)}>
          Show in Finder
        </Button>
        <Button variant="danger" size="sm" type="button" disabled={calibrating} onClick={() => setDeleting(true)}>
          Delete…
        </Button>
      </div>
      <DeleteWritingVoiceSheet
        voice={voice}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={onDeleted}
      />
    </div>
  );
};
