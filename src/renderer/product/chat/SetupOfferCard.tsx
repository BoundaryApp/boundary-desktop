import React from 'react';
import { CalendarDays } from 'lucide-react';
import { openSettings } from '../settingsNavigation';

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
        <button
          type="button"
          className="wb-btn-solid"
          onClick={() => openSettings({ tab: 'calendars', connectFromChat: true })}
        >
          Connect calendar
        </button>
        <button type="button" className="wb-btn-ghost" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  </div>
);
