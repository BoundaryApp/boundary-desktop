import { app, Notification, type BrowserWindow, type WebContents } from 'electron';
import { parseRingAlerts, type RingAction, type RingAlert } from '../shared/calls/ringAlert';
import { handle, sendEvent } from './ipc';
import { persistDebugLog } from './persistDebugLog';
import { heldNotification } from './services/notifications';
import { getMainWindow, showMainWindow } from './services/windows';

/** A notification on screen for one ring. */
export interface RingNotice {
  close(): void;
}

/** What alerting touches, so tests can stand in for Electron. */
export interface RingAlertDeps {
  /** Whether Boundary's window is shown, not minimized and focused. */
  inFront(): boolean;
  /** Show a ring's notification; null when the system can't. */
  notify(ring: RingAlert, on: { answer(): void; decline(): void }): RingNotice | null;
  /** Start bouncing the Dock icon until the app is active or `stopBounce`. */
  bounce(): void;
  stopBounce(): void;
  /** Tell the page to start or stop the ring sound. */
  sound(on: boolean): void;
  /** Bring the window forward, then pass the choice to the page. */
  act(action: RingAction): void;
  /** Counts and states only: no rooms or names. */
  log(event: string, data: Record<string, unknown>): void;
}

interface Tracked {
  ring: RingAlert;
  notice: RingNotice | null;
  /** A ring gets one notification, however often the window comes and goes. */
  notified: boolean;
}

/**
 * Alerts for calls ringing on this Mac while Boundary's window isn't in front. The page owns the
 * rings (`RingInbox`) and sends the whole list each time it changes; this decides what shows.
 *
 * While at least one ring is going and the window isn't in front, the page plays the ring sound
 * and the Dock bounces. Each ring gets one notification the first time it is going with the
 * window not in front. A ring's notification is withdrawn when the ring leaves the list, and
 * every notification is withdrawn when the window comes to the front, where the ring card shows.
 */
export class RingAlerts {
  private readonly rings = new Map<string, Tracked>();
  private alerting = false;

  constructor(private readonly deps: RingAlertDeps) {}

  setRings(list: RingAlert[]): void {
    const rooms = new Set(list.map((ring) => ring.room));
    for (const [room, tracked] of this.rings) {
      if (rooms.has(room)) continue;
      tracked.notice?.close();
      this.rings.delete(room);
    }
    for (const ring of list) {
      const tracked = this.rings.get(ring.room);
      if (tracked) tracked.ring = ring;
      else this.rings.set(ring.room, { ring, notice: null, notified: false });
    }
    this.update();
  }

  /** The window was shown, hidden, focused, blurred, minimized or restored. */
  windowChanged(): void {
    this.update();
  }

  private update(): void {
    const front = this.deps.inFront();
    let shown = 0;
    for (const tracked of this.rings.values()) {
      if (front) {
        tracked.notice?.close();
        tracked.notice = null;
      } else if (!tracked.notified) {
        tracked.notified = true;
        const room = tracked.ring.room;
        tracked.notice = this.deps.notify(tracked.ring, {
          answer: () => this.choose(room, 'answer'),
          decline: () => this.choose(room, 'decline'),
        });
        shown++;
      }
    }
    const alerting = !front && this.rings.size > 0;
    if (shown > 0) this.deps.log('ring notified', { rings: this.rings.size, shown });
    if (alerting === this.alerting) return;
    this.alerting = alerting;
    this.deps.sound(alerting);
    if (alerting) this.deps.bounce();
    else this.deps.stopBounce();
    this.deps.log(alerting ? 'ring alert started' : 'ring alert stopped', { rings: this.rings.size, front });
  }

  private choose(room: string, action: RingAction['action']): void {
    // The notification is gone once acted on; the page's next list drops the ring.
    const tracked = this.rings.get(room);
    if (tracked) tracked.notice = null;
    this.deps.act({ room, action });
  }
}

/**
 * Which button of a ring's notification was pressed. Electron 45 puts the index on the event and
 * still passes it second, deprecated.
 */
