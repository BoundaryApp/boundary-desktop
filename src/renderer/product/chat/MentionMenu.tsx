import React from 'react';
import { Listbox, ListboxGroup, ListboxOption } from '../../components/ui/listbox';
import { Avatar } from '../circles/CircleControls';
import { AgentMark } from './ConversationMark';
import type { MentionItem } from './useMentionMenu';

/**
 * The @ list above the composer: people (Circle channels), agents, then files, with one active
 * row across all three. The composer keeps focus and names this list and its active row
 * (`listId`, `optionId`); `useMentionMenu` owns the keys.
 */
export const MentionMenu: React.FC<{
  listId: string;
  optionId: (index: number) => string;
  items: MentionItem[];
  index: number;
  onPick: (item: MentionItem) => void;
}> = ({ listId, optionId, items, index, onPick }) => {
  const peopleItems = items.filter((i) => i.kind === 'person' || i.kind === 'channel');
  const agentItems = items.filter((i) => i.kind === 'agent');
  const fileItems = items.filter((i) => i.kind === 'file');
  const option = (item: MentionItem, at: number, key: string, body: Omit<React.ComponentProps<typeof ListboxOption>, 'id' | 'onPick'>) => (
    <ListboxOption
      key={key}
      id={optionId(at)}
      active={index === at}
      selected={index === at}
      onPick={() => onPick(item)}
      {...body}
    />
  );
  return (
    <div className="wb-mentions" onMouseDown={(event) => event.preventDefault()}>
    <Listbox id={listId} className="wb-list-inset" aria-label="Mention">
      {peopleItems.length > 0 ? (
        <ListboxGroup label="People">
          {peopleItems.map((item, i) =>
            option(item, i, item.kind === 'person' ? `person:${item.identity}` : 'channel', {
              icon:
                item.kind === 'person' ? (
                  <Avatar name={item.display} seed={item.identity} dot={item.online ? 'bg-ok' : 'bg-warn'} />
                ) : (
                  <span className="wb-circle-avatar">#</span>
                ),
              hint: item.meta,
              children: item.display,
            })
          )}
        </ListboxGroup>
      ) : null}
      {agentItems.length > 0 ? (
        <ListboxGroup label="Agents">
          {agentItems.map((item, n) =>
            option(item, peopleItems.length + n, `agent:${item.agentSlug}`, {
              icon: (
                <AgentMark agent={{ slug: item.agentSlug, displayName: item.display, builtIn: item.builtIn }} />
              ),
              description: item.meta || undefined,
              children: item.display,
            })
          )}
        </ListboxGroup>
      ) : null}
      {fileItems.length > 0 ? (
        <ListboxGroup label="Files">
          {fileItems.map((item, i) =>
            option(item, peopleItems.length + agentItems.length + i, `file:${item.text}`, {
              title: item.display ?? item.text,
              hint: item.meta || undefined,
              children: <span className="mono">{item.display ?? item.text}</span>,
            })
          )}
        </ListboxGroup>
      ) : null}
    </Listbox>
    </div>
  );
};
