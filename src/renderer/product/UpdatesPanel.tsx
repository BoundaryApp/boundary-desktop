import React, { useEffect, useState } from 'react';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../shared/assistantStackConstants';
import type { UpdateChannel } from '../../shared/types/updates';
import { Segmented } from '../components/ui/segmented';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import { UpdateTasks, runUpdateAction, useRestartToInstall, useUpdates } from './updates';
import { describeUpdate, type UpdateDescription } from './updateModel';
import { APP_NAME } from '../../shared/buildIdentity';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';

type HeroTone = UpdateDescription['tone'];

const HERO_ICON: Record<HeroTone, React.ReactNode> = {
  ok: <path d="m4 10.5 4 4 8-9" />,
  brand: <path d="M10 3v9M6 8.5l4 4 4-4M4 16.5h12" />,
  warn: <path d="M10 4v7M10 14.5v.5" />,
};

/** The personal key a gated feed needs. The field never shows the saved key. */
const FeedKeyRow: React.FC<{ onSave: (key: string) => void }> = ({ onSave }) => {
  const [key, setKey] = useState('');
  return (
    <SettingsRow
      label="Update key"
      hint="Your key is on the page you downloaded this app from."
      stacked
      onSubmit={(event) => {
        event.preventDefault();
        onSave(key);
        setKey('');
      }}
    >
      <Input
        aria-label="Update key"
        className="min-w-0 flex-1 font-mono"
        type="password"
        autoComplete="off"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button variant="secondary" block type="submit" disabled={!key.trim()}>
        Save key
      </Button>
    </SettingsRow>
  );
};

/** Settings → Updates (docs/updates-plan.md decision 11). The first card answers "am I up to date?". */
export const UpdatesPanel: React.FC = () => {
  const state = useUpdates();
  const { restart, sheet } = useRestartToInstall();
  const api = window.electronAPI?.updates;
  const showCard = state?.showCard ?? false;

  // The page says everything the card does, so opening it closes the card.
  useEffect(() => {
    if (showCard) void api?.closeCard();
  }, [api, showCard]);

  if (!state || !api) return null;

  const description = describeUpdate(state);
  const { tone, stage } = description;
  // The page runs the card's separate lines into one hint, with the download's progress first.
  const hint = [stage === 'downloading' && description.detail ? `${description.detail}.` : null, description.body, description.note]
    .filter(Boolean)
    .join(' ');
  // Skip leads, so the step forward sits at the end of the row.
  const actions = [
    ...description.actions.filter((action) => action.id === 'skip'),
    ...description.actions.filter((action) => action.id !== 'skip'),
  ];
  const tasks = stage === 'waiting';
  const news = state.version
    ? { version: state.version, summary: state.summary }
    : state.updated;

  const status = (
    <section
      className={`wb-settings-row wb-update-hero${tone === 'warn' ? ' is-warn' : ''}${tasks ? ' has-tasks' : ''}`}
      role="status"
    >
      <span className={`wb-update-tile${tone === 'brand' ? '' : ` is-${tone}`}`}>
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {HERO_ICON[tone]}
        </svg>
      </span>
      <div className="wb-update-body">
        <h2>{description.title}</h2>
        <p className="wb-settings-hint">{hint}</p>
      </div>
      {actions.length > 0 ? (
        <div className="wb-update-row-actions">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant={action.primary ? 'primary' : 'secondary'}
              block
              type="button"
              disabled={action.disabled}
              onClick={() => runUpdateAction(action.id, restart)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      {tasks ? <UpdateTasks state={state} /> : null}
    </section>
  );

  return (
    <>
      {status}

      {news && news.summary.length > 0 ? (
        <SettingsSection id="settings-updates-new" title={`What’s new in ${news.version}`}>
          <div className="wb-settings-row">
            <ul className="wb-update-lines">
              {news.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection id="settings-updates-versions" title="Versions">
        <SettingsRow label={APP_NAME}>
          <span className="wb-update-version">{state.currentVersion}</span>
        </SettingsRow>
        <SettingsRow label="Your tools" hint={`Update with ${APP_NAME}`}>
          <span className="wb-update-version">{SOVEREIGN_AGENT_STACK_VERSION.replace(/^v/, '')}</span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="settings-updates-preferences" title="Preferences">
        {state.keyRequired ? <FeedKeyRow onSave={(key) => void api.setFeedKey(key)} /> : null}
        <SettingsRow
          label="Release channel"
          hint="Beta gets new versions first. They pass the same tests, but fewer people have used them."
        >
          <Segmented<UpdateChannel>
            aria-label="Release channel"
            value={state.channel}
            onChange={(channel) => void api.setChannel(channel)}
            options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label="Check for updates"
          hint={
            state.checksEnabled
              ? state.keyRequired
                ? `${APP_NAME} downloads one small file once a day. Your update key identifies you when it does.`
                : `${APP_NAME} downloads one small file from GitHub once a day. It sends no ID and nothing about how you use it.`
              : `${APP_NAME} doesn’t check for updates, so it can’t tell you about security fixes. Check now still checks once.`
          }
        >
          <Switch
            checked={state.checksEnabled}
            label="Check for updates"
            onChange={(next) => void api.setChecksEnabled(next)}
          />
        </SettingsRow>
      </SettingsSection>
      {sheet}
    </>
  );
};