export function notificationChoice(event: { actionIndex?: unknown } | undefined, legacyIndex: unknown): RingAction['action'] | null {
  const index = typeof event?.actionIndex === 'number' ? event.actionIndex : legacyIndex;
  return index === 0 ? 'answer' : index === 1 ? 'decline' : null;
}

/** The page that last sent rings; alerts go back to it. */
let ringPage: WebContents | null = null;
const watchedPages = new WeakSet<WebContents>();
let alerts: RingAlerts | null = null;
let bounceId: number | null = null;

function mainWindowInFront(win: BrowserWindow | undefined): boolean {
  return !!win && win.isVisible() && !win.isMinimized() && win.isFocused();
}

const electronDeps = (): RingAlertDeps => ({
  inFront: () => mainWindowInFront(getMainWindow()),
  notify: (ring, on) => {
    if (!Notification.isSupported()) return null;
    const { notification, release } = heldNotification({
      title: ring.title,
      body: ring.body,
      // The page plays its own ring, which repeats; the notification stays quiet.
      silent: true,
      // macOS shows the buttons on alert-style notifications, and under Options on banners.
      actions: [
        { type: 'button', text: 'Answer' },
        { type: 'button', text: 'Decline' },
      ],
    });
    notification.on('action', (event, legacyIndex) => {
      release();
      const choice = notificationChoice(event, legacyIndex);
      if (choice === 'answer') on.answer();
      else if (choice === 'decline') on.decline();
    });
    // A click on the notification itself brings the window forward, where the ring card shows.
    notification.once('click', () => {
      release();
      void showMainWindow().catch((): undefined => undefined);
    });
    notification.show();
    return {
      close: () => {
        release();
        notification.close();
      },
    };
  },
  bounce: () => {
    if (process.platform !== 'darwin' || !app.dock) return;
    const id = app.dock.bounce('critical');
    bounceId = id >= 0 ? id : null;
  },
  stopBounce: () => {
    if (bounceId !== null && app.dock) app.dock.cancelBounce(bounceId);
    bounceId = null;
  },
  sound: (on) => {
    if (ringPage) sendEvent(ringPage, 'calls:ring-sound', on);
  },
  act: (action) => {
    const page = ringPage;
    if (!page) return;
    if (action.action === 'decline') {
      sendEvent(page, 'calls:ring-action', action);
      return;
    }
    void showMainWindow()
      .then(() => sendEvent(page, 'calls:ring-action', action))
      .catch(() => persistDebugLog('calls', 'ring answer could not show the window', {}));
  },
  log: (event, data) => persistDebugLog('calls', event, data),
});

function ringAlerts(): RingAlerts {
  alerts ??= new RingAlerts(electronDeps());
  return alerts;
}

/** A page that closes, crashes or loads another page can't take its rings back itself. */
function watchPage(page: WebContents): void {
  if (watchedPages.has(page)) return;
  watchedPages.add(page);
  const gone = () => {
    if (ringPage !== page) return;
    ringAlerts().setRings([]);
    ringPage = null;
  };
  page.on('destroyed', gone);
  page.on('render-process-gone', gone);
  page.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) gone();
  });
}

/** The page sends the calls ringing for this user each time they change. */
export function registerRingAlertHandlers(): void {
  handle('calls:rings', (event, input: unknown) => {
    const rings = parseRingAlerts(input);
    if (!rings) throw new Error('calls:rings takes a list of rings.');
    // Only the main window's page has the ring cards; any other page's list is ignored.
    const page = (event as { sender?: WebContents } | undefined)?.sender;
    if (!page || page !== getMainWindow()?.webContents) return;
    ringPage = page;
    watchPage(page);
    ringAlerts().setRings(rings);
  });
}

/** Re-check alerts whenever the main window's place on screen changes. */
export function watchRingWindow(win: BrowserWindow): void {
  const changed = () => alerts?.windowChanged();
  // A closed window's page is gone too, and `watchPage` clears its rings.
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) win.on(event as 'focus', changed);
}
