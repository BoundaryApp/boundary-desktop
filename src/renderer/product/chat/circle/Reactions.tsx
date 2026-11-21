import React, { Suspense, lazy, useState } from 'react';
import { MAX_REACTIONS_PER_MESSAGE, QUICK_REACTIONS } from '../../../../shared/circleReactions';
import type { CircleMessage, CircleReaction } from '../../../../shared/types/circles';
import { Icon } from '../MessageActions';
import { Chip } from '../../../components/ui/chip';
import { ChipGroup } from '../../../components/ui/chip-group';
import { Button } from '../../../components/ui/button';
import { joinNames } from '../../../../shared/utils/format';
import { Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuNote, MenuTrigger } from '../../../components/ui/menu';

/**
 * The pill's people, the user first as main orders them. A reactor who is still a member shows
 * under the name in the thread's member list, since the name in the reaction record is the
 * reactor's own claim. Only a reactor who has left shows the stored name, tagged `(left)`.
 */
function people(reaction: CircleReaction, memberName: (identity: string) => string | undefined, withLeft: boolean): string {
  return joinNames(
    reaction.people.map((person, index) => {
      if (reaction.mine && index === 0) return 'You';
      const current = memberName(person.identity);
      if (current !== undefined) return current;
      return withLeft ? `${person.name} (left)` : person.name;
    })
  );
}

/**
 * One pill per emoji used on the message, in the order main sends. Clicking adds or takes back the
 * user's own reaction. `memberName` returns a reactor's name from the member list as it is now, or
 * undefined once they have left (main's own `left` flag can be stale in an open thread). With
 * `readOnly`, as in select mode, a click does nothing here and reaches the message line instead.
 */
export const ReactionPills: React.FC<{
  message: CircleMessage;
  onToggle: (emoji: string, on: boolean) => void;
  memberName: (identity: string) => string | undefined;
  readOnly?: boolean;
}> = ({ message, onToggle, memberName, readOnly = false }) => {
  if (message.deleted || message.reactions.length === 0) return null;
  return (
    <ChipGroup type="multiple" aria-label="Reactions" className="wb-react-pills">
      {message.reactions.map((reaction) => (
        <Chip
          key={reaction.emoji}
          pressed={reaction.mine}
          icon={<span aria-hidden="true">{reaction.emoji}</span>}
          disabled={readOnly}
          aria-label={`${reaction.emoji} ${reaction.count}, ${people(reaction, memberName, false)}`}
          data-tip={people(reaction, memberName, true)}
          data-guide-anchor="circle-reactions"
          onPressedChange={(on) => onToggle(reaction.emoji, on)}
        >
          <span className="wb-react-count">{reaction.count}</span>
        </Chip>
      ))}
    </ChipGroup>
  );
};

const EmojiPickerSheet = lazy(() => import('./EmojiPickerSheet'));

/** The full picker. Its code and emoji data load on first use; nothing renders until they arrive. */
export const MoreEmojiSheet: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = (props) => (
  <Suspense fallback={null}>
    <EmojiPickerSheet {...props} />
  </Suspense>
);

/**
 * The picks sit in a row, so Left and Right move between them as well as Radix's Up and Down.
 * Radix uses Left and Right only for submenus, which this menu has none of.
 */
function stepAcross(event: React.KeyboardEvent<HTMLDivElement>): void {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([data-disabled])'));
  const at = items.findIndex((item) => item === event.currentTarget.ownerDocument.activeElement);
  items[(at + step + items.length) % items.length]?.focus();
}

const ReactIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M5.8 9.6a2.6 2.6 0 0 0 4.4 0M6 6.6h.01M10 6.6h.01" />
  </Icon>
);

/**
 * The toolbar's **React** button and its popover of quick picks. Picking an emoji the user already
 * has takes it back. `onMore` adds a **+** item; leave it out where there is no picker to open.
 */
export const ReactButton: React.FC<{
  message: CircleMessage;
  onPick: (emoji: string, on: boolean) => void;
  onMore?: () => void;
}> = ({ message, onPick, onMore }) => {
  const [open, setOpen] = useState(false);
  const mine = new Set(message.reactions.filter((reaction) => reaction.mine).map((reaction) => reaction.emoji));
  const full = mine.size >= MAX_REACTIONS_PER_MESSAGE;

  return (
    <span className="wb-react-wrap">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger>
          <Button type="button" variant="quiet" size="icon-xs" aria-label="React" title="React">
            <ReactIcon />
          </Button>
        </MenuTrigger>
        <MenuContent
          aria-label="React"
          side="bottom"
          align="end"
          className="flex w-max flex-wrap"
          onKeyDown={stepAcross}
        >
          {QUICK_REACTIONS.map((emoji) => {
            const has = mine.has(emoji);
            return (
              <MenuCheckboxItem key={emoji} checked={has} disabled={full && !has} onCheckedChange={(on) => onPick(emoji, on)}>
                {emoji}
              </MenuCheckboxItem>
            );
          })}
          {onMore ? (
            <MenuItem disabled={full} onSelect={onMore}>
              <span aria-hidden="true">+</span>
              <span className="sr-only">More emoji</span>
            </MenuItem>
          ) : null}
          {full ? <MenuNote className="basis-full">You’ve used {MAX_REACTIONS_PER_MESSAGE} reactions on this message</MenuNote> : null}
        </MenuContent>
      </Menu>
    </span>
  );
};
