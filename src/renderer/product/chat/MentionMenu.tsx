import React from 'react';
import { AgentMark } from './ConversationMark';
import type { MentionItem } from './useMentionMenu';

/** The @ list above the composer: agents, then files, with one active row across both. */
export const MentionMenu: React.FC<{
  items: MentionItem[];
  index: number;
  onPick: (item: MentionItem) => void;
}> = ({ items, index, onPick }) => {
  const agentItems = items.filter((i) => i.kind === 'agent');
  const fileItems = items.filter((i) => i.kind === 'file');
  return (
    <div className="wb-mentions" role="listbox" aria-label="Mention">
      {agentItems.length > 0 ? <div className="wb-mention-head">Agents</div> : null}
      {agentItems.map((item, i) => (
        <button
          key={`agent:${item.agentSlug}`}
          type="button"
          role="option"
          aria-selected={index === i}
          className={index === i ? 'is-active' : undefined}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
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
        </button>
      ))}
      {fileItems.length > 0 ? <div className="wb-mention-head">Files</div> : null}
      {fileItems.map((item, i) => {
        const globalIndex = agentItems.length + i;
        return (
          <button
            key={`file:${item.text}`}
            type="button"
            role="option"
            aria-selected={index === globalIndex}
            className={index === globalIndex ? 'is-active' : undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
          >
            <span className="mono" title={item.display ?? item.text}>
              {item.display ?? item.text}
            </span>
            {item.meta ? <span className="meta">{item.meta}</span> : null}
          </button>
        );
      })}
    </div>
  );
};
