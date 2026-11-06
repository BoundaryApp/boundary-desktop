import React, { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Segmented } from '../components/ui/segmented';
import { UpdatesPanel } from './UpdatesPanel';
import { useThemePreference } from '../theme';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import { CIRCLE_MEMBER_PROVIDER } from './cloudInferenceCopy';
import { PasswordsLoginsPanel } from './PasswordsLoginsPanel';
import { CalendarsPanel } from './CalendarsPanel';
import { CodingFoldersPanel } from './CodingFoldersPanel';
import { AgentBrowserPanel } from './AgentBrowserPanel';
import { ComputerAccessPanel } from './ComputerAccessPanel';
import { SETTINGS_TABS, type SettingsTab } from './settingsNavigation';
import { rendererExperiments } from '../experiments';
import { dispatchAppCommand } from './useAppShortcuts';
import { CirclesProfileSection } from './circles/CirclesProfile';

interface ProductSettingsScreenProps {
  onBack: () => void;
  /** Open on this tab instead of General (e.g. from a chat's saved-login note). */
  initialTab?: SettingsTab;
  /** Passwords & Logins: start on this agent's logins. */
  initialAgentSlug?: string;
}

export const ProductSettingsScreen: React.FC<ProductSettingsScreenProps> = ({
  onBack,
  initialTab,
  initialAgentSlug,
}) => {
  const [themePreference, setThemePreference] = useThemePreference();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const { status } = useInferenceStatus();

  return (
    <section className="wb-inference wb-reading" aria-label="Settings">
      <button type="button" className="wb-inference-btn" onClick={onBack}>
        Back to chat
      </button>
      <h1>Settings</h1>
      <div className="wb-settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-tabpanel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === 'passwords' ? (
          <PasswordsLoginsPanel initialAgentSlug={initialAgentSlug} />
        ) : tab === 'calendars' ? (
          <CalendarsPanel
            cloudProvider={
              status?.appDefault === 'openrouter' ? 'OpenRouter' : status?.appSharedModel ? CIRCLE_MEMBER_PROVIDER : null
            }
          />
        ) : tab === 'coding' ? (
          <CodingFoldersPanel />
        ) : tab === 'browser' ? (
          <AgentBrowserPanel />
        ) : tab === 'access' ? (
          <ComputerAccessPanel />
        ) : tab === 'updates' ? (
          <UpdatesPanel />
        ) : (
          <>

          <section className="wb-settings-section" aria-labelledby="settings-appearance">
            <h2 id="settings-appearance">Appearance</h2>
            <div className="wb-settings-row">
              <div>
                <p className="wb-settings-label">Theme</p>
              </div>
              <Segmented
                aria-label="Theme"
                value={themePreference}
                onChange={setThemePreference}
                options={[
                  { value: 'system', label: 'System', icon: <Monitor aria-hidden="true" /> },
                  { value: 'light', label: 'Light', icon: <Sun aria-hidden="true" /> },
                  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden="true" /> },
                ]}
              />
            </div>
          </section>

          {rendererExperiments.map(({ SettingsSection }, index) =>
            SettingsSection ? <SettingsSection key={index} /> : null
          )}

          <section className="wb-settings-section" aria-labelledby="settings-models">
            <h2 id="settings-models">Models</h2>
            <div className="wb-settings-row">
              <div>
                <p className="wb-settings-label">Connections, order and fallbacks</p>
                <p className="wb-settings-hint">In Inference, with what your Circles share.</p>
              </div>
              <button type="button" className="wb-inference-btn" onClick={() => dispatchAppCommand('go-inference')}>
                Open Inference
              </button>
            </div>
          </section>

          <CirclesProfileSection />
          </>
        )}
      </div>
    </section>
  );
};
