import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CircleChannel, CircleSnapshot, CirclesState } from '../../../../shared/types/circles';
import type { SharedFolderListing } from '../../../../shared/types/sharedFolders';
import { CircleConfirmSheet, leaveConfirm, type CircleConfirm } from '../../circles/CircleConfirmSheet';
import { directPeer, directSlot, openCircleAction, openDirect, takeCircleAction, useCircleActionVersion } from '../../circles/circlesNavigation';
import { InviteSheet, useInviteHints } from '../../circles/InviteSheet';
import { useCallCheck } from '../../circles/useCallCheck';
import { getCallService } from '../../circles/calls/callService';
import { useCallWith } from '../../circles/calls/LeaveCallSheet';
import { useCallEntry } from '../../circles/calls/useCallEntry';
import { onNotifyPrefs, useCircleChat } from '../../circles/useCircleChat';
import { useCircleViewing } from '../../circles/useCircleViewing';
import { useScrollToTopOn } from '../../circles/useScrollToTopOn';
import { useDirectChat, useDirectConversations } from '../../circles/useDirectChat';
import { CircleAreaHeader } from '../../circles/CircleAreaHeader';
import { Avatar } from '../../circles/CircleControls';
import { AtMark } from './AtMark';
import { CallCheckSheet } from './CallCheckSheet';
import { ChannelSheets, type ChannelSheet } from './ChannelSheets';
import { CircleThread } from './CircleThread';
import { CirclesMark } from './CirclesMark';
import { CircleTab, OnlineDot } from './CircleTab';
import { DirectThread } from './DirectThread';
import { AddSharedFolderSheet } from './AddSharedFolderSheet';
import { FileHistory, ResolveConflictSheet } from './FolderHistory';
import { FolderTab, RemoveSharedFolderSheet } from './FolderTab';
import { FolderMark, FolderView, SharedFolderIcon } from './FolderView';
import { ShareFolderSheet } from './ShareFolderSheet';
import { folderState } from './sharedFolderView';
import { useSharedFolders } from './useSharedFolders';
import { Button } from '../../../components/ui/button';
import './circleChat.css';
import './sharedFolders.css';

/** Whether @channel counts as a mention of the user in this Circle; read again when the preference is saved. */
function useChannelMentions(key: string): boolean {
  // On until read: the stored default is on.
  const [on, setOn] = useState(true);
  useEffect(() => {
    let live = true;
    setOn(true);
    const read = (): void => {
      void Promise.resolve()
        .then(() => window.electronAPI.circles.notifyPrefs({ key }))
        .then((next) => {
          if (live) setOn(next.prefs.channelMentions);
        })
        .catch((): void => undefined);
    };
    read();
    const off = onNotifyPrefs((circleKey) => {
      if (circleKey === key) read();
    });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return on;
}

/** General exists before the channels have been read. */
const GENERAL: CircleChannel = { id: 'general', name: 'General', unread: 0, mentioned: false };

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M10 2.5v11" />
    </svg>
  );
}

/** A rail section's + button. */
const SectionAdd: React.FC<{ label: string; disabled?: boolean; onClick: () => void }> = ({ label, disabled, onClick }) => (
  <Button type="button" variant="quiet" size="icon-sm" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.75v8.5M2.75 7h8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  </Button>
);

export interface CirclePlaceProps {
  circle: CircleSnapshot;
  /** All of Circles' state, for invite names. */
  circles: CirclesState;
  /** The Circle's channels with unread counts; General alone until they are read. */
  channels: CircleChannel[] | undefined;
  channelId: string;
  onOpenChannel: (channelId: string) => void;
  /**
   * Where this Circle's area (its header and sections) is drawn: an element inside the rail the
   * screen owns, so the rail stays mounted as Circles change. Null until the rail has mounted it.
   */
  areaSlot: HTMLElement | null;
  /** Opens a project on This Mac, after a shared folder was added as one. */
  onOpenProject?: (projectId: string) => void;
}

/** What the screen says after a folder was added: its name, and the project it became. */
interface AddedToast {
  name: string;
  projectId: string | null;
}

/**
 * One Circle on the Circles destination (ADR 0052 §4): its area (header, channels, direct messages
 * and folders) in the rail's slot, the open channel or folder, and the Circle tab. Nothing from
 * This Mac shows here.
 */
