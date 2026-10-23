/** Long timeout: first 70B cold start can exceed 15–25 minutes. */
const WARMUP_TIMEOUT_MS = 300_000;

export interface WarmupProbeResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
}

/**
 * POST a minimal chat completion to wake scale-to-zero serverless workers.
 * GET /v1/models alone may time out without ever queuing GPU placement.
 */
export async function triggerScaleWarmup(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  provider?: string
): Promise<WarmupProbeResult> {
  const model = modelId.trim();
  if (!model) {
    return { ok: false, error: 'Model is not configured for warmup.' };
  }

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization =
      provider === 'baseten' ? `Api-Key ${apiKey}` : `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (res.ok) return { ok: true, httpStatus: res.status };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      httpStatus: res.status,
      error: `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
