/**
 * The hex forms of the 32-byte public keys Circles use (a Circle's key, a member's identity, a
 * device or writer key) and of their 64-byte signatures, in lowercase hex.
 *
 * Autobase operations are checked against these (ADR 0038), so neither may change what it accepts.
 */

/** A Circle key, identity, or device or writer key: 64 lowercase hex characters. */
export const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/;

/** A signature by one of those keys: 128 lowercase hex characters. */
export const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