export const CirclePlace: React.FC<CirclePlaceProps> = ({
  circle,
  circles,
  channels: read,
  channelId,
  onOpenChannel,
  areaSlot,
  onOpenProject,
}) => {
  const channels = read?.length ? read : [GENERAL];
  const channel = channels.find((item) => item.id === channelId) ?? channels[0];
  const chat = useCircleChat(circle.key, channel.id);
  // A direct conversation is remembered in the channel's place (ADR 0054 §5).
  const listed = useDirectConversations(circle.key);
  const conversations = listed ?? [];
  const asked = directPeer(channelId);
  const askedMember = asked ? circle.members.find((item) => item.identity === asked && !item.isMe) : undefined;
  const askedConversation = asked ? conversations.find((item) => item.peer === asked) : undefined;
  // Someone who left still has a conversation to read; anyone else unknown falls back to the channel.
  const peer = askedMember || askedConversation ? asked : null;
  const peerName = askedConversation?.name || askedMember?.name || '';
  const peerEnded = askedConversation?.ended ?? !askedMember;
  const direct = useDirectChat(circle.key, peer ?? '');
  // Someone who left is known only from the list; until it is read, show neither them nor a channel.
  const directPending = Boolean(asked) && !askedMember && listed === null;
  const channelMentions = useChannelMentions(circle.key);
  // Closed until asked for, as in the study; choosing a person opens it.
  const [inspector, setInspector] = useState(false);
  /** The open side panel's id, for the toggles' aria-controls. */
  const inspectorId = useId();
  const [person, setPerson] = useState<string | null>(null);
  const [channelSheet, setChannelSheet] = useState<ChannelSheet | null>(null);
  const callCheck = useCallCheck();
  const [callCheckOpen, setCallCheckOpen] = useState(false);
  // Calling during a call asks before leaving it; nobody is offered a call with the person already in this one.
  const callWith = useCallWith();
  const { enter: askToCall, sheets: callSheets } = useCallEntry<string>({
    then: 'call',
    title: (identity) => `Call ${circle.members.find((item) => item.identity === identity)?.name ?? ''}`,
    // A call nobody answers ends the view and shows in the bar.
    join: (identity, options) => getCallService().call(circle.key, identity, options),
  });
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<CircleConfirm | null>(null);
  const shared = useSharedFolders(circle.key);
  // A selected folder replaces the channel in the center (shared folders spec, decision 2).
  const [folderKey, setFolderKey] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [adding, setAdding] = useState<SharedFolderListing | null>(null);
  const [removing, setRemoving] = useState<SharedFolderListing | null>(null);
  const [added, setAdded] = useState<AddedToast | null>(null);
  // The file whose history the inspector shows, and the conflict copy being resolved.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const folder = folderKey ? (shared.folders?.find((item) => item.key === folderKey) ?? null) : null;
  // A folder in the centre means the channel is not on screen, so main may notify for it.
  // An open DM is reported in the channel's place, so main stays silent for it (ADR 0054 §10).
  useCircleViewing(circle.key, folder || directPending ? null : peer ? directSlot(peer) : channel.id);
  useEffect(() => {
    setFolderKey(null);
    setAdded(null);
  }, [circle.key]);
  // Select mode is for the channel it was started in.
  const [selecting, setSelecting] = useState(false);
  const stopSelecting = useCallback((): void => setSelecting(false), []);
  useEffect(() => setSelecting(false), [circle.key, channel.id, folderKey]);
  useEffect(() => {
    setFilePath(null);
    setResolving(null);
  }, [folderKey]);
  const openFile = (path: string): void => {
    setFilePath(path);
    setInspector(true);
  };
  const openChannel = (channelId: string): void => {
    setFolderKey(null);
    onOpenChannel(channelId);
  };
  const openConversation = (identity: string): void => {
    setFolderKey(null);
    openDirect(circle.key, identity);
  };
  // The open conversation is listed even before its first message.
  const directRows =
    peer && !conversations.some((item) => item.peer === peer)
      ? [{ peer, name: peerName, online: Boolean(askedMember?.online), ended: peerEnded, waiting: 0, unread: 0 }, ...conversations]
      : conversations;
  const hints = useInviteHints(circle.myRole === 'admin' ? circle.key : undefined, circles.inviteCodeIds);
  // Choosing a person, from the tab or a who-line, opens the inspector at them.
  const showPerson = useCallback((identity: string): void => {
    setInspector(true);
    setPerson(identity);
  }, []);

  // A Circle row's menu asks for a sheet or the tab, maybe before this Circle was open, so the
  // request waits until this Circle shows and is taken once.
  const actionVersion = useCircleActionVersion();
  useEffect(() => {
    const action = takeCircleAction(circle.key);
    if (action === 'details') {
      setFolderKey(null);
      setPerson(null);
      setInspector(true);
    } else if (action === 'invite') {
      if (circle.myRole === 'admin' && circle.writable) setInviting(true);
    } else if (action === 'leave') {
      setConfirm(leaveConfirm(circle));
    }
    // Only a new request or another Circle is a reason to look again.
  }, [circle.key, actionVersion]);

  // The sections scroll on their own, and a Circle opens with its first channel where it always is.
  const sectionsRef = useRef<HTMLDivElement>(null);
  useScrollToTopOn(sectionsRef, `${circle.key}:${areaSlot ? 'slot' : 'none'}`);

  const sections = (
    <>
      <div className="wb-sect is-sub">
        <span className="wb-sect-name">Channels</span>
        {circle.myRole === 'admin' ? (
          <SectionAdd label="Add a channel" onClick={() => setChannelSheet({ kind: 'add' })} />
        ) : null}
      </div>
      {channels.map((item) => {
        // The open channel is being read, so its count isn't shown; a folder or DM in its place isn't reading it.
        const unread = !folder && !peer && !directPending && item.id === channel.id ? 0 : item.unread;
        const mentioned = unread > 0 && item.mentioned;
        return (
          <button
            key={item.id}
            type="button"
            className={`wb-row has-mark${!folder && !peer && !directPending && item.id === channel.id ? ' is-on' : ''}`}
            aria-current={!folder && !peer && !directPending && item.id === channel.id ? 'page' : undefined}
            aria-label={unread ? `${item.name}, ${unread} unread${mentioned ? ', mentions you' : ''}` : item.name}
            data-guide-anchor={mentioned ? 'circle-mention' : undefined}
            onClick={() => openChannel(item.id)}
          >
            <CirclesMark size={14} />
            <span className="wb-row-title">{item.name}</span>
            {unread ? (
              <span className={`wb-rail-count${mentioned ? ' has-mention' : ''}`}>
                {mentioned ? <AtMark /> : null}
                {unread}
              </span>
            ) : null}
          </button>
        );
      })}
      {directRows.length ? (
        <>
          <div className="wb-sect is-sub">
            <span className="wb-sect-name">Direct messages</span>
          </div>
          {directRows.map((item) => {
            const on = !folder && item.peer === peer;
            // The open conversation is being read, so its count isn't shown.
            const unread = on ? 0 : item.unread;
            return (
              <button
                key={item.peer}
                type="button"
                className={`wb-row has-mark wb-direct-row${on ? ' is-on' : ''}`}
                aria-current={on ? 'page' : undefined}
                aria-label={`${item.name}, direct message, ${item.ended ? 'left' : item.waiting ? `${item.waiting} waiting` : item.online ? 'online' : 'away'}${unread ? `, ${unread} unread` : ''}`}
                data-guide-anchor="circle-direct"
                onClick={() => openConversation(item.peer)}
              >
                <Avatar name={item.name} seed={item.peer} />
                <span className="wb-row-title">{item.name}</span>
                {unread ? <span className="wb-rail-count">{unread}</span> : null}
                {item.ended ? (
                  <span className="wb-direct-row-note">Left</span>
                ) : item.waiting ? (
                  <span className="wb-direct-row-note">{item.waiting} waiting</span>
                ) : (
                  <OnlineDot online={item.online} />
                )}
              </button>
            );
          })}
        </>
      ) : null}
      <div className="wb-sect is-sub">
        <span className="wb-sect-name">Folders</span>
        {shared.folders?.length ? (
          <SectionAdd label="Share a folder" disabled={!circle.writable} onClick={() => setSharing(true)} />
        ) : null}
      </div>
      {shared.folders && shared.folders.length === 0 ? (
        <button type="button" className="wb-row has-mark wb-folder-share-row" disabled={!circle.writable} onClick={() => setSharing(true)}>
          <SharedFolderIcon size={14} />
          <span className="wb-row-title">Share a folder…</span>
        </button>
      ) : null}
      {(shared.folders ?? []).map((item) => (
        <button
          key={item.key}
          type="button"
          className={`wb-row has-mark${item.key === folderKey ? ' is-on' : ''}`}
          aria-current={item.key === folderKey ? 'page' : undefined}
          onClick={() => setFolderKey(item.key)}
        >
          <SharedFolderIcon size={14} />
          <span className="wb-row-title">{item.name}</span>
          <FolderMark state={folderState(item, circle)} />
        </button>
      ))}
      {shared.error ? <p className="wb-folder-rail-error">{shared.error}</p> : null}
    </>
  );

  return (
    <>
      {areaSlot
        ? createPortal(
            <>
              <CircleAreaHeader circle={circle} onAction={(action) => openCircleAction(circle.key, action)} />
              <div
                ref={sectionsRef}
                className="wb-circle-area-sections"
                role="group"
                aria-label={`${circle.name} channels, direct messages and folders`}
              >
                {sections}
              </div>
            </>,
            areaSlot
          )
        : null}

      <main className="wb-center">
        {folder ? (
          <FolderView
            folder={folder}
            circle={circle}
            selectedFile={filePath}
            onAdd={() => setAdding(folder)}
            onFile={openFile}
            onResolve={setResolving}
            headerEnd={
              <Button
                type="button"
                variant="quiet"
                size="icon-xs"
                aria-label="Folder details"
                aria-expanded={inspector}
                aria-controls={inspector ? inspectorId : undefined}
                title="Folder details"
                onClick={() => setInspector((was) => !was)}
              >
                <PanelIcon />
              </Button>
            }
          />
        ) : directPending ? null : peer ? (
          <DirectThread
            key={`${circle.key}/${peer}`}
            circle={circle}
            peer={peer}
            name={peerName}
            ended={peerEnded}
            chat={direct}
            headerEnd={
              <>
                {askedMember?.online && askedMember.identity !== callWith ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    aria-label={`Call ${askedMember.name}`}
                    onClick={() => askToCall(askedMember.identity)}
                  >
                    Call
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  aria-label="Circle details"
                  aria-expanded={inspector}
                  aria-controls={inspector ? inspectorId : undefined}
                  title="Circle details"
                  onClick={() => setInspector((was) => !was)}
                >
                  <PanelIcon />
                </Button>
              </>
            }
          />
        ) : (
        <CircleThread
          circle={circle}
          channel={channel}
          chat={chat}
          channelMentions={channelMentions}
          onPerson={showPerson}
          selecting={selecting}
          onStopSelecting={stopSelecting}
          headerEnd={
            <Button
              type="button"
              variant="quiet"
              size="icon-xs"
              aria-label="Circle details"
              aria-expanded={inspector}
              aria-controls={inspector ? inspectorId : undefined}
              title="Circle details"
              onClick={() => setInspector((was) => !was)}
            >
              <PanelIcon />
            </Button>
          }
        />
        )}
        {added ? (
          <div className="wb-toast" role="status">
            <span>{added.name} is on this Mac. Files download while members who have them are online.</span>
            {added.projectId && onOpenProject ? (
              <button type="button" onClick={() => onOpenProject(added.projectId as string)}>
                Open project
              </button>
            ) : null}
            <button type="button" aria-label="Dismiss" onClick={() => setAdded(null)}>
              ✕
            </button>
          </div>
        ) : null}
      </main>

      {inspector && folder && filePath ? (
        <FileHistory
          id={inspectorId}
          folder={folder}
          circle={circle}
          path={filePath}
          onBack={() => setFilePath(null)}
          onClose={() => setInspector(false)}
        />
      ) : inspector && folder ? (
        <FolderTab id={inspectorId} folder={folder} circle={circle} onClose={() => setInspector(false)} onRemove={() => setRemoving(folder)} />
      ) : inspector ? (
        <CircleTab
          id={inspectorId}
          circle={circle}
          circles={circles}
          channels={channels}
          hints={hints}
          person={person}
          onPerson={setPerson}
          onClose={() => setInspector(false)}
          onInvite={() => setInviting(true)}
          onConfirm={setConfirm}
          onChannelSheet={setChannelSheet}
          onCallCheck={callCheck ? () => setCallCheckOpen(true) : undefined}
          onRemoveMessages={() => setSelecting(true)}
          onMessage={openConversation}
          onCall={askToCall}
          callWith={callWith}
        />
      ) : null}

      {callSheets}

      {callCheck ? (
        <CallCheckSheet check={callCheck} circle={circle} open={callCheckOpen} onClose={() => setCallCheckOpen(false)} />
      ) : null}

      {circle.myRole === 'admin' ? (
        <InviteSheet
          key={`invite-${circle.key}`}
          circle={circle}
          circles={circles}
          hints={hints}
          open={inviting}
          onClose={() => setInviting(false)}
        />
      ) : null}
      <CircleConfirmSheet
        key={`confirm-${circle.key}`}
        circle={circle}
        pending={confirm}
        onClose={() => setConfirm(null)}
      />

      <ShareFolderSheet
        circle={circle}
        open={sharing}
        onClose={() => setSharing(false)}
        onShared={(key) => {
          setFolderKey(key);
          void shared.reload();
        }}
      />
      <AddSharedFolderSheet
        circle={circle}
        folder={adding}
        onClose={() => setAdding(null)}
        onAdded={(projectId) => {
          if (adding) setAdded({ name: adding.name, projectId });
          void shared.reload();
        }}
      />
      {folder ? <ResolveConflictSheet folder={folder} circle={circle} copy={resolving} onClose={() => setResolving(null)} /> : null}
      <RemoveSharedFolderSheet
        circle={circle}
        folder={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => void shared.reload()}
      />

      <ChannelSheets
        circleKey={circle.key}
        circleName={circle.name}
        sheet={channelSheet}
        onClose={() => setChannelSheet(null)}
        onAdded={openChannel}
      />
    </>
  );
};
