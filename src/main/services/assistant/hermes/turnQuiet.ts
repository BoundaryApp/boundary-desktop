/**
 * How long a turn may go without a Hermes event before Boundary asks whether it is still
 * running, on a gateway that sends no `turn.heartbeat`. Chat and writing-voice calibration both
 * wait this long.
 */
export const TURN_QUIET_MS = 3 * 60 * 1000;
