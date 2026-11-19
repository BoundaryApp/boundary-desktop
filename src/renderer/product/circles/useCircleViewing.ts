import { useEffect } from 'react';
import { useOwnerDocument } from '../../components/ui/ownerDocument';
import { openCircle, requestMessageFocus } from './circlesNavigation';
import { reportViewing, type ViewingSurface } from './circleViewingRegistry';
import { useCirclesState } from './useCircles';

/**
 * Tells main which Circle channel `surface` shows and whether its window has focus, so main stays
 * silent for it (through `reportViewing`, which picks between the window and the desktop panel).
 * `channel` is null while something else fills the centre. Reports again on every change and on
 * focus and blur; `null` on unmount.
 */
export function useCircleViewing(circleKey: string, channel: string | null, surface: ViewingSurface = 'window'): void {
  const doc = useOwnerDocument();
  useEffect(() => {
    // No channel on screen (a shared folder is shown): nothing to report, and main has been sent null.
    if (channel === null) return;
    const send = () => {
      reportViewing(surface, { circleKey, channel, focused: doc.hasFocus() });
    };
    const win = doc.defaultView ?? window;
    send();
    win.addEventListener('focus', send);
    win.addEventListener('blur', send);
    return () => {
      win.removeEventListener('focus', send);
      win.removeEventListener('blur', send);
      reportViewing(surface, null);
    };
  }, [circleKey, channel, doc, surface]);
}

/**
 * Opens the Circle, channel and message a clicked notification names. A Circle this device no
 * longer has is ignored.
 */
export function useCircleNotificationClicks(): void {
  const { snapshot } = useCirclesState();
  useEffect(() => {
    return window.electronAPI.circles.onOpenMessage((target) => {
      if (!snapshot.circles.some((circle) => circle.key === target.circleKey)) return;
      requestMessageFocus(target);
      openCircle(target.circleKey, target.channel);
    });
  }, [snapshot]);
}
