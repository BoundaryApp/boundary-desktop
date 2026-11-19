import React, { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Segmented } from '../components/ui/segmented';
import { useThemePreference } from '../theme';
import { useReplyText } from '../replyText';
import { describeReplyText } from '../../shared/replyText';
import { SettingsRow, SettingsSection } from '../components/settings/SettingsSection';
import { useBusySendPref } from './chat/busySendPref';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import { appCloudProvider } from './cloudInferenceCopy';
import { SETTINGS_PANELS } from './settingsPanels';
import { SETTINGS_TABS, isSettingsPanelTab, type SettingsTab } from './settingsNavigation';
import { rendererExperiments } from '../experiments';
import { dispatchAppCommand } from './useAppShortcuts';
import { CirclesProfileSection } from './circles/CirclesProfile';
import { NotificationsSettingsSection } from './circles/NotificationsSettingsSection';
import { AssistantRestartSection } from './AssistantRestartSection';
import { useDesktopAgentSwitch } from './desktopAgent/useDesktopAgentSwitch';
import { PanelShortcutField } from './desktopAgent/PanelShortcutField';
import { APP_NAME } from '../../shared/buildIdentity';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

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
  const [replyText] = useReplyText();
  const [busySend, setBusySend] = useBusySendPref();
  const desktopAgent = useDesktopAgentSwitch();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const { status } = useInferenceStatus();

  return (
    <section className="wb-inference wb-reading" aria-label="Settings">
      <Button variant="secondary" type="button" onClick={onBack}>
        Back to chat
      </Button>
      <h1>Settings</h1>
      <div className="wb-settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            data-guide-anchor={`settings-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-tabpanel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {isSettingsPanelTab(tab) ? (
          SETTINGS_PANELS[tab]({
            request: { tab, agentSlug: initialAgentSlug },
            cloudProvider: appCloudProvider(status),
          })
        ) : (
          <>

          <SettingsSection id="settings-appearance" title="Appearance">
            <SettingsRow label="Theme">
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
            </SettingsRow>
            <SettingsRow label="Reply text" hint={describeReplyText(replyText)}>
              <Button variant="secondary" type="button" onClick={() => setTab('reply-text')}>
                Adjust
              </Button>
            </SettingsRow>
          </SettingsSection>

          <SettingsSection id="settings-chat" title="Chat">
            <SettingsRow
              label="When you send while an agent is replying"
              hint={
                busySend === 'queue'
                  ? 'Enter queues your message until the reply finishes. ⌘↵ stops the reply and sends now.'
                  : 'Enter asks whether to send now, queue it or keep editing.'
              }
            >
              <Segmented
                aria-label="When you send while an agent is replying"
                value={busySend}
                onChange={setBusySend}
                options={[
                  { value: 'ask', label: 'Ask each time' },
                  { value: 'queue', label: 'Always queue' },
                ]}
              />
            </SettingsRow>
            {desktopAgent.available ? (
              <SettingsRow
                label="Keep the agent button on the desktop"
                hint="The agent's button floats over every app, and closing this window hides it instead of closing it."
              >
                <Switch
                  checked={desktopAgent.on}
                  label="Keep the agent button on the desktop"
                  onChange={(next) => void window.electronAPI.desktopAgent.set(next)}
                />
              </SettingsRow>
            ) : null}
            {desktopAgent.available && desktopAgent.on ? (
              <SettingsRow label="Show the agent button" hint="Hide button in the button's menu hides it until this is on again.">
                <Switch
                  checked={!desktopAgent.hidden}
                  label="Show the agent button"
                  onChange={(show) => void window.electronAPI.desktopAgent.setHidden(!show)}
                />
              </SettingsRow>
            ) : null}
            {desktopAgent.available && desktopAgent.on ? (
              <SettingsRow
                label="Shortcut from any app"
                hint={`Opens and closes the agent's panel while you work in another app. ⌘J works only inside ${APP_NAME}.`}
              >
                <PanelShortcutField shortcut={desktopAgent.shortcut} />
              </SettingsRow>
            ) : null}
          </SettingsSection>

          <NotificationsSettingsSection />

          {rendererExperiments.map(({ SettingsSection }, index) =>
            SettingsSection ? <SettingsSection key={index} /> : null
          )}

          <SettingsSection id="settings-models" title="Models">
            <SettingsRow label="Connections, order and fallbacks" hint="In Inference, with what your Circles share.">
              <Button variant="secondary" type="button" onClick={() => dispatchAppCommand('go-inference')}>
                Open Inference
              </Button>
            </SettingsRow>
          </SettingsSection>

          <AssistantRestartSection />

          <CirclesProfileSection />
          </>
        )}
      </div>
    </section>
  );
};
