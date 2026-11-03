/** A device the operating system gates separately. */
export type MediaDevice = 'camera' | 'microphone';

/**
 * The operating system's answer for one device, as `systemPreferences.getMediaAccessStatus`
 * reports it. `unknown` also covers platforms that don't gate media at the OS level.
 */
export type MediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export type MediaAccess = Record<MediaDevice, MediaAccessStatus>;
