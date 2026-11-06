import React, { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '../components/ui/info-tip';
import type { WebSearchMode, WebSearchModeState } from '../../shared/webSearchMode';

/**
 * Settings → Agent browser → Web search: who answers Hermes's web searches and page reads (the
 * stack's HERMES_WEB_SEARCH_MODE). Shown only on a stack pin that reads the setting.
 */

const OPTIONS: Array<{ mode: WebSearchMode; title: string; sub: string }> = [
  {
    mode: 'private',
    title: 'Private only',
    sub: 'Searches go to your own SearXNG. Pages are fetched from this computer.',
  },
  {
    mode: 'private-first',
    title: 'Private, fall back to outside services',
    sub: 'Outside services step in when SearXNG is unavailable or a site refuses a plain fetch.',
  },
  {
    mode: 'keyless-first',
    title: 'Outside services first',
    sub: 'SearXNG and a plain fetch step in when every outside service fails.',
  },
  {
    mode: 'keyless',
    title: 'Outside services only',
    sub: 'SearXNG and plain fetches aren’t used.',
  },
];

export const WebSearchModeSection: React.FC = () => {
  const [state, setState] = useState<WebSearchModeState | null>(null);
  const [choice, setChoice] = useState<WebSearchMode>('private');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.assistantStack.getWebSearchMode().then((next) => {
      if (!alive) return;
      setState(next);
      setChoice(next.mode);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.electronAPI.assistantStack.setWebSearchMode(choice);
      const next = await window.electronAPI.assistantStack.getWebSearchMode();
      setState(next);
      setChoice(next.mode);
      setNotice(
        result.success
          ? { tone: 'ok', text: 'Saved. Hermes uses the new setting.' }
          : { tone: 'warn', text: result.error ?? 'Couldn’t save the setting.' }
      );
    } catch (error) {
      setNotice({ tone: 'warn', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [choice]);

  if (!state?.available) return null;

  const changed = choice !== state.mode;
  const outside = choice !== 'private';

  return (
    <>
      <h3 className="wb-agent-browser-h3">
        Web search
        <InfoTip label="web search">
          Who answers Hermes’s web searches and page reads. OpenCode, GPT Researcher and n8n always use
          your SearXNG.
        </InfoTip>
      </h3>
      <div className="wb-choices" role="radiogroup" aria-label="Web search">
        {OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={choice === option.mode}
            className={`wb-choice${choice === option.mode ? ' is-sel' : ''}`}
            disabled={busy || !state.canChange}
            onClick={() => {
              setChoice(option.mode);
              setNotice(null);
            }}
          >
            <span className="wb-radio" aria-hidden="true" />
            <span className="wb-choice-copy">
              <b>{option.title}</b>
              <span>{option.sub}</span>
            </span>
          </button>
        ))}
      </div>
      {!state.canChange ? (
        <p className="wb-settings-hint">The local stack’s .env decides this (HERMES_WEB_SEARCH_MODE).</p>
      ) : null}

      {outside ? (
        <div className="wb-agent-browser-notice is-warn" role="note" aria-label="What leaves this computer">
          <p>
            Outside services are the free tiers of Exa, Parallel, Firecrawl and Keenable, used without an
            account. In this mode, search queries and page addresses from your chats go to them from your
            internet address. Addresses on your own network, or that look like they hold a key or token,
            are never sent.
          </p>
          {choice === 'private-first' ? (
            <p>
              A query goes out only when SearXNG is unavailable: its engines are blocked, it times out, or
              the search gate is busy.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.overrides.length > 0 ? (
        <p className="wb-agent-browser-notice is-warn" role="status">
          {state.overrides.map((file) => `hermes/${file}`).join(', ')} in the data folder{' '}
          {state.overrides.length === 1 ? 'sets' : 'set'} HERMES_WEB_SEARCH_MODE, which Hermes uses
          instead of this setting. Remove that line to use the choice here.
        </p>
      ) : null}

      {state.canChange ? (
        <div className="wb-agent-browser-actions">
          <button
            type="button"
            className="wb-inference-btn"
            disabled={busy || !changed}
            onClick={() => void save()}
          >
            {busy ? 'Restarting Hermes…' : 'Save and restart Hermes'}
          </button>
          {changed ? <p className="wb-settings-hint">Chats pause while Hermes restarts.</p> : null}
        </div>
      ) : null}

      {notice ? (
        <p className={`wb-agent-browser-notice is-${notice.tone}`} role="status">
          {notice.text}
        </p>
      ) : null}
    </>
  );
};
