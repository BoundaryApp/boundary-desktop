/**
 * Prem's hardware check, through Prem's Reticle verifier.
 *
 * Reticle fetches the gateway's evidence for the model, verifies the CPU and GPU attestations
 * against Prem's policy, and throws on any failed check. Its policy accepts any workload in
 * Prem's catalog, so this also requires the attested workload to be the requested model on an
 * NVIDIA GPU, GPU evidence among the attested modules, and a session id to send chat under.
 *
 * The evidence commits to the nonce and the workload manifest only, not to the key a prompt is
 * encrypted to, so this is a floor and Prem stays at trust level C.
 */
import { settleOrAbort } from '../adapterKit';

/** The ownership-taking calls (`with_authorization`, `build`, `with`, `set_query`) consume their receiver or argument, as Reticle's wasm-bindgen glue does. */
interface ReticleClientBuilder {
  with_authorization(token: string): ReticleClientBuilder;
  build(): Promise<ReticleClient>;
}

interface ReticleQueryParams {
  with(key: string, value: string): ReticleQueryParams;
}

interface ReticleClient {
  set_query(query: ReticleQueryParams): void;
  attest(): Promise<ReticleAttestResult>;
  free(): void;
}

interface ReticleAttestResult {
  headers(): { get(name: string): string | undefined; free(): void };
  modules(): { has_gpu(): boolean; free(): void };
  pod_report(): unknown;
  free(): void;
}

/** The part of `@premai/reticle` that `attestPrem` uses, so tests can pass a fake. */
export interface ReticleLike {
  ClientBuilder: new (url: string) => ReticleClientBuilder;
  QueryParams: new () => ReticleQueryParams;
}

export interface PremAttested {
  /** Sent as `X-Session-Id` on chat. */
  sessionId: string;
  workloadId: string;
}

type PremAttestationDetail = 'verifier' | 'workload' | 'no-gpu' | 'no-session';

const GATEWAY = 'https://gateway.prem.io';

/**
 * What follows `<model>-` in a workload id: an NVIDIA GPU name, then optional hardware parts,
 * as in `qwen38-27b-h100-pcie-1-96g`. Without it a shorter model id would match a longer
 * model's workload (`qwen38` against `qwen38-27b-…`).
 */
const GPU_SUFFIX = /^(?:a100|h100|h200|h20|h800|b100|b200|b300|gb200|gb300|l40s?)(?:-[a-z0-9]+)*$/;

function workloadMatches(workloadId: unknown, model: string): workloadId is string {
  if (typeof workloadId !== 'string' || model === '') return false;
  if (workloadId === model) return true;
  return workloadId.startsWith(`${model}-`) && GPU_SUFFIX.test(workloadId.slice(model.length + 1));
}

/** Frees a Reticle object, ignoring a throw: a failed free must not turn a result into a rejection. */
function release(object: { free(): void } | undefined): void {
  try {
    object?.free();
  } catch {
    // A failed free leaves nothing to undo.
  }
}

/**
 * Attests Prem's gateway for `model`. Verifier errors are reduced to `verifier` because their
 * text can quote a URL. Reticle takes no signal, so an abort returns `verifier` at once and the
 * verifier's late result is freed when it arrives; callers tell an abort apart by `signal.aborted`.
 */
export async function attestPrem(opts: {
  apiKey: string;
  model: string;
  reticle: ReticleLike;
  signal: AbortSignal;
}): Promise<{ ok: true; value: PremAttested } | { ok: false; detail: PremAttestationDetail }> {
  const { apiKey, model, reticle, signal } = opts;
  if (signal.aborted) return { ok: false, detail: 'verifier' };

  let client: ReticleClient | undefined;
  const freeClient = (): void => {
    release(client);
    client = undefined;
  };
  const work = (async (): Promise<ReticleAttestResult> => {
    client = await new reticle.ClientBuilder(GATEWAY).with_authorization(`Bearer ${apiKey}`).build();
    // Don't attest with the key once the caller has gone.
    if (signal.aborted) throw new Error('aborted');
    client.set_query(new reticle.QueryParams().with('model', model));
    return client.attest();
  })();

  const settled = await settleOrAbort(work, signal);
  if (settled.kind === 'aborted') {
    work
      .then(
        (result) => {
          release(result);
          freeClient();
        },
        freeClient,
      )
      .catch((): undefined => undefined);
    return { ok: false, detail: 'verifier' };
  }
  if (settled.kind === 'failed') {
    freeClient();
    return { ok: false, detail: 'verifier' };
  }

  const result = settled.value;
  try {
    const report = result.pod_report() as { workload_id?: unknown } | null | undefined;
    const workloadId = report && typeof report === 'object' ? report.workload_id : undefined;
    if (!workloadMatches(workloadId, model)) return { ok: false, detail: 'workload' };

    const modules = result.modules();
    let hasGpu: boolean;
    try {
      hasGpu = modules.has_gpu();
    } finally {
      release(modules);
    }
    if (!hasGpu) return { ok: false, detail: 'no-gpu' };

    const headers = result.headers();
    let sessionId: string | undefined;
    try {
      sessionId = headers.get('x-session-id');
    } finally {
      release(headers);
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return { ok: false, detail: 'no-session' };

    return { ok: true, value: { sessionId, workloadId } };
  } catch {
    return { ok: false, detail: 'verifier' };
  } finally {
    release(result);
    freeClient();
  }
}
