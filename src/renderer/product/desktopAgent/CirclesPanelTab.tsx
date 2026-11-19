import React, { useMemo } from 'react';
import type { CircleChannel, CircleSnapshot } from '../../../shared/types/circles';
import { APP_NAME } from '../../../shared/buildIdentity';
import { CircleThread } from '../chat/circle/CircleThread';
import { DirectThread } from '../chat/circle/DirectThread';
import { CircleRowContent, CirclesProblem, circleRowUnread } from '../circles/CirclesDock';
import { circleChannel, directPeer, directSlot, rememberChannel, useCirclesOpen } from '../circles/circlesNavigation';
import { useCircleChannels, useCircleChat } from '../circles/useCircleChat';
import { useCircleViewing } from '../circles/useCircleViewing';
import { useCirclesState } from '../circles/useCircles';
import { useDirectChat, useDirectConversations, useDirectUnread } from '../circles/useDirectChat';
import { openSettings } from '../settingsNavigation';
import { dispatchAppCommand } from '../useAppShortcuts';
import { leavePanelForWindow, setPanelCircle, usePanelCircle } from './desktopPanel';
import '../chat/circle/circleChat.css';

/** General exists before the channels have been read. */
const GENERAL: CircleChannel = { id: 'general', name: 'General', unread: 0, mentioned: false };

const byName = (a: CircleSnapshot, b: CircleSnapshot): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * One Circle in the panel: a picker of its channels and direct messages, and the compact thread.
 * The channel or conversation chosen here is the one the Circles screen opens next in this Circle
 * (ADR 0058 §13); the screen's own open Circle stays as it was.
 */
const PanelCircle: React.FC<{ circle: CircleSnapshot; channels: CircleChannel[] | undefined }> = ({ circle, channels: read }) => {
  const channels = read?.length ? read : [GENERAL];
  const slot = circleChannel(useCirclesOpen(), circle.key);
  const conversations = useDirectConversations(circle.key) ?? [];
  const asked = directPeer(slot);
  const member = asked ? circle.members.find((item) => item.identity === asked && !item.isMe) : undefined;
  const conversation = asked ? conversations.find((item) => item.peer === asked) : undefined;
  const peer = member || conversation ? asked : null;
  const channel = channels.find((item) => item.id === slot) ?? channels[0];
  const chat = useCircleChat(circle.key, channel.id);
  const direct = useDirectChat(circle.key, peer ?? '');
  useCircleViewing(circle.key, peer ? directSlot(peer) : channel.id, 'panel');

  return (
    <div className="wb-panel-circle">
      <div className="wb-agent-panel-bar">
        <button type="button" className="wb-act" aria-label="All Circles" title="All Circles" onClick={() => setPanelCircle(null)}>
          ‹
        </button>
        <select
          className="wb-agent-panel-picker"
          aria-label="Conversation"
          value={peer ? directSlot(peer) : channel.id}
          onChange={(event) => rememberChannel(circle.key, event.target.value)}
        >
          <optgroup label="Channels">
            {channels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.unread && item.id !== channel.id ? `${item.name} (${item.unread})` : item.name}
              </option>
            ))}
          </optgroup>
          {conversations.length ? (
            <optgroup label="Direct messages">
              {conversations.map((item) => (
                <option key={item.peer} value={directSlot(item.peer)}>
                  {item.unread && item.peer !== peer ? `${item.name} (${item.unread})` : item.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
      <div className="wb-agent-panel-thread">
        {peer ? (
          <DirectThread
            key={`${circle.key}/${peer}`}
            circle={circle}
            peer={peer}
            name={conversation?.name || member?.name || ''}
            ended={conversation?.ended ?? !member}
            chat={direct}
          />
        ) : (
          <CircleThread compact circle={circle} channel={channel} chat={chat} />
        )}
      </div>
    </div>
  );
};

/**
 * The desktop panel's Circles tab (ADR 0058 §8): every Circle as the dock lists it, and one
 * Circle's channels and direct messages. Starting, joining, inviting and the Circle tab stay in
 * Boundary's window, which ⤢ opens.
 */
export const CirclesPanelTab: React.FC = () => {
  const state = useCirclesState();
  const circles = useMemo(() => (state.status === 'running' ? [...state.snapshot.circles].sort(byName) : []), [state]);
  const keys = useMemo(() => circles.map((circle) => circle.key), [circles]);
  const channels = useCircleChannels(keys);
  const directUnread = useDirectUnread(keys);
  const openKey = usePanelCircle();
  const open = circles.find((circle) => circle.key === openKey) ?? null;
  const problem = state.status === 'failed' ? (state.error ?? 'Unknown error.') : null;

  if (open) return <PanelCircle key={open.key} circle={open} channels={channels[open.key]} />;

  return (
    <div className="wb-panel-circles">
      {problem ? (
        <CirclesProblem
          problem={problem}
          onOpenProfile={() => {
            openSettings({ tab: 'general' });
            leavePanelForWindow();
          }}
        />
      ) : null}
      {circles.length ? (
        <div className="wb-circles-dock-rows" role="group" aria-label="Circle list">
          {circles.map((circle) => {
            const { shown, mention, label } = circleRowUnread(circle, channels[circle.key], directUnread[circle.key], false);
            return (
              <button
                key={circle.key}
                type="button"
                className={`wb-row has-mark wb-circles-row${shown ? ' is-unread' : ''}`}
                aria-label={label}
                onClick={() => setPanelCircle(circle.key)}
              >
                <CircleRowContent circle={circle} shown={shown} mention={mention} />
              </button>
            );
          })}
        </div>
      ) : state.status === 'running' ? (
        <p className="wb-hint">
          You’re in no Circle yet.{' '}
          <button
            type="button"
            className="wb-circles-link"
            onClick={() => {
              dispatchAppCommand('go-circles');
              leavePanelForWindow();
            }}
          >
            Start or join one in {APP_NAME}’s window
          </button>
        </p>
      ) : null}
    </div>
  );
};
