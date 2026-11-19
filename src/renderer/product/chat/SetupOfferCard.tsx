import React from 'react';
import { CalendarDays } from 'lucide-react';
import { openSettings } from '../settingsNavigation';
import { Button } from '../../components/ui/button';

/** Scene 1 of docs/calendar-ux-study/click-through.html, under the reply that called offer_setup. */
export const SetupOfferCard: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => (
  <div className="wb-draft-card wb-setup-card" role="group" aria-label="Connect a calendar">
    <span className="wb-setup-icon" aria-hidden="true">
      <CalendarDays size={17} />
    </span>
    <div>
      <h3>Connect a calendar</h3>
      <p>iCloud, Fastmail, Nextcloud or any CalDAV server. You’ll need an app password from your provider.</p>
      <div className="wb-draft-actions">
        <Button
          variant="primary"
          block
          type="button"
          onClick={() => openSettings({ tab: 'calendars', connectFromChat: true })}
        >
          Connect calendar
        </Button>
        <Button variant="secondary" block type="button" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  </div>
);
