import type { RunpodRuntimeSnapshot } from '../../../shared/types/infrastructure';
import { getInstance } from './instanceStore';
import { getSecret } from './StackSecretsStore';
import { RunpodApiClient } from './RunpodApiClient';
import { RunpodGraphQLClient } from './RunpodGraphQLClient';
import { fetchRunpodLogTail } from './RunpodLogAdapter';
import { runpodConsoleUrl } from './runpodConsoleUrl';
import { buildRunpodDiagnostics } from './runpodDiagnostics';

function mapPodsToWorkers(
  pods: Array<{
    id: string;
    desiredStatus?: string;
    lastStatusChange?: string;
    gpuCount?: number;
  }>
) {
  return pods.map((p) => ({
    id: p.id,
    desiredStatus: p.desiredStatus,
    lastStatusChange: p.lastStatusChange,
    gpuCount: p.gpuCount,
    dataCenterId: undefined as string | undefined,
  }));
}

export async function buildRunpodRuntimeSnapshot(
  instanceId: string,
  options?: { healthMessage?: string }
): Promise<RunpodRuntimeSnapshot | null> {
  const inst = await getInstance(instanceId);
  if (!inst) return null;

  const endpointId = inst.outputs.endpoint_id;
  if (!endpointId) return null;

  const apiKey = await getSecret(instanceId, 'runpod_api_key');
  if (!apiKey) {
    return {
      endpointId,
      logsAvailable: false,
      logMessage: 'RunPod API key not configured.',
      consoleUrl: runpodConsoleUrl(endpointId),
      warmingSince: inst.warmingSince,
    };
  }

  let restEndpoint;
  let gqlRuntime;
  let restError: string | undefined;
  let gqlError: string | undefined;
  try {
    const client = new RunpodApiClient(apiKey);
    restEndpoint = await client.getEndpoint(endpointId, { includeWorkers: true });
    if (!restEndpoint.workers?.length) {
      const all = await client.listEndpoints({ includeWorkers: true });
      const listed = all.find((e) => e.id === endpointId);
      if (listed?.workers?.length) {
        restEndpoint = listed;
      }
    }
  } catch (e) {
    restEndpoint = undefined;
    restError = e instanceof Error ? e.message : String(e);
  }
  try {
    const gql = new RunpodGraphQLClient(apiKey);
    gqlRuntime = await gql.fetchEndpointRuntime(endpointId);
  } catch (e) {
    gqlRuntime = null;
    gqlError = e instanceof Error ? e.message : String(e);
  }

  const gqlPods = gqlRuntime?.pods ?? [];
  const restWorkers = restEndpoint?.workers ?? [];
  const workers =
    gqlPods.length > 0
      ? mapPodsToWorkers(gqlPods)
      : restWorkers.map((w) => ({
          id: w.id,
          desiredStatus: w.desiredStatus,
          lastStatusChange: w.lastStatusChange,
          gpuCount: w.gpuCount,
          dataCenterId: w.dataCenterId,
        }));

  const workerState = gqlRuntime?.workerState;

  const gpuCount = gqlRuntime?.gpuCount ?? restEndpoint?.gpuCount;
  const diagnostics = buildRunpodDiagnostics({
    workerState,
    workerCount: workers.length,
    warmingSince: inst.warmingSince,
    healthMessage: options?.healthMessage,
    gpuCount,
    workersMin: gqlRuntime?.workersMin,
  });
  if (restError) {
    diagnostics.push(`RunPod REST worker lookup failed: ${restError.slice(0, 200)}`);
  }
  if (gqlError) {
    diagnostics.push(`RunPod GraphQL runtime failed: ${gqlError.slice(0, 200)}`);
  }

  const logResult = await fetchRunpodLogTail(apiKey, endpointId, {
    workers: restWorkers.length > 0 ? restWorkers : undefined,
    healthMessage: options?.healthMessage,
    taskId: inst.lastTaskId,
    limit: 200,
    warming: Boolean(inst.warmingSince),
  });

  return {
    endpointId,
    gpuCount,
    workerState: workerState
      ? {
          initializing: workerState.initializing,
          throttled: workerState.throttled,
          idle: workerState.idle,
          running: workerState.running,
          unhealthy: workerState.unhealthy,
        }
      : undefined,
    workers,
    warmingSince: inst.warmingSince,
    diagnostics,
    logsAvailable: logResult.source === 'api',
    logTail: logResult.lines,
    logMessage: logResult.message,
    consoleUrl: runpodConsoleUrl(endpointId),
  };
}
