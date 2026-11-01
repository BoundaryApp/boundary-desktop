/**
 * Finds a reply's token count without keeping its text (ADR 0034 §5–6). `usage` comes at or near
 * the end of a JSON reply and in the last chunks of a stream, so only the last bytes are held,
 * and only the number leaves. Quotes inside a reply's text are escaped, so its words can't match.
 */
const TAIL_BYTES = 16 * 1024;

function lastCount(text: string, field: string): number | null {
  const matches = [...text.matchAll(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g'))];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

export class UsageTail {
  private tail: Buffer = Buffer.alloc(0);

  push(data: Uint8Array): void {
    const joined = Buffer.concat([this.tail, data]);
    this.tail = joined.subarray(Math.max(0, joined.length - TAIL_BYTES));
  }

  /** Null when the reply didn't report usage, which some servers don't. */
  tokens(): number | null {
    const text = this.tail.toString('utf8');
    const total = lastCount(text, 'total_tokens');
    if (total !== null) return total;
    const prompt = lastCount(text, 'prompt_tokens');
    const completion = lastCount(text, 'completion_tokens');
    return prompt === null && completion === null ? null : (prompt ?? 0) + (completion ?? 0);
  }
}
