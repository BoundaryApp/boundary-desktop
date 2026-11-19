import { persistDebugLog } from '../../persistDebugLog';
import { sendEvent } from '../../ipc';
import { showWindowNotification } from '../notifications';
import type { CirclesResult, CirclesSnapshot, CircleChannel } from '../../../shared/types/circles';
import { getNotifyGlobal, getNotifyPrefs } from './circlesStore';
import type { CircleNotifierDeps } from './circleNotifier';

interface Sources {
  snapshot: () => CirclesSnapshot;
  listChannels: (circleKey: string) => Promise<CirclesResult<{ channels: CircleChannel[] }>>;
}

/**
 * Connects the notifier to the Circles service and the OS: Circle facts from the current snapshot
 * and channel list, preferences from the store, notices through `showWindowNotification`. A click
 * brings the window forward and tells the renderer which message to open.
 */
export function circleNotifierDeps({ snapshot, listChannels }: Sources): CircleNotifierDeps {
  return {
    identity: () => snapshot().identity,
    describe: async (circleKey) => {
      const circle = snapshot().circles.find((candidate) => candidate.key === circleKey);
      if (!circle) return null;
      const channelNames: Record<string, string> = {};
      try {
        const result = await listChannels(circleKey);
        if (result.success) for (const channel of result.channels) channelNames[channel.id] = channel.name;
      } catch {
        // Labels fall back to channel ids.
      }
      return { name: circle.name, people: circle.members.length, channelNames };
    },
    prefs: getNotifyPrefs,
    global: getNotifyGlobal,
    show: (notice) => {
      try {
        showWindowNotification(notice, (win) => sendEvent(win.webContents, 'circles:open-message', notice.open));
      } catch {
        // One failing notification must not lose the rest of the batch.
        persistDebugLog('circles', 'circle-notify', { error: 'show failed' });
      }
    },
    log: (data) => persistDebugLog('circles', 'circle-notify', data),
  };
}
