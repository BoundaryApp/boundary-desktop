import { MoreHorizontal } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { CircleNotifyLevel, CircleSnapshot } from '../../../shared/types/circles';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { isAlone } from './CircleConfirmSheet';
import { NOTIFY_LEVELS, useCircleNotifyPrefs } from './CircleNotifySection';
import type { CircleAction } from './circlesNavigation';

export interface CircleRowMenuProps {
  circle: CircleSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the Circle, then its sheet or tab for the action. */
  onAction: (action: CircleAction) => void;
}

/**
 * A Circle row's ⋯ menu (Circles screen spec decision 20). Each item opens what the Circle tab
 * already has for it, so managing a Circle stays in the tab. The notification level is the
 * tab's own setting, read and saved the same way.
 */
export const CircleRowMenu: React.FC<CircleRowMenuProps> = ({ circle, open, onOpenChange, onAction }) => {
  const [levelsOpen, setLevelsOpen] = useState(false);
  const { state, save } = useCircleNotifyPrefs(circle, open);
  useEffect(() => {
    if (!open) setLevelsOpen(false);
  }, [open]);
  const pick = (action: CircleAction) => () => {
    onOpenChange(false);
    onAction(action);
  };
  const setLevel = (level: CircleNotifyLevel) => {
    if (!state) return;
    onOpenChange(false);
    if (level !== state.prefs.level) save({ ...state.prefs, level });
  };
  const current = state ? NOTIFY_LEVELS.find((item) => item.value === state.prefs.level)?.label : null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger>
        <button
          type="button"
          className="wb-circles-more"
          aria-label={`More for ${circle.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="wb-menu wb-circles-row-menu" role="menu" aria-label={circle.name} side="bottom" align="end">
        {circle.myRole === 'admin' ? (
          <button type="button" role="menuitem" disabled={!circle.writable} onClick={pick('invite')}>
            Invite someone…
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={pick('details')}>
          Circle details
        </button>
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={levelsOpen}
          onClick={() => setLevelsOpen((was) => !was)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') setLevelsOpen(true);
            else if (event.key === 'ArrowLeft') setLevelsOpen(false);
          }}
        >
          Notifications
          {current ? <small>{current}</small> : null}
        </button>
        {levelsOpen ? (
          <div className="wb-circles-row-levels" role="menu" aria-label="Notifications">
            {NOTIFY_LEVELS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={state?.prefs.level === item.value}
                disabled={!state}
                onClick={() => setLevel(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" role="menuitem" className="is-danger" disabled={!circle.writable} onClick={pick('leave')}>
          {isAlone(circle) ? 'Delete Circle…' : 'Leave…'}
        </button>
      </PopoverContent>
    </Popover>
  );
};
