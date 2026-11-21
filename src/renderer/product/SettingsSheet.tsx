import React from 'react';
import { Sheet } from '../components/ui/sheet';
import { useInferenceStatus } from '../onboarding/inferenceStatus';
import { appCloudProvider } from './cloudInferenceCopy';
import { SETTINGS_PANELS } from './settingsPanels';
import { settingsTabInfo, type OpenSettingsRequest, type SettingsPanelTab } from './settingsNavigation';

interface SettingsSheetProps {
  request: OpenSettingsRequest & { tab: SettingsPanelTab };
  onClose: () => void;
}

/** A Settings panel over the current screen, which stays mounted behind it. */
export const SettingsSheet: React.FC<SettingsSheetProps> = ({ request, onClose }) => {
  const { tab } = request;
  const { status } = useInferenceStatus();
  const { label, titled } = settingsTabInfo(tab);

  return (
    <Sheet
      open
      variant="side"
      onClose={onClose}
      label={label}
      title={titled ? undefined : label}
      className="wb-reading"
    >
      {SETTINGS_PANELS[tab]({ request, cloudProvider: appCloudProvider(status), onClose })}
    </Sheet>
  );
};
