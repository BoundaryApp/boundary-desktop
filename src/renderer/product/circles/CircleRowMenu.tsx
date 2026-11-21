import { MoreHorizontal } from 'lucide-react';
import React from 'react';
import type { CircleNotifyLevel, CircleSnapshot } from '../../../shared/types/circles';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from '../../components/ui/menu';
import { Button } from '../../components/ui/button';
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
 * tab's own setting, read and saved the same way, in a submenu.
 */
export const CircleRowMenu: React.FC<CircleRowMenuProps> = ({ circle, open, onOpenChange, onAction }) => {
  const { state, save } = useCircleNotifyPrefs(circle, open);
  const pick = (action: CircleAction) => () => {
    onOpenChange(false);
    onAction(action);
  };
  const setLevel = (value: string) => {
    const level: CircleNotifyLevel | undefined = NOTIFY_LEVELS.find((item) => item.value === value)?.value;
    if (!state || !level) return;
    onOpenChange(false);
    if (level !== state.prefs.level) save({ ...state.prefs, level });
  };
  const current = state ? NOTIFY_LEVELS.find((item) => item.value === state.prefs.level)?.label : null;
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger>
        <Button type="button" variant="quiet" size="icon-xs" className="wb-circles-row-more" aria-label={`More for ${circle.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </MenuTrigger>
      <MenuContent aria-label={circle.name} side="bottom" align="end">
        {circle.myRole === 'admin' ? (
          <MenuItem disabled={!circle.writable} onSelect={pick('invite')}>
            Invite someone…
          </MenuItem>
        ) : null}
        <MenuItem onSelect={pick('details')}>Circle details</MenuItem>
        <MenuSub>
          <MenuSubTrigger hint={current ?? undefined}>Notifications</MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup value={state?.prefs.level ?? ''} onValueChange={setLevel}>
              {NOTIFY_LEVELS.map((item) => (
                <MenuRadioItem key={item.value} value={item.value} disabled={!state}>
                  {item.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuItem variant="danger" disabled={!circle.writable} onSelect={pick('leave')}>
          {isAlone(circle) ? 'Delete Circle…' : 'Leave…'}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
};
