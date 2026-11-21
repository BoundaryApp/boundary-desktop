/** The message to show for a thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
