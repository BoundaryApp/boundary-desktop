/** `text` with every RegExp special character escaped, to match it literally inside a pattern. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
