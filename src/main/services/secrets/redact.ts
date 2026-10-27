/** Replace every occurrence of each non-empty secret in `text` with `«redacted»`. */
export function redactSecrets(text: string, secrets: Iterable<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}
