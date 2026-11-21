import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { formatInferenceChipTitle } from '../../../shared/inferenceDisplay';
import { poolTitle, useConfidentialState } from '../inference/useConfidentialState';
import { useInferenceStatus } from '../../onboarding/inferenceStatus';
import type {
  WritingVoiceCheckSummary,
  WritingVoiceRecord,
  WritingVoiceSampleCheck,
  WritingVoiceSource,
} from '../../../shared/types/writingVoices';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Input } from '../../components/ui/input';
import { WRITING_VOICE_ENOUGH_LONG_PIECES, WRITING_VOICE_LONG_PIECE_WORDS } from '../../../shared/writingVoiceLimits';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** Spelled out under ten, as the rest of the copy does. */
const countWord = (n: number) => NUMBER_WORDS[n] ?? n.toLocaleString('en-US');
const LONG_WORDS = WRITING_VOICE_LONG_PIECE_WORDS.toLocaleString('en-US');

const REFUSAL_TEXT: Record<Exclude<WritingVoiceSampleCheck['refused'], null>, string> = {
  type: '',
  empty: 'Not added: empty',
  'too-large': 'Not added: over 5 MB',
  unreadable: "Not added: couldn't read",
  folder: 'Not added: folder',
};

function refusalText(file: WritingVoiceSampleCheck): string | null {
  if (!file.refused) return null;
  if (file.refused === 'type') return `Not added: ${file.extension ?? 'this type'}`;
  return REFUSAL_TEXT[file.refused];
}

const sameSource = (a: WritingVoiceSource, b: WritingVoiceSource) =>
  a.kind === b.kind && (a.kind === 'file' ? a.path === (b as typeof a).path : a.text === (b as typeof a).text);

function meterText(summary: WritingVoiceCheckSummary): string {
  const parts = [
    summary.enough
      ? 'Enough to calibrate.'
      : `Calibration works best from ${countWord(WRITING_VOICE_ENOUGH_LONG_PIECES)} or more pieces of ${LONG_WORDS} words or more. Add ${
          WRITING_VOICE_ENOUGH_LONG_PIECES - summary.longPieces
        } more for a steadier voice.`,
  ];
  if (summary.listHeavy > 0) {
    const one = summary.listHeavy === 1;
    parts.push(
      `${summary.listHeavy} ${one ? 'file is' : 'files are'} mostly headers and lists, which makes measured sentences shorter. Leave ${
        one ? 'it' : 'them'
      } out unless lists are part of this voice.`
    );
  }
  return parts.join(' ');
}

/** The model the built-in agent calibrates with: the app default, as chat names it. */
function useCalibratingModel(): string {
  const { status } = useInferenceStatus();
  const { state: confidential } = useConfidentialState();
  const first = status?.appSharedModel;
  if (first?.slot === 'confidential') return poolTitle(confidential, first.modelId ?? '');
  if (first) return 'a model shared with you';
  const slot = status?.appDefault ? status.slots[status.appDefault] : undefined;
  return status?.appDefault && slot?.configured && slot.modelId
    ? formatInferenceChipTitle(status.appDefault, slot.modelId)
    : '';
}

export const NewWritingVoiceSheet: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (voice: WritingVoiceRecord) => void;
}> = ({ open, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [sources, setSources] = useState<WritingVoiceSource[]>([]);
  const [summary, setSummary] = useState<WritingVoiceCheckSummary | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const model = useCalibratingModel();

  useEffect(() => {
    if (!open) return;
    setName('');
    setSources([]);
    setSummary(null);
    setPasting(false);
    setPasteText('');
    setError(null);
  }, [open]);

  // One check per change of the list; an answer to an older list is dropped.
  useEffect(() => {
    const id = ++request.current;
    if (sources.length === 0) {
      setSummary(null);
      return;
    }
    void window.electronAPI.writingVoices.check(sources).then((next) => {
      if (id === request.current) setSummary(next);
    });
  }, [sources]);

  const add = (more: WritingVoiceSource[]) =>
    setSources((current) => [...current, ...more.filter((s) => !current.some((c) => sameSource(c, s)))]);

  const choose = async () => {
    const picked = await window.electronAPI.writingVoices.pick();
    if ('paths' in picked) add(picked.paths.map((p) => ({ kind: 'file' as const, path: p })));
  };

  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files ?? []);
    add(
      files
        .map((f) => window.electronAPI.writingVoices.pathForFile(f))
        .filter(Boolean)
        .map((p) => ({ kind: 'file' as const, path: p }))
    );
  };

  const addPasted = () => {
    if (pasteText.trim()) add([{ kind: 'pasted', text: pasteText }]);
    setPasteText('');
    setPasting(false);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.writingVoices.create({ name: name.trim(), sources });
      if ('voice' in result) {
        onCreated(result.voice);
        onClose();
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const files = summary?.files ?? [];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={busy}
      titleId="wb-writing-voice-create-title"
      title="New writing voice"
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmLabel={busy ? 'Copying samples…' : 'Create voice'}
          confirmDisabled={!name.trim() || !summary || summary.pieces < 1}
          onConfirm={() => void create()}
        />
      }
    >
      <p className="wb-sheet-lede">
        Finished pieces you'd publish again work best. Agents imitate everything in the samples.
      </p>
      <label className="wb-field">
        <span>Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      </label>
      <div
        className="wb-voice-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        <p>Drop .md, .txt or .rst files here</p>
        <div className="wb-voice-drop-actions">
          <Button variant="secondary" size="sm" type="button" onClick={() => void choose()}>
            Choose files…
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => setPasting(true)}>
            Paste text
          </Button>
        </div>
      </div>
      {pasting ? (
        <div className="wb-voice-paste">
          <label className="wb-field">
            <span>Pasted text</span>
            <Textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={5} />
          </label>
          <Button variant="secondary" size="sm" type="button" onClick={addPasted}>
            Add
          </Button>
        </div>
      ) : null}
      {files.length > 0 ? (
        <ul className="wb-voice-files">
          {files.map((file) => {
            const refused = refusalText(file);
            return (
              <li key={file.source.kind === 'file' ? file.source.path : file.label}>
                <span className={refused ? 'wb-voice-file is-refused' : 'wb-voice-file'}>
                  {file.label}
                </span>
                {refused ? <small>{refused}</small> : null}
                {!refused && file.listHeavy ? (
                  <small className="is-warn">Mostly headers and lists</small>
                ) : null}
                {!refused ? <small>{file.words.toLocaleString('en-US')} words</small> : null}
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  aria-label={`Remove ${file.label}`}
                  onClick={() => setSources((current) => current.filter((s) => !sameSource(s, file.source)))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {summary && summary.pieces > 0 ? (
        <div className="wb-voice-meter" role="status">
          <div className="wb-voice-meter-nums">
            <span>{summary.pieces} pieces</span>
            <span>{summary.words.toLocaleString('en-US')} words</span>
            <span>
              {summary.longPieces} of {summary.pieces} over {LONG_WORDS} words
            </span>
          </div>
          <div className="wb-voice-meter-bar" aria-hidden="true">
            <i style={{ width: `${Math.min(summary.longPieces / WRITING_VOICE_ENOUGH_LONG_PIECES, 1) * 100}%` }} />
          </div>
          <p>{meterText(summary)}</p>
        </div>
      ) : null}
      <p className="wb-voice-note">{model ? `Calibrates with ${model}` : 'No model set up yet'}</p>
    </Sheet>
  );
};
