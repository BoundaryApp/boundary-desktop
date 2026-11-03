import React, { useEffect, useMemo, useState } from 'react';
import type { CircleChannel, CircleSnapshot } from '../../../../shared/types/circles';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import './circleChat.css';

/** What a Hermes chat message offers to share: its text, who wrote it and, for a reply, the model. */
export interface CircleShareDraft {
  text: string;
  role: 'user' | 'assistant';
  model?: string;
}

/** Where a share went, for the toast's Open. */
export interface CircleShareTarget {
  circleKey: string;
  circleName: string;
  channel: string;
  channelName: string;
}

const LAST_KEY = 'boundary:circle-share-last';
/** The message limit `apply` enforces (ADR 0042 §3), and when the sheet starts showing what's left. */
const MAX_TEXT_BYTES = 12 * 1024;
const SHOW_LEFT_BYTES = 10 * 1024;

function readLast(): { key: string; channel: string } | null {
  try {
    const last = JSON.parse(window.localStorage.getItem(LAST_KEY) ?? 'null') as { key?: unknown; channel?: unknown } | null;
    return typeof last?.key === 'string' && typeof last.channel === 'string' ? { key: last.key, channel: last.channel } : null;
  } catch {
    return null;
  }
}

function saveLast(key: string, channel: string): void {
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify({ key, channel }));
  } catch {
    // The picker starts on the first Circle next time.
  }
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Share one Hermes chat message to a Circle channel (Circle chats spec decision 14). Only the
 * text in the box is posted, and only when the user presses Share.
 */
export const ShareToCircleSheet: React.FC<{
  draft: CircleShareDraft | null;
  circles: CircleSnapshot[];
  /** Each Circle's channels, by key. */
  channels: Record<string, CircleChannel[]>;
  onClose: () => void;
  onShared: (target: CircleShareTarget) => void;
}> = ({ draft, circles, channels, onClose, onShared }) => {
  const writable = useMemo(() => circles.filter((circle) => circle.writable && !circle.needsUpdate), [circles]);
  const [circleKey, setCircleKey] = useState('');
  const [channel, setChannel] = useState('general');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open starts from the message's text and the last place shared to.
  useEffect(() => {
    if (!draft) return;
    const last = readLast();
    const start = writable.find((circle) => circle.key === last?.key) ?? writable[0];
    setCircleKey(start?.key ?? '');
    setChannel(start && last?.key === start.key ? last.channel : 'general');
    setText(draft.text);
    setError(null);
  }, [draft, writable]);

  const circle = writable.find((item) => item.key === circleKey) ?? null;
  const channelList = channels[circleKey]?.length ? channels[circleKey] : [{ id: 'general', name: 'General', unread: 0 }];
  const chosen = channelList.find((item) => item.id === channel) ?? channelList[0];
  const bytes = bytesOf(text);
  const tooLong = bytes > MAX_TEXT_BYTES;
  const from =
    draft?.role === 'assistant' && draft.model ? `Shared from a chat · reply from ${draft.model}` : 'Shared from a chat';

  const share = async () => {
    if (!draft || !circle || busy || !text.trim() || tooLong) return;
    setBusy(true);
    setError(null);
    const shared = { role: draft.role, ...(draft.role === 'assistant' && draft.model ? { model: draft.model } : {}) };
    const result = await window.electronAPI.circles.chatPost({ key: circle.key, channel: chosen.id, text, shared });
    setBusy(false);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    saveLast(circle.key, chosen.id);
    onShared({ circleKey: circle.key, circleName: circle.name, channel: chosen.id, channelName: chosen.name });
  };

  return (
    <Sheet
      open={draft !== null}
      onClose={onClose}
      busy={busy}
      titleId="circle-share"
      title="Share to Circle"
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          confirmLabel={busy ? 'Sharing…' : 'Share'}
          confirmDisabled={!circle || !text.trim() || tooLong}
          onCancel={onClose}
          onConfirm={() => void share()}
        />
      }
    >
      {writable.length === 0 ? (
        <p className="wb-sheet-help">None of your Circles can take messages from this Mac yet.</p>
      ) : (
        <div className="wb-circle-share">
          <div className="wb-circle-share-pick">
            <label>
              <span>Circle</span>
              <select
                value={circleKey}
                onChange={(event) => {
                  setCircleKey(event.target.value);
                  setChannel('general');
                }}
              >
                {writable.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Channel</span>
              <select value={chosen.id} onChange={(event) => setChannel(event.target.value)}>
                {channelList.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea aria-label="Text to share" rows={8} value={text} onChange={(event) => setText(event.target.value)} />
          {bytes > SHOW_LEFT_BYTES ? (
            <p className={`wb-circle-share-left${tooLong ? ' is-over' : ''}`}>
              {tooLong
                ? `Too long by ${Math.ceil((bytes - MAX_TEXT_BYTES) / 1024)} KB.`
                : `${Math.floor((MAX_TEXT_BYTES - bytes) / 1024)} KB left.`}
            </p>
          ) : null}
          <p className="wb-circle-share-from">Shows as: {from}</p>
          <p className="wb-sheet-help">Everyone in this Circle gets a copy that you can’t take back.</p>
        </div>
      )}
    </Sheet>
  );
};
