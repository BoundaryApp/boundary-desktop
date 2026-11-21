import React, { useCallback, useEffect, useId, useState } from 'react';
import { InfoTip } from '../components/ui/info-tip';
import type { WebSearchMode, WebSearchModeState } from '../../shared/webSearchMode';
import { Button } from '../components/ui/button';
import { ChoiceGroup } from '../components/ui/choice-group';
import { ChoiceRow } from '../components/ui/choice-row';
import { Radio } from '../components/ui/radio';
import { useBuiltinAgentName } from './settingsPanelHooks';
import { errorText } from '../lib/errorText';
import { Callout } from '../components/ui/alert';

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
  const agentName = useBuiltinAgentName();
  const groupName = useId();
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
          ? { tone: 'ok', text: `Saved. ${agentName} uses the new setting.` }
          : { tone: 'warn', text: result.error ?? 'Couldn’t save the setting.' }
      );
    } catch (error) {
      setNotice({ tone: 'warn', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }, [agentName, choice]);

  if (!state) return null;

  const changed = choice !== state.mode;
  const outside = choice !== 'private';

  return (
    <>
      <h3 className="wb-agent-browser-h3">
        Web search
        <InfoTip label="web search">
          Who answers {agentName}’s web searches and page reads. OpenCode, GPT Researcher and n8n always use
          your SearXNG.
        </InfoTip>
      </h3>
      <ChoiceGroup kind="radio" aria-label="Web search">
        {OPTIONS.map((option) => (
          <ChoiceRow
            key={option.mode}
            variant="card"
            control={
              <Radio
                name={groupName}
                checked={choice === option.mode}
                disabled={busy || !state.canChange}
                onChange={() => {
                  setChoice(option.mode);
                  setNotice(null);
                }}
              />
            }
            title={option.title}
            description={option.sub}
          />
        ))}
      </ChoiceGroup>
      {!state.canChange ? (
        <p className="wb-settings-hint">The local stack’s .env decides this (HERMES_WEB_SEARCH_MODE).</p>
      ) : null}

      {outside ? (
        <Callout variant="warn" layout="stacked" size="sm" role="note" aria-label="What leaves this computer">
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
        </Callout>
      ) : null}

      {state.overrides.length > 0 ? (
        <Callout variant="warn" size="sm" role="status">
          <p>
            {state.overrides.map((file) => `hermes/${file}`).join(', ')} in the data folder{' '}
            {state.overrides.length === 1 ? 'sets' : 'set'} HERMES_WEB_SEARCH_MODE, which Hermes uses
            instead of this setting. Remove that line to use the choice here.
          </p>
        </Callout>
      ) : null}

      {state.canChange ? (
        <div className="wb-agent-browser-actions">
          <Button
            variant="secondary"
            type="button"
            disabled={busy || !changed}
            onClick={() => void save()}
          >
            {busy ? 'Restarting Hermes…' : 'Save and restart Hermes'}
          </Button>
          {changed ? <p className="wb-settings-hint">Chats pause while Hermes restarts.</p> : null}
        </div>
      ) : null}

      {notice ? (
        <Callout variant={notice.tone} size="sm" role="status">
          <p>{notice.text}</p>
        </Callout>
      ) : null}
    </>
  );
};
