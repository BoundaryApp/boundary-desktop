import React, { useEffect, useState } from 'react';
import type { RepliesAtOnce } from '../../../shared/types/hermesChat';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

/**
 * **Replies at once** on the local model (workload plan Phase 1a, step 1): how many chats the
 * local server answers together. A send beyond it waits in Boundary until a reply ends. The
 * server's own count is the default; LM Studio and llama.cpp report one, Ollama doesn't.
 */
export const RepliesAtOnceRow: React.FC<{ endpointUrl?: string; modelId?: string }> = ({ endpointUrl, modelId }) => {
  const [value, setValue] = useState<RepliesAtOnce | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let live = true;
    void window.electronAPI.hermesChat
      .getRepliesAtOnce()
      .then((next) => {
        if (!live) return;
        setValue(next);
        setDraft(next ? String(next.limit) : '');
      })
      .catch((): void => undefined);
    return () => {
      live = false;
    };
  }, [endpointUrl, modelId]);

  if (!value) return null;

  const save = (raw: number | null) => {
    void window.electronAPI.hermesChat
      .setRepliesAtOnce({ value: raw })
      .then((next) => {
        setValue(next);
        setDraft(next ? String(next.limit) : '');
      })
      .catch((): void => undefined);
  };
  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1) {
      setDraft(String(value.limit));
      return;
    }
    if (n === value.limit) return;
    save(value.reported === n ? null : n);
  };
  const source = value.override
    ? value.reported
      ? `Server reports ${value.reported}`
      : 'Server reports none'
    : value.reported
      ? 'Reported by the server'
      : 'Server reports none, so 1';

  return (
    <div className="wb-inference-meta">
      <dt>
        <label htmlFor="replies-at-once">Replies at once</label>
      </dt>
      <dd className="flex items-center justify-end gap-2">
        <span className="text-xs text-fg-faint">{source}</span>
        {value.override ? (
          <Button variant="secondary" type="button" onClick={() => save(null)}>
            Use server’s
          </Button>
        ) : null}
        <Input
          id="replies-at-once"
          type="number"
          min={1}
          max={16}
          size="sm"
          className="w-[56px]"
          title="Chats the local model answers together. A send beyond this waits in Boundary until a reply ends."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      </dd>
    </div>
  );
};
