import React from 'react';
import { Avatar } from '../circles/CircleControls';
import { AgentMark } from './ConversationMark';
import type { MentionItem } from './useMentionMenu';

const Option: React.FC<{
  active: boolean;
  className?: string;
  onPick: () => void;
  children: React.ReactNode;
}> = ({ active, className, onPick, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={active}
    className={[className, active ? 'is-active' : ''].filter(Boolean).join(' ') || undefined}
    onMouseDown={(event) => {
      event.preventDefault();
      onPick();
    }}
  >
    {children}
  </button>
);

/** The @ list above the composer: people (Circle channels), agents, then files, with one active row across both. */
export const MentionMenu: React.FC<{
  items: MentionItem[];
  index: number;
  onPick: (item: MentionItem) => void;
}> = ({ items, index, onPick }) => {
  const peopleItems = items.filter((i) => i.kind === 'person' || i.kind === 'channel');
  const agentItems = items.filter((i) => i.kind === 'agent');
  const fileItems = items.filter((i) => i.kind === 'file');
  return (
    <div className="wb-mentions" role="listbox" aria-label="Mention">
      {peopleItems.length > 0 ? <div className="wb-mention-head">People</div> : null}
      {peopleItems.map((item, i) => (
        <Option
          key={item.kind === 'person' ? `person:${item.identity}` : 'channel'}
          active={index === i}
          className="is-person"
          onPick={() => onPick(item)}
        >
          {item.kind === 'person' ? (
            <Avatar name={item.display} seed={item.identity} dot={item.online ? 'bg-ok' : 'bg-warn'} label={item.meta} />
          ) : (
            <span className="wb-circle-avatar" aria-hidden>
              #
            </span>
          )}
          <span>{item.display}</span>
          <span className="meta">{item.meta}</span>
        </Option>
      ))}
      {agentItems.length > 0 ? <div className="wb-mention-head">Agents</div> : null}
      {agentItems.map((item, n) => {
        const globalIndex = peopleItems.length + n;
        return (
          <Option
            key={`agent:${item.agentSlug}`}
            active={index === globalIndex}
            onPick={() => onPick(item)}
          >
            <AgentMark
              agent={{ slug: item.agentSlug, displayName: item.display, builtIn: item.builtIn }}
            />
            <span>
              {item.display}
              {item.meta ? (
                <>
                  <br />
                  <span className="meta">{item.meta}</span>
                </>
              ) : null}
            </span>
          </Option>
        );
      })}
      {fileItems.length > 0 ? <div className="wb-mention-head">Files</div> : null}
      {fileItems.map((item, i) => {
        const globalIndex = peopleItems.length + agentItems.length + i;
        return (
          <Option
            key={`file:${item.text}`}
            active={index === globalIndex}
            onPick={() => onPick(item)}
          >
            <span className="mono" title={item.display ?? item.text}>
              {item.display ?? item.text}
            </span>
            {item.meta ? <span className="meta">{item.meta}</span> : null}
          </Option>
        );
      })}
    </div>
  );
};
