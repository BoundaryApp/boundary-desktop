/**
 * Calls with one person, mounted in the app shell: the ring card on any screen, **Call** from a
 * person, and the call bar moving between destinations. The other Mac is played by emitting
 * `circles:call` events through the fake `circles.onCall`.
 */
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CIRCLE_KEY as KEY, ME, circleMember, circleSnapshot, runningCircles } from '../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductReadyShell } from '../ProductReadyShell';
import type { ProductDestination } from '../ProductIconRail';
import { getCallService, resetCallServiceForTests } from '../circles/calls/callService';
import { closeCallView } from '../circles/calls/callViewState';
import { installCallFakes, type CallFakes } from '../circles/calls/__tests__/callFakes';
import { openCircle, openDirect, resetCirclesOpenForTests } from '../circles/circlesNavigation';
import type { ChatRailProps } from '../chat/ChatRail';

vi.mock('../circles/calls/audioLevel', () => ({ watchLevel: vi.fn((): (() => void) => () => undefined) }));
vi.mock('../chat/ProjectPicker', () => ({ ProjectPicker: (): null => null }));
vi.mock('../chat/HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../ProductSettingsScreen', () => ({ ProductSettingsScreen: () => <div>settings-screen</div> }));

// The chat screen's own rail, with nothing in it: the call bar is what these tests look for.
vi.mock('../chat/WorkbenchChatScreen', async () => {
  const { ChatRail } = await import('../chat/ChatRail');
  const none = (): void => undefined;
  const props: ChatRailProps = {
    projects: [],
    activeProjectId: null,
    connecting: false,
    onSelectProject: none,
    onClearProject: none,
    onNewProject: none,
    onCreateEmptyProject: none,
    centerMode: 'conversation',
    onOpenTask: none,
    onOpenTasks: none,
    mentionsUnseen: 0,
    onOpenMentions: none,
    onOpenAllChats: none,
    onOpenProjectPage: none,
    agents: [],
    activeThreadId: null,
    sameChat: () => false,
    loadingThreads: false,
    hermesChats: [],
    onOpenThread: none,
    onNewHermesChat: none,
    channels: [],
    onOpenChannel: none,
    onNewChannel: none,
    personalities: [],
    standingDmByAgent: {},
    onOpenDm: none,
    onMessageAgent: none,
    onNewAgent: none,
    onOpenRoster: none,
    error: null,
  };
  return { WorkbenchChatScreen: () => <ChatRail {...props} /> };
});

const SAM = 'dd'.repeat(32);
const MAYA = 'bb'.repeat(32);
const LEE = 'ab'.repeat(32);
/** Sorts below this user's identity. */
const ZED = '0f'.repeat(32);
const ROOM = 'person/0123456789abcdef';

const circle = circleSnapshot({
  name: 'Book club',
  members: [
    circleMember({ identity: ME, name: 'Ada', isMe: true }),
    circleMember({ identity: SAM, name: 'Sam' }),
    circleMember({ identity: MAYA, name: 'Maya', online: false }),
    circleMember({ identity: LEE, name: 'Lee' }),
    circleMember({ identity: ZED, name: 'Zed' }),
  ],
});
const running = runningCircles({ circles: [circle] });

class FakePeerConnection extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  addTransceiver(kind: string) {
    return { kind, mid: '0', sender: { replaceTrack: async (): Promise<void> => undefined } };
  }
  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }
  close() {}
}

let fakes: CallFakes;

const App: React.FC<{ start: ProductDestination }> = ({ start }) => {
  const [view, setView] = useState<ProductDestination>(start);
  return <ProductReadyShell view={view} onNavigate={setView} />;
};

/** Let the fakes' promises settle; none of them waits on a timer. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function mount(start: ProductDestination) {
  render(<App start={start} />);
  await settle();
}

/** Sam's Mac rings this user. */
function ringFromSam(t: 'ring' | 'cancel' = 'ring') {
  act(() => fakes.deliver({ circleKey: KEY, from: SAM, device: 'ee'.repeat(32), topic: 'call.ring', ring: { t, room: ROOM } }));
}

