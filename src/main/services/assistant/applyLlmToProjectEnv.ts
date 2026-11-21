import type { StackFiles } from '../stackHost/types';
import { rewriteLlmUrlForContainer } from './rewriteLlmUrlForContainer';
import { LLM_PROXY_CLIENT_BASE_URL, LLM_PROXY_PLACEHOLDER_KEY } from './llmProxyAdmin';
import { setProjectEnvValues, type ProjectEnv } from './projectEnv';
import { parseEnv, removeEnvLines, writeStackEnvValues } from './stackEnv';

export interface LlmConnectionForProject {
  endpointUrl: string;
  apiKey: string;
  modelId: string;
}

/**
 * .env keys earlier Boundary versions wrote that the stack no longer reads: GPT Researcher
 * now reaches the model through llm-proxy with a placeholder. OPENAI_API_KEY held a copy of
 * the real key, so it is removed rather than left stale.
 */
const RETIRED_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'FAST_LLM',
  'SMART_LLM',
  'STRATEGIC_LLM',
] as const;

/** .env keys llm-proxy reads its upstream keys from when its container is created. */
const PROXY_KEY_ENV_KEYS = ['LLM_BINDING_API_KEY', 'LIGHTRAG_LLM_BINDING_API_KEY'] as const;

/**
 * Blank the upstream keys in the project .env. Boundary gives the key to llm-proxy through
 * its admin API instead, so it stays in memory. Returns whether anything changed, which
 * means a running proxy container still has the old key in its environment.
 */
export async function clearLlmKeysFromProjectEnv(files: StackFiles, env: ProjectEnv): Promise<boolean> {
  const before = await files.readText('stack', '.env');
  if (before === null) return false;
  const current = parseEnv(before);
  const set = PROXY_KEY_ENV_KEYS.filter((key) => current[key]?.trim());
  if (set.length === 0) return false;
  await setProjectEnvValues(env, files, Object.fromEntries(set.map((key) => [key, ''])));
  return true;
}

/**
 * Write Boundary's verified LLM connection into the project .env, which llm-proxy reads
 * when its container is created, and point OpenCode at the proxy. The `LLM_*` keys go
 * through `env`; `LIGHTRAG_LLM_*` through the file, since `env.sh` before
 * stack v0.3.17 refuses them and the key is a secret. Hermes profiles are
 * written by hermesConfigApply.ts; the live proxy gets the key through its admin API.
 *
 * The key itself goes to .env only for a local stack checkout, where Boundary doesn't
 * drive the proxy. A Boundary-managed stack gets blank key lines.
 */
export async function applyLlmConnectionToProjectFiles(
  files: StackFiles,
  env: ProjectEnv,
  llm: LlmConnectionForProject,
  options: { localStack?: boolean } = {}
): Promise<void> {
  const envKey = options.localStack ? llm.apiKey : '';
  const baseUrl = rewriteLlmUrlForContainer(llm.endpointUrl);
  if (await files.exists('stack', '.env')) {
    const values = {
      LLM_BINDING: 'openai',
      LLM_MODEL: llm.modelId,
      LLM_BINDING_HOST: baseUrl,
      LLM_BINDING_API_KEY: envKey,
      LIGHTRAG_LLM_BINDING: 'openai',
      LIGHTRAG_LLM_MODEL: llm.modelId,
      LIGHTRAG_LLM_BINDING_HOST: baseUrl,
      LIGHTRAG_LLM_BINDING_API_KEY: envKey,
    };
    if (options.localStack) {
      // The developer's own .env, with the real key, which stays off env.sh's command line.
      await writeStackEnvValues(files, 'stack', '.env', values);
    } else {
      await setProjectEnvValues(env, files, values);
      // env.sh doesn't accept these keys; they only exist in an .env an older Boundary wrote.
      const contents = await files.readText('stack', '.env');
      const next = contents === null ? null : removeEnvLines(contents, RETIRED_ENV_KEYS);
      if (next !== null && next !== contents) await files.writeText('stack', '.env', next);
    }
  }

  // OpenCode talks to llm-proxy on the compose network; the real key stays in the proxy.
  await updateOpenCodeLocalConfig(files, {
    baseUrl: LLM_PROXY_CLIENT_BASE_URL,
    apiKey: LLM_PROXY_PLACEHOLDER_KEY,
    modelId: llm.modelId,
  });
}

async function updateOpenCodeLocalConfig(
  files: StackFiles,
  llm: { baseUrl: string; apiKey: string; modelId: string }
): Promise<void> {
  const localPath = 'opencode/opencode.local.json';
  const raw =
    (await files.readText('stack', localPath)) ??
    (await files.readText('stack', 'opencode/opencode.json'));
  if (raw === null) return;
  const config = JSON.parse(raw) as Record<string, unknown>;

  config.model = `local/${llm.modelId}`;
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const local = (provider.local ?? {}) as Record<string, unknown>;
  const options = (local.options ?? {}) as Record<string, unknown>;
  options.baseURL = llm.baseUrl;
  if (llm.apiKey) {
    options.apiKey = llm.apiKey;
  }
  local.options = options;
  local.npm = local.npm ?? '@ai-sdk/openai-compatible';
  local.name = local.name ?? 'Local OpenAI-compatible';
  local.models = {
    ...(typeof local.models === 'object' && local.models ? local.models : {}),
    [llm.modelId]: { name: llm.modelId },
  };
  provider.local = local;
  config.provider = provider;

  await files.writeText('stack', localPath, `${JSON.stringify(config, null, 2)}\n`);
}
