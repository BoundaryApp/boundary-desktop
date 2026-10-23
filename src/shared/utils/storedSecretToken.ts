import { maskSecret } from './secretPreview';

/**
 * Stand-in for a secret main already holds. The renderer gets this instead of
 * the value, sends it back unchanged, and main swaps the real value in.
 */
const PREFIX = 'boundary-stored-secret:';

export function storedSecretToken(fieldName: string, value: string): string {
  return `${PREFIX}${fieldName}:${maskSecret(value)}`;
}

// Not a type guard: narrowing would make a plain string look impossible in the else branch.
export function isStoredSecretToken(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Field name the token stands for, or null when it isn't a token. */
export function storedSecretField(value: unknown): string | null {
  if (typeof value !== 'string' || !isStoredSecretToken(value)) return null;
  const rest = value.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  return sep > 0 ? rest.slice(0, sep) : null;
}

/** Masked preview for display; plain values are masked as usual. */
export function displaySecret(value: string): string {
  if (!isStoredSecretToken(value)) return maskSecret(value);
  const rest = value.slice(PREFIX.length);
  return rest.slice(rest.indexOf(':') + 1);
}
