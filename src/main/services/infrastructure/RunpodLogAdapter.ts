import { redactTerraformLogLine } from './terraformLogRedact';
import { taskService } from '../taskService';
import type { RunpodWorkerPod } from './RunpodApiClient';

const RUNPOD_API_BASE = 'https://rest.runpod.io/v1';
const LOG_PROBE_PATHS = ['/logs', '/log'];

export interface RunpodLogTailResult {
  lines: string[];
  source: 'api' | 'synthetic' | 'unavailable';
  message?: string;
}

async function tryFetchRestLogs(
  apiKey: string,
  endpointId: string,
  limit: number
): Promise<string[] | null> {
  for (const suffix of LOG_PROBE_PATHS) {
    try {
      const res = await fetch(`${RUNPOD_API_BASE}/endpoints/${endpointId}${suffix}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const trimmed = text.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed) as { lines?: string[]; logs?: string[]; data?: string[] };
        const lines = json.lines ?? json.logs ?? json.data;
        if (Array.isArray(lines)) {
          return lines.slice(-limit).map((l) => redactTerraformLogLine(String(l)));
        }
      } catch {
        // plain text
      }
      return trimmed
        .split('\n')
        .slice(-limit)
        .map((l) => redactTerraformLogLine(l));
    } catch {
      continue;
    }
  }
  return null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function normalizeApplyLogBody(line: string): string {
  let body = stripAnsi(line.trim());
  while (/^\[[^\]]+\]/.test(body)) {
    body = body.replace(/^\[[^\]]+\]\s*/, '').trim();
  }
  return body.replace(/^\[INFO\]\s*/i, '').trim();
}

/** Skip terraform plan/output JSON fragments mistakenly shown as "logs". */
export function isUsefulApplyLogLine(line: string): boolean {
  const body = normalizeApplyLogBody(line);
  if (!body) return false;
  if (/^[\{\}\[\],]+$/.test(body)) return false;
  if (/"type":\s*"string"/.test(body)) return false;
  if (/"sensitive":\s*(true|false)/.test(body)) return false;
  if (/^\s*"(value|type|sensitive)":/.test(body)) return false;
  if (/"value":\s*"/.test(body)) return false;
  if (/^\s*"[a-z_]+":\s*[\{\[]/.test(body)) return false;
  if (/Task actor created successfully/.test(body)) return false;
  if (/plan\.bin|Saved the plan to|known after apply/.test(body)) return false;
  if (/^[\s─]+$/.test(body)) return false;
  if (/^\+\s+openai_base_url/.test(body)) return false;
  if (/\bPlan:\s*\d+ to add/.test(body)) return false;
  if (/Changes to Outputs:/.test(body)) return false;
  if (/To perform exactly these actions/.test(body)) return false;
  if (/will be created|will be destroyed|must be replaced/.test(body)) return false;
  if (/^\+\s+[\w_]+\s*=/.test(body)) return false;
  if (/^\s*#\s*\(\d+ unchanged attribute/.test(body)) return false;
  if (/runpod_endpoint\.\w+:/.test(body) && !/Creating|Creation complete|complete after/i.test(body)) {
    return false;
  }
  if (/plan\. Resource actions|Terraform used the selected|Terraform will perform/i.test(body)) {
    return false;
  }
  if (/^\+\s*create$/i.test(body) || /^\+\s*resource\s+"/.test(body)) return false;
  if (/^\+\s*"[^"]+"/.test(body)) return false;
  if (/rerun this command to reinitialize|commands will detect it/i.test(body)) return false;
  return true;
}

async function buildSyntheticTail(options: {
  workers?: RunpodWorkerPod[];
  healthMessage?: string;
  taskId?: string;
  limit: number;
  warming?: boolean;
}): Promise<string[]> {
  const lines: string[] = [];
  if (options.healthMessage) {
    const warmingTimeout =
      options.warming && /timeout|aborted/i.test(options.healthMessage);
    lines.push(
      warmingTimeout
        ? '[health] OpenAI check timed out — worker may still be starting (scale-from-zero)'
        : `[health] ${options.healthMessage}`
    );
  }
  for (const w of options.workers ?? []) {
    if (w.lastStatusChange) {
      lines.push(`[worker ${w.id}] ${w.lastStatusChange}`);
    } else if (w.desiredStatus) {
      lines.push(`[worker ${w.id}] status=${w.desiredStatus}`);
    }
  }
  if (options.taskId) {
    const log = await taskService.getTaskLog(options.taskId);
    if (log) {
      const taskLines = log
        .split('\n')
        .filter(Boolean)
        .filter(isUsefulApplyLogLine)
        .slice(-20);
      for (const line of taskLines) {
        lines.push(`[apply] ${redactTerraformLogLine(line)}`);
      }
    }
  }
  return lines.slice(-options.limit);
}

export async function fetchRunpodLogTail(
  apiKey: string,
  endpointId: string,
  options?: {
    workers?: RunpodWorkerPod[];
    healthMessage?: string;
    taskId?: string;
    limit?: number;
    warming?: boolean;
  }
): Promise<RunpodLogTailResult> {
  const limit = options?.limit ?? 200;

  const apiLines = await tryFetchRestLogs(apiKey, endpointId, limit);
  if (apiLines && apiLines.length > 0) {
    return { lines: apiLines, source: 'api' };
  }

  const synthetic = await buildSyntheticTail({
    workers: options?.workers,
    healthMessage: options?.healthMessage,
    taskId: options?.taskId,
    limit,
    warming: options?.warming,
  });
  if (synthetic.length > 0) {
    return {
      lines: synthetic,
      source: 'synthetic',
      message:
        'RunPod does not expose stdout logs via the public REST API. Showing worker status and apply task lines. Use Open in RunPod for full logs.',
    };
  }

  return {
    lines: [],
    source: 'unavailable',
    message:
      'No logs available yet. Worker logs appear after RunPod allocates a worker. Open the RunPod console for live stdout.',
  };
}
