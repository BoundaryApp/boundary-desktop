import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { MAX_REACTIONS_PER_MESSAGE, QUICK_REACTIONS } from '../../../../shared/circleReactions';
import type { CircleMessage, CircleReaction } from '../../../../shared/types/circles';
import { Icon } from '../MessageActions';
import { useOwnerDocument } from '../../../components/ui/ownerDocument';

/** "You", "You and Maya", "You, Maya and Sam". */
function joined(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The pill's people, the user first as main orders them. A reactor who is still a member shows
 * under the name in the thread's member list, since the name in the reaction record is the
 * reactor's own claim. Only a reactor who has left shows the stored name, tagged `(left)`.
 */
function people(reaction: CircleReaction, memberName: (identity: string) => string | undefined, withLeft: boolean): string {
  return joined(
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
    <div className="wb-react-pills" role="group" aria-label="Reactions">
      {message.reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={`wb-react-pill${reaction.mine ? ' is-mine' : ''}`}
          aria-pressed={reaction.mine}
          data-guide-anchor="circle-reactions"
          aria-label={`${reaction.emoji} ${reaction.count}, ${people(reaction, memberName, false)}`}
          data-tip={people(reaction, memberName, true)}
          aria-disabled={readOnly || undefined}
          tabIndex={readOnly ? -1 : undefined}
          onClick={readOnly ? undefined : () => onToggle(reaction.emoji, !reaction.mine)}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="wb-react-count" aria-hidden="true">
            {reaction.count}
          </span>
        </button>
      ))}
    </div>
  );
};

const EmojiPickerSheet = lazy(() => import('./EmojiPickerSheet'));

/** The full picker. Its code and emoji data load on first use; nothing renders until they arrive. */
export const MoreEmojiSheet: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = (props) => (
  <Suspense fallback={null}>
    <EmojiPickerSheet {...props} />
  </Suspense>
);

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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const doc = useOwnerDocument();
  const mine = new Set(message.reactions.filter((reaction) => reaction.mine).map((reaction) => reaction.emoji));
  const full = mine.size >= MAX_REACTIONS_PER_MESSAGE;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const away = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    doc.addEventListener('mousedown', away);
    return () => doc.removeEventListener('mousedown', away);
  }, [open, doc]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(true);
      return;
    }
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    const at = items.indexOf(doc.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  };

  return (
    <span className="wb-react-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="wb-act"
        aria-label="React"
        data-tip="React"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <ReactIcon />
      </button>
      {open ? (
        <div ref={menuRef} className="wb-react-pop" role="menu" aria-label="React" onKeyDown={onKeyDown}>
          <div className="wb-react-picks">
            {QUICK_REACTIONS.map((emoji) => {
              const has = mine.has(emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  role="menuitemcheckbox"
                  className="wb-react-pick"
                  aria-checked={has}
                  disabled={full && !has}
                  onClick={() => {
                    onPick(emoji, !has);
                    close(true);
                  }}
                >
                  {emoji}
                </button>
              );
            })}
            {onMore ? (
              <button
                type="button"
                role="menuitem"
                className="wb-react-pick"
                aria-label="More emoji"
                disabled={full}
                onClick={() => {
                  close(false);
                  onMore();
                }}
              >
                +
              </button>
            ) : null}
          </div>
          {full ? <p className="wb-react-full">You’ve used {MAX_REACTIONS_PER_MESSAGE} reactions on this message</p> : null}
        </div>
      ) : null}
    </span>
  );
};