const rings = (t: string) => fakes.sent.filter((sent) => (sent as { ring?: { t: string } }).ring?.t === t);
const card = () => screen.queryByRole('alertdialog', { name: 'Incoming call' });
const callBars = () => screen.queryAllByRole('region', { name: 'Call' });

async function joinInSheet(title: string) {
  const sheet = screen.getByRole('dialog', { name: title });
  await settle();
  fireEvent.click(within(sheet).getByRole('button', { name: 'Join' }));
  await settle();
}

async function openPeople() {
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Open Circle details' }));
}

describe('calls with one person in the app', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    window.localStorage.clear();
    resetCallServiceForTests();
    resetCirclesOpenForTests();
    closeCallView();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    fakes = installCallFakes({ state: running });
    stubElectronAPI({
      circles: {
        chatChannels: async () => ({ success: true, state: running, channels: [{ id: 'general', name: 'General', unread: 0, mentioned: false }] }),
        chatMessages: async () => ({ success: true, state: running, messages: [] as unknown[], more: false }),
        chatRead: async () => ({ success: true, state: running }),
        dmList: async () => ({ success: true, state: running, conversations: [] as unknown[] }),
        dmMessages: async () => ({ success: true, state: running, messages: [] as unknown[], more: false }),
        dmRead: async () => ({ success: true, state: running }),
        dmTyping: async (): Promise<void> => undefined,
      },
      media: { getAccess: async () => ({ microphone: 'granted', camera: 'granted' }) },
    });
  });

  afterEach(() => {
    resetCallServiceForTests();
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a ring shows on the Settings screen, and Join opens the sheet, joins the caller's room and opens the call view", async () => {
    await mount('settings');
    expect(screen.getByText('settings-screen')).toBeTruthy();
    ringFromSam();
    const ringCard = card()!;
    expect(within(ringCard).getByText('Sam is calling')).toBeTruthy();
    expect(within(ringCard).getByText('Book club · just you two')).toBeTruthy();

    fireEvent.click(within(ringCard).getByRole('button', { name: 'Join' }));
    expect(rings('answering')).toEqual([{ key: KEY, topic: 'call.ring', to: SAM, ring: { t: 'answering', room: ROOM } }]);
    expect(card()).toBeNull();
    await joinInSheet('Call Sam');

    expect(getCallService().current).toMatchObject({ circleKey: KEY, room: ROOM, with: SAM });
    expect(fakes.sent).toContainEqual(expect.objectContaining({ key: KEY, topic: 'call.state', state: expect.objectContaining({ room: ROOM }) }));
    expect(screen.queryByRole('dialog', { name: 'Call Sam' })).toBeNull();
    // Joining goes to the call view, in the Circles screen, with the bar in its rail.
    expect(screen.queryByText('settings-screen')).toBeNull();
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
    expect(callBars()).toHaveLength(1);
    expect(callBars()[0].className).not.toContain('is-floating');
  });

  it('the join sheet closes and no call starts when the caller hangs up first', async () => {
    await mount('settings');
    ringFromSam();
    fireEvent.click(within(card()!).getByRole('button', { name: 'Join' }));
    expect(screen.getByRole('dialog', { name: 'Call Sam' })).toBeTruthy();
    ringFromSam('cancel');
    expect(screen.queryByRole('dialog', { name: 'Call Sam' })).toBeNull();
    await settle();
    expect(getCallService().current).toBeNull();
    expect(callBars()).toHaveLength(0);
  });

  it('cancelling the join sheet declines the ring', async () => {
    await mount('settings');
    ringFromSam();
    fireEvent.click(within(card()!).getByRole('button', { name: 'Join' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Call Sam' })).getByRole('button', { name: 'Cancel' }));
    expect(rings('decline')).toEqual([{ key: KEY, topic: 'call.ring', to: SAM, ring: { t: 'decline', room: ROOM } }]);
    expect(screen.queryByRole('dialog', { name: 'Call Sam' })).toBeNull();
    expect(getCallService().current).toBeNull();
  });

  it('Decline sends decline and the card goes', async () => {
    await mount('resources');
    ringFromSam();
    fireEvent.click(within(card()!).getByRole('button', { name: 'Decline' }));
    expect(rings('decline')).toEqual([{ key: KEY, topic: 'call.ring', to: SAM, ring: { t: 'decline', room: ROOM } }]);
    expect(card()).toBeNull();
    // Sam's next repeat, already on its way, doesn't bring it back.
    ringFromSam();
    expect(card()).toBeNull();
  });

  it('the card goes 30 seconds after the ring started', async () => {
    await mount('settings');
    ringFromSam();
    // Sam's Mac repeats the ring every 5 seconds while it rings.
    for (let at = 5_000; at < 30_000; at += 5_000) {
      act(() => void vi.advanceTimersByTime(5_000));
      ringFromSam();
    }
    act(() => void vi.advanceTimersByTime(4_999));
    expect(card()).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(card()).toBeNull();
  });

  it('calling from the person panel shows Calling Sam… and No answer after 30 seconds, and Try again rings again', async () => {
    openCircle(KEY);
    await mount('circles');
    await openPeople();
    fireEvent.click(screen.getByRole('button', { name: /^Sam/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Call Sam' }));
    await joinInSheet('Call Sam');

    const rail = screen.getByRole('complementary', { name: 'Circles' });
    expect(within(rail).getByText('Calling Sam…')).toBeTruthy();
    expect(rings('ring')).toEqual([{ key: KEY, topic: 'call.ring', to: SAM, ring: { t: 'ring', room: expect.stringMatching(/^person\//) } }]);
    // Placing the call opens the call view.
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();

    act(() => void vi.advanceTimersByTime(30_000));
    expect(within(rail).getByText('No answer')).toBeTruthy();
    expect(getCallService().current).toBeNull();
    expect(screen.queryByRole('region', { name: 'Sam' })).toBeNull();

    const before = rings('ring').length;
    fireEvent.click(within(rail).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(rings('ring').length).toBe(before + 1);
    expect(within(rail).getByText('Calling Sam…')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
  });

  it('calling from the Settings screen goes to the call view in Circles', async () => {
    await mount('settings');
    act(() => openDirect(KEY, SAM));
    await settle();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Call Sam' }));
    await joinInSheet('Call Sam');
    expect(getCallService().current).toMatchObject({ with: SAM });
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
  });

  it('when both press Call at once, the call view stays open as this side joins the other room', async () => {
    openCircle(KEY);
    await mount('circles');
    await openPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Call Zed' }));
    await joinInSheet('Call Zed');
    expect(screen.getByRole('region', { name: 'Zed' })).toBeTruthy();
    const mine = getCallService().current!.room;
    // This user's identity sorts above Zed's, so this side leaves its room and joins Zed's.
    act(() => fakes.deliver({ circleKey: KEY, from: ZED, device: 'ee'.repeat(32), topic: 'call.ring', ring: { t: 'ring', room: ROOM } }));
    await settle();
    expect(mine).not.toBe(ROOM);
    expect(getCallService().current).toMatchObject({ room: ROOM, with: ZED });
    expect(screen.getByRole('region', { name: 'Zed' })).toBeTruthy();
  });

  it('tells main about each ring once it changes, with the words for its notification', async () => {
    await mount('settings');
    expect(fakes.ringAlerts.at(-1)).toEqual([]);
    ringFromSam();
    await settle();
    expect(fakes.ringAlerts.at(-1)).toEqual([{ room: ROOM, title: 'Sam is calling', body: 'Book club · just you two' }]);
    const sent = fakes.ringAlerts.length;
    // Repeats of the same ring send nothing new.
    act(() => void vi.advanceTimersByTime(5_000));
    ringFromSam();
    await settle();
    expect(fakes.ringAlerts).toHaveLength(sent);
    ringFromSam('cancel');
    await settle();
    expect(fakes.ringAlerts.at(-1)).toEqual([]);
  });

  it('Answer on the notification opens the join sheet like Join, and the ring leaves main', async () => {
    await mount('settings');
    ringFromSam();
    await settle();
    act(() => fakes.ringAction({ room: ROOM, action: 'answer' }));
    await settle();
    expect(rings('answering')).toHaveLength(1);
    expect(card()).toBeNull();
    expect(fakes.ringAlerts.at(-1)).toEqual([]);
    await joinInSheet('Call Sam');
    expect(getCallService().current).toMatchObject({ room: ROOM, with: SAM });
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
  });

  it('Answer on the notification during another call asks first', async () => {
    openCircle(KEY);
    await mount('circles');
    // Sam's ring came first: one arriving during a call is answered busy.
    ringFromSam();
    await act(async () => {
      await getCallService().call(KEY, LEE, { audio: true, video: false });
    });
    act(() => fakes.ringAction({ room: ROOM, action: 'answer' }));
    expect(screen.getByRole('dialog', { name: 'Leave the call with Lee?' })).toBeTruthy();
    expect(rings('answering')).toEqual([]);
  });

  it('Decline on the notification declines, and an action for a ring that ended does nothing', async () => {
    await mount('settings');
    ringFromSam();
    act(() => fakes.ringAction({ room: ROOM, action: 'decline' }));
    expect(rings('decline')).toEqual([{ key: KEY, topic: 'call.ring', to: SAM, ring: { t: 'decline', room: ROOM } }]);
    expect(card()).toBeNull();
    act(() => fakes.ringAction({ room: ROOM, action: 'answer' }));
    expect(rings('answering')).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Call Sam' })).toBeNull();
  });

  it('plays the ring sound while main says to, and stops it when told or when the shell goes', async () => {
    const sources: Array<{ loop: boolean; started: number; stopped: number }> = [];
    class FakeAudioContext {
      destination = {};
      createBuffer = () => ({ copyToChannel: (): void => undefined });
      createBufferSource = () => {
        const source = { buffer: null as unknown, loop: false, started: 0, stopped: 0, connect: (): void => undefined, start() { this.started++; }, stop() { this.stopped++; } };
        sources.push(source);
        return source;
      };
      close = async (): Promise<void> => undefined;
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    await mount('settings');
    ringFromSam();
    act(() => fakes.ringSound(true));
    act(() => fakes.ringSound(true));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ loop: true, started: 1, stopped: 0 });
    act(() => fakes.ringSound(false));
    expect(sources[0].stopped).toBe(1);
    act(() => fakes.ringSound(true));
    expect(sources).toHaveLength(2);
    cleanup();
    expect(sources[1].stopped).toBe(1);
  });

  it('the call bar stays while moving between Chat, Circles and Settings, and Leave ends the call', async () => {
    openCircle(KEY);
    await mount('circles');
    await act(async () => {
      await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    const inRail = () => within(screen.getByRole('complementary', { name: 'Circles' })).getByRole('region', { name: 'Call' });
    expect(within(inRail()).getByText('Sam')).toBeTruthy();
    expect(callBars()).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Chat'));
    await settle();
    expect(callBars()).toHaveLength(1);
    expect(callBars()[0].closest('.wb-left')).not.toBeNull();
    expect(callBars()[0].className).not.toContain('is-floating');

    fireEvent.click(screen.getByLabelText('Settings'));
    await settle();
    expect(callBars()).toHaveLength(1);
    expect(callBars()[0].className).toContain('is-floating');

    fireEvent.click(screen.getByLabelText('Circles'));
    await settle();
    expect(inRail()).toBeTruthy();
    fireEvent.click(within(inRail()).getByRole('button', { name: 'Leave' }));
    expect(getCallService().current).toBeNull();
    expect(callBars()).toHaveLength(0);
    expect(rings('cancel')).toHaveLength(1);
  });

  it('Call shows only for online people other than you', async () => {
    openCircle(KEY);
    await mount('circles');
    await openPeople();
    expect(screen.getByRole('button', { name: 'Call Sam' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Call Maya' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Call (Ada|You)$/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Maya/ }));
    expect(screen.queryByRole('button', { name: /^Call/ })).toBeNull();

    act(() => openDirect(KEY, MAYA));
    await settle();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: /^Call/ })).toBeNull();
    act(() => openDirect(KEY, SAM));
    await settle();
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Call Sam' }));
    expect(screen.getByRole('dialog', { name: 'Call Sam' })).toBeTruthy();
  });

  it('the call view closes when the call ends, so the next call opens in the bar', async () => {
    openCircle(KEY);
    await mount('circles');
    await act(async () => {
      await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    fireEvent.click(within(callBars()[0]).getByRole('button', { name: /Sam/ }));
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    fireEvent.click(within(screen.getByRole('region', { name: 'Sam' })).getByRole('button', { name: 'Leave' }));
    expect(screen.queryByRole('region', { name: 'Sam' })).toBeNull();

    await act(async () => {
      await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    expect(screen.queryByRole('region', { name: 'Sam' })).toBeNull();
    expect(callBars()).toHaveLength(1);
  });

  it('choosing a Circle or a conversation closes the call view', async () => {
    openCircle(KEY);
    await mount('circles');
    await act(async () => {
      await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    fireEvent.click(within(callBars()[0]).getByRole('button', { name: /Sam/ }));
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();

    fireEvent.click(within(screen.getByRole('group', { name: 'Circle list' })).getByRole('button', { name: /^Book club/ }));
    await settle();
    expect(screen.queryByRole('region', { name: 'Sam' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Circle details' })).toBeTruthy();
    expect(getCallService().current).not.toBeNull();

    fireEvent.click(within(callBars()[0]).getByRole('button', { name: /Sam/ }));
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
    act(() => openDirect(KEY, LEE));
    await settle();
    expect(screen.queryByRole('region', { name: 'Sam' })).toBeNull();
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'Call Lee' })).toBeTruthy();
  });

  it("Call is hidden for the person you're in a call with", async () => {
    openCircle(KEY);
    await mount('circles');
    await act(async () => {
      await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    act(() => openDirect(KEY, SAM));
    await settle();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Call Sam' })).toBeNull();
    await openPeople();
    expect(screen.queryByRole('button', { name: 'Call Sam' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Call Lee' })).toBeTruthy();
    const details = screen.getByRole('complementary', { name: 'Circle details' });
    fireEvent.click(within(details).getByRole('button', { name: /^Sam/ }));
    expect(screen.getByRole('complementary', { name: 'Sam' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Call Sam/ })).toBeNull();
  });

  it('calling someone else during a call asks first, and Cancel keeps the call', async () => {
    openCircle(KEY);
    await mount('circles');
    let call = null as unknown;
    await act(async () => {
      call = await getCallService().call(KEY, SAM, { audio: true, video: false });
    });
    await openPeople();
    fireEvent.click(screen.getByRole('button', { name: 'Call Lee' }));
    const ask = screen.getByRole('dialog', { name: 'Leave the call with Sam?' });
    expect(screen.queryByRole('dialog', { name: 'Call Lee' })).toBeNull();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Leave the call with Sam?' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Call Lee' })).toBeNull();
    expect(getCallService().current).toBe(call);

    fireEvent.click(screen.getByRole('button', { name: 'Call Lee' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Leave the call with Sam?' })).getByRole('button', { name: 'Leave and call' }));
    await joinInSheet('Call Lee');
    expect(getCallService().current).toMatchObject({ with: LEE });
  });

  it('Join on a second ring during a call asks first', async () => {
    openCircle(KEY);
    await mount('circles');
    ringFromSam();
    let call = null as unknown;
    await act(async () => {
      call = await getCallService().call(KEY, LEE, { audio: true, video: false });
    });
    fireEvent.click(within(card()!).getByRole('button', { name: 'Join' }));
    const ask = screen.getByRole('dialog', { name: 'Leave the call with Lee?' });
    expect(rings('answering')).toEqual([]);
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(getCallService().current).toBe(call);
    expect(card()).not.toBeNull();

    fireEvent.click(within(card()!).getByRole('button', { name: 'Join' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Leave the call with Lee?' })).getByRole('button', { name: 'Leave and join' }));
    expect(rings('answering')).toHaveLength(1);
    await joinInSheet('Call Sam');
    expect(getCallService().current).toMatchObject({ room: ROOM, with: SAM });
  });
});
