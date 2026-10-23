import fs from 'node:fs';
import path from 'node:path';
import { rewriteLlmUrlForContainer } from './rewriteLlmUrlForContainer';
import { LLM_PROXY_CLIENT_BASE_URL, LLM_PROXY_PLACEHOLDER_KEY } from './llmProxyAdmin';

export interface LlmConnectionForProject {
  endpointUrl: string;
  apiKey: string;
  modelId: string;
}

export function upsertEnvLine(contents: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  const trimmed = contents.replace(/\s*$/, '');
  return `${trimmed}\n${line}\n`;
}

/** Drop `KEY=…` lines from dotenv contents. */
export function removeEnvLines(contents: string, keys: readonly string[]): string {
  const drop = new Set(keys);
  return contents
    .split(/(?<=\n)/)
    .filter((line) => {
      const eq = line.indexOf('=');
      return eq <= 0 || !drop.has(line.slice(0, eq).trim());
    })
    .join('');
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
export async function clearLlmKeysFromProjectEnv(projectRoot: string): Promise<boolean> {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return false;
  const before = await fs.promises.readFile(envPath, 'utf8');
  let after = before;
  for (const key of PROXY_KEY_ENV_KEYS) {
    const pattern = new RegExp(`^${key}=(.*)$`, 'm');
    const match = after.match(pattern);
    if (match && match[1].trim()) after = upsertEnvLine(after, key, '');
  }
  if (after === before) return false;
  await fs.promises.writeFile(envPath, after, 'utf8');
  return true;
}

/**
 * Write Boundary's verified LLM connection into the project .env, which llm-proxy reads
 * when its container is created, and point OpenCode at the proxy. Hermes profiles are
 * updated via hermes config set; the live proxy gets the key through its admin API.
 *
 * The key itself goes to .env only for a local stack checkout, where Boundary doesn't
 * drive the proxy. A Boundary-managed stack gets blank key lines.
 */
export async function applyLlmConnectionToProjectFiles(
  projectRoot: string,
  llm: LlmConnectionForProject,
  options: { localStack?: boolean } = {}
): Promise<void> {
  const envKey = options.localStack ? llm.apiKey : '';
  const baseUrl = rewriteLlmUrlForContainer(llm.endpointUrl);
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envPath)) {
    let contents = await fs.promises.readFile(envPath, 'utf8');
    const updates: Array<[string, string]> = [
      ['LLM_BINDING', 'openai'],
      ['LLM_MODEL', llm.modelId],
      ['LLM_BINDING_HOST', baseUrl],
      ['LLM_BINDING_API_KEY', envKey],
      ['LIGHTRAG_LLM_BINDING', 'openai'],
      ['LIGHTRAG_LLM_MODEL', llm.modelId],
      ['LIGHTRAG_LLM_BINDING_HOST', baseUrl],
      ['LIGHTRAG_LLM_BINDING_API_KEY', envKey],
    ];
    for (const [key, value] of updates) {
      contents = upsertEnvLine(contents, key, value);
    }
    // A local stack checkout is the developer's own .env; leave its other lines alone.
    if (!options.localStack) {
      contents = removeEnvLines(contents, RETIRED_ENV_KEYS);
    }
    await fs.promises.writeFile(envPath, contents, 'utf8');
  }

  // OpenCode talks to llm-proxy on the compose network; the real key stays in the proxy.
  await updateOpenCodeLocalConfig(projectRoot, {
    baseUrl: LLM_PROXY_CLIENT_BASE_URL,
    apiKey: LLM_PROXY_PLACEHOLDER_KEY,
    modelId: llm.modelId,
  });
}

async function updateOpenCodeLocalConfig(
  projectRoot: string,
  llm: { baseUrl: string; apiKey: string; modelId: string }
): Promise<void> {
  const localPath = path.join(projectRoot, 'opencode', 'opencode.local.json');
  const templatePath = path.join(projectRoot, 'opencode', 'opencode.json');
  let config: Record<string, unknown>;

  if (fs.existsSync(localPath)) {
    config = JSON.parse(await fs.promises.readFile(localPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } else if (fs.existsSync(templatePath)) {
    config = JSON.parse(await fs.promises.readFile(templatePath, 'utf8')) as Record<
      string,
      unknown
    >;
  } else {
    return;
  }

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

  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fs.promises.writeFile(localPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Exported for tests */
export const __test = {
  upsertEnvLine,
  removeEnvLines,
  RETIRED_ENV_KEYS,
};
