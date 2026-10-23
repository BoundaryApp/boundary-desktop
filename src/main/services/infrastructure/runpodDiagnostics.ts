const WARMING_TIMEOUT_MS = 45 * 60 * 1000;

export function buildRunpodDiagnostics(options: {
  workerState?: {
    initializing: number;
    throttled: number;
    idle: number;
    running: number;
    unhealthy: number;
  };
  workerCount: number;
  warmingSince?: string;
  healthMessage?: string;
  gpuCount?: number;
  workersMin?: number;
}): string[] {
  const diagnostics: string[] = [];
  const ws = options.workerState;

  if (ws && ws.throttled > 0) {
    diagnostics.push(
      `${ws.throttled} worker(s) throttled — RunPod may be waiting for 2×80GB GPU capacity in your selected regions.`
    );
  }
  if (ws && ws.initializing > 0 && ws.throttled === 0) {
    diagnostics.push(
      `${ws.initializing} worker(s) initializing — model download and vLLM load can take 15–25+ minutes for 70B on first start.`
    );
    diagnostics.push(
      'If RunPod shows hundreds of queued jobs, close this stack page (or quit Boundary) before Destroy — health probes enqueue work. Use Destroy then Apply for a clean endpoint with 2 GPUs.'
    );
  }
  if (ws && ws.unhealthy > 0) {
    diagnostics.push(`${ws.unhealthy} unhealthy worker(s) — check logs for OOM or HF_TOKEN errors.`);
  }
  const stateTotal = ws
    ? ws.initializing + ws.throttled + ws.idle + ws.running + ws.unhealthy
    : 0;
  if (options.workerCount === 0 && stateTotal === 0) {
    if (options.warmingSince && (options.workersMin ?? 0) === 0) {
      diagnostics.push(
        'No workers running yet (scale-to-zero). Periodic health checks trigger worker startup; first 70B cold start often takes 15–25+ minutes.'
      );
    } else {
      diagnostics.push('No workers allocated yet — endpoint is waiting for GPU placement.');
    }
  }
  if (options.gpuCount != null && options.gpuCount < 2) {
    diagnostics.push(
      `Endpoint gpuCount is ${options.gpuCount}; Llama 3.3 70B expects 2 GPUs with TENSOR_PARALLEL_SIZE=2. Re-apply the stack.`
    );
  }
  if (options.warmingSince) {
    const elapsed = Date.now() - new Date(options.warmingSince).getTime();
    const elapsedMin = Math.floor(elapsed / 60_000);
    if (elapsedMin >= 1 && elapsed <= WARMING_TIMEOUT_MS) {
      diagnostics.unshift(
        `Warming for ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'} — worker badges stay at 0 until RunPod allocates a GPU (normal for scale-to-zero).`
      );
    }
    if (elapsed > 30 * 60_000 && stateTotal === 0 && options.workerCount === 0) {
      diagnostics.push(
        'No worker activity after 30+ minutes — re-Apply alone will not fix this (the endpoint already exists). Open RunPod console for throttling/errors; verify HF token. Destroy and re-Apply only if the console shows a broken endpoint.'
      );
    }
    if (elapsed > WARMING_TIMEOUT_MS) {
      diagnostics.push(
        'Warming exceeded 45 minutes — likely throttling or misconfiguration. Widen GPU types/regions or check RunPod console logs.'
      );
    }
  }
  if (options.healthMessage) {
    const warmingTimeout =
      Boolean(options.warmingSince) && /timeout|aborted/i.test(options.healthMessage);
    if (warmingTimeout) {
      diagnostics.push(
        'OpenAI health check timed out — expected while the 70B worker is still starting (often 15–25+ minutes on first run).'
      );
    } else {
      diagnostics.push(`Health probe: ${options.healthMessage}`);
    }
  }
  return diagnostics;
}
