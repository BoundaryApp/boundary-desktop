import React, { useEffect, useState } from 'react';
import type { CircleNotifyGlobal } from '../../../shared/types/circles';
import { SettingsRow, SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/switch';

const api = () => window.electronAPI.circles;

/** Device-wide switches for Circle chat notifications. Each Circle's level is in its Circle tab. */
export const NotificationsSettingsSection: React.FC = () => {
  const [global, setGlobal] = useState<CircleNotifyGlobal | null>(null);

  useEffect(() => {
    let live = true;
    // The switches are device-wide; main answers them for any key, so none is needed here.
    void api()
      .notifyPrefs({ key: '' })
      .then((next) => {
        if (live) setGlobal(next.global);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!global) return null;
  const change = (next: CircleNotifyGlobal) => {
    setGlobal(next);
    void api().setNotifyGlobal(next);
  };
  return (
    <SettingsSection id="settings-notifications" title="Notifications">
      <SettingsRow
        label="Circle notifications"
        hint="Show a notification for Circle messages, following each Circle's setting."
      >
        <Switch label="Circle notifications" checked={global.enabled} onChange={(enabled) => change({ ...global, enabled })} />
      </SettingsRow>
      <SettingsRow
        label="Show message text in notifications"
        hint="macOS keeps notifications in Notification Center and may show them on the lock screen."
      >
        <Switch label="Show message text in notifications" checked={global.showText} onChange={(showText) => change({ ...global, showText })} />
      </SettingsRow>
    </SettingsSection>
  );
};
