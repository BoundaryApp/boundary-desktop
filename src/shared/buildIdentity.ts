declare const __BOUNDARY_APP_ID__: string | undefined;
declare const __BOUNDARY_APP_NAME__: string | undefined;
declare const __BOUNDARY_INSTANCE__: string | undefined;

/** This build's bundle ID. `BOUNDARY_APP_ID` sets it for a build. */
export const APP_ID =
  (typeof __BOUNDARY_APP_ID__ === 'string' && __BOUNDARY_APP_ID__) || 'com.boundary.desktop';

/** The name people see. `BOUNDARY_APP_NAME` sets it for a build. */
export const APP_NAME =
  (typeof __BOUNDARY_APP_NAME__ === 'string' && __BOUNDARY_APP_NAME__) || 'Boundary';

/**
 * Names this build's Podman machine, Compose project, containers and images, so a build with
 * its own `BOUNDARY_INSTANCE` shares none of them with another copy on the same Mac.
 */
export const INSTANCE_NAME =
  (typeof __BOUNDARY_INSTANCE__ === 'string' && __BOUNDARY_INSTANCE__) || 'boundary';

/** True for a build meant to install beside the default one. */
export const IS_SEPARATE_INSTANCE = INSTANCE_NAME !== 'boundary';
