import { BrowserWindow, Notification } from 'electron';

/** Held until closed: an unreferenced Notification can be collected before macOS shows it. */
const liveNotifications = new Set<Notification>();
const RETAIN_MS = 10 * 60_000;

/**
 * A notification that this module holds a reference to until it closes or ten minutes pass.
 * `release` drops the reference early.
 */
export function heldNotification(options: { title: string; body: string }): {
  notification: Notification;
  release: () => void;
} {
  const notification = new Notification(options);
  liveNotifications.add(notification);
  const release = () => {
    liveNotifications.delete(notification);
  };
  notification.once('close', release);
  setTimeout(release, RETAIN_MS).unref();
  return { notification, release };
}

/**
 * Shows a notification when the system supports them. A click brings the first open window
 * forward and passes it to `onClick`.
 */
export function showWindowNotification(
  notice: { title: string; body: string },
  onClick?: (win: BrowserWindow) => void
): void {
  if (!Notification.isSupported()) return;
  const { notification, release } = heldNotification({ title: notice.title, body: notice.body });
  notification.once('click', () => {
    release();
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    onClick?.(win);
  });
  notification.show();
}
