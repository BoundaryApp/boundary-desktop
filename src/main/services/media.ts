import { systemPreferences, type Session } from 'electron';
import type { MediaAccess, MediaAccessStatus, MediaDevice } from '../../shared/types/media';
import { handle } from '../ipc';

/**
 * Web permissions the app's own page may use. `media` is camera and microphone through
 * getUserMedia, for calls between Circle members or any other feature that needs them.
 * `clipboard-sanitized-write` keeps the copy buttons working. Every other permission, and every
 * other page, is refused.
 */
const APP_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);

const MEDIA_TYPES = new Set(['audio', 'video']);

/**
 * Install the session's permission handlers. Only the app's own top-level page gets the
 * permissions above, and a media request must ask for audio, video or both. The OS still asks
 * the user on first use; see `requestMediaAccess`.
 */
export function installPermissionHandlers(session: Session, isAppUrl: (url: string) => boolean): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (!APP_PERMISSIONS.has(permission) || !details.isMainFrame || !isAppUrl(details.requestingUrl)) {
      callback(false);
      return;
    }
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      callback(types.length > 0 && types.every((type) => MEDIA_TYPES.has(type)));
      return;
    }
    callback(true);
  });

  session.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    return APP_PERMISSIONS.has(permission) && details.isMainFrame && isAppUrl(details.requestingUrl ?? '');
  });
}

const MEDIA_DEVICES: readonly MediaDevice[] = ['camera', 'microphone'];

function isMediaDevice(value: unknown): value is MediaDevice {
  return MEDIA_DEVICES.includes(value as MediaDevice);
}

/** Linux leaves media to the browser layer, so it has nothing to report. */
function readStatus(device: MediaDevice, platform: NodeJS.Platform): MediaAccessStatus {
  if (platform !== 'darwin' && platform !== 'win32') return 'unknown';
  return systemPreferences.getMediaAccessStatus(device);
}

export function getMediaAccess(platform: NodeJS.Platform = process.platform): MediaAccess {
  return { camera: readStatus('camera', platform), microphone: readStatus('microphone', platform) };
}

/**
 * On macOS, show the system prompt for one device when the user hasn't answered it yet, and
 * report the status afterwards. macOS asks once per app: after a denial it answers without
 * prompting, and only System Settings can change it. Elsewhere this only reports the status.
 */
export async function requestMediaAccess(
  device: MediaDevice,
  platform: NodeJS.Platform = process.platform
): Promise<MediaAccessStatus> {
  if (platform === 'darwin' && readStatus(device, platform) === 'not-determined') {
    await systemPreferences.askForMediaAccess(device);
  }
  return readStatus(device, platform);
}

export function registerMediaHandlers(): void {
  handle('media:get-access', () => getMediaAccess());
  handle('media:request-access', (_event, device: unknown) => {
    if (!isMediaDevice(device)) throw new Error('Unknown media device.');
    return requestMediaAccess(device);
  });
}
