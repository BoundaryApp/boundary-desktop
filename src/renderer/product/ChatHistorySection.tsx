import React, { useEffect, useState } from 'react';
import type { ChatHistoryProfileCount, ChatHistoryState } from '../../shared/types/chatHistory';
import { Callout } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';

/** ADR 0070 §12: import waits on a stack release with the title fix (CR 0039 R5). */
export const IMPORT_NEEDS_NEWER_STACK = 'Import needs a newer agent stack than this one. Export works now, so you can take a copy before you move.';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function profileName(p: ChatHistoryProfileCount): string {
  return p.label ?? p.profile;
}

function ProfileCounts({ profiles }: { profiles: ChatHistoryProfileCount[] }) {
  if (!profiles.length) return null;
  return (
    <ul className="m-0 list-none p-0 text-ui">
      {profiles.map((p) => (
        <li key={p.profile}>
          {profileName(p)}: {plural(p.sessions, 'chat', 'chats')}, {plural(p.messages, 'message', 'messages')}
        </li>
      ))}
    </ul>
  );
}

/**
 * Settings → General → Chat history (ADR 0070 §1): **Export history…** writes the stack's
 * export and Boundary's records into a new folder. **Import history…** is shown disabled until
 * the stack can import without failing on a shared title.
 */
export const ChatHistorySection: React.FC = () => {
  const [state, setState] = useState<ChatHistoryState>({ phase: 'idle' });
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const api = window.electronAPI?.chatHistory;
    if (!api) return;
    let live = true;
    void api
      .status()
      .then((status) => {
        if (!live) return;
        setState(status.state);
        setUnavailable(status.unavailable);
      })
      .catch((): void => undefined);
    const off = api.onChanged((next) => setState(next));
    return () => {
      live = false;
      off();
    };
  }, []);

  const exporting = state.phase === 'exporting';

  const startExport = (): void => {
    setError(null);
    setPicking(true);
    void window.electronAPI.chatHistory
      .export()
      .then((result) => {
        if ('error' in result) setError(result.error);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPicking(false));
  };

  const hint = unavailable
    ? null
    : 'Saves every chat, with its agent, project and room, to a new folder you can import on another install.';

  return (
    <SettingsSection id="settings-chat-history" title="Chat history">
      {unavailable ? <Callout variant="info">{unavailable}</Callout> : null}
      <SettingsRow
        label="Export history"
        hint={hint}
        details={
          exporting ? (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              <p className="m-0 text-ui">
                {state.cancelling ? 'Cancelling…' : state.profiles.length ? 'Exporting…' : 'Starting the export…'}
              </p>
              <ProfileCounts profiles={state.profiles} />
            </div>
          ) : null
        }
      >
        {exporting ? (
          <Button
            variant="secondary"
            type="button"
            disabled={state.cancelling}
            onClick={() => void window.electronAPI.chatHistory.cancel()}
          >
            Cancel
          </Button>
        ) : (
          <Button variant="secondary" type="button" disabled={!!unavailable || picking} onClick={startExport}>
            Export history…
          </Button>
        )}
      </SettingsRow>
      {state.phase === 'exported' ? (
        <Callout variant="ok" layout="stacked">
          <p>
            Exported {plural(state.sessions, 'chat', 'chats')} and {plural(state.messages, 'message', 'messages')} to{' '}
            <span className="break-all">{state.folder}</span>.
          </p>
          <ProfileCounts profiles={state.profiles} />
          <p>The folder holds your whole chats, unencrypted. Keep it as you would a backup.</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void window.electronAPI.chatHistory.reveal(state.folder)}
          >
            Show in Finder
          </Button>
        </Callout>
      ) : null}
      {state.phase === 'cancelled' ? <Callout variant="default">Export cancelled. Its folder was deleted.</Callout> : null}
      {state.phase === 'failed' ? <Callout variant="destructive">{state.error}</Callout> : null}
      {error ? <Callout variant="destructive">{error}</Callout> : null}
      <SettingsRow label="Import history" hint={unavailable ? null : IMPORT_NEEDS_NEWER_STACK}>
        <Button variant="secondary" type="button" disabled>
          Import history…
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
};
